import { filePreviewCopy } from './filePreviewUiCopy'
import type { FileTreeEntry } from '../../../types'
import type { WorkspaceTextSaveResult } from '../../../../../shared/workspaceFileOperations'
import type { RemoteProjectFileContextValue } from '../../../lib/remoteProjectFileContext'

export const FILE_TREE_TOOLTIP_DELAY_MS = 800

export type FileTreeActions = {
  onRenameFile?: (path: string, newName: string) => Promise<void>
  onDeleteFile?: (path: string) => Promise<void>
  onDownloadFile?: (path: string) => void
  onRevealFile?: (path: string) => void
  canModifyFile?: (path: string) => boolean
  onSaveTextFile?: (
    path: string,
    content: string,
    expectedContent: string
  ) => Promise<WorkspaceTextSaveResult>
  onTextDirtyChange?: (path: string, dirty: boolean) => void
  onSaveMarkdownFile?: FileTreeActions['onSaveTextFile']
  onMarkdownDirtyChange?: FileTreeActions['onTextDirtyChange']
  onOpenDirectory?: (path: string) => void
  onReloadFile?: (path: string) => void
  markdownRemoteContext?: RemoteProjectFileContextValue | null
}

export type FileTreeAction = 'open' | 'download' | 'reveal' | 'copy' | 'rename' | 'delete'

export function fileTreeDisplayPath(entry: FileTreeEntry): string {
  if (!entry.path.startsWith('ssh://')) return entry.path
  try {
    const url = new URL(entry.path)
    return `${url.host}:${decodeURIComponent(url.pathname)}`
  } catch {
    return entry.displayPath
  }
}

export function fileTreeEntryActions(
  entry: FileTreeEntry,
  rootPath: string,
  actions?: FileTreeActions
): FileTreeAction[] {
  const remote = entry.path.startsWith('ssh://')
  const result: FileTreeAction[] = ['open']
  if (remote && entry.kind === 'file' && actions?.onDownloadFile) result.push('download')
  if (!remote && actions?.onRevealFile) result.push('reveal')
  result.push('copy')
  if (entry.path !== rootPath && (actions?.canModifyFile?.(entry.path) ?? true)) {
    if (actions?.onRenameFile) result.push('rename')
    if (actions?.onDeleteFile) result.push('delete')
  }
  return result
}

export function fileTreeRenameError(name: string): string {
  if (!name.trim()) return filePreviewCopy.nameRequired
  if (/\uFFFD|[\uD800-\uDFFF]/u.test(name)) return filePreviewCopy.nameInvalid
  if (new TextEncoder().encode(name).length > 255) return filePreviewCopy.nameTooLong
  if (
    name === '.' ||
    name === '..' ||
    /[/\\]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    return filePreviewCopy.nameDisallowed
  }
  return ''
}

export function fileTreeParentPath(path: string): string {
  const slash = path.lastIndexOf('/')
  if (path.startsWith('ssh://') && slash === path.indexOf('/', 'ssh://'.length)) {
    return path.slice(0, slash + 1)
  }
  return slash === 0 ? '/' : path.slice(0, slash)
}

export function fileTreePathInSubtree(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent.replace(/\/+$/, '')}/`)
}
