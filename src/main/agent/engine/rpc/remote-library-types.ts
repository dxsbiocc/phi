import type { LibraryToolAction } from '../../library/library-tools'
import type { RemoteRuntimeWorkspace } from '../../remote-runtime/types'
import type { RemoteStdioProcess } from '../../wrappers/remote-ssh-session'

export const REMOTE_LIBRARY_MAX_INDEX_BYTES = 4 * 1024 * 1024
export const REMOTE_LIBRARY_MAX_PAPER_BYTES = 512 * 1024
export const REMOTE_LIBRARY_MAX_REQUEST_BYTES = 256 * 1024
export interface RemoteLibraryIdentity {
  readonly runtimeSessionId: string
  readonly sessionId: string
  readonly projectId: string
}
export interface RemoteLibraryRequest extends RemoteLibraryIdentity {
  readonly requestId: string
  readonly toolCallId: string
  readonly action: LibraryToolAction
  readonly input: Record<string, unknown>
}
export interface RemoteLibraryTarget {
  /** Operation-owned lease; service calls close when present. Omit close for externally owned hosts. */
  readonly workspace: RemoteRuntimeWorkspace
  /** The same selected project's owned SSH stdio capability, never another host/master. */
  readonly openLockStdio: (command: string) => Promise<RemoteStdioProcess>
}
export class RemoteLibraryError extends Error {
  constructor(
    readonly code:
      | 'PATH_INVALID'
      | 'PERMISSION_DENIED'
      | 'FILE_INVALID'
      | 'LIMIT_EXCEEDED'
      | 'IDENTITY_MISMATCH'
      | 'STORAGE_FAILED'
      | 'COMMIT_UNCONFIRMED',
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'RemoteLibraryError'
  }
}
