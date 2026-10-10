import type { RemoteRuntimeRootWarningCode } from './remoteRuntimeRootTypes'

export type RemoteMicromambaPlatform = 'linux-x64' | 'linux-arm64'

export interface RemoteMicromambaArtifact {
  version: string
  platform: RemoteMicromambaPlatform
  localPath: string
  sha256: string
  size: number
}

export interface RemoteMicromambaInstallRequest {
  runtimeRoot: string
  confirmedWarnings: readonly RemoteRuntimeRootWarningCode[]
  requestId?: string
}

export type RemoteMicromambaOperationStatus =
  'installed' | 'already-installed' | 'needs-confirmation' | 'failed' | 'unsupported'

export type RemoteMicromambaErrorCode =
  | 'unsupported-platform'
  | 'invalid-artifact'
  | 'runtime-root-check-failed'
  | 'runtime-root-hard-error'
  | 'directory-creation-failed'
  | 'hash-tool-unavailable'
  | 'upload-failed'
  | 'remote-hash-mismatch'
  | 'activation-failed'
  | 'verification-failed'
  | 'aborted'
  | 'status-check-failed'

export type RemoteMicromambaProgressPhase =
  | 'checking-runtime-root'
  | 'preparing-directory'
  | 'checking-existing'
  | 'uploading'
  | 'verifying-upload'
  | 'activating'
  | 'verifying-installation'
  | 'complete'

export interface RemoteMicromambaProgress {
  stage: RemoteMicromambaProgressPhase
  message: string
  requestId?: string
  attempt?: number
  transferredBytes?: number
  totalBytes?: number
}

export interface RemoteMicromambaVerification {
  version: string | null
  platform: string | null
  versionMatches: boolean
  platformMatches: boolean
  runnable: boolean
}

export interface RemoteMicromambaResult {
  status: RemoteMicromambaOperationStatus
  version: string
  platform: RemoteMicromambaPlatform
  durationMs: number
  installPath?: string
  warningCodes: readonly RemoteRuntimeRootWarningCode[]
  errorCode?: RemoteMicromambaErrorCode
  message: string
  verification?: RemoteMicromambaVerification
}

export type RemoteMicromambaStatusState =
  'not-installed' | 'installed' | 'outdated' | 'unusable' | 'unchecked' | 'failed'

export interface RemoteMicromambaStatusResult {
  status: RemoteMicromambaStatusState
  installedVersions: readonly string[]
  expectedVersion?: string
  versionMatches: boolean | null
  runnable: boolean | null
  platform?: RemoteMicromambaPlatform
  durationMs: number
  warningCodes: readonly RemoteRuntimeRootWarningCode[]
  errorCode?: RemoteMicromambaErrorCode
  message: string
}
