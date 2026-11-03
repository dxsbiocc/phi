import type { KernelEventFrame } from '../../../shared/kernel-protocol'
import { reportConnection } from '../connection-events'
import type { PhiHostRequestHandler, PhiSessionCreateParams } from './types'
import { subscribeReportingReplayGap } from './kernel-client'
import type { KernelSessionFactory } from './kernel-session-factory'
import {
  engineError,
  pendingRun,
  record,
  stringValue,
  type KernelSessionClient,
  type KernelSessionConnection,
  type KernelSessionLauncher,
  type PendingRun,
  type RunCompletion
} from './kernel-session-support'

export class KernelExecutionHost {
  private connection?: KernelSessionConnection
  private connecting?: Promise<KernelSessionConnection>
  private recovering?: Promise<void>
  private cleanup: Array<() => void> = []
  private stopped = false
  private lastSeq = 0
  private kernelInstanceId?: string
  private launchParams?: PhiSessionCreateParams
  // The connection, its model gateway and its tunnels serve every session on this host, so they
  // live until the host closes. A session's own signal only stops that session waiting.
  private readonly lifetime = new AbortController()
  private readonly runs = new Map<string, PendingRun>()
  private readonly lateHostHandlers = new Map<string, () => void>()

  constructor(
    readonly key: string,
    private readonly factory: KernelSessionFactory,
    private readonly launcher: KernelSessionLauncher
  ) {}

  async client(params: PhiSessionCreateParams, signal: AbortSignal): Promise<KernelSessionClient> {
    signal.throwIfAborted()
    if (this.connection) return this.connection.client
    return (await untilAborted(this.connect(params), signal)).client
  }

  currentConnection(): KernelSessionConnection | undefined {
    return this.connection
  }

  rebindHostHandler(method: string, handler: PhiHostRequestHandler | undefined): void {
    this.lateHostHandlers.get(method)?.()
    this.lateHostHandlers.delete(method)
    if (!handler || !this.connection) return
    this.lateHostHandlers.set(
      method,
      this.factory.bindHostHandler(this.connection.client, method, handler, this.key)
    )
  }

  waitForRun(runId: string): Promise<RunCompletion> {
    let run = this.runs.get(runId)
    if (!run) {
      run = pendingRun()
      this.runs.set(runId, run)
    }
    return run.promise.finally(() => this.runs.delete(runId))
  }

  settleRunFromSnapshot(value: unknown): void {
    const lastRun = record(record(value)?.lastRun)
    const runId = stringValue(lastRun?.runId)
    const status = stringValue(lastRun?.status) as RunCompletion['status'] | undefined
    if (!runId || !status || !['completed', 'failed', 'cancelled', 'unknown'].includes(status)) {
      return
    }
    this.runs.get(runId)?.resolve({ status })
  }

  isCurrent(client: KernelSessionClient): boolean {
    return this.connection?.client === client
  }

  async close(): Promise<void> {
    this.stopped = true
    this.lifetime.abort(new Error('Kernel execution host closed'))
    const connection = this.connection
    if (connection)
      reportConnection({
        layer: 'kernel',
        change: 'closed',
        target: this.key,
        reason: 'app_closed'
      })
    this.clearConnection()
    await connection?.close().catch(() => undefined)
  }

  private connect(params: PhiSessionCreateParams): Promise<KernelSessionConnection> {
    if (this.connection) return Promise.resolve(this.connection)
    if (this.connecting) return this.connecting
    this.launchParams = structuredClone(params)
    const configured = new WeakSet<object>()
    const configureClient = (client: KernelSessionClient): void => {
      if (configured.has(client as object)) return
      configured.add(client as object)
      this.cleanup.push(
        this.factory.configureClient(client, this.key),
        client.onEvent((event) => this.onEvent(event)),
        client.onClose(() => this.onClose(client))
      )
    }
    this.connecting = this.launcher(
      params,
      {
        hostCapabilities: this.factory.hostCapabilityNames(),
        afterSeq: this.lastSeq,
        configureClient
      },
      this.lifetime.signal
    )
      .then(async (connection) => {
        configureClient(connection.client)
        this.factory.assertConnectionIdentity(params, connection)
        this.connection = connection
        reportConnection({ layer: 'kernel', change: 'opened', target: this.key })
        const replayFrom =
          this.kernelInstanceId === connection.greeting.kernelInstanceId ? this.lastSeq : 0
        if (replayFrom === 0) this.lastSeq = 0
        this.kernelInstanceId = connection.greeting.kernelInstanceId
        // reopenHostSessions below rebuilds every session from a snapshot, which covers a gap.
        await subscribeReportingReplayGap(connection.client, replayFrom)
        await this.factory.reopenHostSessions(this, connection.client)
        return connection
      })
      .catch((error) => {
        this.clearConnection()
        throw engineError(error)
      })
      .finally(() => {
        this.connecting = undefined
      })
    return this.connecting
  }

  private clearConnection(): void {
    for (const remove of this.lateHostHandlers.values()) remove()
    this.lateHostHandlers.clear()
    for (const dispose of this.cleanup.splice(0)) dispose()
    this.connection = undefined
  }

  private onClose(client: KernelSessionClient): void {
    if (!this.isCurrent(client)) return
    reportConnection({ layer: 'kernel', change: 'closed', target: this.key, reason: 'lost' })
    this.clearConnection()
    if (this.stopped || !this.launchParams || !this.factory.hasLiveSessions(this.key)) return
    this.recovering ??= this.connect(this.launchParams)
      .then(() => undefined)
      .catch((error) => this.factory.interruptHost(this.key, engineError(error)))
      .finally(() => {
        this.recovering = undefined
      })
  }

  private onEvent(event: KernelEventFrame): void {
    this.lastSeq = Math.max(this.lastSeq, event.seq)
    const payload = record(event.payload)
    if (event.type === 'run.completed' && payload) {
      const runId = stringValue(payload.runId) ?? event.runId
      const status = stringValue(payload.status) as RunCompletion['status'] | undefined
      if (runId && status && ['completed', 'failed', 'cancelled', 'unknown'].includes(status)) {
        let run = this.runs.get(runId)
        if (!run) {
          run = pendingRun()
          this.runs.set(runId, run)
        }
        const detail = stringValue(payload.detail)
        run.resolve({ status, ...(detail ? { detail } : {}) })
      }
    }
    this.factory.projectEvent(this, event, payload)
  }
}

function untilAborted<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let stop!: () => void
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      stop = () => reject(signal.reason)
      signal.addEventListener('abort', stop, { once: true })
    })
  ]).finally(() => signal.removeEventListener('abort', stop))
}
