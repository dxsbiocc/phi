import type { WrapperRunPlan } from './wrapperTypes'

export type RemoteProjectUploadStatus =
  'queued' | 'uploading' | 'verifying' | 'completed' | 'failed' | 'cancelled'

export type RemoteProjectUploadFileResolution = 'pending' | 'uploaded' | 'reused' | 'renamed'

export interface RemoteProjectUploadFile {
  localPath: string
  relativePath: string
  name: string
  size: number
  sha256: string
  destinationPath?: string
  originalDestinationPath?: string
  resolution: RemoteProjectUploadFileResolution
}

export interface RemoteProjectUploadJob {
  id: string
  status: RemoteProjectUploadStatus
  sourcePaths: readonly string[]
  destinationDirectory: string
  totalFiles: number
  totalBytes: number
  bytesTransferred: number
  bytesPerSecond: number
  requiresConfirmation: boolean
  confirmed: boolean
  files: readonly RemoteProjectUploadFile[]
  error?: string
  createdAt: number
  updatedAt: number
}

export interface PrepareRemoteProjectUploadInput {
  sourcePaths: readonly string[]
  /** POSIX path relative to the remote project root. Empty means the root itself. */
  destinationDirectory?: string
}

export interface StartRemoteProjectUploadOptions {
  confirmed?: boolean
}

export interface LocalFileDropTarget {
  kind: 'chat-composer' | 'wrapper-input' | 'remote-file-tree'
  path?: string
}

export interface RemoteProjectUploadRendererApi {
  pickLocalUploadFiles: () => Promise<string[]>
  prepareRemoteProjectUpload: (
    projectId: string,
    input: PrepareRemoteProjectUploadInput
  ) => Promise<RemoteProjectUploadJob>
  startRemoteProjectUpload: (
    projectId: string,
    jobId: string,
    options?: StartRemoteProjectUploadOptions
  ) => Promise<RemoteProjectUploadJob>
  listRemoteProjectUploads: () => Promise<RemoteProjectUploadJob[]>
  cancelRemoteProjectUpload: (jobId: string) => Promise<void>
  retryRemoteProjectUpload: (jobId: string) => Promise<RemoteProjectUploadJob>
  onRemoteProjectUploadsChanged: (cb: (job: RemoteProjectUploadJob) => void) => () => void
  completeWrapperInputUpload: (
    jobId: string,
    planId: string,
    inputId: string,
    expectedRevision: number
  ) => Promise<WrapperRunPlan>
  onInputFilesDropped: (cb: (paths: string[], target: LocalFileDropTarget) => void) => () => void
}
