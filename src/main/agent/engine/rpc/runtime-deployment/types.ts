import type { RemoteUploadFileOptions } from '../../../transfer/remote-upload-types'
import type { TransferEvent } from '../../../transfer/types'
import type { HostCapabilityProfile, WorkspaceHost } from '../../../workspace-host/types'
import type { RemoteOmpFailureDetail } from '../../../../../shared/errorCodes'

export interface RemoteOmpAsset {
  readonly url: string
  readonly sha256: string
  /** Pinned release size; older injected test manifests may omit it. */
  readonly size?: number
}

export interface RemoteOmpManifest {
  readonly version: string
  readonly assets: Readonly<Record<'linux-x64' | 'linux-arm64', RemoteOmpAsset>>
}

export type DeploymentErrorCode =
  | 'INVALID_ARGUMENT'
  | 'UNSUPPORTED_PLATFORM'
  | 'UNSUPPORTED_VERSION'
  | 'DOWNLOAD_FAILED'
  | 'HASH_MISMATCH'
  | 'VERSION_MISMATCH'
  | 'PERMISSION_DENIED'
  | 'INSUFFICIENT_SPACE'
  | 'REMOTE_COMMAND_FAILED'

export class RemoteOmpDeploymentError extends Error {
  readonly errorCode?: 'REMOTE_OMP_DOWNLOAD_FAILED' | 'REMOTE_OMP_HASH_MISMATCH'
  readonly errorDetail?: RemoteOmpFailureDetail

  constructor(
    readonly code: DeploymentErrorCode,
    message: string,
    options?: ErrorOptions & { errorDetail?: RemoteOmpFailureDetail }
  ) {
    super(message, options)
    this.name = 'RemoteOmpDeploymentError'
    this.errorDetail = code === 'HASH_MISMATCH' ? { cause: 'checksum' } : options?.errorDetail
    this.errorCode =
      code === 'DOWNLOAD_FAILED'
        ? 'REMOTE_OMP_DOWNLOAD_FAILED'
        : code === 'HASH_MISMATCH'
          ? 'REMOTE_OMP_HASH_MISMATCH'
          : undefined
  }
}

export interface RemoteOmpDeploymentProgress {
  readonly phase: 'checking' | 'downloading' | 'uploading' | 'verifying' | 'ready'
  readonly bytesTransferred?: number
  readonly totalBytes?: number
  readonly attempt?: number
  readonly transfer?: TransferEvent
}

export interface RemoteOmpDeploymentOptions {
  /** Already connected host, scoped to the selected server runtime root. */
  runtimeHost: WorkspaceHost
  /** Absolute, canonical, user-selected root; there is no HOME fallback. */
  runtimeRoot: string
  desktopVersion: string
  /** Phi-owned local cache directory, supplied by the desktop caller. */
  cacheDir: string
  signal?: AbortSignal
  onProgress?: (progress: RemoteOmpDeploymentProgress) => void
  uploadOptions?: Pick<
    RemoteUploadFileOptions,
    'hostKey' | 'workspaceId' | 'coordinator' | 'agentDir' | 'helperConnect' | 'timeoutMs'
  >
  /** Trusted dependencies for tests; production uses the official manifest and global fetch. */
  manifest?: RemoteOmpManifest
  fetchImpl?: typeof fetch
}

export interface RemoteOmpDeployment {
  readonly version: string
  readonly executablePath: string
  readonly homePath: string
  readonly agentDir: string
  readonly reused: boolean
}

export type RemoteOmpPlatform = HostCapabilityProfile['platform']
