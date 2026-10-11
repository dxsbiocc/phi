import { shellQuote } from '../wrappers/remote-ssh-session'
import type { CommandResult } from '../workspace-host/types'

export type RemoteWriteFailureKind = 'quota-exceeded' | 'no-space' | 'read-only' | 'other'
export type RemoteWriteProbeFailure = Exclude<RemoteWriteFailureKind, 'other'>

export interface RemoteWriteDiagnosis {
  kind: RemoteWriteFailureKind
  message: string
}

export type RemoteWriteProbeExecutor = (script: string) => Promise<{
  stdout: string
  stderr: string
  code: number | null
}>

const PROBE_MARKER = '__PHI_WRITE_PROBE__='
const CAPACITY_GUIDANCE =
  '服务器上该位置的写入空间或文件数配额已用尽；请在 设置 → 远程主机 把运行时目录改到有空间的位置（例如工作区所在文件系统），或清理旧环境'
const READ_ONLY_GUIDANCE =
  '服务器上该位置是只读文件系统；请在 设置 → 远程主机 把运行时目录改到可写的位置（例如工作区所在文件系统），或请管理员调整挂载设置'

export function classifyRemoteWriteFailure(output: string): RemoteWriteFailureKind {
  if (/disk quota exceeded|\bedquot\b|quota exceeded/iu.test(output)) return 'quota-exceeded'
  if (/no space left|\benospc\b|not enough space/iu.test(output)) return 'no-space'
  if (/read-only file system|\berofs\b|filesystem is read-only/iu.test(output)) return 'read-only'
  return 'other'
}

export function remoteWriteDiagnosis(kind: RemoteWriteFailureKind): RemoteWriteDiagnosis {
  if (kind === 'quota-exceeded' || kind === 'no-space') {
    return { kind, message: CAPACITY_GUIDANCE }
  }
  if (kind === 'read-only') return { kind, message: READ_ONLY_GUIDANCE }
  return { kind, message: '服务器运行时目录写入探测失败；请检查目录权限与文件系统状态。' }
}

function simulatedFailure(failure: RemoteWriteProbeFailure | undefined): string[] {
  if (!failure) return []
  const detail = {
    'quota-exceeded': 'Disk quota exceeded (EDQUOT)',
    'no-space': 'No space left on device (ENOSPC)',
    'read-only': 'Read-only file system (EROFS)'
  }[failure]
  return [`phi_error=${shellQuote(detail)}`, 'phi_status=1']
}

export function buildRemoteWriteProbeScript(
  runtimeRoot: string,
  simulateFailure?: RemoteWriteProbeFailure
): string {
  return [
    'set +e',
    'umask 077',
    `phi_root=${shellQuote(runtimeRoot)}`,
    'phi_probe="$phi_root/.phi-write-probe-$$"',
    'phi_cleanup() { rm -rf -- "$phi_probe"; }',
    'trap phi_cleanup 0',
    "trap 'phi_cleanup; exit 1' 1 2 15",
    'phi_error=$(mkdir "$phi_probe" 2>&1)',
    'phi_status=$?',
    'if [ "$phi_status" -eq 0 ]; then',
    '  phi_error=$( (printf x > "$phi_probe/value") 2>&1)',
    '  phi_status=$?',
    'fi',
    ...simulatedFailure(simulateFailure),
    'phi_cleanup',
    'trap - 0 1 2 15',
    'case "$phi_error" in',
    '  *"Disk quota exceeded"*|*"disk quota exceeded"*|*EDQUOT*) phi_kind=quota-exceeded ;;',
    '  *"No space left"*|*"no space left"*|*ENOSPC*) phi_kind=no-space ;;',
    '  *"Read-only file system"*|*"read-only file system"*|*EROFS*) phi_kind=read-only ;;',
    '  *) phi_kind=other ;;',
    'esac',
    `printf '%s%s\\n' '${PROBE_MARKER}' "$phi_kind"`
  ].join('\n')
}

export function parseRemoteWriteProbe(
  stdout: string,
  stderr: string,
  code: number | null
): RemoteWriteDiagnosis {
  const value = stdout
    .split(/\r?\n/u)
    .find((line) => line.startsWith(PROBE_MARKER))
    ?.slice(PROBE_MARKER.length)
  const kind = isFailureKind(value)
    ? value
    : classifyRemoteWriteFailure(`${stderr}\n${stdout}\nexit code ${String(code)}`)
  return remoteWriteDiagnosis(kind)
}

export async function probeRemoteWriteCapacity(
  runtimeRoot: string,
  execute: RemoteWriteProbeExecutor,
  simulateFailure?: RemoteWriteProbeFailure
): Promise<RemoteWriteDiagnosis> {
  const result = await execute(buildRemoteWriteProbeScript(runtimeRoot, simulateFailure))
  return parseRemoteWriteProbe(result.stdout, result.stderr, result.code)
}

export async function diagnoseRemoteCommandFailure(
  result: Pick<CommandResult, 'code' | 'stdout' | 'stderr' | 'terminationReason'>,
  runtimeRoot: string,
  execute: RemoteWriteProbeExecutor,
  simulateFailure?: RemoteWriteProbeFailure
): Promise<RemoteWriteDiagnosis | undefined> {
  if (result.code === 0 || result.terminationReason) return undefined
  const output = `${result.stderr}\n${result.stdout}`.trim()
  const direct = classifyRemoteWriteFailure(output)
  if (direct !== 'other') return remoteWriteDiagnosis(direct)
  if (hasExplicitFailureReason(output)) return undefined
  try {
    return await probeRemoteWriteCapacity(runtimeRoot, execute, simulateFailure)
  } catch {
    return undefined
  }
}

function hasExplicitFailureReason(output: string): boolean {
  return /error|failed|denied|not found|unreachable|resolve host|timed? out|ssl|repodata|solver|unsatisfiable/iu.test(
    output
  )
}

function isFailureKind(value: string | undefined): value is RemoteWriteFailureKind {
  return ['quota-exceeded', 'no-space', 'read-only', 'other'].includes(value ?? '')
}
