import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalPathKind } from './components/MarkdownContent'
import type { AnalysisWorkspaceFileTab } from './features/analysis/AnalysisView'
import type { FilePreviewPanelState } from './features/file-preview/FilePreviewPanel'
import type { FileDownloadState } from './features/file-preview/lib/filePreviewState'
import { absoluteWorkspacePath, fileNameFromPath, filePreviewStatePath } from './lib/workspacePaths'
import { readableErrorMessage } from './lib/sessionNotifications'
import type { AppView } from './App'
import type { DirectoryListing, RendererApi } from './types'
import type { RemoteWorkspaceFileRequest } from '../../shared/remoteWorkspacePath'
import type { WrapperResultDirectoryRequest } from '../../shared/wrapperResultTypes'
import { remotePathWithinProjectUri } from '../../shared/remoteWorkspacePath'
import {
  wrapperResultRequestForUri,
  wrapperResultScopeChanged,
  wrapperResultUri,
  wrapperResultUriInScope,
  type WrapperResultFileScope
} from './features/wrapper/lib/resultFiles'

export type RemoteWorkspaceFileScope = {
  sessionId: string
  projectId: string
  hostAlias: string
  canonicalRoot: string
}

export function remoteFileRequestForUri(
  uri: string,
  scope: RemoteWorkspaceFileScope | null
): RemoteWorkspaceFileRequest {
  const path = scope ? remotePathWithinProjectUri(uri, scope.hostAlias, scope.canonicalRoot) : null
  if (!scope || !path) throw new Error('远程文件不属于当前项目或服务器档案不可用')
  return { sessionId: scope.sessionId, projectId: scope.projectId, path }
}

export function workspaceFileRoute(
  path: string,
  resultScope: WrapperResultFileScope | null,
  projectScope: RemoteWorkspaceFileScope | null
):
  | { kind: 'local' }
  | { kind: 'remote-project'; request: RemoteWorkspaceFileRequest }
  | { kind: 'wrapper-result'; request: WrapperResultDirectoryRequest } {
  if (!path.startsWith('ssh://')) return { kind: 'local' }
  if (resultScope && wrapperResultUriInScope(path, resultScope)) {
    return { kind: 'wrapper-result', request: wrapperResultRequestForUri(path, resultScope) }
  }
  return { kind: 'remote-project', request: remoteFileRequestForUri(path, projectScope) }
}

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
  getActiveProjectId: () => string | null
  getActiveRemoteProject: () => RemoteWorkspaceFileScope | null
  showSnackbarError: (error: unknown, fallback: string) => void
  setIsSidebarOpen: (value: boolean) => void
  setActiveView: (view: AppView) => void
}

export type WorkspaceFileTabsState = {
  filePreview: FilePreviewPanelState | null
  setFilePreview: (state: FilePreviewPanelState | null) => void
  filePreviewCache: WorkspaceFilePreviewCache
  clearCachedFilePreview: (path: string) => void
  clearFileWorkspace: () => void
  workspaceFileTabs: WorkspaceFileTab[]
  setWorkspaceFileTabs: (
    tabs: WorkspaceFileTab[] | ((prev: WorkspaceFileTab[]) => WorkspaceFileTab[])
  ) => void
  activeWorkspaceFilePath: string | null
  setActiveWorkspaceFilePath: (path: string | null) => void
  filePreviewRequestRef: { current: number }
  activeWrapperResultScope: WrapperResultFileScope | null
  isActiveWrapperResultUri: (uri: string) => boolean
  openWrapperResultPath: (
    scope: WrapperResultFileScope,
    path: string,
    pathKind: LocalPathKind
  ) => string
  cancelActiveWrapperResultRead: () => void
  fileDownload: FileDownloadState | null
  downloadWrapperResultFile: (uri: string) => Promise<void>
  cancelActiveWrapperResultDownload: () => void
  upsertWorkspaceFileTab: (tab: WorkspaceFileTab) => void
  openWorkspaceTab: (tab: WorkspaceFileTab) => void
  loadFilePreview: (path: string, pathKind?: LocalPathKind) => void
  /** Opens a plain (non-notebook) file into the preview pane and a workspace tab. */
  previewFilePath: (path: string) => void
  /** Opens a directory into the preview pane and a workspace tab. */
  previewDirectoryPath: (path: string) => void
  onRevealPreviewPath: (path: string, kind?: LocalPathKind) => void
  onListPreviewDirectory: (path: string) => Promise<DirectoryListing>
  openPathWithSystemDefault: (path: string) => void
}

export function useWorkspaceFileTabs({
  rendererApi,
  getActiveCwd,
  getActiveProjectId,
  getActiveRemoteProject,
  showSnackbarError,
  setIsSidebarOpen,
  setActiveView
}: WorkspaceFileTabsDeps): WorkspaceFileTabsState {
  const [filePreview, setFilePreview] = useState<FilePreviewPanelState | null>(null)
  const [filePreviewCache, setFilePreviewCache] = useState<WorkspaceFilePreviewCache>({})
  const [workspaceFileTabs, setWorkspaceFileTabs] = useState<WorkspaceFileTab[]>([])
  const [activeWorkspaceFilePath, setActiveWorkspaceFilePath] = useState<string | null>(null)
  const filePreviewRequestRef = useRef(0)
  const [activeWrapperResultScope, setActiveWrapperResultScope] =
    useState<WrapperResultFileScope | null>(null)
  const wrapperResultScopeRef = useRef<WrapperResultFileScope | null>(null)
  const activeResultReadIdRef = useRef<string | null>(null)
  const [fileDownload, setFileDownload] = useState<FileDownloadState | null>(null)
  const activeDownloadIdRef = useRef<string | null>(null)
  const downloadSequenceRef = useRef(0)

  const cancelActiveWrapperResultRead = useCallback((): void => {
    const requestId = activeResultReadIdRef.current
    activeResultReadIdRef.current = null
    if (requestId) void rendererApi.cancelWrapperResultRead(requestId).catch(() => undefined)
  }, [rendererApi])

  const cancelActiveWrapperResultDownload = useCallback((): void => {
    const requestId = activeDownloadIdRef.current
    if (requestId) void rendererApi.cancelWrapperResultDownload(requestId).catch(() => undefined)
  }, [rendererApi])

  const abandonActiveWrapperResultDownload = useCallback((): void => {
    cancelActiveWrapperResultDownload()
    activeDownloadIdRef.current = null
  }, [cancelActiveWrapperResultDownload])

  useEffect(
    () =>
      rendererApi.onWrapperResultDownloadProgress((progress) => {
        if (activeDownloadIdRef.current !== progress.requestId) return
        setFileDownload((current) =>
          current?.status === 'running' && current.requestId === progress.requestId
            ? {
                ...current,
                phase: progress.phase,
                bytesDownloaded: progress.bytesDownloaded,
                totalBytes: progress.totalBytes
              }
            : current
        )
      }),
    [rendererApi]
  )

  const cacheFilePreviewState = useCallback((state: FilePreviewPanelState): void => {
    setFilePreviewCache((cache) => cacheWorkspaceFilePreviewState(cache, state))
  }, [])

  const clearCachedFilePreview = useCallback((path: string): void => {
    setFilePreviewCache((cache) => removeWorkspaceFilePreviewState(cache, path))
  }, [])

  const clearFileWorkspace = useCallback((): void => {
    cancelActiveWrapperResultRead()
    abandonActiveWrapperResultDownload()
    wrapperResultScopeRef.current = null
    setActiveWrapperResultScope(null)
    setFileDownload(null)
    filePreviewRequestRef.current += 1
    setFilePreview(null)
    setFilePreviewCache({})
    setWorkspaceFileTabs([])
    setActiveWorkspaceFilePath(null)
  }, [abandonActiveWrapperResultDownload, cancelActiveWrapperResultRead])

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
      cancelActiveWrapperResultRead()
      const requestId = ++filePreviewRequestRef.current
      let route: ReturnType<typeof workspaceFileRoute>
      try {
        const scope = wrapperResultScopeRef.current
        route = workspaceFileRoute(
          path,
          scope?.projectId === getActiveProjectId() ? scope : null,
          getActiveRemoteProject()
        )
      } catch (error) {
        setFilePreview({
          status: 'error',
          path,
          pathKind,
          message: readableErrorMessage(error, '无法访问远程文件')
        })
        return
      }
      const resultRequest = route.kind === 'wrapper-result' ? route.request : null
      const remoteRequest = route.kind === 'remote-project' ? route.request : null
      if (pathKind === 'directory') {
        setFilePreview({ status: 'loading', path, pathKind: 'directory' })
        void (
          resultRequest
            ? rendererApi.listWrapperResultDirectory(resultRequest)
            : remoteRequest
              ? rendererApi.listRemoteWorkspaceDirectory(remoteRequest)
              : rendererApi.listDirectory(path)
        )
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
      const resultReadId = resultRequest ? `result_${Date.now()}_${requestId}` : null
      if (resultReadId) activeResultReadIdRef.current = resultReadId
      void (
        resultRequest && resultReadId
          ? rendererApi.previewWrapperResult({ ...resultRequest, requestId: resultReadId })
          : remoteRequest
            ? rendererApi.previewRemoteWorkspaceFile(remoteRequest)
            : rendererApi.previewFile(path)
      )
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
        .finally(() => {
          if (activeResultReadIdRef.current === resultReadId) activeResultReadIdRef.current = null
        })
    },
    [
      cacheFilePreviewState,
      cancelActiveWrapperResultRead,
      getActiveRemoteProject,
      getActiveProjectId,
      rendererApi,
      upsertWorkspaceFileTab
    ]
  )

  const isActiveWrapperResultUri = useCallback(
    (uri: string): boolean => {
      const scope = wrapperResultScopeRef.current
      return scope?.projectId === getActiveProjectId() && wrapperResultUriInScope(uri, scope)
    },
    [getActiveProjectId]
  )

  const openWrapperResultPath = useCallback(
    (scope: WrapperResultFileScope, path: string, pathKind: LocalPathKind): string => {
      const uri = wrapperResultUri(scope, path)
      const current = wrapperResultScopeRef.current
      if (wrapperResultScopeChanged(current, scope)) {
        cancelActiveWrapperResultRead()
        abandonActiveWrapperResultDownload()
        setFileDownload(null)
        filePreviewRequestRef.current += 1
        setFilePreview(null)
        setFilePreviewCache({})
        setWorkspaceFileTabs([])
        setActiveWorkspaceFilePath(null)
      }
      wrapperResultScopeRef.current = scope
      setActiveWrapperResultScope(scope)
      openWorkspaceTab({
        id: uri,
        path: uri,
        name: fileNameFromPath(uri),
        status: uri,
        absolutePath: uri,
        kind: pathKind,
        pathKind
      })
      loadFilePreview(uri, pathKind)
      return uri
    },
    [
      abandonActiveWrapperResultDownload,
      cancelActiveWrapperResultRead,
      loadFilePreview,
      openWorkspaceTab
    ]
  )

  const downloadWrapperResultFile = useCallback(
    async (uri: string): Promise<void> => {
      const scope = wrapperResultScopeRef.current
      if (!scope || scope.projectId !== getActiveProjectId()) {
        showSnackbarError(new Error('远程运行不属于当前项目'), '无法下载结果')
        return
      }
      if (activeDownloadIdRef.current) {
        showSnackbarError(new Error('已有文件正在下载'), '无法开始新下载')
        return
      }
      let request: ReturnType<typeof wrapperResultRequestForUri>
      try {
        request = wrapperResultRequestForUri(uri, scope)
      } catch (error) {
        showSnackbarError(error, '无法下载结果')
        return
      }
      const requestId = `download_${Date.now()}_${++downloadSequenceRef.current}`
      activeDownloadIdRef.current = requestId
      setFileDownload({
        status: 'running',
        requestId,
        sourcePath: uri,
        phase: 'choosing',
        bytesDownloaded: 0,
        totalBytes: 0
      })
      try {
        const result = await rendererApi.downloadWrapperResult({ ...request, requestId })
        if (activeDownloadIdRef.current !== requestId) return
        setFileDownload(
          result.status === 'cancelled'
            ? null
            : {
                status: 'saved',
                sourcePath: uri,
                path: result.path,
                bytes: result.bytes,
                remoteDigestVerified: result.remoteDigestVerified
              }
        )
      } catch (error) {
        if (activeDownloadIdRef.current !== requestId) return
        const message = readableErrorMessage(error, '远程文件下载失败')
        if (/下载已取消|aborted/i.test(message)) setFileDownload(null)
        else {
          setFileDownload({ status: 'error', sourcePath: uri, message })
          showSnackbarError(error, '远程文件下载失败')
        }
      } finally {
        if (activeDownloadIdRef.current === requestId) activeDownloadIdRef.current = null
      }
    },
    [getActiveProjectId, rendererApi, showSnackbarError]
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
      if (path.startsWith('ssh://')) {
        previewFilePath(path)
        return
      }
      void rendererApi.openPath(path).catch((error) => {
        showSnackbarError(error, '无法打开文件')
      })
    },
    [previewFilePath, rendererApi, showSnackbarError]
  )

  const onRevealPreviewPath = useCallback(
    (path: string, kind: LocalPathKind = 'file'): void => {
      if (path.startsWith('ssh://')) {
        if (kind === 'directory') previewDirectoryPath(path)
        else previewFilePath(path)
        return
      }
      void rendererApi.revealPath(path).catch((error) => {
        showSnackbarError(error, '无法在文件管理器中显示')
      })
    },
    [previewDirectoryPath, previewFilePath, rendererApi, showSnackbarError]
  )

  const onListPreviewDirectory = useCallback(
    (path: string): Promise<DirectoryListing> => {
      if (!path.startsWith('ssh://')) return rendererApi.listDirectory(path)
      try {
        const scope = wrapperResultScopeRef.current
        const route = workspaceFileRoute(
          path,
          scope?.projectId === getActiveProjectId() ? scope : null,
          getActiveRemoteProject()
        )
        return route.kind === 'wrapper-result'
          ? rendererApi.listWrapperResultDirectory(route.request)
          : route.kind === 'remote-project'
            ? rendererApi.listRemoteWorkspaceDirectory(route.request)
            : rendererApi.listDirectory(path)
      } catch (error) {
        return Promise.reject(error)
      }
    },
    [getActiveProjectId, getActiveRemoteProject, rendererApi]
  )

  return {
    filePreview,
    setFilePreview,
    filePreviewCache,
    clearCachedFilePreview,
    clearFileWorkspace,
    workspaceFileTabs,
    setWorkspaceFileTabs,
    activeWorkspaceFilePath,
    setActiveWorkspaceFilePath,
    filePreviewRequestRef,
    activeWrapperResultScope,
    isActiveWrapperResultUri,
    openWrapperResultPath,
    cancelActiveWrapperResultRead,
    fileDownload,
    downloadWrapperResultFile,
    cancelActiveWrapperResultDownload,
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
