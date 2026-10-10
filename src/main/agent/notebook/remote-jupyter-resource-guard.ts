export interface RemoteJupyterResourcePolicy {
  maxKernels: number
  maxThreads: number
  blasThreads: number
  maxRssBytes: number
  maxCpuSeconds: number
  idleTimeoutMs: number
  cellTimeoutMs: number
  monitorIntervalMs: number
  requireHardLimits: boolean
}

export type RemoteJupyterResourcePolicyInput = Partial<RemoteJupyterResourcePolicy>
export type RemoteJupyterResourceLimitMode = 'pending' | 'prlimit' | 'ulimit' | 'monitor'
export type RemoteJupyterResourceViolationCode =
  'rss' | 'threads' | 'cpu' | 'hard_limit_required' | 'monitor_unavailable'

export type RemoteJupyterResourceEvent =
  | { type: 'mode'; mode: Exclude<RemoteJupyterResourceLimitMode, 'pending'> }
  | { type: 'warning'; code: 'hard_limit_unavailable' | 'monitor_unavailable' }
  | { type: 'violation'; code: RemoteJupyterResourceViolationCode }

export interface RemoteJupyterResourceStatus {
  policy: Readonly<RemoteJupyterResourcePolicy>
  activeKernels: number
  idleArmed: boolean
  limitMode: RemoteJupyterResourceLimitMode
  warning?: RemoteJupyterResourceEvent & { type: 'warning' }
  violation?: RemoteJupyterResourceEvent & { type: 'violation' }
}

export interface RemoteJupyterResourceSample {
  rssBytes: number
  threads: number
  cpuSeconds: number
}

export const DEFAULT_REMOTE_JUPYTER_RESOURCE_POLICY: Readonly<RemoteJupyterResourcePolicy> =
  Object.freeze({
    maxKernels: 2,
    maxThreads: 16,
    blasThreads: 2,
    maxRssBytes: 4 * 1024 ** 3,
    maxCpuSeconds: 30 * 60,
    idleTimeoutMs: 30 * 60 * 1_000,
    cellTimeoutMs: 30 * 60 * 1_000,
    monitorIntervalMs: 5_000,
    requireHardLimits: false
  })

const RESOURCE_MARKER = '__PHI_JUPYTER_RESOURCE__:'
const activeTimers = new Set<ReturnType<typeof setTimeout>>()

export function normalizeRemoteJupyterResourcePolicy(
  input: RemoteJupyterResourcePolicyInput = {}
): Readonly<RemoteJupyterResourcePolicy> {
  const policy = { ...DEFAULT_REMOTE_JUPYTER_RESOURCE_POLICY, ...input }
  for (const [key, value] of Object.entries(policy)) {
    if (key === 'requireHardLimits') continue
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`远程 Jupyter 资源配置无效: ${key}`)
    }
  }
  if (typeof policy.requireHardLimits !== 'boolean') {
    throw new Error('远程 Jupyter 资源配置无效: requireHardLimits')
  }
  return Object.freeze(policy)
}

export class RemoteJupyterKernelLimitError extends Error {
  constructor(limit: number) {
    super(`远程 Jupyter 同时 kernel 数已达到上限 ${limit}`)
  }
}

interface RemoteJupyterResourceGateOptions {
  onIdle?: () => void | Promise<void>
  onError?: (error: unknown) => void
}

export class RemoteJupyterResourceGate {
  readonly policy: Readonly<RemoteJupyterResourcePolicy>
  private readonly kernels = new Set<string>()
  private idleTimer?: ReturnType<typeof setTimeout>
  private limitMode: RemoteJupyterResourceLimitMode = 'pending'
  private warning?: RemoteJupyterResourceEvent & { type: 'warning' }
  private violation?: RemoteJupyterResourceEvent & { type: 'violation' }

  constructor(
    policy: RemoteJupyterResourcePolicyInput = {},
    private readonly options: RemoteJupyterResourceGateOptions = {}
  ) {
    this.policy = normalizeRemoteJupyterResourcePolicy(policy)
  }

  claimKernel(owner: string): void {
    assertOwner(owner)
    if (this.kernels.has(owner)) return this.clearIdleTimer()
    if (this.kernels.size >= this.policy.maxKernels) {
      throw new RemoteJupyterKernelLimitError(this.policy.maxKernels)
    }
    this.kernels.add(owner)
    this.clearIdleTimer()
  }

  releaseKernel(owner: string): void {
    if (this.kernels.delete(owner) && this.kernels.size === 0) this.armIdleTimer()
  }

  touchActivity(): void {
    this.clearIdleTimer()
    if (this.kernels.size > 0) return
    this.armIdleTimer()
  }

  private armIdleTimer(): void {
    this.idleTimer = trackedTimeout(() => {
      this.idleTimer = undefined
      Promise.resolve(this.options.onIdle?.()).catch(this.options.onError ?? (() => undefined))
    }, this.policy.idleTimeoutMs)
  }

  cellTimeoutMs(): number {
    return this.policy.cellTimeoutMs
  }

  reportResourceEvent(event: RemoteJupyterResourceEvent): void {
    if (event.type === 'mode') this.limitMode = event.mode
    if (event.type === 'warning') this.warning = event
    if (event.type === 'violation') this.violation = event
  }

  resourceStatus(): RemoteJupyterResourceStatus {
    return {
      policy: this.policy,
      activeKernels: this.kernels.size,
      idleArmed: Boolean(this.idleTimer),
      limitMode: this.limitMode,
      ...(this.warning ? { warning: this.warning } : {}),
      ...(this.violation ? { violation: this.violation } : {})
    }
  }

  dispose(): void {
    this.clearIdleTimer()
    this.kernels.clear()
  }

  reset(): void {
    this.dispose()
    this.limitMode = 'pending'
    this.warning = undefined
    this.violation = undefined
  }

  private clearIdleTimer(): void {
    if (!this.idleTimer) return
    clearTrackedTimeout(this.idleTimer)
    this.idleTimer = undefined
  }
}

type ApplicableLimitMode = 'prlimit' | 'ulimit'

interface RemoteJupyterProcessResourceMonitorOptions {
  policy?: RemoteJupyterResourcePolicyInput
  applyLimit?: (
    mode: ApplicableLimitMode,
    policy: Readonly<RemoteJupyterResourcePolicy>
  ) => Promise<boolean>
  sample: () => Promise<RemoteJupyterResourceSample>
  terminate: (reason: RemoteJupyterResourceViolationCode) => Promise<void>
  onEvent?: (event: RemoteJupyterResourceEvent) => void
}

export class RemoteJupyterProcessResourceMonitor {
  readonly policy: Readonly<RemoteJupyterResourcePolicy>
  private stopped = true
  private timer?: ReturnType<typeof setTimeout>
  private polling?: Promise<void>

  constructor(private readonly options: RemoteJupyterProcessResourceMonitorOptions) {
    this.policy = normalizeRemoteJupyterResourcePolicy(options.policy)
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    const mode = await this.selectLimitMode()
    this.stopped = false
    this.emit({ type: 'mode', mode })
    if (mode === 'monitor') this.emit({ type: 'warning', code: 'hard_limit_unavailable' })
    this.schedulePoll()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearTrackedTimeout(this.timer)
    this.timer = undefined
    await this.polling
  }

  private async selectLimitMode(): Promise<Exclude<RemoteJupyterResourceLimitMode, 'pending'>> {
    for (const mode of ['prlimit', 'ulimit'] as const) {
      try {
        if (await this.options.applyLimit?.(mode, this.policy)) return mode
      } catch {
        // A rejected hard limit is reported by the explicit monitoring fallback.
      }
    }
    return 'monitor'
  }

  private schedulePoll(): void {
    if (this.stopped) return
    this.timer = trackedTimeout(() => {
      this.timer = undefined
      this.polling = this.poll().finally(() => {
        this.polling = undefined
        this.schedulePoll()
      })
    }, this.policy.monitorIntervalMs)
  }

  private async poll(): Promise<void> {
    let violation: RemoteJupyterResourceViolationCode | undefined
    try {
      violation = resourceViolation(await this.options.sample(), this.policy)
    } catch {
      violation = 'monitor_unavailable'
      this.emit({ type: 'warning', code: 'monitor_unavailable' })
    }
    if (!violation || this.stopped) return
    this.stopped = true
    this.emit({ type: 'violation', code: violation })
    await this.options.terminate(violation)
  }

  private emit(event: RemoteJupyterResourceEvent): void {
    this.options.onEvent?.(event)
  }
}

export function buildRemoteJupyterResourceLaunchLines(
  command: string,
  input: RemoteJupyterResourcePolicyInput = {},
  environment = ''
): string[] {
  if (!command || /[\r\n\0]/.test(command)) throw new Error('远程 Jupyter 资源命令无效')
  if (/[\r\n\0]/.test(environment)) throw new Error('远程 Jupyter 资源环境无效')
  const policy = normalizeRemoteJupyterResourcePolicy(input)
  const limits = `--cpu=${policy.maxCpuSeconds} --as=${policy.maxRssBytes}`
  const rssKiB = Math.ceil(policy.maxRssBytes / 1024)
  const launchPrefix = `${threadEnvironment(policy.blasThreads)} ${environment}`
  return [
    'resource_mode=monitor',
    `if command -v prlimit >/dev/null 2>&1 && prlimit ${limits} -- true >/dev/null 2>&1; then`,
    `  ${launchPrefix}prlimit ${limits} -- setsid ${command} &`,
    '  resource_mode=prlimit',
    `elif (ulimit -t ${policy.maxCpuSeconds} && ulimit -v ${rssKiB}) 2>/dev/null; then`,
    `  (ulimit -t ${policy.maxCpuSeconds}; ulimit -v ${rssKiB}; ${launchPrefix}exec setsid ${command}) &`,
    '  resource_mode=ulimit',
    'else',
    `  printf '\\n%s\\n' '${RESOURCE_MARKER}warning=hard_limit_unavailable'`,
    ...(policy.requireHardLimits
      ? [`  printf '\\n%s\\n' '${RESOURCE_MARKER}violation=hard_limit_required'`, '  exit 74']
      : [`  ${launchPrefix}setsid ${command} &`]),
    'fi',
    'pid=$!',
    `printf '\\n%s\\n' "${RESOURCE_MARKER}mode=$resource_mode"`,
    ...resourceMonitorLines(policy)
  ]
}

export function buildRemoteJupyterResourceCleanupLines(): string[] {
  return [
    'if [ -n "$resource_watcher" ]; then',
    '  kill "$resource_watcher" 2>/dev/null || true',
    '  wait "$resource_watcher" 2>/dev/null || true',
    '  resource_watcher=',
    'fi'
  ]
}

export function parseRemoteJupyterResourceMarker(
  line: string
): RemoteJupyterResourceEvent | undefined {
  const marker = line.trim()
  if (marker === `${RESOURCE_MARKER}mode=prlimit`) return { type: 'mode', mode: 'prlimit' }
  if (marker === `${RESOURCE_MARKER}mode=ulimit`) return { type: 'mode', mode: 'ulimit' }
  if (marker === `${RESOURCE_MARKER}mode=monitor`) return { type: 'mode', mode: 'monitor' }
  if (marker === `${RESOURCE_MARKER}warning=hard_limit_unavailable`) {
    return { type: 'warning', code: 'hard_limit_unavailable' }
  }
  if (marker === `${RESOURCE_MARKER}warning=monitor_unavailable`) {
    return { type: 'warning', code: 'monitor_unavailable' }
  }
  for (const code of [
    'rss',
    'threads',
    'cpu',
    'hard_limit_required',
    'monitor_unavailable'
  ] as const) {
    if (marker === `${RESOURCE_MARKER}violation=${code}`) return { type: 'violation', code }
  }
  return undefined
}

export function remoteJupyterResourceGuardActivity(): { timers: number } {
  return { timers: activeTimers.size }
}

function resourceMonitorLines(policy: Readonly<RemoteJupyterResourcePolicy>): string[] {
  const intervalSeconds = policy.monitorIntervalMs / 1_000
  const awk =
    'function secs(v,a,n,d,h){n=split(v,a,":");if(n==1)return a[1];if(n==2)return a[1]*60+a[2];h=a[1];if(index(h,"-")){split(h,d,"-");return d[1]*86400+d[2]*3600+a[2]*60+a[3]}return h*3600+a[2]*60+a[3]} $1==group{seen=1;rss+=$2;threads+=$3;cpu+=secs($4)} END{if(!seen)exit 3;printf "%.0f %.0f %.0f\\n",rss*1024,threads,cpu}'
  return [
    '(',
    '  resource_sleep=',
    '  trap \'[ -z "$resource_sleep" ] || { kill "$resource_sleep" 2>/dev/null || true; wait "$resource_sleep" 2>/dev/null || true; }; exit 0\' HUP TERM INT',
    '  stop_resource_group() {',
    '    if [ -n "$lease_shell" ]; then kill -TERM "$lease_shell" 2>/dev/null || true; return; fi',
    '    kill -TERM -"$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true',
    '    sleep 1',
    '    kill -KILL -"$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true',
    '  }',
    '  while kill -0 "$pid" 2>/dev/null; do',
    `    sleep ${intervalSeconds} &`,
    '    resource_sleep=$!',
    '    wait "$resource_sleep" 2>/dev/null || exit 0',
    '    resource_sleep=',
    `    resource_sample=$(ps -eo pgid=,rss=,nlwp=,time= 2>/dev/null | awk -v group="$pid" '${awk}')`,
    '    resource_sample_status=$?',
    '    if [ "$resource_sample_status" -ne 0 ]; then',
    '      kill -0 "$pid" 2>/dev/null || exit 0',
    `      printf '\\n%s\\n' '${RESOURCE_MARKER}warning=monitor_unavailable'`,
    `      printf '\\n%s\\n' '${RESOURCE_MARKER}violation=monitor_unavailable'`,
    '      stop_resource_group',
    '      exit 0',
    '    fi',
    '    set -- $resource_sample',
    `    if [ "$1" -gt ${policy.maxRssBytes} ]; then resource_violation=rss`,
    `    elif [ "$2" -gt ${policy.maxThreads} ]; then resource_violation=threads`,
    `    elif [ "$3" -gt ${policy.maxCpuSeconds} ]; then resource_violation=cpu`,
    '    else resource_violation=; fi',
    '    [ -n "$resource_violation" ] || continue',
    `    printf '\\n${RESOURCE_MARKER}violation=%s\\n' "$resource_violation"`,
    '    stop_resource_group',
    '    exit 0',
    '  done',
    ') &',
    'resource_watcher=$!'
  ]
}

function threadEnvironment(threads: number): string {
  return [
    'OMP_NUM_THREADS',
    'OPENBLAS_NUM_THREADS',
    'MKL_NUM_THREADS',
    'NUMEXPR_NUM_THREADS',
    'VECLIB_MAXIMUM_THREADS'
  ]
    .map((key) => `${key}=${threads}`)
    .join(' ')
}

function resourceViolation(
  sample: RemoteJupyterResourceSample,
  policy: Readonly<RemoteJupyterResourcePolicy>
): RemoteJupyterResourceViolationCode | undefined {
  if (sample.rssBytes > policy.maxRssBytes) return 'rss'
  if (sample.threads > policy.maxThreads) return 'threads'
  if (sample.cpuSeconds > policy.maxCpuSeconds) return 'cpu'
  return undefined
}

function trackedTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(() => {
    activeTimers.delete(timer)
    callback()
  }, delay)
  timer.unref?.()
  activeTimers.add(timer)
  return timer
}

function clearTrackedTimeout(timer: ReturnType<typeof setTimeout>): void {
  clearTimeout(timer)
  activeTimers.delete(timer)
}

function assertOwner(owner: string): void {
  if (!owner.trim()) throw new Error('远程 Jupyter kernel owner 无效')
}
