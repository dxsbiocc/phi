import { randomBytes, randomInt } from 'node:crypto'

import { shellQuote, type RemoteConnectionConfig } from '../wrappers/remote-ssh-session'
import {
  buildSshPortForwardArgs,
  type SshPortForwardSpawn
} from '../workspace-host/ssh-port-forward'
import {
  defaultRemoteJupyterReadyProbe,
  openRemoteJupyterLease,
  pauseForRemoteJupyter,
  sanitizedRemoteJupyterError,
  sanitizeRemoteJupyterText,
  RemoteJupyterCleanupUnconfirmedError,
  type OpenRemoteJupyterLeaseOptions,
  type RemoteJupyterLease
} from './remote-jupyter-lease'
import {
  RemoteJupyterResourceGate,
  buildRemoteJupyterResourceLaunchLines,
  parseRemoteJupyterResourceMarker,
  type RemoteJupyterResourceEvent,
  type RemoteJupyterResourcePolicyInput,
  type RemoteJupyterResourceStatus
} from './remote-jupyter-resource-guard'
import {
  assertRemoteJupyterLaunchInput,
  buildRemoteJupyterCleanupFunctionLines,
  buildRemoteJupyterLeaseSetupLines,
  buildRemoteJupyterLeaseWriteLines,
  reconcileRemoteJupyterLease,
  remoteJupyterLeaseEnvironment,
  remoteJupyterLeaseIdentity,
  remoteJupyterOwnedCommand,
  remoteJupyterSecurityArgs,
  RemoteJupyterReconciliationError,
  type ReconcileRemoteJupyterLeaseOptions,
  type RemoteJupyterLeaseIdentity
} from './remote-jupyter-reconcile'

export type RemoteJupyterServerState =
  | 'stopped'
  | 'preparing_environment'
  | 'allocating_ports'
  | 'starting_lease'
  | 'probing_through_tunnel'
  | 'ready'
  | 'stopping'
  | 'disconnected'
  | 'cleaning'
  | 'reconciling'
  | 'error'

export interface RemoteJupyterServerStatus {
  state: RemoteJupyterServerState
  localPort?: number
  remotePort?: number
  message?: string
  cleanupUnconfirmed?: boolean
  canAbandonCleanup?: boolean
  resources: RemoteJupyterResourceStatus
}

export interface RemoteJupyterLaunchCommand {
  command: string
  args?: string[]
  cwd?: string
  env?: Record<string, string>
}

export interface RemoteJupyterConnection {
  readonly baseUrl: string
  authorizationHeader(): string
}

export type RemoteJupyterReadyProbe = (
  url: string,
  authorization: string,
  signal?: AbortSignal
) => Promise<boolean>

export interface RemoteJupyterSupervisorOptions {
  connection: RemoteConnectionConfig
  launch: RemoteJupyterLaunchCommand
  spawnImpl?: SshPortForwardSpawn
  openLease?: (options: OpenRemoteJupyterLeaseOptions) => Promise<RemoteJupyterLease>
  reconcileLease?: (options: ReconcileRemoteJupyterLeaseOptions) => Promise<unknown>
  selectRemotePort?: () => number
  readyProbe?: RemoteJupyterReadyProbe
  maxStartAttempts?: number
  startupTimeoutMs?: number
  probeIntervalMs?: number
  shutdownGraceMs?: number
  resourcePolicy?: RemoteJupyterResourcePolicyInput
  onLog?: (line: string) => void
  onStateChange?: (status: RemoteJupyterServerStatus) => void
}

export function buildRemoteJupyterSshArgs(
  config: RemoteConnectionConfig,
  localPort: number,
  remotePort: number,
  launchScript: string
): string[] {
  return buildSshPortForwardArgs(config, localPort, remotePort, launchScript)
}

export function buildRemoteJupyterLaunchScript(
  launch: RemoteJupyterLaunchCommand,
  remotePort: number,
  cleanupMarker: string,
  shutdownGraceMs = 500,
  resourcePolicy: RemoteJupyterResourcePolicyInput = {}
): string {
  assertRemoteJupyterLaunchInput(launch.command, remotePort, cleanupMarker)
  const command = [launch.command, ...(launch.args ?? []), ...remoteJupyterSecurityArgs(remotePort)]
    .map(shellQuote)
    .join(' ')
  const environment = remoteJupyterEnvironment(launch.env)
  const graceSeconds = Math.max(0, shutdownGraceMs) / 1_000
  const startedMarker = cleanupMarker.replace('CLEANED', 'STARTED')
  const leaseIdentity = remoteJupyterLeaseIdentity(launch.env?.JUPYTER_RUNTIME_DIR, cleanupMarker)
  const leaseEnvironment = remoteJupyterLeaseEnvironment(leaseIdentity)
  const ownedCommand = remoteJupyterOwnedCommand(command, leaseIdentity)
  return [
    launch.cwd ? `cd ${shellQuote(launch.cwd)} || exit 72` : ':',
    'exec 3<&0',
    'pid=',
    'resource_watcher=',
    'cleaned=0',
    ...buildRemoteJupyterLeaseSetupLines(leaseIdentity),
    ...buildRemoteJupyterCleanupFunctionLines(cleanupMarker, graceSeconds, leaseIdentity),
    "trap 'terminate_tree; exit 73' HUP TERM INT",
    "trap 'terminate_tree' EXIT",
    'IFS= read -r PHI_JUPYTER_TOKEN <&3 || exit 70',
    'test "${#PHI_JUPYTER_TOKEN}" -ge 43 || exit 71',
    'lease_shell=$$',
    ...buildRemoteJupyterResourceLaunchLines(
      ownedCommand,
      resourcePolicy,
      `${environment}${leaseEnvironment}JUPYTER_TOKEN="$PHI_JUPYTER_TOKEN" `
    ),
    ...buildRemoteJupyterLeaseWriteLines(leaseIdentity),
    'unset PHI_JUPYTER_TOKEN',
    `printf '\\n%s\\n' ${shellQuote(startedMarker)}`,
    '( trap \'\' HUP; cat <&3 >/dev/null; kill -TERM "$lease_shell" 2>/dev/null || true ) &',
    'watcher=$!',
    'wait "$pid"',
    'status=$?',
    'kill "$watcher" 2>/dev/null || true',
    'wait "$watcher" 2>/dev/null || true',
    'terminate_tree',
    'exit "$status"'
  ].join('\n')
}

function remoteJupyterEnvironment(env: Record<string, string> | undefined): string {
  if (!env) return ''
  const allowed = new Set([
    'IPYTHONDIR',
    'JUPYTER_CONFIG_DIR',
    'JUPYTER_DATA_DIR',
    'JUPYTER_PATH',
    'JUPYTER_RUNTIME_DIR',
    'PYTHONNOUSERSITE'
  ])
  return Object.entries(env)
    .map(([key, value]) => {
      if (!allowed.has(key) || /[\r\n\0]/.test(value)) {
        throw new Error('远程 Jupyter 环境变量无效')
      }
      return `${key}=${shellQuote(value)} `
    })
    .join('')
}

export class RemoteJupyterServerSupervisor {
  readonly options: RemoteJupyterSupervisorOptions
  #token?: string
  private currentStatus: Omit<RemoteJupyterServerStatus, 'resources'> = { state: 'stopped' }
  private readonly resourceGate: RemoteJupyterResourceGate
  private remoteLease?: RemoteJupyterLease
  private remoteLeaseIdentity?: RemoteJupyterLeaseIdentity
  private pendingReconciliation?: RemoteJupyterLeaseIdentity
  private generation = 0
  private restartBlocked = false
  private reconciliationUnavailable = false
  private starting?: Promise<RemoteJupyterConnection>
  private stopping?: Promise<void>
  private reconciling?: Promise<void>
  private cleaning?: Promise<boolean>
  private lifecycleAbort?: AbortController

  constructor(options: RemoteJupyterSupervisorOptions) {
    this.options = options
    this.resourceGate = new RemoteJupyterResourceGate(options.resourcePolicy, {
      onIdle: () => this.stop(),
      onError: (error) => this.options.onLog?.(sanitizedRemoteJupyterError(error).message)
    })
  }

  status(): RemoteJupyterServerStatus {
    const resources = this.resourceGate.resourceStatus()
    const resourceMessage = resourceEventMessage(resources.violation ?? resources.warning)
    return {
      ...this.currentStatus,
      ...(this.restartBlocked ? { cleanupUnconfirmed: true } : {}),
      ...(this.restartBlocked && this.reconciliationUnavailable ? { canAbandonCleanup: true } : {}),
      ...(!this.currentStatus.message && resourceMessage ? { message: resourceMessage } : {}),
      resources
    }
  }

  claimKernel(owner: string): void {
    this.requireReady()
    this.resourceGate.claimKernel(owner)
  }

  releaseKernel(owner: string): void {
    this.resourceGate.releaseKernel(owner)
  }

  touchActivity(): void {
    if (this.currentStatus.state === 'ready') this.resourceGate.touchActivity()
  }

  cellTimeoutMs(): number {
    return this.resourceGate.cellTimeoutMs()
  }

  start(signal?: AbortSignal): Promise<RemoteJupyterConnection> {
    if (this.currentStatus.state === 'ready') return Promise.resolve(this.connection())
    if (this.starting) return this.starting
    if (
      this.stopping ||
      (!this.restartBlocked && !['stopped', 'error'].includes(this.currentStatus.state))
    ) {
      return Promise.reject(new Error('远程 Jupyter 正在清理，暂不能重新启动'))
    }
    this.lifecycleAbort = new AbortController()
    const combined = signal
      ? AbortSignal.any([signal, this.lifecycleAbort.signal])
      : this.lifecycleAbort.signal
    this.starting = this.startAfterReconciliation(combined).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  stop(options: { abandonUnconfirmed?: boolean } = {}): Promise<void> {
    if (this.stopping) return this.stopping
    const sharedReconciliation = this.reconciling
    this.lifecycleAbort?.abort()
    this.stopping = this.finishStop(
      sharedReconciliation,
      options.abandonUnconfirmed === true
    ).finally(() => {
      this.stopping = undefined
    })
    return this.stopping
  }

  reconcile(): Promise<void> {
    if (!this.restartBlocked) return Promise.resolve()
    if (this.reconciling) return this.reconciling
    this.reconciling = this.performReconciliation().finally(() => {
      this.reconciling = undefined
    })
    return this.reconciling
  }

  private async startAfterReconciliation(signal: AbortSignal): Promise<RemoteJupyterConnection> {
    await this.reconcile()
    throwIfAborted(signal)
    this.resourceGate.reset()
    return this.startLoop(signal)
  }

  private async finishStop(shared: Promise<void> | undefined, abandon: boolean): Promise<void> {
    if (this.currentStatus.state === 'ready') this.transition('stopping')
    await this.starting?.catch(() => undefined)
    if (this.restartBlocked) {
      await this.finishPendingStop(shared, abandon)
      return
    }
    if (this.currentStatus.state === 'stopped') return
    if (this.currentStatus.state !== 'stopping') this.transition('stopping')
    this.finishCleanupState(await this.beginCleanup())
    if (this.restartBlocked) await this.finishPendingStop(undefined, abandon)
  }

  private async finishPendingStop(
    shared: Promise<void> | undefined,
    abandon: boolean
  ): Promise<void> {
    try {
      await (shared ?? this.reconcile())
    } catch {
      if (abandon) this.abandonUnconfirmedCleanup()
    }
  }

  private async startLoop(signal: AbortSignal): Promise<RemoteJupyterConnection> {
    const attempts = positiveInteger(this.options.maxStartAttempts ?? 3)
    const usedPorts = new Set<number>()
    this.transition('preparing_environment')
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      throwIfAborted(signal)
      this.#token = randomBytes(32).toString('base64url')
      const remotePort = this.nextRemotePort(usedPorts)
      try {
        return await this.startAttempt(remotePort, signal)
      } catch (error) {
        if (error instanceof RemoteJupyterCleanupUnconfirmedError) this.restartBlocked = true
        const sanitized = sanitizedRemoteJupyterError(error, this.#token)
        const confirmed = await this.beginCleanup()
        if (!confirmed) {
          const message = '旧远程 Jupyter lease 清理尚未确认，禁止重新启动'
          this.transition('error', message)
          throw new Error(message, { cause: sanitized })
        }
        if (signal.aborted) {
          this.transition('stopped')
          throw new Error('远程 Jupyter 启动已取消')
        }
        if (attempt === attempts) {
          const message = `远程 Jupyter 在 ${attempts} 次尝试后仍未就绪`
          this.transition('error', message)
          throw new Error(message, { cause: sanitized })
        }
      }
    }
    throw new Error('远程 Jupyter 未启动')
  }

  private async startAttempt(
    remotePort: number,
    signal: AbortSignal
  ): Promise<RemoteJupyterConnection> {
    this.transition('allocating_ports', undefined, remotePort)
    this.transition('starting_lease', undefined, remotePort)
    const token = this.#token
    if (!token) throw new Error('远程 Jupyter token 尚未生成')
    const cleanupMarker = `__PHI_JUPYTER_CLEANED_${randomBytes(16).toString('hex')}__`
    this.remoteLeaseIdentity = remoteJupyterLeaseIdentity(
      this.options.launch.env?.JUPYTER_RUNTIME_DIR,
      cleanupMarker
    )
    const launchScript = buildRemoteJupyterLaunchScript(
      this.options.launch,
      remotePort,
      cleanupMarker,
      this.options.shutdownGraceMs,
      this.options.resourcePolicy
    )
    const openLease = this.options.openLease ?? openRemoteJupyterLease
    this.remoteLease = await openLease({
      connection: this.options.connection,
      remotePort,
      token,
      cleanupMarker,
      launchScript,
      signal,
      spawnImpl: this.options.spawnImpl,
      shutdownGraceMs: this.options.shutdownGraceMs,
      onLog: (line) => this.handleLeaseLog(line)
    })
    this.transition('probing_through_tunnel', undefined, remotePort, this.remoteLease.localPort)
    await this.probeUntilReady(this.remoteLease.localPort, signal)
    this.transition('ready', undefined, remotePort, this.remoteLease.localPort)
    this.resourceGate.touchActivity()
    this.restartBlocked = false
    this.pendingReconciliation = undefined
    this.reconciliationUnavailable = false
    const generation = ++this.generation
    this.watchForDisconnect(generation, this.remoteLease)
    return this.connection()
  }

  private async probeUntilReady(localPort: number, signal: AbortSignal): Promise<void> {
    const probe = this.options.readyProbe ?? defaultRemoteJupyterReadyProbe
    const timeoutMs = this.options.startupTimeoutMs ?? 10_000
    const intervalMs = this.options.probeIntervalMs ?? 100
    const deadline = Date.now() + timeoutMs
    const url = `http://127.0.0.1:${localPort}/`
    while (Date.now() < deadline) {
      throwIfAborted(signal)
      if (this.remoteLease?.isClosed()) throw new Error('远程 Jupyter 进程提前退出')
      if (await probe(url, this.authorizationHeader(), signal)) return
      await pauseForRemoteJupyter(Math.min(intervalMs, Math.max(1, deadline - Date.now())), signal)
    }
    throw new Error('远程 Jupyter 就绪探测超时')
  }

  private nextRemotePort(used: Set<number>): number {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const port = (this.options.selectRemotePort ?? (() => randomInt(49_152, 65_536)))()
      assertPort(port)
      if (!used.has(port)) {
        used.add(port)
        return port
      }
    }
    throw new Error('无法分配不重复的远端随机端口')
  }

  private connection(): RemoteJupyterConnection {
    const generation = this.generation
    const baseUrl = `http://127.0.0.1:${this.currentStatus.localPort}/`
    return {
      baseUrl,
      authorizationHeader: () => {
        if (this.currentStatus.state !== 'ready' || generation !== this.generation) {
          throw new Error('远程 Jupyter 连接已失效')
        }
        return this.authorizationHeader()
      }
    }
  }

  private authorizationHeader(): string {
    if (!this.#token) throw new Error('远程 Jupyter token 不可用')
    return `token ${this.#token}`
  }

  private watchForDisconnect(generation: number, lease: RemoteJupyterLease): void {
    void lease.closed.then(() => this.handleDisconnect(generation))
  }

  private async handleDisconnect(generation: number): Promise<void> {
    if (generation !== this.generation || this.currentStatus.state !== 'ready') return
    const lease = this.takeLease()
    this.transition('disconnected', '远程 Jupyter SSH lease 已断开')
    this.finishCleanupState(await this.beginCleanup(lease))
  }

  private takeLease(): {
    lease?: RemoteJupyterLease
    identity?: RemoteJupyterLeaseIdentity
  } {
    const lease = this.remoteLease
    const identity = this.remoteLeaseIdentity
    this.remoteLease = undefined
    this.remoteLeaseIdentity = undefined
    this.generation += 1
    return { ...(lease ? { lease } : {}), ...(identity ? { identity } : {}) }
  }

  private async cleanup(detachedLease?: {
    lease?: RemoteJupyterLease
    identity?: RemoteJupyterLeaseIdentity
  }): Promise<boolean> {
    const owned = detachedLease ?? this.takeLease()
    const lease = owned.lease
    this.transition('cleaning')
    await lease?.close().catch(() => undefined)
    const confirmed = lease ? lease.cleanupConfirmed() : !this.restartBlocked
    if (!confirmed) {
      this.restartBlocked = true
      this.pendingReconciliation ??= owned.identity
    }
    this.#token = undefined
    this.resourceGate.dispose()
    return confirmed
  }

  private beginCleanup(detachedLease?: {
    lease?: RemoteJupyterLease
    identity?: RemoteJupyterLeaseIdentity
  }): Promise<boolean> {
    if (this.cleaning) return this.cleaning
    const cleaning = this.cleanup(detachedLease).finally(() => {
      if (this.cleaning === cleaning) this.cleaning = undefined
    })
    this.cleaning = cleaning
    return cleaning
  }

  private finishCleanupState(confirmed: boolean): void {
    if (confirmed) {
      this.transition('stopped')
      return
    }
    this.transition('error', '旧远程 Jupyter lease 清理尚未确认，禁止重新启动')
  }

  private async performReconciliation(): Promise<void> {
    const identity = this.pendingReconciliation
    this.transition('reconciling', '正在通过新的 SSH 连接确认旧 Jupyter 是否已退出')
    try {
      if (!identity) throw new Error('缺少旧 lease 身份记录')
      const reconcileLease = this.options.reconcileLease ?? reconcileRemoteJupyterLease
      await reconcileLease({
        connection: this.options.connection,
        identity,
        shutdownGraceMs: this.options.shutdownGraceMs,
        spawnImpl: this.options.spawnImpl
      })
      this.pendingReconciliation = undefined
      this.restartBlocked = false
      this.reconciliationUnavailable = false
      this.transition('stopped', '已确认旧 Jupyter 已退出，可以重新启动')
    } catch (error) {
      const unavailable =
        !(error instanceof RemoteJupyterReconciliationError) || error.reason === 'unavailable'
      this.reconciliationUnavailable = unavailable
      const message = unavailable
        ? '服务器暂时连不上，无法确认旧 Jupyter 已退出；网络恢复后再试。旧 lease 清理尚未确认。'
        : '旧 Jupyter 的 lease 身份记录无法安全核验；清理尚未确认，已禁止重新启动。'
      this.transition('error', message)
      throw new Error(message, { cause: sanitizedRemoteJupyterError(error) })
    }
  }

  private abandonUnconfirmedCleanup(): void {
    if (!this.restartBlocked || !this.reconciliationUnavailable) return
    this.reconciliationUnavailable = false
    this.#token = undefined
    this.resourceGate.dispose()
    this.transition('stopped', '已放弃本地 runtime 状态；服务器侧旧 Jupyter 退出未确认')
  }

  private handleLeaseLog(line: string): void {
    const event = parseRemoteJupyterResourceMarker(line)
    if (event) {
      this.resourceGate.reportResourceEvent(event)
      const message = resourceEventMessage(event)
      if (message) {
        this.currentStatus = { ...this.currentStatus, message }
        this.notifyStatus()
      }
    }
    this.options.onLog?.(line)
  }

  private requireReady(): void {
    if (this.currentStatus.state !== 'ready') {
      throw new Error('远程 Jupyter 尚未就绪，不能启动 kernel')
    }
  }

  private transition(
    state: RemoteJupyterServerState,
    message?: string,
    remotePort?: number,
    localPort?: number
  ): void {
    this.currentStatus = {
      state,
      ...(remotePort === undefined ? {} : { remotePort }),
      ...(localPort === undefined ? {} : { localPort }),
      ...(message ? { message: sanitizeRemoteJupyterText(message, this.#token) } : {})
    }
    this.notifyStatus()
  }

  private notifyStatus(): void {
    try {
      this.options.onStateChange?.(this.status())
    } catch {
      // Lifecycle cleanup must not be interruptible by an observer.
    }
  }
}

function resourceEventMessage(event?: RemoteJupyterResourceEvent): string | undefined {
  if (!event) return undefined
  if (event.type === 'warning' && event.code === 'hard_limit_unavailable') {
    return '服务器无法施加 Jupyter 硬资源限额，已降级为 supervisor 监控'
  }
  if (event.type === 'warning') return '服务器资源监控不可用，Jupyter 将安全停止'
  if (event.type !== 'violation') return undefined
  if (event.code === 'hard_limit_required') return '站点要求硬资源限额，但服务器无法施加'
  if (event.code === 'monitor_unavailable') return '服务器资源监控不可用，Jupyter 正在停止'
  const label = event.code === 'rss' ? 'RSS' : event.code === 'cpu' ? 'CPU' : '线程数'
  return `远程 Jupyter ${label} 超过上限，正在停止`
}

function positiveInteger(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error('远程 Jupyter 重试次数必须是正整数')
  return value
}

function assertPort(port: number): void {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('远程 Jupyter 端口无效')
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('远程 Jupyter 操作已取消')
}
