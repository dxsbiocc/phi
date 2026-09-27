import type { FilePreviewPanelState } from '../features/file-preview/FilePreviewPanel'

export function fileNameFromPath(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

export function absoluteWorkspacePath(cwd: string, path: string): string {
  if (!path || path.startsWith('/') || /^ssh:\/\//i.test(path)) return path
  if (!cwd) return path
  return `${cwd.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`
}

export function filePreviewStatePath(state: FilePreviewPanelState): string {
  if (state.status === 'ready') return state.file.path
  if (state.status === 'directory') return state.directory.path
  return state.path
}

export function shouldClearWorkspaceFilesForRemoteSwitch(
  previous: string | null,
  next: string | null
): boolean {
  return previous !== next && (previous !== null || next !== null)
}
