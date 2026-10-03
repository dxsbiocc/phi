import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface, type Interface as ReadLineInterface } from 'node:readline'
import { randomUUID } from 'node:crypto'
import {
  TERMINAL_MAX_FRAME_BYTES,
  encodeProtocolFrame,
  parseProtocolLine,
  parseSupervisorResponse,
  parseSupervisorResponseResult,
  parseWorkerMessage,
  parseWorkerResponseResult,
  type WorkerEvent
} from './terminal-protocol'
import type {
  TerminalChildSpawner,
  TerminalCreateOptions,
  TerminalHostEvent,
  TerminalHostOptions,
  TerminalReplayResult
} from './terminal-host-types'
import { resolveTerminalScript, spawnBunProcess } from './terminal-host-process'
export type {
  TerminalChildSpawner,
  TerminalCreateOptions,
  TerminalHostEvent,
  TerminalHostOptions,
  TerminalReplayResult
} from './terminal-host-types'

const DEFAULT_HEARTBEAT_INTERVAL_MS = 1_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 3_000
const DEFAULT_REQUEST_TIMEOUT_MS = 5_000
const START_TIMEOUT_MS = 10_000
const USER_CLOSE_BUDGET_MS = 5_000
// Leave process-shutdown scheduling headroom inside the externally visible 1.5 s budget.
const QUIT_CLOSE_BUDGET_MS = 1_400

interface PendingRequest {
  type: string
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ChildChannel {
  kind: 'worker' | 'supervisor'
  child: ChildProcessWithoutNullStreams
  reader: ReadLineInterface
  pending: Map<string, PendingRequest>
  lastPongAt: number
  pingPending: boolean
  stopping: boolean
}

interface TerminalRecord {
  terminalId: string
  state: 'starting' | 'open' | 'closing' | 'exited' | 'failed'
  pid?: number
  started: Promise<number>
  resolveStarted: (pid: number) => void
  rejectStarted: (error: Error) => void
  inputChain: Promise<void>
  closePromise?: Promise<void>
}

function createStartedLatch(): Pick<
  TerminalRecord,
  'started' | 'resolveStarted' | 'rejectStarted'
> {
  let resolveStarted!: (pid: number) => void
  let rejectStarted!: (error: Error) => void
  const started = new Promise<number>((resolve, reject) => {
    resolveStarted = resolve
    rejectStarted = reject
  })
  return { started, resolveStarted, rejectStarted }
}

function remaining(deadline: number): number {
  return Math.max(1, deadline - Date.now())
}

function remainingBefore(deadline: number, reserveMs: number): number {
  return Math.max(1, deadline - Date.now() - reserveMs)
}

export class TerminalHost {
  private readonly spawnWorker: TerminalChildSpawner
  private readonly spawnSupervisor: TerminalChildSpawner
  private readonly workerPath: string
  private readonly supervisorPath: string
  private readonly heartbeatTimeoutMs: number
  private readonly requestTimeoutMs: number
  private readonly listeners = new Set<(event: TerminalHostEvent) => void>()
  private readonly terminals = new Map<string, TerminalRecord>()
  private worker: ChildChannel | null = null
  private supervisor: ChildChannel | null = null
  private acceptingNewTerminals = true
  private disposed = false
  private workerRecovery: Promise<void> = Promise.resolve()
  private readonly heartbeatTimer: NodeJS.Timeout

  constructor(options: TerminalHostOptions = {}) {
    this.spawnWorker = options.spawnWorker ?? spawnBunProcess
    this.spawnSupervisor = options.spawnSupervisor ?? spawnBunProcess
    this.workerPath = resolveTerminalScript(
      'terminal-worker.ts',
      options.workerPath,
      'PHI_TERMINAL_WORKER_PATH'
    )
    this.supervisorPath = resolveTerminalScript(
      'terminal-supervisor.ts',
      options.supervisorPath,
      'PHI_TERMINAL_SUPERVISOR_PATH'
    )
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.heartbeatTimer = setInterval(
      () => this.runHeartbeat(),
      options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    )
    this.heartbeatTimer.unref()
  }

  subscribe(listener: (event: TerminalHostEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async createTerminal(
    options: TerminalCreateOptions
  ): Promise<{ terminalId: string; pid: number }> {
    if (this.disposed) throw new Error('Terminal host is disposed')
    if (!this.acceptingNewTerminals) throw new Error('Terminal supervisor is unavailable')
    if (this.terminals.has(options.terminalId)) throw new Error('Terminal already exists')
    await this.workerRecovery

    const latch = createStartedLatch()
    const record: TerminalRecord = {
      terminalId: options.terminalId,
      state: 'starting',
      ...latch,
      inputChain: Promise.resolve()
    }
    this.terminals.set(options.terminalId, record)

    try {
      const worker = this.ensureWorker()
      const supervisor = this.ensureSupervisor()
      const create = this.request(
        worker,
        { id: randomUUID(), type: 'create', ...options },
        START_TIMEOUT_MS
      )
      const [pid] = await Promise.all([record.started, create])
      await this.request(
        supervisor,
        { id: randomUUID(), type: 'register', terminalId: options.terminalId, pid },
        this.requestTimeoutMs
      )
      record.pid = pid
      record.state = 'open'
      this.emit({ type: 'started', terminalId: options.terminalId, pid })
      return { terminalId: options.terminalId, pid }
    } catch (error) {
      record.state = 'failed'
      await this.bestEffortWorkerRequest(
        { id: randomUUID(), type: 'kill', terminalId: options.terminalId },
        500
      )
      this.terminals.delete(options.terminalId)
      throw error
    }
  }

  input(terminalId: string, data: string): Promise<void> {
    const record = this.requireOpenTerminal(terminalId)
    const operation = record.inputChain.then(async () => {
      this.requireOpenTerminal(terminalId)
      const worker = this.requireWorker()
      await this.request(worker, { id: randomUUID(), type: 'input', terminalId, data })
    })
    record.inputChain = operation.catch(() => undefined)
    return operation
  }

  async resize(terminalId: string, cols: number, rows: number): Promise<void> {
    this.requireOpenTerminal(terminalId)
    await this.request(this.requireWorker(), {
      id: randomUUID(),
      type: 'resize',
      terminalId,
      cols,
      rows
    })
  }

  async credit(terminalId: string, bytes: number): Promise<void> {
    this.requireOpenTerminal(terminalId)
    await this.request(this.requireWorker(), {
      id: randomUUID(),
      type: 'credit',
      terminalId,
      bytes
    })
  }

  async replay(terminalId: string, fromSeq: number): Promise<TerminalReplayResult> {
    this.requireKnownTerminal(terminalId)
    return this.request<TerminalReplayResult>(this.requireWorker(), {
      id: randomUUID(),
      type: 'replay',
      terminalId,
      fromSeq
    })
  }

  close(terminalId: string, mode: 'user' | 'quit'): Promise<void> {
    const record = this.terminals.get(terminalId)
    if (!record) return Promise.resolve()
    if (record.closePromise) return record.closePromise
    record.state = 'closing'
    const deadline = Date.now() + (mode === 'quit' ? QUIT_CLOSE_BUDGET_MS : USER_CLOSE_BUDGET_MS)
    record.closePromise = this.closeTerminal(record, mode, deadline)
    return record.closePromise
  }

  async closeAll(mode: 'user' | 'quit'): Promise<void> {
    const deadline = Date.now() + (mode === 'quit' ? QUIT_CLOSE_BUDGET_MS : USER_CLOSE_BUDGET_MS)
    const records = [...this.terminals.values()]
    for (const record of records) record.state = 'closing'

    if (this.supervisor) {
      await this.request(
        this.supervisor,
        { id: randomUUID(), type: 'terminateAll', mode },
        remainingBefore(deadline, 75)
      ).catch(() => undefined)
    }
    await Promise.all(
      records.map((record) =>
        this.bestEffortWorkerRequest(
          { id: randomUUID(), type: 'kill', terminalId: record.terminalId },
          remaining(deadline)
        )
      )
    )
    await Promise.all(
      records.map((record) =>
        this.bestEffortSupervisorRequest(
          { id: randomUUID(), type: 'forget', terminalId: record.terminalId },
          remaining(deadline)
        )
      )
    )
    for (const record of records) this.terminals.delete(record.terminalId)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.acceptingNewTerminals = false
    clearInterval(this.heartbeatTimer)
    const deadline = Date.now() + QUIT_CLOSE_BUDGET_MS

    await this.closeAll('quit').catch(() => undefined)
    await Promise.all([
      this.stopChannel(this.worker, deadline),
      this.stopChannel(this.supervisor, deadline)
    ])
    this.worker = null
    this.supervisor = null
    this.terminals.clear()
    this.listeners.clear()
  }

  private async closeTerminal(
    record: TerminalRecord,
    mode: 'user' | 'quit',
    deadline: number
  ): Promise<void> {
    await this.bestEffortSupervisorRequest(
      { id: randomUUID(), type: 'terminate', terminalId: record.terminalId, mode },
      remainingBefore(deadline, 100)
    )
    await this.bestEffortWorkerRequest(
      { id: randomUUID(), type: 'kill', terminalId: record.terminalId },
      remainingBefore(deadline, 50)
    )
    await this.bestEffortSupervisorRequest(
      { id: randomUUID(), type: 'forget', terminalId: record.terminalId },
      remaining(deadline)
    )
    this.terminals.delete(record.terminalId)
  }

  private ensureWorker(): ChildChannel {
    if (this.worker && !this.worker.child.killed) return this.worker
    this.worker = this.startChannel('worker', this.spawnWorker(this.workerPath))
    return this.worker
  }

  private ensureSupervisor(): ChildChannel {
    if (this.supervisor && !this.supervisor.child.killed) return this.supervisor
    if (!this.acceptingNewTerminals) throw new Error('Terminal supervisor is unavailable')
    this.supervisor = this.startChannel('supervisor', this.spawnSupervisor(this.supervisorPath))
    return this.supervisor
  }

  private startChannel(
    kind: 'worker' | 'supervisor',
    child: ChildProcessWithoutNullStreams
  ): ChildChannel {
    const channel: ChildChannel = {
      kind,
      child,
      reader: createInterface({ input: child.stdout }),
      pending: new Map(),
      lastPongAt: Date.now(),
      pingPending: false,
      stopping: false
    }
    channel.reader.on('line', (line) => this.handleLine(channel, line))
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => undefined)
    child.on('error', (error) => this.faultChannel(channel, error))
    child.on('exit', (code, signal) => {
      if (!channel.stopping) {
        this.faultChannel(channel, new Error(`${kind} exited (${signal ?? code ?? 'unknown'})`))
      }
    })
    return channel
  }

  private handleLine(channel: ChildChannel, line: string): void {
    if (Buffer.byteLength(line, 'utf8') > TERMINAL_MAX_FRAME_BYTES) {
      process.stderr.write(`Terminal ${channel.kind} discarded an oversized protocol frame\n`)
      return
    }
    try {
      const raw = parseProtocolLine(line)
      const message =
        channel.kind === 'worker' ? parseWorkerMessage(raw) : parseSupervisorResponse(raw)
      if ('id' in message) {
        this.resolveResponse(channel, message)
      } else if (channel.kind === 'worker') {
        this.handleWorkerEvent(message as WorkerEvent)
      }
    } catch {
      process.stderr.write(`Terminal ${channel.kind} discarded a malformed protocol frame\n`)
    }
  }

  private resolveResponse(
    channel: ChildChannel,
    response: { id: string; ok: true; result: unknown } | { id: string; ok: false; error: string }
  ): void {
    const pending = channel.pending.get(response.id)
    if (!pending) return
    const result = response.ok
      ? channel.kind === 'worker'
        ? parseWorkerResponseResult(pending.type, response.result)
        : parseSupervisorResponseResult(pending.type, response.result)
      : undefined
    channel.pending.delete(response.id)
    clearTimeout(pending.timer)
    if (pending.type === 'ping' && response.ok) channel.lastPongAt = Date.now()
    if (response.ok) pending.resolve(result)
    else pending.reject(new Error(response.error))
  }

  private handleWorkerEvent(event: WorkerEvent): void {
    const record = this.terminals.get(event.terminalId)
    if (!record) return
    switch (event.type) {
      case 'started':
        record.resolveStarted(event.pid)
        return
      case 'data':
        this.emit(event)
        return
      case 'gap':
        this.emit(event)
        return
      case 'exit':
        record.state = 'exited'
        this.emit(event)
        return
      case 'error': {
        record.state = 'failed'
        const failure = {
          type: 'failed' as const,
          terminalId: event.terminalId,
          message: event.message
        }
        record.rejectStarted(new Error(event.message))
        this.emit(failure)
      }
    }
  }

  private request<T = void>(
    channel: ChildChannel,
    frame: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs
  ): Promise<T> {
    if (channel.stopping || channel.child.killed)
      return Promise.reject(new Error(`${channel.kind} unavailable`))
    const id = typeof frame.id === 'string' ? frame.id : randomUUID()
    const type = typeof frame.type === 'string' ? frame.type : 'unknown'
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => {
          channel.pending.delete(id)
          reject(new Error(`${channel.kind} ${type} timed out`))
        },
        Math.max(1, timeoutMs)
      )
      timer.unref()
      channel.pending.set(id, {
        type,
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })
      channel.child.stdin.write(encodeProtocolFrame({ ...frame, id }), (error) => {
        if (!error) return
        const pending = channel.pending.get(id)
        if (!pending) return
        channel.pending.delete(id)
        clearTimeout(pending.timer)
        pending.reject(error)
      })
    })
  }

  private runHeartbeat(): void {
    if (this.disposed) return
    const now = Date.now()
    for (const channel of [this.worker, this.supervisor]) {
      if (!channel || channel.stopping) continue
      if (now - channel.lastPongAt >= this.heartbeatTimeoutMs) {
        this.faultChannel(channel, new Error(`${channel.kind} heartbeat timed out`))
        continue
      }
      if (channel.pingPending) continue
      channel.pingPending = true
      void this.request(channel, { id: randomUUID(), type: 'ping' }, this.heartbeatTimeoutMs)
        .catch(() => undefined)
        .finally(() => {
          channel.pingPending = false
        })
    }
  }

  private faultChannel(channel: ChildChannel, error: Error): void {
    if (channel.stopping) return
    channel.stopping = true
    channel.reader.close()
    for (const pending of channel.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    channel.pending.clear()
    if (!channel.child.killed) channel.child.kill()

    if (channel.kind === 'worker' && this.worker === channel) {
      this.worker = null
      for (const record of this.terminals.values()) {
        if (record.state === 'closing' || record.state === 'exited') continue
        record.state = 'failed'
        record.rejectStarted(error)
        this.emit({ type: 'failed', terminalId: record.terminalId, message: error.message })
      }
      this.workerRecovery = this.bestEffortSupervisorRequest(
        { id: randomUUID(), type: 'terminateAll', mode: 'user' },
        USER_CLOSE_BUDGET_MS
      )
    } else if (channel.kind === 'supervisor' && this.supervisor === channel) {
      this.supervisor = null
      this.acceptingNewTerminals = false
      for (const record of this.terminals.values()) {
        if (record.state === 'closing' || record.state === 'exited') continue
        record.state = 'failed'
        record.rejectStarted(error)
        this.emit({ type: 'failed', terminalId: record.terminalId, message: error.message })
        void this.bestEffortWorkerRequest(
          { id: randomUUID(), type: 'kill', terminalId: record.terminalId },
          500
        )
      }
    }
  }

  private async stopChannel(channel: ChildChannel | null, deadline: number): Promise<void> {
    if (!channel) return
    channel.stopping = true
    channel.reader.close()
    for (const pending of channel.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new Error('Terminal host disposed'))
    }
    channel.pending.clear()
    if (channel.child.killed) return
    channel.child.stdin.end()
    channel.child.kill()
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remaining(deadline))
      timer.unref()
      channel.child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  private requireKnownTerminal(terminalId: string): TerminalRecord {
    const record = this.terminals.get(terminalId)
    if (!record) throw new Error('Unknown terminal')
    return record
  }

  private requireOpenTerminal(terminalId: string): TerminalRecord {
    const record = this.requireKnownTerminal(terminalId)
    if (record.state !== 'open') throw new Error(`Terminal is ${record.state}`)
    return record
  }

  private requireWorker(): ChildChannel {
    if (!this.worker || this.worker.stopping) throw new Error('Terminal worker is unavailable')
    return this.worker
  }

  private bestEffortWorkerRequest(
    frame: Record<string, unknown>,
    timeoutMs: number
  ): Promise<void> {
    if (!this.worker) return Promise.resolve()
    return this.request(this.worker, frame, timeoutMs).then(
      () => undefined,
      () => undefined
    )
  }

  private bestEffortSupervisorRequest(
    frame: Record<string, unknown>,
    timeoutMs: number
  ): Promise<void> {
    if (!this.supervisor) return Promise.resolve()
    return this.request(this.supervisor, frame, timeoutMs).then(
      () => undefined,
      () => undefined
    )
  }

  private emit(event: TerminalHostEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch {
        process.stderr.write('Terminal host event listener failed\n')
      }
    }
  }
}
