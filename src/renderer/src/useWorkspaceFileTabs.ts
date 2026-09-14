import { useCallback, useRef, useState } from 'react'
import type { LocalPathKind } from './components/MarkdownContent'
import type { AnalysisWorkspaceFileTab } from './features/analysis/AnalysisView'
import type { FilePreviewPanelState } from './features/file-preview/FilePreviewPanel'
import { absoluteWorkspacePath, fileNameFromPath, filePreviewStatePath } from './lib/workspacePaths'
import { readableErrorMessage } from './lib/sessionNotifications'
import type { AppView } from './App'
import type { DirectoryListing, RendererApi } from './types'

export type WorkspaceFileTabKind = 'notebook' | 'file' | 'directory'
export type WorkspaceFileTab = AnalysisWorkspaceFileTab & {
  kind: WorkspaceFileTabKind
  pathKind: LocalPathKind
}
export type WorkspaceFilePreviewCache = Record<string, FilePreviewPanelState>

export function cacheWorkspaceFilePreviewState(
  cache: WorkspaceFilePreviewCache,
  state: FilePreviewPanelState
): WorkspaceFilePreviewCache {
  return {
    ...cache,
    [filePreviewStatePath(state)]: state
  }
}

export function removeWorkspaceFilePreviewState(
  cache: WorkspaceFilePreviewCache,
  path: string
): WorkspaceFilePreviewCache {
  if (!(path in cache)) return cache
  const next = { ...cache }
  delete next[path]
  return next
}

export type WorkspaceFileTabsDeps = {
  rendererApi: RendererApi
  getActiveCwd: () => string
  showSnackbarError: (error: unknown, fallback: string) => void
  setIsSidebarOpen: (value: boolean) => void
  setActiveView: (view: AppView) => void
}

export type WorkspaceFileTabsState = {
  filePreview: FilePreviewPanelState | null
  setFilePreview: (state: FilePreviewPanelState | null) => void
  filePreviewCache: WorkspaceFilePreviewCache
  clearCachedFilePreview: (path: string) => void
  workspaceFileTabs: WorkspaceFileTab[]
  setWorkspaceFileTabs: (
    tabs: WorkspaceFileTab[] | ((prev: WorkspaceFileTab[]) => WorkspaceFileTab[])
  ) => void
  activeWorkspaceFilePath: string | null
  setActiveWorkspaceFilePath: (path: string | null) => void
  filePreviewRequestRef: { current: number }
  upsertWorkspaceFileTab: (tab: WorkspaceFileTab) => void
  openWorkspaceTab: (tab: WorkspaceFileTab) => void
  loadFilePreview: (path: string, pathKind?: LocalPathKind) => void
  /** Opens a plain (non-notebook) file into the preview pane and a workspace tab. */
  previewFilePath: (path: string) => void
  /** Opens a directory into the preview pane and a workspace tab. */
  previewDirectoryPath: (path: string) => void
  onRevealPreviewPath: (path: string) => void
  onListPreviewDirectory: (path: string) => Promise<DirectoryListing>
  openPathWithSystemDefault: (path: string) => void
}

export function useWorkspaceFileTabs({
  rendererApi,
  getActiveCwd,
  showSnackbarError,
  setIsSidebarOpen,
  setActiveView
}: WorkspaceFileTabsDeps): WorkspaceFileTabsState {
  const [filePreview, setFilePreview] = useState<FilePreviewPanelState | null>(null)
  const [filePreviewCache, setFilePreviewCache] = useState<WorkspaceFilePreviewCache>({})
  const [workspaceFileTabs, setWorkspaceFileTabs] = useState<WorkspaceFileTab[]>([])
  const [activeWorkspaceFilePath, setActiveWorkspaceFilePath] = useState<string | null>(null)
  const filePreviewRequestRef = useRef(0)

  const cacheFilePreviewState = useCallback((state: FilePreviewPanelState): void => {
    setFilePreviewCache((cache) => cacheWorkspaceFilePreviewState(cache, state))
  }, [])

  const clearCachedFilePreview = useCallback((path: string): void => {
    setFilePreviewCache((cache) => removeWorkspaceFilePreviewState(cache, path))
  }, [])

  const upsertWorkspaceFileTab = useCallback((tab: WorkspaceFileTab): void => {
    setWorkspaceFileTabs((tabs) => {
      const existingIndex = tabs.findIndex((item) => item.path === tab.path)
      if (existingIndex === -1) return [...tabs, tab]
      return tabs.map((item, index) => (index === existingIndex ? { ...item, ...tab } : item))
    })
    setActiveWorkspaceFilePath(tab.path)
  }, [])

  const openWorkspaceTab = useCallback(
    (tab: WorkspaceFileTab): void => {
      upsertWorkspaceFileTab(tab)
      setIsSidebarOpen(true)
      setActiveView('analysis')
    },
    [setActiveView, setIsSidebarOpen, upsertWorkspaceFileTab]
  )

  const loadFilePreview = useCallback(
    (path: string, pathKind: LocalPathKind = 'file'): void => {
      const requestId = ++filePreviewRequestRef.current
      if (pathKind === 'directory') {
        setFilePreview({ status: 'loading', path, pathKind: 'directory' })
        void rendererApi
          .listDirectory(path)
          .then((directory) => {
            if (filePreviewRequestRef.current !== requestId) return
            const nextState = { status: 'directory', directory } satisfies FilePreviewPanelState
            setFilePreview(nextState)
            cacheFilePreviewState(nextState)
            upsertWorkspaceFileTab({
              id: directory.path,
              path: directory.path,
              name: directory.name,
              status: directory.displayPath,
              absolutePath: directory.path,
              kind: 'directory',
              pathKind: 'directory'
            })
          })
          .catch((error) => {
            if (filePreviewRequestRef.current !== requestId) return
            setFilePreview({
              status: 'error',
              path,
              pathKind: 'directory',
              message: readableErrorMessage(error, '无法读取目录')
            })
          })
        return
      }

      setFilePreview({ status: 'loading', path })
      void rendererApi
        .previewFile(path)
        .then((file) => {
          if (filePreviewRequestRef.current !== requestId) return
          const nextState = { status: 'ready', file } satisfies FilePreviewPanelState
          setFilePreview(nextState)
          cacheFilePreviewState(nextState)
          upsertWorkspaceFileTab({
            id: file.path,
            path: file.path,
            name: file.name,
            status: file.displayPath,
            absolutePath: file.path,
            kind: 'file',
            pathKind: 'file'
          })
        })
        .catch((error) => {
          if (filePreviewRequestRef.current !== requestId) return
          setFilePreview({
            status: 'error',
            path,
            message: readableErrorMessage(error, '无法预览文件')
          })
        })
    },
    [cacheFilePreviewState, rendererApi, upsertWorkspaceFileTab]
  )

  const previewFilePath = useCallback(
    (path: string): void => {
      const normalizedPath = absoluteWorkspacePath(getActiveCwd(), path)
      openWorkspaceTab({
        id: normalizedPath,
        path: normalizedPath,
        name: fileNameFromPath(normalizedPath),
        status: normalizedPath,
        absolutePath: normalizedPath,
        kind: 'file',
        pathKind: 'file'
      })
      loadFilePreview(normalizedPath)
    },
    [getActiveCwd, loadFilePreview, openWorkspaceTab]
  )

  const previewDirectoryPath = useCallback(
    (path: string): void => {
      const normalizedPath = absoluteWorkspacePath(getActiveCwd(), path)
      openWorkspaceTab({
        id: normalizedPath,
        path: normalizedPath,
        name: fileNameFromPath(normalizedPath),
        status: normalizedPath,
        absolutePath: normalizedPath,
        kind: 'directory',
        pathKind: 'directory'
      })
      loadFilePreview(normalizedPath, 'directory')
    },
    [getActiveCwd, loadFilePreview, openWorkspaceTab]
  )

  const openPathWithSystemDefault = useCallback(
    (path: string): void => {
      void rendererApi.openPath(path).catch((error) => {
        showSnackbarError(error, '无法打开文件')
      })
    },
    [rendererApi, showSnackbarError]
  )

  const onRevealPreviewPath = useCallback(
    (path: string): void => {
      void rendererApi.revealPath(path).catch((error) => {
        showSnackbarError(error, '无法在文件管理器中显示')
      })
    },
    [rendererApi, showSnackbarError]
  )

  const onListPreviewDirectory = useCallback(
    (path: string): Promise<DirectoryListing> => rendererApi.listDirectory(path),
    [rendererApi]
  )

  return {
    filePreview,
    setFilePreview,
    filePreviewCache,
    clearCachedFilePreview,
    workspaceFileTabs,
    setWorkspaceFileTabs,
    activeWorkspaceFilePath,
    setActiveWorkspaceFilePath,
    filePreviewRequestRef,
    upsertWorkspaceFileTab,
    openWorkspaceTab,
    loadFilePreview,
    previewFilePath,
    previewDirectoryPath,
    onRevealPreviewPath,
    onListPreviewDirectory,
    openPathWithSystemDefault
  }
}
