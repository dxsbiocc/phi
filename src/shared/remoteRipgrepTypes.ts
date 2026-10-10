import type { RemoteMicromambaProgress } from './remoteMicromambaTypes'
import type { RemoteRuntimeRootWarningCode } from './remoteRuntimeRootTypes'

export const REMOTE_RIPGREP_COMPLETE_MARKER = '.phi-ripgrep-complete'

export type RemoteRipgrepStatusState = 'system' | 'managed' | 'not-installed' | 'failed'

export type RemoteRipgrepOperationStatus =
  'system' | 'installed' | 'already-installed' | 'needs-confirmation' | 'failed'

export type RemoteRipgrepErrorCode =
  | 'runtime-root-check-failed'
  | 'runtime-root-hard-error'
  | 'micromamba-not-installed'
  | 'source-unreachable'
  | 'installation-failed'
  | 'verification-failed'
  | 'activation-failed'
  | 'aborted'
  | 'status-check-failed'

export interface RemoteRipgrepStatusResult {
  status: RemoteRipgrepStatusState
  executablePath?: string
  version?: string
  durationMs: number
  message: string
  errorCode?: RemoteRipgrepErrorCode
}

export interface RemoteRipgrepInstallRequest {
  runtimeRoot: string
  confirmedWarnings: readonly RemoteRuntimeRootWarningCode[]
  forceManaged?: boolean
  requestId?: string
}

export interface RemoteRipgrepResult {
  status: RemoteRipgrepOperationStatus
  executablePath?: string
  version?: string
  durationMs: number
  warningCodes: readonly RemoteRuntimeRootWarningCode[]
  message: string
  errorCode?: RemoteRipgrepErrorCode
}

export type RemoteRipgrepProgress = RemoteMicromambaProgress
