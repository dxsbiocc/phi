import type { FileTreeEntry } from '../../../types'

export const FILE_TREE_TOOLTIP_DELAY_MS = 800

export type FileTreeActions = {
  onRenameFile?: (path: string, newName: string) => Promise<void>
  onDeleteFile?: (path: string) => Promise<void>
  onDownloadFile?: (path: string) => void
  onRevealFile?: (path: string) => void
  canModifyFile?: (path: string) => boolean
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
  if (!name.trim()) return '请输入名称'
  if (/\uFFFD|[\uD800-\uDFFF]/u.test(name)) return '名称包含无效字符'
  if (new TextEncoder().encode(name).length > 255) return '名称过长，请缩短到 255 字节以内'
  if (
    name === '.' ||
    name === '..' ||
    /[/\\]/.test(name) ||
    [...name].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  ) {
    return '名称不能包含路径分隔符、控制字符或使用 . 和 ..'
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
