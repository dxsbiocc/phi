import type {
  RemoteMicromambaDownloadCapability,
  RemoteRuntimeRootWarningCode
} from './remoteRuntimeRootTypes'

export type RemoteMicromambaPlatform = 'linux-x64' | 'linux-arm64'

const REMOTE_MICROMAMBA_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

export function remoteMicromambaPath(runtimeRoot: string, version: string): string {
  if (!REMOTE_MICROMAMBA_VERSION_PATTERN.test(version)) {
    throw new Error('invalid remote micromamba version')
  }
  const root = runtimeRoot.replace(/\/+$/, '')
  return `${root}/bin/micromamba-${version}/micromamba`
}

export function remoteMicromambaMirrorPrefixError(value: string): string | null {
  const prefix = value.trim()
  if (!prefix) return null
  let url: URL
  try {
    url = new URL(prefix)
  } catch {
    return 'Download mirror prefix must be a valid HTTPS URL'
  }
  if (url.protocol !== 'https:') return 'Download mirror prefix must use https://'
  if (url.username || url.password)
    return 'Download mirror prefix must not contain a username or password'
  if (!prefix.endsWith('/')) return 'Download mirror prefix must end with /'
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
  | 'run-verification-failed'
  | 'legacy-layout'
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
  runSuccessful: boolean
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
