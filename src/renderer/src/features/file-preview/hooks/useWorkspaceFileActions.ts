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
import type { WorkspaceTextSaveResult } from '../../../../../shared/workspaceFileOperations'
import type { RemoteProjectFileContextValue } from '../../../lib/remoteProjectFileContext'

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
  onReloadFile,
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
  onReloadFile?: (path: string) => void
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
        onNotice?.('文件操作已完成；操作期间产生的未保存修改仍保留在标签页中，请另存以保留修改。')
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

  const saveTextFile = useCallback(
    async (
      path: string,
      content: string,
      expectedContent: string
    ): Promise<WorkspaceTextSaveResult> => {
      const target = targetForPath(path)
      const identity = JSON.stringify([getActiveCwd(), getActiveRemoteProject()])
      const before = latest.current
      const cached = before.filePreviewCache[path]
      const initial =
        before.filePreview?.status === 'ready' && before.filePreview.file.path === path
          ? before.filePreview
          : cached?.status === 'ready'
            ? cached
            : null
      const result = await rendererApi.saveTextFile({ ...target, content, expectedContent })
      if (
        identity !== JSON.stringify([getActiveCwd(), getActiveRemoteProject()]) ||
        currentRoot.current !== rootPath
      )
        return result
      const state = latest.current
      state.clearCachedFilePreview(path)
      if (state.filePreview && filePreviewStatePath(state.filePreview) === path) {
        state.filePreviewRequestRef.current += 1
        if (initial?.file.kind === 'text' || initial?.file.kind === 'html')
          state.setFilePreview({
            status: 'ready',
            file: {
              ...initial.file,
              content: result.content,
              bytes: result.bytes,
              previewBytes: result.bytes,
              truncated: false
            }
          })
        else onOpenFile(path)
      }
      onChanged()
      return result
    },
    [
      getActiveCwd,
      getActiveRemoteProject,
      onChanged,
      onOpenFile,
      rendererApi,
      rootPath,
      targetForPath
    ]
  )

  const textDirtyChange = useCallback((path: string, dirty: boolean): void => {
    latest.current.setWorkspaceFileTabs((tabs) =>
      tabs.map((tab) => (tab.path === path ? { ...tab, dirty } : tab))
    )
  }, [])

  const { sessionId, projectId, hostAlias, canonicalRoot } = getActiveRemoteProject() ?? {}
  const markdownRemoteContext = useMemo<RemoteProjectFileContextValue | null>(
    () =>
      sessionId && projectId && hostAlias && canonicalRoot
        ? {
            sessionId,
            projectId,
            hostAlias,
            canonicalRoot,
            remoteRoot: canonicalRoot,
            openPath: (uri, kind) => (kind === 'directory' ? onOpenDirectory(uri) : onOpenFile(uri))
          }
        : null,
    [sessionId, projectId, hostAlias, canonicalRoot, onOpenDirectory, onOpenFile]
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
      onSaveTextFile: saveTextFile,
      onSaveMarkdownFile: saveTextFile,
      onTextDirtyChange: textDirtyChange,
      onOpenDirectory,
      onReloadFile: (path: string) => {
        latest.current.clearCachedFilePreview(path)
        if (onReloadFile) onReloadFile(path)
        else onOpenFile(path)
      },
      markdownRemoteContext,
      onDownloadFile,
      onRevealFile
    }),
    [
      mutate,
      onDownloadFile,
      onRevealFile,
      targetForPath,
      saveTextFile,
      textDirtyChange,
      onOpenDirectory,
      onReloadFile,
      onOpenFile,
      markdownRemoteContext
    ]
  )
}
