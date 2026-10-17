import { randomUUID } from 'node:crypto'
import { validateControlFrame } from './control-frame'
import { RpcRequestError, validRpcErrorCode } from './errors'
import {
  MAX_RPC_FRAME_BYTES,
  MAX_RPC_REASSEMBLED_BYTES,
  RpcFrameCodec,
  encodeRpcCommand
} from './frame-codec'
import type {
  RpcCommand,
  RpcConnectionOptions,
  RpcControlChannel,
  RpcControlCommit,
  RpcDisconnect,
  RpcFrame,
  RpcPromptOptions,
  RpcPromptResult,
  RpcRequestOptions,
  RpcResponse,
  RpcTransport,
  RpcTransportFactory
} from './types'

type Timer = ReturnType<typeof setTimeout>
interface PendingResponse {
  command: string
  resolve(response: RpcResponse): void
  reject(error: Error): void
  timer?: Timer
}
interface PendingPrompt {
  admitted: boolean
  result?: RpcPromptResult
  resolve(result: RpcPromptResult): void
  reject(error: Error): void
  timer?: Timer
}
interface Generation {
  id: number
  phase: 'starting' | 'negotiating' | 'ready' | 'closed'
  controller: AbortController
  codec: RpcFrameCodec
  process?: RpcTransport
  start: Promise<void>
  ready(): void
  rejectStart(error: Error): void
  timer?: Timer
  responses: Map<string, PendingResponse>
  prompts: Map<string, PendingPrompt>
  writes: Promise<void>
  writing: number
  queuedBytes: number
  detach?: () => void
  cleanup?: Promise<void>
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function timeout(value: number | undefined, fallback: number): number {
  const result = value ?? fallback
  if (!Number.isFinite(result) || result < 0)
    throw new Error('RPC timeout must be nonnegative and finite')
  return result
}
function promptResult(value: RpcFrame): RpcPromptResult {
  if (
    typeof value.id !== 'string' ||
    typeof value.agentInvoked !== 'boolean' ||
    typeof value.status !== 'string' ||
    !['completed', 'aborted', 'error'].includes(value.status) ||
    typeof value.sessionSettled !== 'boolean' ||
    (value.error !== undefined &&
      (!record(value.error) ||
        typeof value.error.message !== 'string' ||
        typeof value.error.retryable !== 'boolean' ||
        (value.error.provider !== undefined && typeof value.error.provider !== 'string') ||
        (value.error.model !== undefined && typeof value.error.model !== 'string') ||
        (value.error.httpStatus !== undefined &&
          (typeof value.error.httpStatus !== 'number' ||
            !Number.isInteger(value.error.httpStatus)))))
  )
    throw new Error('Invalid RPC prompt result')
  return value as RpcPromptResult
}

/** One persistent channel. Only prompt_result, never agent_end, completes an invoked prompt. */
export class RpcConnection {
  private current?: Generation
  private generation = 0
  private readonly events = new Set<(frame: RpcFrame) => void>()
  private readonly disconnects = new Set<(event: RpcDisconnect) => void>()
  private readonly startupMs: number
  private readonly requestMs: number
  private readonly promptMs: number
  private readonly closeMs: number
  private lastCleanup: Promise<void> = Promise.resolve()

  constructor(
    private readonly open: RpcTransportFactory,
    options: RpcConnectionOptions = {}
  ) {
    this.startupMs = timeout(options.startupTimeoutMs, 30_000)
    this.requestMs = timeout(options.requestTimeoutMs, 30_000)
    this.promptMs = timeout(options.promptTimeoutMs, 0)
    this.closeMs = timeout(options.closeTimeoutMs, 5_000)
    if (!this.closeMs) throw new Error('RPC cleanup timeout must be positive')
  }

  get isReady(): boolean {
    return this.current?.phase === 'ready'
  }

  get isClosed(): boolean {
    return this.current?.phase === 'closed'
  }

  onEvent(listener: (frame: RpcFrame) => void): () => void {
    this.events.add(listener)
    return () => {
      this.events.delete(listener)
    }
  }

  onDisconnect(listener: (event: RpcDisconnect) => void): () => void {
    this.disconnects.add(listener)
    return () => {
      this.disconnects.delete(listener)
    }
  }

  start(): Promise<void> {
    if (this.current && this.current.phase !== 'closed') return this.current.start
    let ready!: () => void
    let rejectStart!: (error: Error) => void
    const start = new Promise<void>((resolve, reject) => {
      ready = resolve
      rejectStart = reject
    })
    const state: Generation = {
      id: ++this.generation,
      phase: 'starting',
      controller: new AbortController(),
      codec: new RpcFrameCodec(),
      start,
      ready,
      rejectStart,
      responses: new Map(),
      prompts: new Map(),
      writes: Promise.resolve(),
      writing: 0,
      queuedBytes: 0
    }
    this.current = state
    if (this.startupMs)
      state.timer = setTimeout(() => {
        this.fail(state, new Error('RPC startup timed out'))
      }, this.startupMs)
    // Reap an earlier channel before opening its replacement. A late factory
    // result is separately closed and cannot attach to a newer generation.
    void this.lastCleanup
      .catch(() => undefined)
      .then(() => (this.active(state) ? this.open(state.controller.signal, state.id) : undefined))
      .then(
        (process) => {
          if (!process) return
          if (!this.active(state)) {
            void this.closeTransport(process).catch(() => undefined)
            return
          }
          this.attach(state, process)
        },
        (error: unknown) => this.fail(state, asError(error))
      )
      .catch((error: unknown) => this.fail(state, asError(error)))
    return start
  }

  async request<T = unknown>(command: RpcCommand, options: RpcRequestOptions = {}): Promise<T> {
    const state = this.readyState()
    const response = await this.send(state, command, timeout(options.timeoutMs, this.requestMs))
    return response.data as T
  }

  bindControl(): RpcControlChannel {
    const state = this.readyState()
    return Object.freeze({
      generation: state.id,
      signal: state.controller.signal,
      sendControl: async (frame, commit) => {
        if (!this.active(state)) throw new Error('RPC control generation is closed')
        validateControlFrame(frame)
        if (
          commit &&
          (typeof commit.canSubmit !== 'function' || typeof commit.onSubmit !== 'function')
        )
          throw new Error('Invalid RPC control commit hooks')
        const hooks = commit
          ? { canSubmit: commit.canSubmit, onSubmit: commit.onSubmit }
          : undefined
        await this.write(state, encodeRpcCommand(frame), hooks)
        if (!this.active(state)) throw new Error('RPC control generation is closed')
      },
      onFrame: (listener) => {
        if (!this.active(state)) throw new Error('RPC control generation is closed')
        const off = this.onEvent((frame) => {
          if (this.active(state)) return listener(frame)
        })
        const detach = (): void => {
          off()
          state.controller.signal.removeEventListener('abort', detach)
        }
        state.controller.signal.addEventListener('abort', detach, { once: true })
        return detach
      }
    } satisfies RpcControlChannel)
  }

  async prompt(message: string, options: RpcPromptOptions = {}): Promise<RpcPromptResult> {
    const state = this.readyState()
    const id = this.requestId(state)
    const ms = timeout(options.timeoutMs, this.promptMs)
    const command: RpcCommand = {
      type: 'prompt',
      message,
      ...(options.images ? { images: options.images } : {}),
      ...(options.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {})
    }
    const completion = new Promise<RpcPromptResult>((resolve, reject) => {
      const pending: PendingPrompt = { admitted: false, resolve, reject }
      state.prompts.set(id, pending)
      if (ms)
        pending.timer = setTimeout(() => {
          this.fail(state, new Error('RPC prompt completion timed out'))
        }, ms)
    })
    void this.send(state, command, this.requestMs, id).then(
      (response) => {
        const pending = state.prompts.get(id)
        if (!pending) return
        pending.admitted = true
        if (record(response.data) && response.data.agentInvoked === false && !pending.result) {
          pending.result = {
            type: 'prompt_result',
            id,
            agentInvoked: false,
            status: 'completed',
            sessionSettled: true
          }
        }
        this.finishPrompt(state, id)
      },
      (error: unknown) => this.rejectPrompt(state, id, asError(error))
    )
    return completion
  }

  async abort(): Promise<void> {
    const state = this.current
    // A failed generation has no command channel left to stop. Once an abort is
    // submitted, however, send() still owns its real response/failure/timeout.
    if (state?.phase === 'closed') return
    await this.request({ type: 'abort' })
  }

  async close(): Promise<void> {
    const state = this.current
    if (state && state.phase !== 'closed')
      this.fail(state, new Error('RPC connection closed'), true)
    await this.lastCleanup
  }

  private active(state: Generation): boolean {
    return this.current === state && state.phase !== 'closed'
  }

  private readyState(): Generation {
    const state = this.current
    if (!state || state.phase !== 'ready') throw new Error('RPC connection is not ready')
    return state
  }

  private requestId(state: Generation): string {
    return `phi-${state.id}-${randomUUID()}`
  }

  private attach(state: Generation, process: RpcTransport): void {
    state.process = process
    const failure = (error: Error): void => this.fail(state, error)
    const eof = (): void => {
      if (!this.active(state)) return
      try {
        state.codec.finish()
      } catch (error) {
        this.fail(state, asError(error))
        return
      }
      this.fail(state, new Error('RPC output stream ended'))
    }
    const data = (chunk: unknown): void => {
      if (!this.active(state)) return
      try {
        if (!(chunk instanceof Uint8Array)) throw new Error('RPC stdout must contain raw bytes')
        state.codec.push(chunk, (value) => this.receive(state, value))
      } catch (error) {
        this.fail(state, asError(error))
      }
    }
    const drainStderr = (): void => undefined
    process.stdin.on('error', failure)
    process.stdout.on('error', failure)
    process.stderr.on('error', failure)
    process.stdout.on('end', eof)
    process.stdout.on('close', eof)
    process.stderr.on('data', drainStderr)
    state.detach = () => {
      if (!state.writing) process.stdin.removeListener('error', failure)
      process.stdout.removeListener('error', failure)
      process.stderr.removeListener('error', failure)
      process.stdout.removeListener('data', data)
      process.stdout.removeListener('end', eof)
      process.stdout.removeListener('close', eof)
      process.stderr.removeListener('data', drainStderr)
    }
    void process.closed.then(
      ({ code, signal }) =>
        this.fail(state, new Error(`RPC process exited (${signal ?? code ?? 'unknown'})`)),
      (error: unknown) => this.fail(state, asError(error))
    )
    process.stdout.on('data', data)
  }

  private receive(state: Generation, value: RpcFrame): void {
    if (!this.active(state)) return
    if (value.type === 'ready') {
      if (
        state.phase !== 'starting' ||
        value.protocolVersion !== 1 ||
        !Array.isArray(value.supportedProtocolVersions) ||
        !value.supportedProtocolVersions.includes(2) ||
        value.maxFrameBytes !== MAX_RPC_FRAME_BYTES ||
        value.maxReassembledFrameBytes !== MAX_RPC_REASSEMBLED_BYTES
      ) {
        throw new Error('RPC ready frame does not support the required protocol v2')
      }
      state.phase = 'negotiating'
      void this.send(
        state,
        { type: 'negotiate_protocol', protocolVersion: 2 },
        this.requestMs
      ).then(
        (response) => {
          if (!this.active(state)) return
          if (!record(response.data) || response.data.protocolVersion !== 2) {
            this.fail(state, new Error('RPC protocol v2 negotiation failed'))
            return
          }
          state.phase = 'ready'
          if (state.timer) clearTimeout(state.timer)
          state.ready()
        },
        (error: unknown) => this.fail(state, asError(error))
      )
      return
    }
    if (state.phase === 'starting') throw new Error('RPC output arrived before ready')
    if (value.type === 'response') {
      if (
        typeof value.id !== 'string' ||
        typeof value.command !== 'string' ||
        typeof value.success !== 'boolean' ||
        (!value.success && typeof value.error !== 'string') ||
        (value.code !== undefined && !validRpcErrorCode(value.code))
      )
        throw new Error('Invalid RPC response')
      const pending = state.responses.get(value.id)
      if (!pending) return
      if (pending.command !== value.command)
        throw new Error('RPC response command does not match its request')
      if (
        value.command === 'negotiate_protocol' &&
        value.success &&
        record(value.data) &&
        value.data.protocolVersion === 2
      ) {
        // Enable synchronously: a chunk may follow the acknowledgement in the
        // same stdout read, before promise continuations mark startup complete.
        state.codec.enableProtocolV2()
      }
      state.responses.delete(value.id)
      if (pending.timer) clearTimeout(pending.timer)
      if (value.success) pending.resolve(value as RpcResponse)
      else
        pending.reject(
          new RpcRequestError({
            id: value.id,
            command: value.command,
            error: String(value.error),
            ...(value.code === undefined ? {} : { code: value.code as string })
          })
        )
      return
    }
    if (value.type === 'prompt_result') {
      const result = promptResult(value)
      const pending = state.prompts.get(result.id)
      if (!pending) return
      if (pending.result) throw new Error('Duplicate RPC prompt result')
      pending.result = result
      this.finishPrompt(state, result.id)
      return
    }
    for (const listener of [...this.events]) {
      if (!this.active(state)) break
      try {
        void Promise.resolve(listener(value)).catch(() => undefined)
      } catch {
        /* Observers cannot corrupt the protocol channel. */
      }
    }
  }

  private send(
    state: Generation,
    command: RpcCommand,
    ms: number,
    id = this.requestId(state)
  ): Promise<RpcResponse> {
    let bytes: Buffer
    try {
      bytes = encodeRpcCommand({ ...command, id })
    } catch (error) {
      return Promise.reject(asError(error))
    }
    return new Promise<RpcResponse>((resolve, reject) => {
      const pending: PendingResponse = { command: command.type, resolve, reject }
      state.responses.set(id, pending)
      if (ms)
        pending.timer = setTimeout(
          () => this.fail(state, new Error(`RPC ${command.type} response timed out`)),
          ms
        )
      void this.write(state, bytes).catch((error: unknown) => this.fail(state, asError(error)))
    })
  }

  private write(state: Generation, bytes: Buffer, commit?: RpcControlCommit): Promise<void> {
    let skipped = false
    if (!this.active(state)) return Promise.reject(new Error('RPC channel is closed'))
    // Bound queued client memory independently from the server's chunk reassembly budget.
    if (state.queuedBytes + bytes.length > 8 * MAX_RPC_FRAME_BYTES) {
      const error = new Error('RPC write queue exceeds the supported byte limit')
      this.fail(state, error)
      return Promise.reject(error)
    }
    state.queuedBytes += bytes.length
    const queued = state.writes.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (!this.active(state) || !state.process) {
            reject(new Error('RPC channel is closed'))
            return
          }
          if (commit) {
            let current = false
            try {
              current = commit.canSubmit() === true
            } catch {
              /* A retired control is local to this queue entry. */
            }
            if (!current) {
              skipped = true
              resolve()
              return
            }
            if (!this.active(state) || !state.process) {
              reject(new Error('RPC channel is closed'))
              return
            }
            try {
              commit.onSubmit()
              if (!this.active(state) || !state.process) {
                reject(new Error('RPC channel is closed'))
                return
              }
            } catch {
              skipped = true
              resolve()
              return
            }
          }
          state.writing++
          let completed = false
          const finish = (error?: Error | null): void => {
            if (completed) return
            completed = true
            state.writing--
            if (error) {
              // Writable emits its error after invoking this callback. Keep the
              // retired generation's listener through that drain turn.
              state.writing++
              setImmediate(() => {
                state.writing--
                if (state.phase === 'closed') state.detach?.()
              })
            }
            if (state.phase === 'closed') setImmediate(() => state.detach?.())
            if (error) reject(error)
            else resolve()
          }
          try {
            state.process.stdin.write(bytes, finish)
          } catch (error) {
            finish(asError(error))
          }
        })
    )
    state.writes = queued
    void queued
      .finally(() => {
        state.queuedBytes -= bytes.length
      })
      .catch(() => undefined)
    void queued.catch((error: unknown) => this.fail(state, asError(error)))
    return new Promise<void>((resolve, reject) => {
      const signal = state.controller.signal
      const abort = (): void => reject(asError(signal.reason))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      void queued
        .then(
          () => (skipped ? reject(new Error('RPC control retired before submission')) : resolve()),
          reject
        )
        .finally(() => signal.removeEventListener('abort', abort))
    })
  }

  private finishPrompt(state: Generation, id: string): void {
    const pending = state.prompts.get(id)
    if (!pending?.admitted || !pending.result) return
    state.prompts.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.resolve(pending.result)
  }

  private rejectPrompt(state: Generation, id: string, error: Error): void {
    const pending = state.prompts.get(id)
    if (!pending) return
    state.prompts.delete(id)
    if (pending.timer) clearTimeout(pending.timer)
    pending.reject(error)
  }

  private fail(state: Generation, error: Error, expected = false): void {
    if (!this.active(state)) return
    state.phase = 'closed'
    state.controller.abort(error)
    if (state.timer) clearTimeout(state.timer)
    for (const pending of state.responses.values()) {
      if (pending.timer) clearTimeout(pending.timer)
      pending.reject(error)
    }
    state.responses.clear()
    for (const id of state.prompts.keys()) this.rejectPrompt(state, id, error)
    state.codec.reset()
    // Keep error handlers through transport shutdown; a failed Writable emits
    // its error after invoking the write callback.
    const previousCleanup = this.lastCleanup
    state.cleanup = state.process ? this.closeTransport(state.process) : Promise.resolve()
    this.lastCleanup = Promise.all([previousCleanup.catch(() => undefined), state.cleanup])
      .then(() => undefined)
      .finally(() => state.detach?.())
    void this.lastCleanup.catch(() => undefined)
    void this.lastCleanup.then(
      () => state.rejectStart(error),
      () => state.rejectStart(error)
    )
    for (const listener of [...this.disconnects]) {
      try {
        void Promise.resolve(listener({ error, generation: state.id, expected })).catch(
          () => undefined
        )
      } catch {
        /* Preserve protocol cleanup. */
      }
    }
  }

  private async closeTransport(process: RpcTransport): Promise<void> {
    let timer: Timer | undefined
    const reaped = Promise.allSettled([
      Promise.resolve().then(() => process.close()),
      process.closed
    ]).then((results) => {
      if (results[0].status === 'rejected') throw asError(results[0].reason)
    })
    try {
      await Promise.race([
        reaped,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('RPC transport cleanup timed out')),
            this.closeMs
          )
        })
      ])
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}
