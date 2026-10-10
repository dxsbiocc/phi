import type {
  RemoteMicromambaDownloadCapability,
  RemoteRuntimeRootWarningCode
} from './remoteRuntimeRootTypes'

export type RemoteMicromambaPlatform = 'linux-x64' | 'linux-arm64'

export function remoteMicromambaMirrorPrefixError(value: string): string | null {
  const prefix = value.trim()
  if (!prefix) return null
  let url: URL
  try {
    url = new URL(prefix)
  } catch {
    return '下载镜像前缀必须是有效的 HTTPS 地址'
  }
  if (url.protocol !== 'https:') return '下载镜像前缀必须使用 https://'
  if (url.username || url.password) return '下载镜像前缀不能包含用户名或密码'
  if (!prefix.endsWith('/')) return '下载镜像前缀必须以 / 结尾'
  return null
}

export function normalizeRemoteMicromambaMirrorPrefix(value: string): string | undefined {
  const prefix = value.trim()
  const error = remoteMicromambaMirrorPrefixError(prefix)
  if (error) throw new Error(error)
  return prefix || undefined
}

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
  downloadMirrorPrefix?: string
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
  | 'probing-network'
  | 'remote-downloading'
  | 'desktop-relay'
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
  networkProbe?: RemoteMicromambaDownloadCapability
  transferMethod?: 'remote-direct' | 'desktop-relay' | 'existing'
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
