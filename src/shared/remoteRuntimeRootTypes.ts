export type RemoteRuntimeRootSource = 'project' | 'host' | 'default'

export type RemoteRuntimeRootWarningCode =
  | 'not-owned'
  | 'group-or-other-writable'
  | 'symlink'
  | 'low-space'
  | 'high-disk-use'
  | 'noexec'
  | 'shared-filesystem-info'

export type RemoteRuntimeRootHardErrorCode =
  'invalid-configured-root' | 'unable-to-expand' | 'ancestor-not-writable'

export type RemoteRuntimeRootCheckStatus = 'checked' | 'timed-out' | 'failed' | 'incomplete'

export interface RemoteRuntimeRootWarning {
  code: RemoteRuntimeRootWarningCode
  message: string
  consequence: string
}

export interface RemoteRuntimeRootHardError {
  code: RemoteRuntimeRootHardErrorCode
  message: string
}

export interface RemoteRuntimeRootCheckResult {
  configured: string
  checkedAt: string
  status: RemoteRuntimeRootCheckStatus
  expandedPath: string | null
  exists: boolean | null
  nearestExistingAncestor: string | null
  ancestorWritable: boolean | null
  ownedByCurrentUser: boolean | null
  groupOrOtherWritable: boolean | null
  hasSymlink: boolean | null
  fsType: string | null
  availableKiB: number | null
  diskUsePercent: number | null
  inodeUsePercent: number | null
  executable: boolean | null
  sharedFilesystem: boolean | null
  computeNodeVisibility: 'unknown'
  hardErrors: readonly RemoteRuntimeRootHardError[]
  warnings: readonly RemoteRuntimeRootWarning[]
}

export interface ResolvedRemoteRuntimeRoot {
  source: RemoteRuntimeRootSource
  configured: string
}

export type RemoteRuntimeRootProfileCheckState = 'ok' | 'warning' | 'error' | 'unknown'

export type RemoteMicromambaProfileStatus =
  'unchecked' | 'not-installed' | 'installed' | 'outdated' | 'unusable'

export type RemoteMicromambaDownloadTool = 'curl' | 'wget'

export type RemoteMicromambaDownloadCapability =
  | { status: 'reachable'; tool: RemoteMicromambaDownloadTool; host: string }
  | { status: 'unreachable' | 'no-tool' }

export type RemoteMicromambaCapabilityProfile = (
  | { status: 'unchecked' | 'not-installed' }
  | { status: 'installed' | 'outdated' | 'unusable'; version: string }
) & { download?: RemoteMicromambaDownloadCapability }

export type RemoteRipgrepCapabilityProfile =
  { status: 'unchecked' | 'not-installed' } | { status: 'system' | 'managed'; version: string }

export interface RemoteRuntimeRootCapabilityProfile {
  source: RemoteRuntimeRootSource
  checkedAt: string
  status: RemoteRuntimeRootCheckStatus
  hasHardError: boolean
  warningCodes: readonly RemoteRuntimeRootWarningCode[]
  micromamba?: RemoteMicromambaCapabilityProfile
  ripgrep?: RemoteRipgrepCapabilityProfile
  checks: {
    pathResolution: RemoteRuntimeRootProfileCheckState
    creation: RemoteRuntimeRootProfileCheckState
    ownership: RemoteRuntimeRootProfileCheckState
    permissions: RemoteRuntimeRootProfileCheckState
    filesystem: RemoteRuntimeRootProfileCheckState
    space: RemoteRuntimeRootProfileCheckState
    executable: RemoteRuntimeRootProfileCheckState
    sharedFilesystem: RemoteRuntimeRootProfileCheckState
  }
}
