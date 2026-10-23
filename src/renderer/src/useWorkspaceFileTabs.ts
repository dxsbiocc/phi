import { useCallback, useEffect, useRef, useState } from 'react'
import type { LocalPathKind } from './components/MarkdownContent'
import type { AnalysisWorkspaceFileTab } from './features/analysis/AnalysisView'
import type { FilePreviewPanelState } from './features/file-preview/FilePreviewPanel'
import type { FileDownloadState } from './features/file-preview/lib/filePreviewState'
import { filePreviewCopy } from './features/file-preview/lib/filePreviewUiCopy'
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
  if (!scope || !path) throw new Error(filePreviewCopy.remoteFileOutsideProject)
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
  /** Notebook tabs retain the project and conversation in which they were last opened. */
  ownerProjectId?: string | null
  ownerSessionPath?: string | null
  ownerCwd?: string
  /** Modified notebooks stay open when the reusable preview slot changes. */
  dirty?: boolean
}

function normalizedNotebookTabPath(path: string): string {
  if (!path.startsWith('/')) return path
  const segments = path.split('/').reduce<string[]>((resolved, segment) => {
    if (segment === '..') resolved.pop()
    else if (segment && segment !== '.') resolved.push(segment)
    return resolved
  }, [])
  return `/${segments.join('/')}`
}

export function notebookWorkspaceTabId(projectId: string | null, path: string): string {
  return `notebook:${JSON.stringify([projectId, normalizedNotebookTabPath(path)])}`
}

export function notebookTabsAfterScopeSwitch(tabs: WorkspaceFileTab[]): WorkspaceFileTab[] {
  return tabs.filter((tab) => tab.kind === 'notebook')
}

function upsertNotebookWorkspaceFileTab(
  tabs: WorkspaceFileTab[],
  tab: WorkspaceFileTab
): WorkspaceFileTab[] {
  const tabPath = normalizedNotebookTabPath(tab.path)
  const matches = tabs.filter(
    (item) =>
      item.kind === 'notebook' &&
      (item.id === tab.id ||
        (normalizedNotebookTabPath(item.path) === tabPath &&
          (item.ownerProjectId
            ? item.ownerProjectId === tab.ownerProjectId
            : item.ownerCwd === tab.ownerCwd)))
  )
  const retainedTabs =
    matches.some((item) => item.dirty) && tab.dirty !== false
      ? tabs
      : tabs.filter((item) => item.kind === 'notebook' || item.dirty)
  if (matches.length === 0) return [...retainedTabs, tab]
  const existingDirty = matches.some((item) => item.dirty)
    ? true
    : matches.find((item) => item.dirty !== undefined)?.dirty
  const dirty = tab.dirty ?? existingDirty
  const next = {
    ...(matches.find((item) => item.id === tab.id) ?? matches[0]),
    ...tab,
    ...(dirty === undefined ? {} : { dirty })
  }
  let inserted = false
  return retainedTabs.flatMap((item) => {
    if (!matches.includes(item)) return [item]
    if (inserted) return []
    inserted = true
    return [next]
  })
}

export function upsertReusableWorkspaceFileTab(
  tabs: WorkspaceFileTab[],
  tab: WorkspaceFileTab
): WorkspaceFileTab[] {
  if (tab.kind === 'notebook') return upsertNotebookWorkspaceFileTab(tabs, tab)
  const existing = tabs.find((item) => item.id === tab.id)
  if (existing?.dirty && tab.dirty !== false) {
    return tabs.map((item) => (item.id === tab.id ? { ...existing, ...tab, dirty: true } : item))
  }
  const next = existing
    ? {
        ...existing,
        ...tab,
        ...(tab.dirty === undefined && existing.dirty !== undefined
          ? { dirty: existing.dirty }
          : {})
      }
    : tab
  const remaining = tabs.filter(
    (item) => item.id === tab.id || item.dirty || item.kind === 'notebook'
  )
  return existing
    ? remaining.map((item) => (item.id === tab.id ? next : item))
    : [...remaining, next]
}
export type WorkspaceFilePreviewCache = Record<string, FilePreviewPanelState>
const MAX_FILE_PREVIEW_CACHE_ENTRIES = 16

/** Raw service cancellation diagnostics must stay independent of interface language. */
export function isWorkspaceFileDownloadCancellation(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === 'AbortError') ||
    /下载已取消|\b(?:cancelled|canceled|aborted|AbortError)\b/iu.test(
      readableErrorMessage(error, '')
    )
  )
}

export function cacheWorkspaceFilePreviewState(
  cache: WorkspaceFilePreviewCache,
  state: FilePreviewPanelState
): WorkspaceFilePreviewCache {
  const path = filePreviewStatePath(state)
  const next = { ...cache }
  delete next[path]
  next[path] = state
  const keys = Object.keys(next)
  if (keys.length > MAX_FILE_PREVIEW_CACHE_ENTRIES) delete next[keys[0]]
  return next
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
  setActiveView: (view: AppView) => void
}

export type WorkspaceFileTabsState = {
  filePreview: FilePreviewPanelState | null
  setFilePreview: (state: FilePreviewPanelState | null) => void
  filePreviewCache: WorkspaceFilePreviewCache
  clearCachedFilePreview: (path: string) => void
  clearFileWorkspace: (options?: { preserveNotebookTabs?: boolean }) => void
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

  const clearFileWorkspace = useCallback(
    (options: { preserveNotebookTabs?: boolean } = {}): void => {
      cancelActiveWrapperResultRead()
      abandonActiveWrapperResultDownload()
      wrapperResultScopeRef.current = null
      setActiveWrapperResultScope(null)
      setFileDownload(null)
      filePreviewRequestRef.current += 1
      setFilePreview(null)
      setFilePreviewCache({})
      setWorkspaceFileTabs((tabs) =>
        options.preserveNotebookTabs ? notebookTabsAfterScopeSwitch(tabs) : []
      )
      setActiveWorkspaceFilePath(null)
    },
    [abandonActiveWrapperResultDownload, cancelActiveWrapperResultRead]
  )

  const upsertWorkspaceFileTab = useCallback((tab: WorkspaceFileTab): void => {
    setWorkspaceFileTabs((tabs) => upsertReusableWorkspaceFileTab(tabs, tab))
    setActiveWorkspaceFilePath(tab.path)
  }, [])

  const openWorkspaceTab = useCallback(
    (tab: WorkspaceFileTab): void => {
      upsertWorkspaceFileTab(tab)
      setActiveView('analysis')
    },
    [setActiveView, upsertWorkspaceFileTab]
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
          message: readableErrorMessage(error, filePreviewCopy.accessRemoteFileFailed)
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
              message: readableErrorMessage(error, filePreviewCopy.readDirectoryFailed)
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
            message: readableErrorMessage(error, filePreviewCopy.previewFileFailed)
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
        setWorkspaceFileTabs(notebookTabsAfterScopeSwitch)
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
      if (activeDownloadIdRef.current) {
        showSnackbarError(
          new Error(filePreviewCopy.downloadInProgress),
          filePreviewCopy.startDownloadFailed
        )
        return
      }
      let route: ReturnType<typeof workspaceFileRoute>
      try {
        route = workspaceFileRoute(
          uri,
          scope?.projectId === getActiveProjectId() ? scope : null,
          getActiveRemoteProject()
        )
        if (route.kind === 'local') throw new Error(filePreviewCopy.chooseRemoteDownload)
      } catch (error) {
        showSnackbarError(error, filePreviewCopy.downloadResultFailed)
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
        const result =
          route.kind === 'remote-project'
            ? await rendererApi.downloadRemoteWorkspaceFile({ ...route.request, requestId })
            : await rendererApi.downloadWrapperResult({ ...route.request, requestId })
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
        const message = readableErrorMessage(error, filePreviewCopy.remoteDownloadFailed)
        if (isWorkspaceFileDownloadCancellation(error)) setFileDownload(null)
        else {
          setFileDownload({ status: 'error', sourcePath: uri, message })
          showSnackbarError(error, filePreviewCopy.remoteDownloadFailed)
        }
      } finally {
        if (activeDownloadIdRef.current === requestId) activeDownloadIdRef.current = null
      }
    },
    [getActiveProjectId, getActiveRemoteProject, rendererApi, showSnackbarError]
  )

  const previewFilePath = useCallback(
    (path: string): void => {
      const normalizedPath = absoluteWorkspacePath(getActiveCwd(), path)
      const alreadyVisible =
        activeWorkspaceFilePath === normalizedPath &&
        filePreview?.status !== 'error' &&
        filePreview !== null &&
        filePreviewStatePath(filePreview) === normalizedPath
      openWorkspaceTab({
        id: normalizedPath,
        path: normalizedPath,
        name: fileNameFromPath(normalizedPath),
        status: normalizedPath,
        absolutePath: normalizedPath,
        kind: 'file',
        pathKind: 'file'
      })
      if (!alreadyVisible) loadFilePreview(normalizedPath)
    },
    [activeWorkspaceFilePath, filePreview, getActiveCwd, loadFilePreview, openWorkspaceTab]
  )

  const previewDirectoryPath = useCallback(
    (path: string): void => {
      const normalizedPath = absoluteWorkspacePath(getActiveCwd(), path)
      const alreadyVisible =
        activeWorkspaceFilePath === normalizedPath &&
        filePreview?.status !== 'error' &&
        filePreview !== null &&
        filePreviewStatePath(filePreview) === normalizedPath
      openWorkspaceTab({
        id: normalizedPath,
        path: normalizedPath,
        name: fileNameFromPath(normalizedPath),
        status: normalizedPath,
        absolutePath: normalizedPath,
        kind: 'directory',
        pathKind: 'directory'
      })
      if (!alreadyVisible) loadFilePreview(normalizedPath, 'directory')
    },
    [activeWorkspaceFilePath, filePreview, getActiveCwd, loadFilePreview, openWorkspaceTab]
  )

  const openPathWithSystemDefault = useCallback(
    (path: string): void => {
      if (path.startsWith('ssh://')) {
        previewFilePath(path)
        return
      }
      void rendererApi.openPath(path).catch((error) => {
        showSnackbarError(error, filePreviewCopy.openFileFailed)
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
        showSnackbarError(error, filePreviewCopy.revealFileFailed)
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
