import { pickDeclaredToolInput } from '../../remote-workspace-tool-input'
import type { PhiTool, PhiToolContext, PhiToolImage, PhiToolResult } from '../types'
import { RpcConnection } from './connection'
import { rpcIdentifier, rpcRecord, validToolResult } from './control-frame'
import { encodeRpcCommand, MAX_RPC_FRAME_BYTES } from './frame-codec'
import { encodeHostResult } from '../phi-extension/lib/rpc-host-result-protocol'
import type { RpcHostResultDelivery } from './host-result-delivery'
import { registeredHostTools, type RegisteredHostTool } from './host-tool-validation'
import type { RpcControlChannel, RpcControlFrame, RpcFrame } from './types'

export interface RpcHostToolRun {
  readonly id: string
  readonly signal: AbortSignal
  /** Supplied by attested main-run tracking, never populated from host_tool_call alone. */
  authorizeCall(
    toolCallId: string,
    toolName: string,
    normalizedInput: Readonly<Record<string, unknown>>,
    signal: AbortSignal
  ): 'main' | 'child' | undefined | Promise<'main' | 'child' | undefined>
}
export interface RpcHostToolScope {
  readonly sessionId: string
  readonly projectId: string
  readonly cwd: string
  recentUserImages(): PhiToolImage[]
  /** Return a stable immutable binding; replace it when call input or policy authority changes. */
  currentRun(): RpcHostToolRun | undefined
}
export interface RpcHostToolBridgeOptions {
  connection: RpcConnection
  tools: readonly PhiTool[]
  scope: RpcHostToolScope
  signal?: AbortSignal
  /** Owned by this bridge; root injects the matching private server hydration extension. */
  resultDelivery?: RpcHostResultDelivery
  onError?(error: Error): void
}
interface Invocation {
  id: string
  toolCallId: string
  toolName: string
  finishing: boolean
  run: RpcHostToolRun
  runId: string
  runSignal: AbortSignal
  authority: RpcHostToolRun['authorizeCall']
  controller: AbortController
  detach(): void
  settled: boolean
  serial: Promise<void>
}
const generations = new WeakMap<RpcConnection, number>()
const MAX_ACTIVE_CALLS = 64
const MAX_INVOCATIONS = 10_000
const MAX_QUEUED_BYTES = 8 * MAX_RPC_FRAME_BYTES
const errorResult = (message: string): PhiToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true
})
function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}

/** R5 must provide main-call authority before production activation. */
export class RpcHostToolBridge {
  private readonly channel: RpcControlChannel
  private readonly roster: Map<string, RegisteredHostTool>
  private readonly calls = new Map<string, Invocation>()
  private readonly delivered = new Map<string, string>()
  private readonly seen = new Set<string>()
  private readonly seenToolCalls = new Set<string>()
  private readonly scope: RpcHostToolScope
  private detach: Array<() => void> = []
  private registered = false
  private disposed = false
  private queuedBytes = 0
  private readonly lifetime = new AbortController()

  private constructor(private readonly options: RpcHostToolBridgeOptions) {
    this.scope = Object.freeze({
      ...options.scope,
      recentUserImages: options.scope.recentUserImages.bind(options.scope),
      currentRun: options.scope.currentRun.bind(options.scope)
    })
    if (
      ![this.scope.sessionId, this.scope.projectId].every(rpcIdentifier) ||
      typeof this.scope.cwd !== 'string' ||
      !this.scope.cwd.startsWith('/')
    ) {
      throw new Error('RPC host tools require a trusted session/project scope')
    }
    this.roster = registeredHostTools(options.tools)
    this.channel = options.connection.bindControl()
    if (
      options.resultDelivery &&
      !options.resultDelivery.matchesScope({
        generation: this.channel.generation,
        phiSessionId: this.scope.sessionId,
        projectId: this.scope.projectId,
        cwd: this.scope.cwd
      })
    )
      throw new Error('Host result delivery does not match the current generation scope')
    if (generations.get(options.connection) === this.channel.generation) {
      throw new Error('RPC host tools already bound in this generation')
    }
    generations.set(options.connection, this.channel.generation)
    this.detach.push(
      this.channel.onFrame((frame) => {
        try {
          this.receive(frame)
        } catch (error) {
          this.fail(asError(error))
        }
      })
    )
    for (const signal of [this.channel.signal, options.signal]) {
      if (!signal) continue
      const abort = (): void => this.dispose()
      signal.addEventListener('abort', abort, { once: true })
      this.detach.push(() => signal.removeEventListener('abort', abort))
      if (signal.aborted) this.dispose()
    }
  }

  static async create(options: RpcHostToolBridgeOptions): Promise<RpcHostToolBridge> {
    const bridge = new RpcHostToolBridge(options)
    try {
      if (bridge.disposed) throw new Error('RPC host tool registration aborted')
      const tools = [...bridge.roster.values()].map(({ definition }) => definition)
      // One replacement command. Batching would silently discard previous tool definitions.
      encodeRpcCommand({ type: 'set_host_tools', id: 'preflight', tools })
      const registration = options.connection.request({ type: 'set_host_tools', tools })
      const response = await bridge.untilRetired(registration)
      if (
        bridge.disposed ||
        !rpcRecord(response) ||
        !Array.isArray(response.toolNames) ||
        response.toolNames.length !== tools.length ||
        response.toolNames.some((name, index) => name !== tools[index].name)
      ) {
        throw new Error('RPC host tool registration did not confirm the exact roster')
      }
      bridge.registered = true
      return bridge
    } catch (error) {
      bridge.dispose()
      throw error
    }
  }

  get isReady(): boolean {
    return this.registered && !this.disposed
  }

  /** Immediately retires execution authority; late callbacks can never write another generation. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.registered = false
    this.lifetime.abort(new Error('RPC host tool bridge disposed'))
    for (const detach of this.detach.splice(0)) detach()
    for (const call of this.calls.values()) {
      call.settled = true
      call.detach()
      call.controller.abort(new Error('RPC host tool bridge disposed'))
      if (!this.channel.signal.aborted) {
        void call.serial
          .catch(() => undefined)
          .then(async () => {
            if (!this.channel.signal.aborted)
              await this.channel.sendControl({
                type: 'host_tool_result',
                id: call.id,
                result: errorResult('Host tool execution cancelled'),
                isError: true
              })
          })
          .catch((error: unknown) => this.fail(asError(error)))
      }
    }
    this.calls.clear()
    this.delivered.clear()
    void this.options.resultDelivery?.dispose().catch((error: unknown) => this.fail(asError(error)))
  }

  private untilRetired<T>(operation: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const signals = [this.lifetime.signal, this.channel.signal, this.options.signal].filter(
        (signal): signal is AbortSignal => !!signal
      )
      const abort = (): void => reject(new Error('RPC host tool registration aborted'))
      for (const signal of signals) signal.addEventListener('abort', abort, { once: true })
      if (signals.some((signal) => signal.aborted)) abort()
      void operation.then(resolve, reject).finally(() => {
        for (const signal of signals) signal.removeEventListener('abort', abort)
      })
    })
  }

  private receive(frame: RpcFrame): void {
    if (this.disposed) return
    if (frame.type === 'tool_execution_end' && typeof frame.toolCallId === 'string') {
      const runId = this.delivered.get(frame.toolCallId)
      if (runId) {
        this.delivered.delete(frame.toolCallId)
        this.options.resultDelivery?.consumed(runId, frame.toolCallId)
      }
      return
    }
    if (frame.type === 'host_tool_cancel') {
      if (!rpcIdentifier(frame.id) || !rpcIdentifier(frame.targetId)) return
      const call = this.calls.get(frame.targetId)
      if (call) this.finish(call, errorResult('Host tool execution cancelled'), true)
      return
    }
    if (frame.type !== 'host_tool_call' || !rpcIdentifier(frame.id)) return
    if (this.seen.has(frame.id)) return
    if (this.seen.size >= MAX_INVOCATIONS) {
      this.fail(new Error('RPC host tool invocation limit reached; create a new generation'))
      return
    }
    this.seen.add(frame.id)
    const tool = typeof frame.toolName === 'string' ? this.roster.get(frame.toolName) : undefined
    const run = this.scope.currentRun()
    if (
      !this.registered ||
      !tool ||
      !rpcIdentifier(frame.toolCallId) ||
      !rpcRecord(frame.arguments) ||
      !run ||
      !rpcIdentifier(run.id) ||
      run.signal.aborted ||
      this.seenToolCalls.has(JSON.stringify([run.id, frame.toolCallId])) ||
      this.delivered.has(frame.toolCallId) ||
      this.calls.size >= MAX_ACTIVE_CALLS ||
      this.disposed
    ) {
      this.reject(frame.id, 'Host tool call is not authorized for the active main run')
      return
    }
    const params = pickDeclaredToolInput(frame.arguments, tool.definition.parameters)
    if (!tool.validate(params)) {
      this.reject(frame.id, 'Host tool input does not match its declared schema')
      return
    }
    this.seenToolCalls.add(JSON.stringify([run.id, frame.toolCallId]))
    const controller = new AbortController()
    const runSignal = run.signal
    const cancel = (): void => this.finish(call, errorResult('Host tool execution cancelled'), true)
    const call: Invocation = {
      id: frame.id,
      toolCallId: frame.toolCallId,
      toolName: tool.definition.name,
      finishing: false,
      run,
      runId: run.id,
      runSignal,
      authority: run.authorizeCall,
      controller,
      detach: () => runSignal.removeEventListener('abort', cancel),
      settled: false,
      serial: Promise.resolve()
    }
    runSignal.addEventListener('abort', cancel, { once: true })
    this.calls.set(call.id, call)
    void this.execute(call, tool, params).catch((error: unknown) => this.fail(asError(error)))
  }

  private async execute(
    call: Invocation,
    tool: RegisteredHostTool,
    params: Record<string, unknown>
  ): Promise<void> {
    try {
      const input = structuredClone(params)
      const pending: unknown[] = [input]
      while (pending.length) {
        const value = pending.pop()
        if (value && typeof value === 'object') {
          pending.push(...Object.values(value))
          Object.freeze(value)
        }
      }
      const authorization = call.authority.call(
        call.run,
        call.toolCallId,
        tool.definition.name,
        input,
        call.controller.signal
      )
      const authorized = await this.authorization(call, authorization)
      if (!this.live(call) || authorized !== 'main') {
        this.finish(
          call,
          errorResult('Host tool call is not authorized for the active main run'),
          true
        )
        return
      }
      // Capture this session's prompt images before execute can outlive the current run.
      const images = this.scope
        .recentUserImages()
        .filter(
          (image) =>
            image.type === 'image' &&
            !!image.data &&
            ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(image.mimeType)
        )
        .slice(0, 5)
        .map((image) => ({ ...image }))
      const context: PhiToolContext = {
        cwd: this.scope.cwd,
        recentUserImages: () => images.map((image) => ({ ...image }))
      }
      if (!this.live(call)) {
        this.finish(call, errorResult('Host tool execution cancelled'), true)
        return
      }
      const result = await tool.tool.execute(
        call.toolCallId,
        structuredClone(input),
        (partial) => this.update(call, partial),
        context,
        call.controller.signal
      )
      this.finish(call, result)
    } catch (error) {
      this.finish(call, errorResult(asError(error).message))
    }
  }

  private authorization<T>(call: Invocation, operation: T | Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const signal = call.controller.signal
      const abort = (): void => reject(new Error('Host tool authorization cancelled'))
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      void Promise.resolve(operation)
        .then(resolve, reject)
        .finally(() => signal.removeEventListener('abort', abort))
    })
  }

  private live(call: Invocation): boolean {
    const run = this.scope.currentRun()
    return (
      !this.disposed &&
      !call.settled &&
      !this.channel.signal.aborted &&
      this.calls.get(call.id) === call &&
      run === call.run &&
      run.id === call.runId &&
      run.signal === call.runSignal &&
      run.authorizeCall === call.authority &&
      !call.runSignal.aborted
    )
  }

  private update(call: Invocation, partial: PhiToolResult): void {
    if (!this.live(call) || call.finishing) return
    try {
      this.enqueue(call, { type: 'host_tool_update', id: call.id, partialResult: partial })
    } catch {
      this.finish(
        call,
        errorResult('Host tool progress exceeds the supported frame limit or has invalid content'),
        true
      )
    }
  }

  private finish(call: Invocation, result: PhiToolResult, abort = false): void {
    if (this.disposed || call.settled || this.calls.get(call.id) !== call) return
    if (!abort && !this.live(call)) {
      result = errorResult('Host tool execution cancelled')
      abort = true
    }
    if (!abort && call.finishing) return
    if (!abort && this.options.resultDelivery) {
      try {
        if (!validToolResult(result)) throw new Error('Invalid host tool result')
        let smallFrame: Buffer | undefined
        try {
          smallFrame = encodeRpcCommand({
            type: 'host_tool_result',
            id: call.id,
            result,
            isError: result.isError === true
          })
        } catch {
          /* A complete large result uses the private file transport. */
        }
        const structuredError =
          result.isError === true &&
          (result.details !== undefined || result.content.some((part) => part.type === 'image'))
        if (!smallFrame || structuredError) {
          const snapshot = JSON.parse(encodeHostResult(result).toString('utf8')) as PhiToolResult
          call.finishing = true
          // Reserve the complete payload now, before waiting behind prior writes.
          // Upload activation itself waits on this call's existing progress sequence.
          const publication = this.options.resultDelivery.publish(
            snapshot,
            {
              runId: call.runId,
              invocationId: call.id,
              toolCallId: call.toolCallId,
              toolName: call.toolName
            },
            call.controller.signal,
            call.serial
          )
          void publication.catch(() => undefined)
          call.serial = call.serial.then(async () => {
            try {
              const receipt = await publication
              if (!this.live(call)) return
              this.complete(call, receipt, false, false, true)
            } catch {
              if (this.live(call))
                this.complete(
                  call,
                  errorResult(
                    'Host tool result delivery failed or exceeds its supported logical/file/byte budget'
                  ),
                  true
                )
            }
          })
          void call.serial.catch((error: unknown) => this.fail(asError(error)))
          return
        }
        // Preserve the existing small-result JSON serialization contract.
        result = (JSON.parse(smallFrame!.toString('utf8')) as { result: PhiToolResult }).result
      } catch {
        result = errorResult(
          'Host tool result exceeds its supported logical limit or has invalid JSON content'
        )
      }
    }
    this.complete(call, result, result.isError === true, abort)
  }

  private complete(
    call: Invocation,
    result: PhiToolResult,
    frameError: boolean,
    abort = false,
    receipt = false
  ): void {
    if (receipt) this.delivered.set(call.toolCallId, call.runId)
    call.settled = true
    call.detach()
    this.calls.delete(call.id)
    if (abort) call.controller.abort(new Error('Host tool execution cancelled'))
    try {
      this.enqueue(call, {
        type: 'host_tool_result',
        id: call.id,
        result,
        isError: frameError
      })
    } catch {
      try {
        this.enqueue(call, {
          type: 'host_tool_result',
          id: call.id,
          result: errorResult(
            'Host tool result exceeds the supported frame limit or has invalid content'
          ),
          isError: true
        })
      } catch (error) {
        this.fail(asError(error))
      }
    }
  }

  private enqueue(call: Invocation, frame: RpcControlFrame): void {
    const payload =
      frame.type === 'host_tool_update'
        ? frame.partialResult
        : frame.type === 'host_tool_result'
          ? frame.result
          : undefined
    if (!validToolResult(payload)) throw new Error('Invalid host tool result')
    const bytes = encodeRpcCommand(frame)
    const limit =
      frame.type === 'host_tool_update' ? MAX_QUEUED_BYTES - MAX_RPC_FRAME_BYTES : MAX_QUEUED_BYTES
    if (this.queuedBytes + bytes.length > limit)
      throw new Error('RPC host tool write queue is full')
    const snapshot = JSON.parse(bytes.toString('utf8')) as RpcControlFrame
    this.queuedBytes += bytes.length
    call.serial = call.serial
      .then(async () => {
        const current = this.scope.currentRun()
        if (
          (snapshot.type === 'host_tool_result' || !this.disposed) &&
          (snapshot.type !== 'host_tool_update' ||
            (current === call.run && current.signal === call.run.signal && !current.signal.aborted))
        ) {
          const staleFinal =
            snapshot.type === 'host_tool_result' &&
            snapshot.isError !== true &&
            (this.disposed ||
              current !== call.run ||
              current.signal.aborted ||
              current.authorizeCall !== call.authority)
          await this.channel.sendControl(
            staleFinal
              ? {
                  type: 'host_tool_result',
                  id: call.id,
                  result: errorResult('Host tool execution cancelled'),
                  isError: true
                }
              : snapshot
          )
        }
      })
      .finally(() => {
        this.queuedBytes -= bytes.length
      })
    void call.serial.catch((error: unknown) => this.fail(asError(error)))
  }

  private reject(id: string, message: string): void {
    void this.channel
      .sendControl({ type: 'host_tool_result', id, result: errorResult(message), isError: true })
      .catch((error: unknown) => this.fail(asError(error)))
  }

  private fail(error: Error): void {
    this.dispose()
    try {
      void Promise.resolve(this.options.onError?.(error)).catch(() => undefined)
    } catch {
      /* Diagnostic observers cannot revive or corrupt a retired bridge. */
    }
  }
}
