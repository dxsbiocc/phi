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
  | 'error'

export interface RemoteJupyterServerStatus {
  state: RemoteJupyterServerState
  localPort?: number
  remotePort?: number
  message?: string
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
  selectRemotePort?: () => number
  readyProbe?: RemoteJupyterReadyProbe
  maxStartAttempts?: number
  startupTimeoutMs?: number
  probeIntervalMs?: number
  shutdownGraceMs?: number
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
  shutdownGraceMs = 500
): string {
  assertPort(remotePort)
  if (!/^__PHI_JUPYTER_CLEANED_[a-f0-9]{32}__$/.test(cleanupMarker)) {
    throw new Error('远程 Jupyter cleanup marker 无效')
  }
  if (!launch.command || /[\r\n\0]/.test(launch.command)) throw new Error('远程 Jupyter 命令无效')
  const command = [launch.command, ...(launch.args ?? []), ...jupyterSecurityArgs(remotePort)]
    .map(shellQuote)
    .join(' ')
  const environment = remoteJupyterEnvironment(launch.env)
  const graceSeconds = Math.max(0, shutdownGraceMs) / 1_000
  const startedMarker = cleanupMarker.replace('CLEANED', 'STARTED')
  return [
    launch.cwd ? `cd ${shellQuote(launch.cwd)} || exit 72` : ':',
    'exec 3<&0',
    'pid=',
    'cleaned=0',
    ...cleanupFunctionLines(cleanupMarker, graceSeconds),
    "trap 'terminate_tree; exit 73' HUP TERM INT",
    "trap 'terminate_tree' EXIT",
    'IFS= read -r PHI_JUPYTER_TOKEN <&3 || exit 70',
    'test "${#PHI_JUPYTER_TOKEN}" -ge 43 || exit 71',
    `${environment}JUPYTER_TOKEN="$PHI_JUPYTER_TOKEN" setsid ${command} &`,
    'pid=$!',
    'unset PHI_JUPYTER_TOKEN',
    `printf '\\n%s\\n' ${shellQuote(startedMarker)}`,
    'lease_shell=$$',
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

function cleanupFunctionLines(cleanupMarker: string, graceSeconds: number): string[] {
  return [
    'terminate_tree() {',
    '  [ "$cleaned" -eq 0 ] || return 0',
    '  cleaned=1',
    '  trap - EXIT',
    "  trap '' HUP TERM INT",
    '  if [ -n "$pid" ]; then',
    '    kill -TERM -"$pid" 2>/dev/null || true; kill -TERM "$pid" 2>/dev/null || true; kill -TERM -"$pid" 2>/dev/null || true',
    `    sleep ${graceSeconds}`,
    '    kill -KILL -"$pid" 2>/dev/null || true; kill -KILL "$pid" 2>/dev/null || true; kill -KILL -"$pid" 2>/dev/null || true',
    '    wait "$pid" 2>/dev/null || true',
    '    attempt=0',
    '    while { kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; } && [ "$attempt" -lt 20 ]; do sleep 0.05; attempt=$((attempt + 1)); done',
    '    if kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; then return 1; fi',
    '  fi',
    `  printf '\\n%s\\n' ${shellQuote(cleanupMarker)}`,
    '}'
  ]
}

function jupyterSecurityArgs(port: number): string[] {
  return [
    '--no-browser',
    '--ServerApp.ip=127.0.0.1',
    `--ServerApp.port=${port}`,
    '--ServerApp.port_retries=0',
    '--ServerApp.open_browser=False',
    '--ServerApp.allow_remote_access=False',
    '--ServerApp.write_server_info_file=False',
    '--ServerApp.write_browser_open_file=False'
  ]
}

export class RemoteJupyterServerSupervisor {
  readonly options: RemoteJupyterSupervisorOptions
  #token?: string
  private currentStatus: RemoteJupyterServerStatus = { state: 'stopped' }
  private remoteLease?: RemoteJupyterLease
  private generation = 0
  private restartBlocked = false
  private starting?: Promise<RemoteJupyterConnection>
  private stopping?: Promise<void>
  private lifecycleAbort?: AbortController

  constructor(options: RemoteJupyterSupervisorOptions) {
    this.options = options
  }

  status(): RemoteJupyterServerStatus {
    return { ...this.currentStatus }
  }

  start(signal?: AbortSignal): Promise<RemoteJupyterConnection> {
    if (this.restartBlocked) {
      return Promise.reject(new Error('旧远程 Jupyter lease 清理尚未确认，禁止重新启动'))
    }
    if (this.currentStatus.state === 'ready') return Promise.resolve(this.connection())
    if (this.starting) return this.starting
    if (this.stopping || !['stopped', 'error'].includes(this.currentStatus.state)) {
      return Promise.reject(new Error('远程 Jupyter 正在清理，暂不能重新启动'))
    }
    this.lifecycleAbort = new AbortController()
    const combined = signal
      ? AbortSignal.any([signal, this.lifecycleAbort.signal])
      : this.lifecycleAbort.signal
    this.starting = this.startLoop(combined).finally(() => {
      this.starting = undefined
    })
    return this.starting
  }

  stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.lifecycleAbort?.abort()
    this.stopping = this.finishStop().finally(() => {
      this.stopping = undefined
    })
    return this.stopping
  }

  private async finishStop(): Promise<void> {
    if (this.currentStatus.state === 'ready') this.transition('stopping')
    await this.starting?.catch(() => undefined)
    if (this.currentStatus.state === 'stopped') return
    if (this.currentStatus.state !== 'stopping') this.transition('stopping')
    this.finishCleanupState(await this.cleanup())
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
        const confirmed = await this.cleanup()
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
    const launchScript = buildRemoteJupyterLaunchScript(
      this.options.launch,
      remotePort,
      cleanupMarker,
      this.options.shutdownGraceMs
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
      onLog: this.options.onLog
    })
    this.transition('probing_through_tunnel', undefined, remotePort, this.remoteLease.localPort)
    await this.probeUntilReady(this.remoteLease.localPort, signal)
    this.transition('ready', undefined, remotePort, this.remoteLease.localPort)
    this.restartBlocked = false
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
    this.finishCleanupState(await this.cleanup(lease))
  }

  private takeLease(): RemoteJupyterLease | undefined {
    const lease = this.remoteLease
    this.remoteLease = undefined
    this.generation += 1
    return lease
  }

  private async cleanup(detachedLease?: RemoteJupyterLease): Promise<boolean> {
    const lease = detachedLease ?? this.takeLease()
    this.transition('cleaning')
    await lease?.close().catch(() => undefined)
    const confirmed = lease ? lease.cleanupConfirmed() : !this.restartBlocked
    if (!confirmed) this.restartBlocked = true
    this.#token = undefined
    return confirmed
  }

  private finishCleanupState(confirmed: boolean): void {
    if (confirmed) {
      this.transition('stopped')
      return
    }
    this.transition('error', '旧远程 Jupyter lease 清理尚未确认，禁止重新启动')
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
    try {
      this.options.onStateChange?.(this.status())
    } catch {
      // Lifecycle cleanup must not be interruptible by an observer.
    }
  }
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
