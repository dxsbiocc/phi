import type { RemoteDoctorReport } from '../../../../../shared/remoteDoctorTypes'
import type { RemoteRuntimeRootCheckResult } from '../../../../../shared/remoteRuntimeRootTypes'
import type { RemoteDoctorUiState } from './remoteDoctorUi'

type ReportWithRuntimeRoot = RemoteDoctorReport & {
  runtimeRootCheck?: RemoteRuntimeRootCheckResult
}

export type RemoteRuntimeRootUiStatus =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'timed-out' }
  | { phase: 'failed' }
  | { phase: 'checked'; result: RemoteRuntimeRootCheckResult }

export function remoteRuntimeRootResultStatus(
  result: RemoteRuntimeRootCheckResult
): RemoteRuntimeRootUiStatus {
  if (result.status === 'timed-out') return { phase: 'timed-out' }
  if (result.status === 'failed' || result.status === 'incomplete') return { phase: 'failed' }
  return { phase: 'checked', result }
}

export function remoteRuntimeRootUiStatus(
  state: RemoteDoctorUiState,
  targetKey: string
): RemoteRuntimeRootUiStatus {
  if (state.phase === 'idle' || state.key !== targetKey) return { phase: 'idle' }
  if (state.phase === 'running') return { phase: 'running' }
  if (state.phase === 'failed') {
    return /超时/.test(state.message) ? { phase: 'timed-out' } : { phase: 'failed' }
  }
  const result = (state.report as ReportWithRuntimeRoot).runtimeRootCheck
  return result ? remoteRuntimeRootResultStatus(result) : { phase: 'idle' }
}

export function formatRemoteRuntimeRootSpace(availableKiB: number | null): string {
  if (availableKiB === null) return '未知'
  const gibibytes = availableKiB / 1024 / 1024
  return `${Number.isInteger(gibibytes) ? gibibytes : gibibytes.toFixed(1)} GiB`
}

export function runtimeRootHasHardErrors(state: RemoteDoctorUiState, targetKey: string): boolean {
  const status = remoteRuntimeRootUiStatus(state, targetKey)
  return status.phase === 'checked' && status.result.hardErrors.length > 0
}

export function runtimeRootNeedsWarningConfirmation(
  state: RemoteDoctorUiState,
  targetKey: string
): boolean {
  const status = remoteRuntimeRootUiStatus(state, targetKey)
  return (
    status.phase === 'checked' &&
    status.result.hardErrors.length === 0 &&
    status.result.warnings.length > 0
  )
}

export function remoteRuntimeRootValueError(value: string): string | null {
  if (!value) return null
  if (/\0|\r|\n/.test(value)) return '运行时根目录不能包含 NUL 或换行符'
  if (!value.startsWith('/') && !value.startsWith('~/')) {
    return '运行时根目录必须是绝对路径或以 ~/ 开头'
  }
  if (value.split('/').includes('..')) return '运行时根目录不能包含 .. 路径段'
  return null
}

export function normalizeRemoteRuntimeRootValue(value: string): string | undefined {
  if (!value) return undefined
  const withoutTrailingSlash = value.replace(/\/+$/, '')
  if (!withoutTrailingSlash) return '/'
  return withoutTrailingSlash === '~' ? '~/' : withoutTrailingSlash
}
