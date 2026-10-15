import { useCallback, useLayoutEffect, useMemo, useRef } from 'react'
import type { WorkspaceFileOperationTarget } from '../../../../../shared/workspaceFileOperations'
import {
  remoteFileRequestForUri,
  type RemoteWorkspaceFileScope,
  type WorkspaceFileTabsState
} from '../../../useWorkspaceFileTabs'
import type { RendererApi } from '../../../types'
import { filePreviewStatePath } from '../../../lib/workspacePaths'
import { fileTreePathInSubtree, type FileTreeActions } from '../lib/fileTreeActions'
import { assertWorkspaceFilesSaved, renamedWorkspacePath } from '../lib/workspaceFileMutations'

type FileWorkspace = Pick<
  WorkspaceFileTabsState,
  | 'filePreview'
  | 'filePreviewCache'
  | 'workspaceFileTabs'
  | 'activeWorkspaceFilePath'
  | 'setFilePreview'
  | 'clearCachedFilePreview'
  | 'setWorkspaceFileTabs'
  | 'setActiveWorkspaceFilePath'
  | 'filePreviewRequestRef'
>

export function useWorkspaceFileActions({
  rootPath,
  rendererApi,
  getActiveCwd,
  getActiveRemoteProject,
  workspace,
  onChanged,
  onOpenFile,
  onOpenDirectory,
  onDownloadFile,
  onRevealFile,
  onNotice
}: {
  rootPath: string
  rendererApi: RendererApi
  getActiveCwd: () => string
  getActiveRemoteProject: () => RemoteWorkspaceFileScope | null
  workspace: FileWorkspace
  onChanged: () => void
  onOpenFile: (path: string) => void
  onOpenDirectory: (path: string) => void
  onDownloadFile: (path: string) => void
  onRevealFile: (path: string) => void
  onNotice?: (message: string) => void
}): FileTreeActions {
  const latest = useRef(workspace)
  const currentRoot = useRef(rootPath)
  useLayoutEffect(() => {
    latest.current = workspace
    currentRoot.current = rootPath
  }, [workspace, rootPath])

  const targetForPath = useCallback(
    (path: string): WorkspaceFileOperationTarget => {
      if (
        !rootPath ||
        currentRoot.current !== rootPath ||
        path === rootPath ||
        !fileTreePathInSubtree(path, rootPath)
      ) {
        throw new Error('文件不属于当前工作空间，或工作空间已切换。')
      }
      if (path.startsWith('ssh://')) {
        return { kind: 'remote', ...remoteFileRequestForUri(path, getActiveRemoteProject()) }
      }
      if (getActiveRemoteProject() || getActiveCwd() !== rootPath) {
        throw new Error('本地文件不属于当前工作空间。')
      }
      return { kind: 'local', rootPath, path }
    },
    [getActiveCwd, getActiveRemoteProject, rootPath]
  )

  const mutate = useCallback(
    async (path: string, newName?: string): Promise<void> => {
      const target = targetForPath(path)
      const identity = JSON.stringify([getActiveCwd(), getActiveRemoteProject()])
      assertWorkspaceFilesSaved(path, latest.current.workspaceFileTabs)
      const destination =
        newName === undefined
          ? (await rendererApi.deleteWorkspaceFile(target), null)
          : (await rendererApi.renameWorkspaceFile({ ...target, newName })).path
      if (
        identity !== JSON.stringify([getActiveCwd(), getActiveRemoteProject()]) ||
        currentRoot.current !== rootPath
      )
        return

      const state = latest.current
      const activeTab = state.workspaceFileTabs.find(
        (tab) => tab.path === state.activeWorkspaceFilePath
      )
      const affectedActive =
        activeTab && !activeTab.dirty && fileTreePathInSubtree(activeTab.path, path)
          ? activeTab
          : null
      if (
        state.workspaceFileTabs.some((tab) => tab.dirty && fileTreePathInSubtree(tab.path, path))
      ) {
        onNotice?.('文件操作已完成；操作期间产生的未保存笔记本仍保留在标签页中，请另存以保留修改。')
      }
      // Successful mutations invalidate parents' listings as well as descendant previews.
      for (const cachedPath of Object.keys(state.filePreviewCache)) {
        if (fileTreePathInSubtree(cachedPath, path) || fileTreePathInSubtree(path, cachedPath)) {
          state.clearCachedFilePreview(cachedPath)
        }
      }
      state.setWorkspaceFileTabs((tabs) =>
        tabs.filter((tab) => tab.dirty || !fileTreePathInSubtree(tab.path, path))
      )
      if (
        state.filePreview &&
        fileTreePathInSubtree(filePreviewStatePath(state.filePreview), path)
      ) {
        state.filePreviewRequestRef.current += 1
        state.setFilePreview(null)
      }
      if (affectedActive) {
        state.setActiveWorkspaceFilePath(null)
        if (destination) {
          const nextPath = renamedWorkspacePath(affectedActive.path, path, destination)
          if (affectedActive.pathKind === 'directory') onOpenDirectory(nextPath)
          else onOpenFile(nextPath)
        }
      }
      onChanged()
    },
    [
      getActiveCwd,
      getActiveRemoteProject,
      onChanged,
      onOpenDirectory,
      onOpenFile,
      onNotice,
      rendererApi,
      rootPath,
      targetForPath
    ]
  )

  return useMemo(
    () => ({
      canModifyFile: (path: string): boolean => {
        try {
          targetForPath(path)
          return true
        } catch {
          return false
        }
      },
      onRenameFile: (path: string, name: string) => mutate(path, name),
      onDeleteFile: (path: string) => mutate(path),
      onDownloadFile,
      onRevealFile
    }),
    [mutate, onDownloadFile, onRevealFile, targetForPath]
  )
}
