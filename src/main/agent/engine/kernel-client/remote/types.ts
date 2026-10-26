import type { RemoteUploadFileOptions } from '../../../transfer/remote-upload-types'
import type { RemoteHelperInstallation } from '../../../remote-helper-marker'
import type {
  CommandResult,
  HostCapabilityProfile,
  HostCommand,
  RunCommandOptions
} from '../../../workspace-host/types'

export type RemoteKernelVariant = 'modern' | 'baseline'

export interface RemoteKernelProfile {
  readonly os: 'linux'
  readonly arch: 'x64'
  readonly libc: 'glibc'
  readonly glibcVersion?: string
  readonly variant: RemoteKernelVariant
}

/** The small WorkspaceHost surface needed by kernel deployment. */
export interface RemoteKernelDeploymentHost {
  exec: {
    run(command: HostCommand, options: RunCommandOptions): Promise<CommandResult>
  }
  transfer?: {
    uploadFile(
      localPath: string,
      remotePath: string,
      options?: RemoteUploadFileOptions
    ): Promise<void>
  }
  capabilities(): HostCapabilityProfile
  /** Existing marker-backed helper installation, if one is already known. */
  managedRemoteHelper?(): RemoteHelperInstallation | undefined
  /** Reuse the WorkspaceHost helper installer; never create a second deployment path here. */
  ensureManagedRemoteHelper?(options?: {
    force?: boolean
  }): Promise<RemoteHelperInstallation | undefined>
  managedRemoteHelperFailure?(): string | undefined
}

export type RemoteKernelErrorCode =
  | 'INVALID_ARGUMENT'
  | 'INVALID_MANIFEST'
  | 'UNSUPPORTED_PLATFORM'
  | 'HASH_MISMATCH'
  | 'TRANSFER_STALLED'
  | 'PERMISSION_DENIED'
  | 'INSUFFICIENT_SPACE'
  | 'REMOTE_COMMAND_FAILED'
  | 'STDIO_UNAVAILABLE'
  | 'HELPER_UNAVAILABLE'
  | 'LAUNCH_FAILED'

export class RemoteKernelError extends Error {
  constructor(
    readonly code: RemoteKernelErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RemoteKernelError'
  }
}

export interface KernelBuildManifestFile {
  readonly name: string
  readonly role: 'kernel' | 'native'
  readonly variant?: RemoteKernelVariant
  readonly sha256: string
  readonly size: number
}

export interface KernelBuildManifest {
  readonly phiVersion: string
  readonly ompVersion: string
  readonly nativeVersion: string
  readonly bunVersion: string
  readonly target: 'linux-x64'
  readonly files: readonly KernelBuildManifestFile[]
}

export interface RemoteKernelDeploymentProgress {
  readonly phase: 'checking' | 'uploading' | 'verifying' | 'ready'
  readonly file?: 'kernel' | 'native'
  readonly variant?: RemoteKernelVariant
}

export interface RemoteKernelDeploymentOptions {
  readonly runtimeHost: RemoteKernelDeploymentHost
  readonly runtimeRoot: string
  readonly buildDirectory: string
  readonly signal?: AbortSignal
  readonly onProgress?: (progress: RemoteKernelDeploymentProgress) => void
  readonly uploadOptions?: Pick<
    RemoteUploadFileOptions,
    | 'hostKey'
    | 'workspaceId'
    | 'coordinator'
    | 'agentDir'
    | 'helperConnect'
    | 'timeoutMs'
    | 'onPhaseTiming'
  >
}

export interface RemoteKernelDeployment {
  readonly phiVersion: string
  readonly kernelSha256: string
  readonly runtimeRoot: string
  readonly executablePath: string
  readonly nativePath: string
  readonly homePath: string
  readonly agentDir: string
  readonly profile: RemoteKernelProfile
  readonly variant: RemoteKernelVariant
  readonly reused: boolean
  /** Logical remote exec commands; streaming uploads are reported separately by their transport. */
  readonly remoteCommandCount: number
}
