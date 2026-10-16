import type { RemoteWorkspaceFileRequest } from './remoteWorkspacePath'
import type { WrapperResultDownloadResult } from './wrapperResultTypes'

export type WorkspaceFileOperationTarget =
  | { kind: 'local'; rootPath: string; path: string }
  | ({ kind: 'remote' } & RemoteWorkspaceFileRequest)

export type WorkspaceFileRenameRequest = WorkspaceFileOperationTarget & { newName: string }

export const WORKSPACE_TEXT_MAX_BYTES = 320_000
export const WORKSPACE_MARKDOWN_MAX_BYTES = WORKSPACE_TEXT_MAX_BYTES

export type WorkspaceTextSaveRequest = WorkspaceFileOperationTarget & {
  content: string
  expectedContent: string
}

export interface WorkspaceTextSaveResult {
  path: string
  content: string
  bytes: number
}

export type WorkspaceMarkdownSaveRequest = WorkspaceTextSaveRequest
export type WorkspaceMarkdownSaveResult = WorkspaceTextSaveResult

export type RemoteWorkspaceFileDownloadRequest = RemoteWorkspaceFileRequest & { requestId: string }

export interface WorkspaceFileOperationsRendererApi {
  saveTextFile: (request: WorkspaceTextSaveRequest) => Promise<WorkspaceTextSaveResult>
  saveMarkdownFile: (request: WorkspaceMarkdownSaveRequest) => Promise<WorkspaceMarkdownSaveResult>
  renameWorkspaceFile: (request: WorkspaceFileRenameRequest) => Promise<{ path: string }>
  deleteWorkspaceFile: (request: WorkspaceFileOperationTarget) => Promise<void>
  downloadRemoteWorkspaceFile: (
    request: RemoteWorkspaceFileDownloadRequest
  ) => Promise<WrapperResultDownloadResult>
}
