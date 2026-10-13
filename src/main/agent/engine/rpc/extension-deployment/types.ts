import type { RemoteUploadFileOptions } from '../../../transfer/remote-upload-types'
import type { TransferEvent } from '../../../transfer/types'
import type { WorkspaceHost } from '../../../workspace-host/types'
import type { RemoteStdioProcess } from '../../../wrappers/remote-ssh-session'

export interface PhiExtensionFile {
  readonly path: string
  readonly sha256: string
  readonly bytes: Buffer
}

export interface PhiExtensionBundle {
  readonly contentHash: string
  readonly entryPoint: 'rpc-entry.ts'
  readonly files: readonly PhiExtensionFile[]
}

export interface ExtensionDeploymentProgress {
  readonly phase: 'checking' | 'uploading' | 'verifying' | 'ready'
  readonly file?: string
  readonly transfer?: TransferEvent
}

export interface ExtensionDeploymentOptions {
  runtimeHost: WorkspaceHost
  runtimeRoot: string
  cacheDir: string
  /** Existing connected session capability; this owns only the lock's stdio channel. */
  openLockStdio: (command: string) => Promise<RemoteStdioProcess>
  bundle: PhiExtensionBundle
  signal?: AbortSignal
  onProgress?: (event: ExtensionDeploymentProgress) => void
  uploadOptions?: Pick<
    RemoteUploadFileOptions,
    'hostKey' | 'workspaceId' | 'coordinator' | 'agentDir' | 'helperConnect' | 'timeoutMs'
  >
}

export interface PhiExtensionDeployment {
  readonly contentHash: string
  readonly directory: string
  readonly entryPath: string
  readonly reused: boolean
}
