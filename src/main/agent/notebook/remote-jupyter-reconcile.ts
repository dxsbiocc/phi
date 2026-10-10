import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { posix } from 'node:path'

import {
  SSH_OPTIONS,
  shellQuote,
  validateHostAlias,
  type RemoteConnectionConfig
} from '../wrappers/remote-ssh-session'
import {
  buildSshConnectionArgs,
  type SshPortForwardSpawn
} from '../workspace-host/ssh-port-forward'
import { buildRemoteJupyterResourceCleanupLines } from './remote-jupyter-resource-guard'

export interface RemoteJupyterLeaseIdentity {
  leaseId: string
  recordPath: string
}

export type RemoteJupyterReconcileResult = 'already_cleaned' | 'identity_mismatch' | 'terminated'

export class RemoteJupyterReconciliationError extends Error {
  constructor(
    readonly reason: 'unavailable' | 'unconfirmed',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
  }
}

export interface ReconcileRemoteJupyterLeaseOptions {
  connection: RemoteConnectionConfig
  identity: RemoteJupyterLeaseIdentity
  shutdownGraceMs?: number
  spawnImpl?: SshPortForwardSpawn
}

const activeChildren = new Set<ChildProcessWithoutNullStreams>()
const activeTimers = new Set<ReturnType<typeof setTimeout>>()
const MAX_OUTPUT_BYTES = 8_192

process.once('exit', () => {
  for (const child of activeChildren) child.kill('SIGTERM')
})

export function remoteJupyterReconcileActivity(): { children: number; timers: number } {
  return { children: activeChildren.size, timers: activeTimers.size }
}

export function assertRemoteJupyterLaunchInput(
  command: string,
  remotePort: number,
  cleanupMarker: string
): void {
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
    throw new Error('远程 Jupyter 端口无效')
  }
  if (!/^__PHI_JUPYTER_CLEANED_[a-f0-9]{32}__$/.test(cleanupMarker)) {
    throw new Error('远程 Jupyter cleanup marker 无效')
  }
  if (!command || /[\r\n\0]/.test(command)) throw new Error('远程 Jupyter 命令无效')
}

export function remoteJupyterSecurityArgs(port: number): string[] {
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

export function remoteJupyterLeaseIdentity(
  runtimeDir: string | undefined,
  cleanupMarker: string
): RemoteJupyterLeaseIdentity {
  const match = /^__PHI_JUPYTER_CLEANED_([a-f0-9]{32})__$/.exec(cleanupMarker)
  if (!runtimeDir || !posix.isAbsolute(runtimeDir) || !match || /[\r\n\0]/.test(runtimeDir)) {
    throw new Error('远程 Jupyter lease 身份无效')
  }
  return {
    leaseId: match[1],
    recordPath: posix.join(runtimeDir, 'phi-leases', `${match[1]}.lease`)
  }
}

export function buildRemoteJupyterLeaseSetupLines(
  identity: RemoteJupyterLeaseIdentity | undefined
): string[] {
  if (!identity) return ['lease_record=']
  return [
    `lease_record=${shellQuote(identity.recordPath)}`,
    `lease_id=${shellQuote(identity.leaseId)}`
  ]
}

export function buildRemoteJupyterLeaseWriteLines(
  identity: RemoteJupyterLeaseIdentity | undefined
): string[] {
  if (!identity) return []
  const directory = posix.dirname(identity.recordPath)
  return [
    `lease_dir=${shellQuote(directory)}`,
    'lease_pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d "[:space:]")',
    'lease_started=$(LC_ALL=C ps -o lstart= -p "$pid" 2>/dev/null | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")',
    'lease_command=$(PHI_RECONCILE_EXPECTED_LEASE="$lease_id" LC_ALL=C ps -ww -o command= -p "$pid" 2>/dev/null)',
    'case "$lease_pgid" in ""|*[!0-9]*) exit 75 ;; esac',
    '[ "$lease_pgid" = "$pid" ] && [ -n "$lease_started" ] && [ -n "$lease_command" ] || exit 75',
    'case "$lease_command" in *"phi-jupyter-lease-$lease_id"*) ;; *) exit 75 ;; esac',
    'lease_tmp="${lease_record}.tmp.$$"',
    'umask 077',
    'mkdir -p "$lease_dir" || exit 75',
    'printf "%s\\n%s\\n%s\\n%s\\n%s\\n" PHI_JUPYTER_LEASE_V1 "$lease_id" "$pid" "$lease_pgid" "$lease_started" > "$lease_tmp" || exit 75',
    'mv -f "$lease_tmp" "$lease_record" || exit 75'
  ]
}

export function remoteJupyterOwnedCommand(
  command: string,
  identity: RemoteJupyterLeaseIdentity | undefined
): string {
  if (!identity) return command
  const marker = `phi-jupyter-lease-${identity.leaseId}`
  const wrapper = '"$@" & child=$!; wait "$child"'
  return `sh -c ${shellQuote(wrapper)} ${shellQuote(marker)} ${command}`
}

export function remoteJupyterLeaseEnvironment(
  identity: RemoteJupyterLeaseIdentity | undefined
): string {
  return identity ? `PHI_JUPYTER_LEASE_ID=${shellQuote(identity.leaseId)} ` : ''
}

export function buildRemoteJupyterLeaseCleanupLines(
  identity: RemoteJupyterLeaseIdentity | undefined
): string[] {
  return identity ? ['rm -f "$lease_record" || return 1'] : []
}

export function buildRemoteJupyterCleanupFunctionLines(
  cleanupMarker: string,
  graceSeconds: number,
  identity?: RemoteJupyterLeaseIdentity
): string[] {
  return [
    'terminate_tree() {',
    '  [ "$cleaned" -eq 0 ] || return 0',
    '  cleaned=1',
    '  trap - EXIT',
    "  trap '' HUP TERM INT",
    ...buildRemoteJupyterResourceCleanupLines().map((line) => `  ${line}`),
    '  if [ -n "$pid" ]; then',
    '    kill -TERM -"$pid" 2>/dev/null || true; kill -TERM "$pid" 2>/dev/null || true; kill -TERM -"$pid" 2>/dev/null || true',
    `    sleep ${graceSeconds}`,
    '    kill -KILL -"$pid" 2>/dev/null || true; kill -KILL "$pid" 2>/dev/null || true; kill -KILL -"$pid" 2>/dev/null || true',
    '    wait "$pid" 2>/dev/null || true',
    '    attempt=0',
    '    while { kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; } && [ "$attempt" -lt 20 ]; do sleep 0.05; attempt=$((attempt + 1)); done',
    '    if kill -0 -"$pid" 2>/dev/null || kill -0 "$pid" 2>/dev/null; then return 1; fi',
    '  fi',
    ...buildRemoteJupyterLeaseCleanupLines(identity).map((line) => `  ${line}`),
    `  printf '\\n%s\\n' ${shellQuote(cleanupMarker)}`,
    '}'
  ]
}

export function buildRemoteJupyterReconcileScript(
  identity: RemoteJupyterLeaseIdentity,
  shutdownGraceMs = 500
): string {
  assertIdentity(identity)
  const marker = `__PHI_JUPYTER_RECONCILED_${identity.leaseId}__`
  const graceSeconds = Math.max(0, shutdownGraceMs) / 1_000
  return [
    `lease_record=${shellQuote(identity.recordPath)}`,
    `expected_lease=${shellQuote(identity.leaseId)}`,
    ...identityFunctionLines(),
    ...readRecordLines(marker),
    ...reconcileProcessLines(marker, graceSeconds)
  ].join('\n')
}

export async function reconcileRemoteJupyterLease(
  options: ReconcileRemoteJupyterLeaseOptions
): Promise<RemoteJupyterReconcileResult> {
  const script = buildRemoteJupyterReconcileScript(options.identity, options.shutdownGraceMs)
  const args = buildReconcileSshArgs(options.connection, script)
  const spawnImpl = options.spawnImpl ?? defaultSpawn
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawnImpl('ssh', args, { stdio: ['pipe', 'pipe', 'pipe'] })
  } catch (error) {
    throw unavailableError(error)
  }
  activeChildren.add(child)
  child.stdin.on('error', () => undefined)
  child.stdin.end()
  let result: { code: number | null; stdout: string }
  try {
    result = await collectReconcileResult(child, options.connection.execTimeoutMs ?? 15_000)
  } catch (error) {
    throw unavailableError(error)
  }
  if (result.code === 255) throw unavailableError()
  if (result.code !== 0) throw unconfirmedError()
  try {
    return parseReconcileResult(result.stdout, options.identity.leaseId)
  } catch (error) {
    throw unconfirmedError(error)
  }
}

function buildReconcileSshArgs(config: RemoteConnectionConfig, script: string): string[] {
  return [
    '-T',
    ...buildSshConnectionArgs(config),
    ...SSH_OPTIONS,
    '-o',
    'ControlMaster=no',
    '-o',
    'ControlPath=none',
    validateHostAlias(config.host),
    script
  ]
}

function identityFunctionLines(): string[] {
  return [
    'inspect_identity() {',
    '  command -v ps >/dev/null 2>&1 || return 2',
    '  current_pgid=$(ps -o pgid= -p "$record_pid" 2>/dev/null | tr -d "[:space:]")',
    '  current_started=$(LC_ALL=C ps -o lstart= -p "$record_pid" 2>/dev/null | sed "s/^[[:space:]]*//;s/[[:space:]]*$//")',
    '  current_command=$(PHI_RECONCILE_EXPECTED_LEASE="$expected_lease" LC_ALL=C ps -ww -o command= -p "$record_pid" 2>/dev/null)',
    '  [ -n "$current_pgid" ] && [ -n "$current_started" ] && [ -n "$current_command" ] || return 2',
    '  [ "$current_pgid" = "$record_pgid" ] && [ "$current_started" = "$record_started" ] || return 1',
    '  case "$current_command" in *"phi-jupyter-lease-$expected_lease"*) ;; *) return 1 ;; esac',
    '  if [ -d "/proc/$record_pid" ]; then',
    '    [ -r "/proc/$record_pid/environ" ] || return 2',
    '    tr "\\000" "\\n" < "/proc/$record_pid/environ" 2>/dev/null | grep -Fqx "PHI_JUPYTER_LEASE_ID=$expected_lease" || return 1',
    '  fi',
    '  return 0',
    '}'
  ]
}

function readRecordLines(marker: string): string[] {
  return [
    `if [ ! -f "$lease_record" ]; then printf '%s\\n' '${marker}:already_cleaned'; exit 0; fi`,
    '{ IFS= read -r record_version && IFS= read -r record_lease && IFS= read -r record_pid && IFS= read -r record_pgid && IFS= read -r record_started; } < "$lease_record" || exit 76',
    '[ "$record_version" = PHI_JUPYTER_LEASE_V1 ] && [ "$record_lease" = "$expected_lease" ] || exit 76',
    'case "$record_pid:$record_pgid" in *[!0-9:]*|:*|*:) exit 76 ;; esac',
    '[ "$record_pid" = "$record_pgid" ] && [ -n "$record_started" ] || exit 76'
  ]
}

function reconcileProcessLines(marker: string, graceSeconds: number): string[] {
  return [
    `if ! kill -0 "$record_pid" 2>/dev/null && ! kill -0 -"$record_pgid" 2>/dev/null; then rm -f "$lease_record" || exit 78; printf '%s\\n' '${marker}:already_cleaned'; exit 0; fi`,
    'kill -0 "$record_pid" 2>/dev/null || exit 76',
    'inspect_identity; identity_status=$?',
    'if [ "$identity_status" -eq 2 ]; then exit 76; fi',
    `if [ "$identity_status" -ne 0 ]; then rm -f "$lease_record" || exit 78; printf '%s\\n' '${marker}:identity_mismatch'; exit 0; fi`,
    'kill -TERM -"$record_pgid" 2>/dev/null || true',
    `sleep ${graceSeconds}`,
    'if kill -0 -"$record_pgid" 2>/dev/null; then kill -KILL -"$record_pgid" 2>/dev/null || true; fi',
    'attempt=0',
    'while kill -0 -"$record_pgid" 2>/dev/null && [ "$attempt" -lt 20 ]; do sleep 0.05; attempt=$((attempt + 1)); done',
    'if kill -0 -"$record_pgid" 2>/dev/null; then exit 77; fi',
    'rm -f "$lease_record" || exit 78',
    `printf '%s\\n' '${marker}:terminated'`
  ]
}

function collectReconcileResult(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<{ code: number | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let bytes = 0
    let failure: Error | undefined
    let forceTimer: ReturnType<typeof setTimeout> | undefined
    const fail = (error: Error): void => {
      if (failure) return
      failure = error
      child.kill('SIGTERM')
      forceTimer = trackedTimer(() => child.kill('SIGKILL'), 500)
    }
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.byteLength
      if (bytes > MAX_OUTPUT_BYTES) fail(new Error('远程 Jupyter 清理确认输出过大'))
      else chunks.push(chunk)
    })
    child.stderr.resume()
    child.once('error', (error) => fail(error))
    child.once('close', (code) => {
      clearTrackedTimer(timer)
      if (forceTimer) clearTrackedTimer(forceTimer)
      activeChildren.delete(child)
      if (failure) {
        reject(failure)
        return
      }
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') })
    })
    const timer = trackedTimer(() => fail(new Error('远程 Jupyter 清理确认连接超时')), timeoutMs)
  })
}

function parseReconcileResult(stdout: string, leaseId: string): RemoteJupyterReconcileResult {
  const marker = `__PHI_JUPYTER_RECONCILED_${leaseId}__:`
  const result = stdout
    .split(/\r?\n/)
    .find((line) => line.startsWith(marker))
    ?.slice(marker.length)
  if (result === 'already_cleaned' || result === 'identity_mismatch' || result === 'terminated') {
    return result
  }
  throw new Error('远程 Jupyter 清理确认回执无效')
}

function trackedTimer(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
  const timer = setTimeout(
    () => {
      activeTimers.delete(timer)
      callback()
    },
    Math.max(1, ms)
  )
  activeTimers.add(timer)
  timer.unref()
  return timer
}

function clearTrackedTimer(timer: ReturnType<typeof setTimeout>): void {
  clearTimeout(timer)
  activeTimers.delete(timer)
}

function assertIdentity(identity: RemoteJupyterLeaseIdentity): void {
  const expectedName = `${identity.leaseId}.lease`
  if (
    !/^[a-f0-9]{32}$/.test(identity.leaseId) ||
    !posix.isAbsolute(identity.recordPath) ||
    posix.basename(identity.recordPath) !== expectedName ||
    posix.basename(posix.dirname(identity.recordPath)) !== 'phi-leases' ||
    /[\r\n\0]/.test(identity.recordPath)
  ) {
    throw new Error('远程 Jupyter lease 身份无效')
  }
}

function unavailableError(cause?: unknown): RemoteJupyterReconciliationError {
  return new RemoteJupyterReconciliationError(
    'unavailable',
    '远程 Jupyter 清理确认连接不可用',
    cause === undefined ? undefined : { cause }
  )
}

function unconfirmedError(cause?: unknown): RemoteJupyterReconciliationError {
  return new RemoteJupyterReconciliationError(
    'unconfirmed',
    '远程 Jupyter 清理确认未完成',
    cause === undefined ? undefined : { cause }
  )
}

const defaultSpawn: SshPortForwardSpawn = (binary, args, options) => spawn(binary, args, options)
