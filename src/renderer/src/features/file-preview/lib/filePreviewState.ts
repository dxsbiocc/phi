import { directoryIconForPath, fileIconForPath, type FileIconMeta } from '../../../icons'
import type { DirectoryListing, FilePreview } from '../../../types'

export type FilePreviewPanelState =
  | { status: 'loading'; path: string; pathKind?: 'file' | 'directory' }
  | { status: 'ready'; file: FilePreview }
  | { status: 'directory'; directory: DirectoryListing }
  | { status: 'error'; path: string; message: string; pathKind?: 'file' | 'directory' }

export type FileDownloadState =
  | {
      status: 'running'
      requestId: string
      sourcePath: string
      phase: 'choosing' | 'downloading' | 'verifying' | 'saving'
      bytesDownloaded: number
      totalBytes: number
    }
  | {
      status: 'saved'
      sourcePath: string
      path: string
      bytes: number
      remoteDigestVerified?: boolean
    }
  | { status: 'error'; sourcePath: string; message: string }

export type DefaultAppIconMode = 'native' | 'extension'

const OFFICE_DRAFT_EXTENSION_PATTERN = /\.(?:xlsx|docx|pptx)$/i

export function isOfficeDraftFilePath(path: string): boolean {
  const normalizedPath = path.replaceAll('\\', '/')
  return (
    /(?:^|\/)artifacts\/office\/[^/]+\/[^/]+$/.test(normalizedPath) &&
    OFFICE_DRAFT_EXTENSION_PATTERN.test(normalizedPath)
  )
}

export function defaultAppIconMode(
  path: string,
  pathKind: 'file' | 'directory'
): DefaultAppIconMode {
  if (pathKind !== 'file') return 'native'
  return isOfficeDraftFilePath(path) ? 'extension' : 'native'
}

export function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/')
  if (index <= 0) return '/'
  return path.slice(0, index)
}

export function previewTitle(state: FilePreviewPanelState): string {
  if (state.status === 'ready') return state.file.name
  if (state.status === 'directory') return state.directory.name
  return fileNameFromPath(state.path)
}

export function previewFullPath(state: FilePreviewPanelState): string {
  if (state.status === 'directory') return state.directory.path
  return state.status === 'ready' ? state.file.path : state.path
}

export function previewDisplayPath(state: FilePreviewPanelState): string {
  if (isOfficeDraftFilePath(previewFullPath(state))) return fileNameFromPath(previewFullPath(state))
  if (state.status === 'ready') return state.file.displayPath
  if (state.status === 'directory') return state.directory.displayPath
  return fileNameFromPath(state.path)
}

function previewRootPath(state: FilePreviewPanelState): string {
  if (state.status === 'ready') return state.file.rootPath
  if (state.status === 'directory') return state.directory.rootPath
  return parentDirectory(state.path)
}

export function previewTreeRootPath(state: FilePreviewPanelState): string {
  if (state.status === 'directory') return state.directory.path
  return previewRootPath(state)
}

export function previewRootLabel(state: FilePreviewPanelState): string {
  if (isOfficeDraftFilePath(previewFullPath(state))) return 'Office 草稿'
  if (state.status === 'ready') return state.file.rootLabel
  if (state.status === 'directory') return state.directory.rootLabel
  if (state.path.startsWith('ssh://')) {
    return /^ssh:\/\/([^/]+)/.exec(state.path)?.[1] ?? '远程文件'
  }
  return fileNameFromPath(previewRootPath(state))
}

export function previewIconForState(state: FilePreviewPanelState): FileIconMeta {
  if (state.status === 'directory') return directoryIconForPath(state.directory.path, true)
  if (state.status !== 'ready' && state.pathKind === 'directory') {
    return directoryIconForPath(state.path)
  }
  return fileIconForPath(previewFullPath(state))
}
