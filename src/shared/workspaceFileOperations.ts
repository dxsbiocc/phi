import type { RemoteWorkspaceFileRequest } from './remoteWorkspacePath'
import type { WrapperResultDownloadResult } from './wrapperResultTypes'

export type WorkspaceFileOperationTarget =
  | { kind: 'local'; rootPath: string; path: string }
  | ({ kind: 'remote' } & RemoteWorkspaceFileRequest)

export type WorkspaceFileRenameRequest = WorkspaceFileOperationTarget & { newName: string }

export type RemoteWorkspaceFileDownloadRequest = RemoteWorkspaceFileRequest & { requestId: string }

export interface WorkspaceFileOperationsRendererApi {
  renameWorkspaceFile: (request: WorkspaceFileRenameRequest) => Promise<{ path: string }>
  deleteWorkspaceFile: (request: WorkspaceFileOperationTarget) => Promise<void>
  downloadRemoteWorkspaceFile: (
    request: RemoteWorkspaceFileDownloadRequest
  ) => Promise<WrapperResultDownloadResult>
}
