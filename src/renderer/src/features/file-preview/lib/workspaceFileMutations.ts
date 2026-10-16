import { fileTreePathInSubtree } from './fileTreeActions'

export function renamedWorkspacePath(path: string, source: string, destination: string): string {
  return fileTreePathInSubtree(path, source) ? `${destination}${path.slice(source.length)}` : path
}

export function assertWorkspaceFilesSaved(
  source: string,
  tabs: ReadonlyArray<{ path: string; dirty?: boolean }>
): void {
  if (tabs.some((tab) => tab.dirty && fileTreePathInSubtree(tab.path, source))) {
    throw new Error('此文件或文件夹中有未保存的修改，请先保存或放弃修改后再操作。')
  }
}
