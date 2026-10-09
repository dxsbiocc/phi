import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { writeAppLog } from '../app-logger'
import { getPhiAgentDir } from '../runtime-paths'
import { resolveBunExecutable, workerPathWithBun } from './bun-executable'
import { resolveWorkerProxyEnv } from './worker-proxy-env'

type PendingRequest = {
  method: string
  params?: unknown
  resolve: (value: unknown) => void
  reject: (error: Error) => void
}

type BridgeResponse =
  | {
      id: string
      ok: true
      result?: unknown
    }
  | {
      id: string
      ok: false
      error: string
      stack?: string
    }

type BridgeEvent = {
  type: 'event'
  event: string
  sessionId?: string
  requestId?: string
  payload?: unknown
}

type BridgeHostRequest = {
  type: 'hostRequest'
  id: string
  method: string
  params?: unknown
  context?: unknown
}

type BridgeHostResponse =
  | {
      type: 'hostResponse'
      id: string
      ok: true
      result?: unknown
    }
  | {
      type: 'hostResponse'
      id: string
      ok: false
      error: string
      stack?: string
    }

export interface HostRequestContext {
  readonly originSessionId?: string
  readonly agentRunId?: string
  readonly toolCallId?: string
}

type HostRequestHandler = (
  params: unknown,
  context: HostRequestContext
) => unknown | Promise<unknown>

const MAX_HOST_CONTEXT_ID_LENGTH = 512

function isBridgeResponse(value: unknown): value is BridgeResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    'ok' in value &&
    typeof (value as { id?: unknown }).id === 'string'
  )
}

function isBridgeEvent(value: unknown): value is BridgeEvent {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'event' &&
    typeof (value as { event?: unknown }).event === 'string'
  )
}

function isBridgeHostRequest(value: unknown): value is BridgeHostRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'hostRequest' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { method?: unknown }).method === 'string'
  )
}

function hostRequestContext(value: unknown): HostRequestContext {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const context = value as Record<string, unknown>
  const originSessionId = boundedContextId(context.originSessionId)
  const agentRunId = boundedContextId(context.agentRunId)
  const toolCallId = boundedContextId(context.toolCallId)
  return {
    ...(originSessionId ? { originSessionId } : {}),
    ...(agentRunId ? { agentRunId } : {}),
    ...(toolCallId ? { toolCallId } : {})
  }
}

function boundedContextId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_HOST_CONTEXT_ID_LENGTH
    ? value
    : undefined
}

function asarUnpackedPath(path: string): string {
  return path.includes('.asar/') ? path.replace('.asar/', '.asar.unpacked/') : path
}

function resolveWorkerPath(): string {
  const explicit = process.env.PHI_OMP_WORKER_PATH
  if (explicit) return explicit

  const sourcePath = resolve(process.cwd(), 'src/main/agent/omp/omp-sdk-worker.ts')
  if (existsSync(sourcePath)) return sourcePath

  const bundleDir = dirname(fileURLToPath(import.meta.url))
  const candidates = [
    join(bundleDir, 'agent', 'omp', 'omp-sdk-worker.ts'),
    join(bundleDir, 'omp', 'omp-sdk-worker.ts')
  ]
  for (const candidate of candidates) {
    // Unpacked first: Electron's fs reports in-asar paths as existing, but the
    // worker runs under bun, which cannot read inside app.asar.
    const unpacked = asarUnpackedPath(candidate)
    if (existsSync(unpacked)) return unpacked
    if (existsSync(candidate)) return candidate
  }

  return candidates[0]
}

function createBridgeError(message: string, stack?: string): Error {
  const error = new Error(message)
  if (stack) error.stack = stack
  return error
}

export type WorkerSpawner = (workerPath: string, agentDir: string) => ChildProcessWithoutNullStreams

function spawnBunWorker(workerPath: string, agentDir: string): ChildProcessWithoutNullStreams {
  const resourcesPath = process.resourcesPath
  const bunPath = resolveBunExecutable({
    resourcesPath: typeof resourcesPath === 'string' ? resourcesPath : undefined
  })
  return spawn(bunPath, [workerPath], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      ...resolveWorkerProxyEnv(process.env),
      PATH: workerPathWithBun(bunPath, process.env.PATH),
      PI_CODING_AGENT_DIR: agentDir,
      OMP_APP_NAME: 'Phi'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

export class OmpBridge extends EventEmitter {
  private child: ChildProcessWithoutNullStreams | null = null
  // Workers we stopped on purpose, so their exit is not reported as a crash.
  private readonly stoppedChildren = new WeakSet<ChildProcessWithoutNullStreams>()
  private readonly pending = new Map<string, PendingRequest>()
  private readonly hostHandlers = new Map<string, HostRequestHandler>()
  private readonly activeSessions = new Set<string>()
  private idleTimer: NodeJS.Timeout | null = null
  private stderrTail = ''

  constructor(private readonly spawnWorker: WorkerSpawner = spawnBunWorker) {
    super()
  }

  /**
   * Whether the running worker still holds this session. Sessions live only in the
   * worker's memory, so a worker that exited (crash, idle stop) has lost all of them.
   */
  hasSession(sessionId: string): boolean {
    return this.activeSessions.has(sessionId)
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.cancelIdleStop()
    let child: ChildProcessWithoutNullStreams
    try {
      child = this.ensureStarted()
    } catch (error) {
      // e.g. bun is not installed: surface it as a failed request, not a throw.
      return Promise.reject(error)
    }
    const id = randomUUID()

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        method,
        params,
        resolve: (value) => resolve(value as T),
        reject
      })
    })

    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`)
    return promise
  }

  registerHostHandler(method: string, handler: HostRequestHandler): () => void {
    this.hostHandlers.set(method, handler)
    return () => {
      if (this.hostHandlers.get(method) === handler) {
        this.hostHandlers.delete(method)
      }
    }
  }

  onSessionEvent(sessionId: string, listener: (event: unknown) => void): () => void {
    const eventName = `session:${sessionId}:event`
    this.on(eventName, listener)
    return () => this.off(eventName, listener)
  }

  onSessionState(sessionId: string, listener: (state: unknown) => void): () => void {
    const eventName = `session:${sessionId}:state`
    this.on(eventName, listener)
    return () => this.off(eventName, listener)
  }

  onSessionToolApproval(sessionId: string, listener: (request: unknown) => void): () => void {
    const eventName = `session:${sessionId}:toolApproval`
    this.on(eventName, listener)
    return () => this.off(eventName, listener)
  }

  onAuthPrompt(
    listener: (request: { requestId: string; providerId: string; prompt: unknown }) => void
  ): () => void {
    this.on('auth:prompt', listener)
    return () => this.off('auth:prompt', listener)
  }

  onAuthNotify(listener: (request: { providerId: string; event: unknown }) => void): () => void {
    this.on('auth:notify', listener)
    return () => this.off('auth:notify', listener)
  }

  async sendToolApprovalResult(requestId: string, result: unknown): Promise<void> {
    await this.request('toolApproval.result', {
      requestId,
      result: result ?? null
    })
  }

  async sendAuthPromptResult(requestId: string, value: string): Promise<void> {
    await this.request('auth.promptResult', {
      requestId,
      value
    })
  }

  async sendAuthPromptError(requestId: string, error: unknown): Promise<void> {
    await this.request('auth.promptResult', {
      requestId,
      error: error instanceof Error ? error.message : String(error)
    })
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    this.cancelIdleStop()
    if (!child) return

    this.stoppedChildren.add(child)
    child.kill()
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve())
      setTimeout(resolve, 1500).unref()
    })
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && !this.child.killed) {
      return this.child
    }

    const workerPath = resolveWorkerPath()
    const agentDir = getPhiAgentDir()
    this.stderrTail = ''
    const child = this.spawnWorker(workerPath, agentDir)
    this.child = child

    const stdout = createInterface({ input: child.stdout })
    stdout.on('line', (line) => this.handleLine(line))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      this.stderrTail = `${this.stderrTail}${chunk}`.slice(-8000)
    })

    child.on('error', (error) => {
      this.rejectAll(error)
    })

    child.on('exit', (code, signal) => {
      // A worker we replaced can exit after its successor started (stop() then a new
      // request). It must not wipe the successor's sessions or fail its requests.
      const superseded = this.child !== null && this.child !== child
      const reason = `${signal ?? code ?? 'unknown'}`
      if (!this.stoppedChildren.has(child)) {
        writeAppLog({
          level: 'error',
          event: 'omp_worker_exited',
          metadata: {
            reason,
            lostSessions: superseded ? 0 : this.activeSessions.size,
            stderrTail: this.stderrTail.slice(-2000)
          }
        })
      }
      if (superseded) return
      if (this.child === child) {
        this.child = null
      }
      this.activeSessions.clear()
      this.rejectAll(
        createBridgeError(
          `OMP worker exited (${reason})${this.stderrTail ? `: ${this.stderrTail}` : ''}`
        )
      )
    })

    return child
  }

  private handleLine(line: string): void {
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      this.stderrTail = `${this.stderrTail}${line}\n`.slice(-8000)
      return
    }

    if (isBridgeHostRequest(message)) {
      void this.handleHostRequest(message)
      return
    }

    if (isBridgeResponse(message)) {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)

      if (message.ok) {
        this.recordSuccessfulRequest(pending, message.result)
        pending.resolve(message.result)
      } else {
        pending.reject(createBridgeError(message.error, message.stack))
      }
      this.scheduleIdleStop()
      return
    }

    if (!isBridgeEvent(message)) return

    if (message.event === 'sessionEvent' && message.sessionId) {
      this.emit(`session:${message.sessionId}:event`, message.payload)
    } else if (message.event === 'sessionState' && message.sessionId) {
      this.emit(`session:${message.sessionId}:state`, message.payload)
    } else if (message.event === 'toolApproval' && message.sessionId) {
      this.emit(`session:${message.sessionId}:toolApproval`, message.payload)
    } else if (
      message.event === 'authPrompt' &&
      message.requestId &&
      typeof message.payload === 'object' &&
      message.payload !== null
    ) {
      const payload = message.payload as { providerId?: unknown; prompt?: unknown }
      this.emit('auth:prompt', {
        requestId: message.requestId,
        providerId: typeof payload.providerId === 'string' ? payload.providerId : '',
        prompt: payload.prompt
      })
    } else if (
      message.event === 'authNotify' &&
      typeof message.payload === 'object' &&
      message.payload !== null
    ) {
      const payload = message.payload as { providerId?: unknown; event?: unknown }
      this.emit('auth:notify', {
        providerId: typeof payload.providerId === 'string' ? payload.providerId : '',
        event: payload.event
      })
    }
  }

  private async handleHostRequest(request: BridgeHostRequest): Promise<void> {
    const child = this.child
    if (!child || child.killed) return
    const respond = (payload: BridgeHostResponse): void => {
      child.stdin.write(`${JSON.stringify(payload)}\n`)
    }
    try {
      const handler = this.hostHandlers.get(request.method)
      if (!handler) {
        throw new Error(`Unknown host request method: ${request.method}`)
      }
      const result = await handler(request.params, hostRequestContext(request.context))
      respond({ type: 'hostResponse', id: request.id, ok: true, result })
    } catch (error) {
      respond({
        type: 'hostResponse',
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      })
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      pending.reject(error)
    }
    this.pending.clear()
  }

  private recordSuccessfulRequest(pending: PendingRequest, result: unknown): void {
    if (pending.method === 'session.create' && typeof result === 'object' && result !== null) {
      const sessionId = (result as { sessionId?: unknown }).sessionId
      if (typeof sessionId === 'string') {
        this.activeSessions.add(sessionId)
      }
      return
    }

    if (
      pending.method === 'session.dispose' &&
      typeof pending.params === 'object' &&
      pending.params
    ) {
      const sessionId = (pending.params as { sessionId?: unknown }).sessionId
      if (typeof sessionId === 'string') {
        this.activeSessions.delete(sessionId)
      }
    }
  }

  private scheduleIdleStop(): void {
    if (this.pending.size > 0 || this.activeSessions.size > 0 || !this.child) return
    this.cancelIdleStop()
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      void this.stop()
    }, 2000)
  }

  private cancelIdleStop(): void {
    if (!this.idleTimer) return
    clearTimeout(this.idleTimer)
    this.idleTimer = null
  }
}

let bridge: OmpBridge | null = null

export function getOmpBridge(): OmpBridge {
  bridge ??= new OmpBridge()
  return bridge
}
