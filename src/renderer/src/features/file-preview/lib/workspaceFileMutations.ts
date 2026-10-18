import { filePreviewCopy } from './filePreviewUiCopy'
import { fileTreePathInSubtree } from './fileTreeActions'

export function renamedWorkspacePath(path: string, source: string, destination: string): string {
  return fileTreePathInSubtree(path, source) ? `${destination}${path.slice(source.length)}` : path
}

export function assertWorkspaceFilesSaved(
  source: string,
  tabs: ReadonlyArray<{ path: string; dirty?: boolean }>
): void {
  if (tabs.some((tab) => tab.dirty && fileTreePathInSubtree(tab.path, source))) {
    throw new Error(filePreviewCopy.unsavedMutation)
  }
}
