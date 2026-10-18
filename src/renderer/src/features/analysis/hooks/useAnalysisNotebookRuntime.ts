import { analysisCopy } from '../lib/analysisUiCopy'
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  AnalysisJupyterRuntimeStatus,
  AnalysisNotebookCompletionResult,
  AnalysisKernelDiagnostics,
  AnalysisNotebookCodeGenerationInput,
  AnalysisNotebookCodeGenerationResult,
  AnalysisNotebookDraftChange,
  AnalysisNotebookFileChange,
  AnalysisNotebookFormatResult,
  AnalysisNotebookFile,
  AnalysisNotebookRegistry,
  AnalysisNotebookSessionStatus,
  JupyterServerStatus,
  NotebookCellJumpTarget
} from '../../../types'
import { readableErrorMessage } from '../../../lib/sessionNotifications'
import { pollJupyterServerStartupStatus } from '../../runtime/lib/jupyterStatusPolling'
import { clearNotebookCellOutput, updateNotebookCell } from '../../../../../shared/notebookDocument'
import { notebookCellMetadataWithExecutionDuration } from '../../../../../shared/notebookExecutionMetadata'
import type { AnalysisNotebookAgentFocus } from '../lib/notebookCanvasTypes'
import type {
  AnalysisNotebookRuntimeDeps,
  AnalysisNotebookRuntimeState
} from '../lib/analysisNotebookRuntimeTypes'
import {
  analysisNotebookMatchesTarget,
  cacheAnalysisNotebookFile,
  jupyterServerIsReady,
  missingJupyterRuntimeHandler,
  mergeSavedAnalysisNotebook,
  notebookEnvironmentErrorMessage,
  reconcileAnalysisNotebookDiskFile,
  remoteJupyterRequiresExplicitStart,
  removeAnalysisNotebookFileCacheEntry,
  requireRendererApiMethod,
  waitForRendererDelay
} from '../lib/analysisNotebookRuntimeUtils'
import {
  dropUnconfirmedNotebookKernelSession,
  pendingNotebookKernelSession,
  upsertNotebookKernelSession
} from '../lib/notebookSession'

export function useAnalysisNotebookRuntime({
  rendererApi,
  getActiveCwd,
  showSnackbar,
  onNavigateToNotebookView
}: AnalysisNotebookRuntimeDeps): AnalysisNotebookRuntimeState {
  const [analysisNotebookRegistry, setAnalysisNotebookRegistry] =
    useState<AnalysisNotebookRegistry | null>(null)
  const [activeAnalysisNotebook, setActiveAnalysisNotebookState] =
    useState<AnalysisNotebookFile | null>(null)
  const [isLoadingAnalysisNotebooks, setIsLoadingAnalysisNotebooks] = useState(false)
  const [isOpeningAnalysisNotebook, setIsOpeningAnalysisNotebook] = useState(false)
  const [analysisNotebookError, setAnalysisNotebookError] = useState<string | null>(null)
  const [analysisNotebookContentError, setAnalysisNotebookContentError] = useState<string | null>(
    null
  )
  const [analysisKernelDiagnostics, setAnalysisKernelDiagnostics] =
    useState<AnalysisKernelDiagnostics | null>(null)
  const [isLoadingAnalysisKernels, setIsLoadingAnalysisKernels] = useState(false)
  const [analysisKernelError, setAnalysisKernelError] = useState<string | null>(null)
  const [analysisJupyterStatus, setAnalysisJupyterStatus] = useState<JupyterServerStatus | null>(
    null
  )
  const [analysisJupyterRuntimeStatus, setAnalysisJupyterRuntimeStatus] =
    useState<AnalysisJupyterRuntimeStatus | null>(null)
  const [isLoadingAnalysisJupyterRuntime, setIsLoadingAnalysisJupyterRuntime] = useState(false)
  const [analysisJupyterRuntimeError, setAnalysisJupyterRuntimeError] = useState<string | null>(
    null
  )
  const [isStartingAnalysisJupyter, setIsStartingAnalysisJupyter] = useState(false)
  const [analysisJupyterError, setAnalysisJupyterError] = useState<string | null>(null)
  const [analysisNotebookSessionStatus, setAnalysisNotebookSessionStatus] =
    useState<AnalysisNotebookSessionStatus | null>(null)
  const [isStartingAnalysisNotebookSession, setIsStartingAnalysisNotebookSession] = useState(false)
  const [closingRuntimeNotebookPath, setClosingRuntimeNotebookPath] = useState<string | null>(null)
  const [analysisNotebookSessionError, setAnalysisNotebookSessionError] = useState<string | null>(
    null
  )
  const [executingAnalysisCellId, setExecutingAnalysisCellId] = useState<string | null>(null)
  const [analysisCellExecutionError, setAnalysisCellExecutionError] = useState<string | null>(null)
  const [analysisAgentFocus, setAnalysisAgentFocus] = useState<AnalysisNotebookAgentFocus | null>(
    null
  )

  const activeAnalysisNotebookRef = useRef<AnalysisNotebookFile | null>(null)
  const analysisNotebookFileCacheRef = useRef<Map<string, AnalysisNotebookFile>>(new Map())
  const pendingAnalysisCellJumpRef = useRef<NotebookCellJumpTarget | null>(null)
  const analysisNotebooksRequestRef = useRef(0)
  const analysisNotebookOpenRequestRef = useRef(0)
  const analysisKernelsRequestRef = useRef(0)
  const analysisJupyterRequestRef = useRef(0)
  const analysisJupyterRuntimeRequestRef = useRef(0)
  const analysisNotebookSessionRequestRef = useRef(0)
  const analysisNotebookSessionReadRef = useRef(0)
  const analysisNotebookSessionEpochRef = useRef(0)
  const isStartingNotebookSessionRef = useRef(false)
  const analysisCellExecutionRequestRef = useRef(0)
  const notebookScopeEpochRef = useRef(0)
  const notebookRefreshRequestRef = useRef(0)
  const pendingNotebookSavesRef = useRef(new Map<string, string>())
  const pendingNotebookSyncsRef = useRef(new Map<string, number>())
  const notebookRegistryCwdRef = useRef<string | null>(null)
  const notebookFileCwdsRef = useRef(new WeakMap<AnalysisNotebookFile, string>())
  const notebookPathCwdsRef = useRef(new Map<string, string>())

  const setActiveAnalysisNotebook = useCallback(
    (file: AnalysisNotebookFile | null): void => {
      activeAnalysisNotebookRef.current = file
      if (file) {
        const cwd = notebookFileCwdsRef.current.get(file) ?? getActiveCwd()
        notebookFileCwdsRef.current.set(file, cwd)
        notebookPathCwdsRef.current.set(file.path, cwd)
        analysisNotebookFileCacheRef.current = cacheAnalysisNotebookFile(
          analysisNotebookFileCacheRef.current,
          file
        )
      }
      setActiveAnalysisNotebookState(file)
    },
    [getActiveCwd]
  )

  const cancelPendingNotebookSyncs = useCallback((): void => {
    pendingNotebookSyncsRef.current.forEach((timer) => window.clearTimeout(timer))
    pendingNotebookSyncsRef.current.clear()
  }, [])

  useEffect(() => cancelPendingNotebookSyncs, [cancelPendingNotebookSyncs])

  const getActiveAnalysisCwd = useCallback((): string | null => {
    const cwd = getActiveCwd()
    return cwd || null
  }, [getActiveCwd])

  const refreshAnalysisNotebooks = useCallback(async (): Promise<void> => {
    const request = ++analysisNotebooksRequestRef.current
    const cwd = getActiveCwd()
    setIsLoadingAnalysisNotebooks(true)
    setAnalysisNotebookError(null)
    try {
      const registry = await rendererApi.listAnalysisNotebooks(cwd)
      if (request !== analysisNotebooksRequestRef.current || cwd !== getActiveCwd()) return
      notebookRegistryCwdRef.current = cwd
      setAnalysisNotebookRegistry(registry)
    } catch (error) {
      if (request !== analysisNotebooksRequestRef.current) return
      setAnalysisNotebookError(readableErrorMessage(error, analysisCopy.readNotebooksFailed))
    } finally {
      if (request === analysisNotebooksRequestRef.current) {
        setIsLoadingAnalysisNotebooks(false)
      }
    }
  }, [getActiveCwd, rendererApi])

  const onInitializeProjectAnalysis = useCallback(
    async (cwd: string): Promise<void> => {
      try {
        await rendererApi.initializeProjectAnalysis(cwd)
        await refreshAnalysisNotebooks()
      } catch (error) {
        setAnalysisNotebookError(readableErrorMessage(error, analysisCopy.initializeAnalysisFailed))
      }
    },
    [refreshAnalysisNotebooks, rendererApi]
  )

  const refreshAnalysisNotebookSessionStatus = useCallback(
    async (file: AnalysisNotebookFile): Promise<void> => {
      // Reads must not share the start/stop generation. Opening a notebook
      // refreshes status and then auto-connects; sharing one counter let the
      // read cancel the connect, and the auto-connect key then stayed latched.
      const read = ++analysisNotebookSessionReadRef.current
      const epoch = analysisNotebookSessionEpochRef.current
      const cwd = getActiveAnalysisCwd()
      if (!cwd) {
        if (read !== analysisNotebookSessionReadRef.current) return
        setAnalysisNotebookSessionStatus(null)
        setAnalysisNotebookSessionError(null)
        return
      }
      setAnalysisNotebookSessionError(null)
      try {
        const status = await rendererApi.getAnalysisNotebookSessionStatus(
          cwd,
          file.path,
          file.document
        )
        if (
          read !== analysisNotebookSessionReadRef.current ||
          epoch !== analysisNotebookSessionEpochRef.current ||
          isStartingNotebookSessionRef.current ||
          cwd !== getActiveAnalysisCwd() ||
          activeAnalysisNotebookRef.current?.path !== file.path
        ) {
          return
        }
        setAnalysisNotebookSessionStatus(status)
      } catch (error) {
        if (
          read !== analysisNotebookSessionReadRef.current ||
          epoch !== analysisNotebookSessionEpochRef.current ||
          isStartingNotebookSessionRef.current ||
          activeAnalysisNotebookRef.current?.path !== file.path
        ) {
          return
        }
        setAnalysisNotebookSessionStatus(null)
        setAnalysisNotebookSessionError(readableErrorMessage(error, analysisCopy.readKernelFailed))
      }
    },
    [getActiveAnalysisCwd, rendererApi]
  )

  const onOpenAnalysisNotebook = useCallback(
    async (path: string): Promise<AnalysisNotebookFile | null> => {
      const request = ++analysisNotebookOpenRequestRef.current
      const cwd = getActiveAnalysisCwd()
      if (!cwd) {
        setIsOpeningAnalysisNotebook(false)
        setAnalysisNotebookContentError(null)
        setAnalysisNotebookSessionError(null)
        setAnalysisNotebookSessionStatus(null)
        showSnackbar(analysisCopy.chooseWorkspace, 'warning')
        return null
      }
      setIsOpeningAnalysisNotebook(true)
      setAnalysisNotebookContentError(null)
      setAnalysisNotebookSessionError(null)
      setAnalysisNotebookSessionStatus(null)
      try {
        const file = await rendererApi.openAnalysisNotebook(cwd, path)
        if (request !== analysisNotebookOpenRequestRef.current || cwd !== getActiveAnalysisCwd()) {
          return null
        }
        setActiveAnalysisNotebook(file)
        void refreshAnalysisNotebookSessionStatus(file)
        return file
      } catch (error) {
        if (request !== analysisNotebookOpenRequestRef.current) return null
        setAnalysisNotebookContentError(
          readableErrorMessage(error, analysisCopy.openNotebookFailed)
        )
        return null
      } finally {
        if (request === analysisNotebookOpenRequestRef.current) {
          setIsOpeningAnalysisNotebook(false)
        }
      }
    },
    [
      getActiveAnalysisCwd,
      refreshAnalysisNotebookSessionStatus,
      rendererApi,
      setActiveAnalysisNotebook,
      showSnackbar
    ]
  )

  const activateCachedAnalysisNotebook = useCallback(
    (path: string): AnalysisNotebookFile | null => {
      const file = analysisNotebookFileCacheRef.current.get(path) ?? null
      if (!file) return null

      analysisNotebookOpenRequestRef.current += 1
      setIsOpeningAnalysisNotebook(false)
      setAnalysisNotebookContentError(null)
      setAnalysisNotebookSessionError(null)
      setAnalysisNotebookSessionStatus(null)
      setActiveAnalysisNotebook(file)
      void refreshAnalysisNotebookSessionStatus(file)
      return file
    },
    [refreshAnalysisNotebookSessionStatus, setActiveAnalysisNotebook]
  )

  const forgetCachedAnalysisNotebook = useCallback((path: string): void => {
    analysisNotebookFileCacheRef.current = removeAnalysisNotebookFileCacheEntry(
      analysisNotebookFileCacheRef.current,
      path
    )
  }, [])

  const focusAnalysisNotebookCell = useCallback(
    (file: AnalysisNotebookFile, target: NotebookCellJumpTarget): boolean => {
      if (!analysisNotebookMatchesTarget(file, target)) return false
      if (!file.document.cells.some((cell) => cell.id === target.cellId)) {
        showSnackbar(analysisCopy.cellMissing, 'warning')
        return false
      }

      setAnalysisAgentFocus({
        requestId: `${file.path}:${file.document.revision}:${target.cellId}:jump:${Date.now()}`,
        path: file.path,
        relativePath: file.relativePath,
        cellId: target.cellId,
        changeKind: 'updated'
      })
      return true
    },
    [showSnackbar]
  )

  useEffect(() => {
    const pending = pendingAnalysisCellJumpRef.current
    if (!pending || !activeAnalysisNotebook) return
    if (!analysisNotebookMatchesTarget(activeAnalysisNotebook, pending)) return
    pendingAnalysisCellJumpRef.current = null
    focusAnalysisNotebookCell(activeAnalysisNotebook, pending)
  }, [activeAnalysisNotebook, focusAnalysisNotebookCell])

  const onSaveAnalysisNotebook = useCallback(
    async (
      file: AnalysisNotebookFile,
      document: AnalysisNotebookFile['document']
    ): Promise<AnalysisNotebookFile | false> => {
      const cwd =
        notebookFileCwdsRef.current.get(file) ??
        notebookPathCwdsRef.current.get(file.path) ??
        getActiveCwd()
      const epoch = notebookScopeEpochRef.current
      const saveKey = `${cwd}\0${file.path}`
      pendingNotebookSavesRef.current.set(saveKey, document.revision)
      if (cwd === getActiveCwd() && activeAnalysisNotebookRef.current?.path === file.path) {
        setAnalysisNotebookContentError(null)
      }
      try {
        const saved = await rendererApi.saveAnalysisNotebook(cwd, {
          path: file.path,
          document,
          expectedRevision: file.savedRevision,
          ...(file.contentHash ? { expectedHash: file.contentHash } : {})
        })
        notebookFileCwdsRef.current.set(saved, cwd)
        if (cwd !== getActiveCwd() || epoch !== notebookScopeEpochRef.current) return saved
        const current = analysisNotebookFileCacheRef.current.get(file.path)
        const next = mergeSavedAnalysisNotebook(current, saved, document.revision)
        analysisNotebookFileCacheRef.current = cacheAnalysisNotebookFile(
          analysisNotebookFileCacheRef.current,
          next
        )
        if (activeAnalysisNotebookRef.current?.path === file.path) {
          setActiveAnalysisNotebook(next)
          void refreshAnalysisNotebookSessionStatus(next)
        }
        if (next.document.revision !== saved.savedRevision) {
          // A backend save also acknowledges its submitted draft. Restore later
          // edits if the earlier debounce already fired while that write waited.
          void rendererApi
            .syncAnalysisNotebookDraft(cwd, next.path, next.document, next.savedRevision)
            .catch(() => {})
        }
        void refreshAnalysisNotebooks()
        return saved
      } catch (error) {
        if (
          cwd === getActiveCwd() &&
          epoch === notebookScopeEpochRef.current &&
          activeAnalysisNotebookRef.current?.path === file.path
        ) {
          setAnalysisNotebookContentError(
            readableErrorMessage(error, analysisCopy.saveNotebookFailed)
          )
        }
        return false
      } finally {
        if (pendingNotebookSavesRef.current.get(saveKey) === document.revision) {
          pendingNotebookSavesRef.current.delete(saveKey)
        }
      }
    },
    [
      getActiveCwd,
      refreshAnalysisNotebookSessionStatus,
      refreshAnalysisNotebooks,
      rendererApi,
      setActiveAnalysisNotebook
    ]
  )

  const onSyncAnalysisNotebookDraft = useCallback(
    async (
      file: AnalysisNotebookFile,
      document: AnalysisNotebookFile['document']
    ): Promise<void> => {
      const cwd =
        notebookFileCwdsRef.current.get(file) ??
        notebookPathCwdsRef.current.get(file.path) ??
        getActiveCwd()
      if (cwd !== getActiveCwd()) return
      const epoch = notebookScopeEpochRef.current
      const cached = analysisNotebookFileCacheRef.current.get(file.path)
      // Adopting an agent/disk snapshot in Canvas is not a new local edit.
      if (cached?.document.revision === document.revision) return
      const next = { ...(cached ?? file), document }
      analysisNotebookFileCacheRef.current = cacheAnalysisNotebookFile(
        analysisNotebookFileCacheRef.current,
        next
      )
      if (activeAnalysisNotebookRef.current?.path === file.path) {
        // The local marker is synchronous; the backend sync remains debounced.
        activeAnalysisNotebookRef.current = next
      }
      const previous = pendingNotebookSyncsRef.current.get(file.path)
      if (previous !== undefined) window.clearTimeout(previous)
      pendingNotebookSyncsRef.current.set(
        file.path,
        window.setTimeout(() => {
          pendingNotebookSyncsRef.current.delete(file.path)
          if (cwd !== getActiveCwd() || epoch !== notebookScopeEpochRef.current) return
          const latest = analysisNotebookFileCacheRef.current.get(file.path)
          if (!latest) return
          void rendererApi
            .syncAnalysisNotebookDraft(cwd, latest.path, latest.document, latest.savedRevision)
            .catch((error) => {
              if (cwd !== getActiveCwd() || epoch !== notebookScopeEpochRef.current) return
              setAnalysisNotebookContentError(
                readableErrorMessage(error, analysisCopy.syncNotebookDraftFailed)
              )
            })
        }, 300)
      )
    },
    [getActiveCwd, rendererApi]
  )

  const onCreateAnalysisNotebook = useCallback(
    async (cwd: string): Promise<void> => {
      setIsOpeningAnalysisNotebook(true)
      setAnalysisNotebookContentError(null)
      setAnalysisNotebookSessionError(null)
      setAnalysisNotebookSessionStatus(null)
      try {
        const file = await rendererApi.createAnalysisNotebook(cwd)
        setActiveAnalysisNotebook(file)
        void refreshAnalysisNotebookSessionStatus(file)
        await refreshAnalysisNotebooks()
      } catch (error) {
        setAnalysisNotebookContentError(
          readableErrorMessage(error, analysisCopy.createNotebookFailed)
        )
      } finally {
        setIsOpeningAnalysisNotebook(false)
      }
    },
    [
      refreshAnalysisNotebookSessionStatus,
      refreshAnalysisNotebooks,
      rendererApi,
      setActiveAnalysisNotebook
    ]
  )

  const onDeleteAnalysisNotebook = useCallback(
    async (file: { path: string; relativePath: string }): Promise<void> => {
      const cwd = getActiveCwd()
      setAnalysisNotebookContentError(null)
      setAnalysisNotebookSessionError(null)
      try {
        await rendererApi.deleteAnalysisNotebook(cwd, file.path)
        analysisNotebookFileCacheRef.current = removeAnalysisNotebookFileCacheEntry(
          analysisNotebookFileCacheRef.current,
          file.path
        )
        if (activeAnalysisNotebook?.path === file.path) {
          setActiveAnalysisNotebook(null)
          setAnalysisNotebookSessionStatus(null)
          setExecutingAnalysisCellId(null)
          setAnalysisCellExecutionError(null)
        }
        await refreshAnalysisNotebooks()
        showSnackbar(analysisCopy.deletedNamed(file.relativePath), 'success')
      } catch (error) {
        setAnalysisNotebookContentError(
          readableErrorMessage(error, analysisCopy.deleteNotebookFailed)
        )
      }
    },
    [
      activeAnalysisNotebook,
      getActiveCwd,
      refreshAnalysisNotebooks,
      rendererApi,
      setActiveAnalysisNotebook,
      showSnackbar
    ]
  )

  const refreshAnalysisKernels = useCallback(async (): Promise<void> => {
    const request = ++analysisKernelsRequestRef.current
    const cwd = getActiveCwd()
    setIsLoadingAnalysisKernels(true)
    setAnalysisKernelError(null)
    try {
      const listAnalysisKernels = requireRendererApiMethod(
        rendererApi,
        'listAnalysisKernels',
        analysisCopy.kernelApiUnavailable
      )
      const diagnostics = await listAnalysisKernels(cwd)
      if (request !== analysisKernelsRequestRef.current || cwd !== getActiveCwd()) return
      setAnalysisKernelDiagnostics(diagnostics)
    } catch (error) {
      if (request !== analysisKernelsRequestRef.current) return
      setAnalysisKernelError(readableErrorMessage(error, analysisCopy.checkKernelsFailed))
    } finally {
      if (request === analysisKernelsRequestRef.current) {
        setIsLoadingAnalysisKernels(false)
      }
    }
  }, [getActiveCwd, rendererApi])

  const refreshAnalysisJupyterStatus = useCallback(async (): Promise<void> => {
    const request = ++analysisJupyterRequestRef.current
    const cwd = getActiveCwd()
    if (!cwd) {
      setAnalysisJupyterStatus(null)
      setAnalysisJupyterError(null)
      return
    }

    setAnalysisJupyterError(null)
    try {
      const getAnalysisJupyterStatus = requireRendererApiMethod(
        rendererApi,
        'getAnalysisJupyterStatus',
        analysisCopy.jupyterApiUnavailable
      )
      const status = await getAnalysisJupyterStatus(cwd)
      if (request !== analysisJupyterRequestRef.current || cwd !== getActiveCwd()) return
      setAnalysisJupyterStatus(status)
    } catch (error) {
      if (request !== analysisJupyterRequestRef.current) return
      setAnalysisJupyterError(readableErrorMessage(error, analysisCopy.jupyterStatusFailed))
      setAnalysisJupyterStatus(null)
    }
  }, [getActiveCwd, rendererApi])

  const onJumpToAnalysisNotebookCell = useCallback(
    (target: NotebookCellJumpTarget): void => {
      const notebookPath = target.path ?? target.relativePath
      if (!notebookPath) {
        showSnackbar(analysisCopy.missingNotebookPath, 'warning')
        return
      }

      onNavigateToNotebookView()
      void refreshAnalysisNotebooks()
      void refreshAnalysisKernels()
      void refreshAnalysisJupyterStatus()

      const current = activeAnalysisNotebookRef.current
      if (current && focusAnalysisNotebookCell(current, target)) {
        pendingAnalysisCellJumpRef.current = null
        return
      }

      pendingAnalysisCellJumpRef.current = target
      void onOpenAnalysisNotebook(notebookPath).then((file) => {
        if (!file && pendingAnalysisCellJumpRef.current === target) {
          pendingAnalysisCellJumpRef.current = null
        }
      })
    },
    [
      focusAnalysisNotebookCell,
      onNavigateToNotebookView,
      onOpenAnalysisNotebook,
      refreshAnalysisJupyterStatus,
      refreshAnalysisKernels,
      refreshAnalysisNotebooks,
      showSnackbar
    ]
  )

  const refreshAnalysisJupyterRuntimeStatus = useCallback(async (): Promise<void> => {
    const request = ++analysisJupyterRuntimeRequestRef.current
    const cwd = getActiveAnalysisCwd()
    if (!cwd) {
      setAnalysisJupyterRuntimeStatus(null)
      setAnalysisJupyterRuntimeError(null)
      return
    }

    setIsLoadingAnalysisJupyterRuntime(true)
    setAnalysisJupyterRuntimeError(null)
    try {
      const getAnalysisJupyterRuntimeStatus =
        typeof rendererApi.getAnalysisJupyterRuntimeStatus === 'function'
          ? rendererApi.getAnalysisJupyterRuntimeStatus
          : null
      const status = getAnalysisJupyterRuntimeStatus
        ? await getAnalysisJupyterRuntimeStatus(cwd)
        : {
            server: await rendererApi.getAnalysisJupyterStatus(cwd),
            notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
          }
      if (request !== analysisJupyterRuntimeRequestRef.current || cwd !== getActiveAnalysisCwd()) {
        return
      }
      setAnalysisJupyterRuntimeStatus(status)
      setAnalysisJupyterStatus(status.server)
    } catch (error) {
      if (request !== analysisJupyterRuntimeRequestRef.current) return
      if (missingJupyterRuntimeHandler(error)) {
        try {
          const server = await rendererApi.getAnalysisJupyterStatus(cwd)
          if (
            request !== analysisJupyterRuntimeRequestRef.current ||
            cwd !== getActiveAnalysisCwd()
          ) {
            return
          }
          setAnalysisJupyterRuntimeStatus({
            server,
            notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
          })
          setAnalysisJupyterStatus(server)
          setAnalysisJupyterRuntimeError(null)
          return
        } catch (fallbackError) {
          if (request !== analysisJupyterRuntimeRequestRef.current) return
          setAnalysisJupyterRuntimeError(
            notebookEnvironmentErrorMessage(fallbackError, analysisCopy.jupyterStatusFailed)
          )
          setAnalysisJupyterRuntimeStatus(null)
          return
        }
      }
      setAnalysisJupyterRuntimeError(
        notebookEnvironmentErrorMessage(error, analysisCopy.jupyterRuntimeFailed)
      )
      setAnalysisJupyterRuntimeStatus(null)
    } finally {
      if (request === analysisJupyterRuntimeRequestRef.current) {
        setIsLoadingAnalysisJupyterRuntime(false)
      }
    }
  }, [getActiveAnalysisCwd, rendererApi])

  const onStartAnalysisJupyter = useCallback(
    async (cwd: string): Promise<void> => {
      const request = ++analysisJupyterRequestRef.current
      setIsStartingAnalysisJupyter(true)
      setAnalysisJupyterError(null)
      try {
        let status = await rendererApi.startAnalysisJupyter(cwd)
        if (request !== analysisJupyterRequestRef.current || cwd !== getActiveCwd()) return
        setAnalysisJupyterStatus(status)
        setAnalysisJupyterRuntimeStatus((previous) =>
          previous ? { ...previous, server: status } : previous
        )
        status = await pollJupyterServerStartupStatus({
          cwd,
          initialStatus: status,
          readStatus: rendererApi.getAnalysisJupyterStatus,
          delay: waitForRendererDelay,
          shouldContinue: () =>
            request === analysisJupyterRequestRef.current && cwd === getActiveCwd(),
          onStatus: (nextStatus) => {
            setAnalysisJupyterStatus(nextStatus)
            setAnalysisJupyterRuntimeStatus((previous) =>
              previous ? { ...previous, server: nextStatus } : previous
            )
          }
        })
        if (request !== analysisJupyterRequestRef.current || cwd !== getActiveCwd()) return
        setAnalysisJupyterStatus(status)
        setAnalysisJupyterRuntimeStatus((previous) =>
          previous ? { ...previous, server: status } : previous
        )
        if (status.state === 'ready' && status.hasEndpoint) await refreshAnalysisKernels()
      } catch (error) {
        if (request !== analysisJupyterRequestRef.current) return
        setAnalysisJupyterError(
          notebookEnvironmentErrorMessage(error, analysisCopy.startJupyterFailed)
        )
      } finally {
        if (request === analysisJupyterRequestRef.current) {
          setIsStartingAnalysisJupyter(false)
        }
      }
    },
    [getActiveCwd, refreshAnalysisKernels, rendererApi]
  )

  const onStopAnalysisJupyter = useCallback(
    async (cwd: string, options: { abandonUnconfirmed?: boolean } = {}): Promise<void> => {
      const request = ++analysisJupyterRequestRef.current
      setIsStartingAnalysisJupyter(true)
      setAnalysisJupyterError(null)
      try {
        const status = await rendererApi.stopAnalysisJupyter(cwd, options)
        if (request !== analysisJupyterRequestRef.current || cwd !== getActiveCwd()) return
        setAnalysisJupyterStatus(status)
        setAnalysisJupyterRuntimeStatus((previous) =>
          previous
            ? {
                server: status,
                notebooks: { activeSessionCount: 0, busySessionCount: 0, sessions: [] }
              }
            : previous
        )
        if (status.runtimeKind === 'ssh') setAnalysisKernelDiagnostics(null)
        setAnalysisNotebookSessionStatus(null)
      } catch (error) {
        if (request !== analysisJupyterRequestRef.current) return
        setAnalysisJupyterError(readableErrorMessage(error, analysisCopy.stopJupyterFailed))
      } finally {
        if (request === analysisJupyterRequestRef.current) {
          setIsStartingAnalysisJupyter(false)
        }
      }
    },
    [getActiveCwd, rendererApi]
  )

  const onStartAnalysisNotebookSession = useCallback(
    async (
      file: AnalysisNotebookFile,
      document: AnalysisNotebookFile['document']
    ): Promise<void> => {
      const request = ++analysisNotebookSessionRequestRef.current
      const cwd = getActiveCwd()
      isStartingNotebookSessionRef.current = true
      setIsStartingAnalysisNotebookSession(true)
      setAnalysisNotebookSessionError(null)
      // Drop any in-flight sidebar refresh so it cannot replace this row
      // with a snapshot from before the kernel connect started.
      analysisJupyterRuntimeRequestRef.current += 1
      setAnalysisJupyterRuntimeStatus((current) =>
        upsertNotebookKernelSession(
          current,
          pendingNotebookKernelSession({
            projectCwd: cwd,
            notebookPath: file.path,
            document,
            kernelDiagnostics: analysisKernelDiagnostics
          }),
          analysisJupyterStatus
        )
      )
      try {
        let jupyterStatus = analysisJupyterStatus
        if (!jupyterServerIsReady(jupyterStatus)) {
          if (remoteJupyterRequiresExplicitStart(jupyterStatus)) {
            throw new Error(analysisCopy.remoteJupyterFirst)
          }
          setIsStartingAnalysisJupyter(true)
          setAnalysisJupyterError(null)
          jupyterStatus = await rendererApi.startAnalysisJupyter(cwd)
          if (request !== analysisNotebookSessionRequestRef.current || cwd !== getActiveCwd()) {
            return
          }
          setAnalysisJupyterStatus(jupyterStatus)

          // Use the same startup poll window the explicit "start Jupyter" flow
          // uses (pollJupyterServerStartupStatus, ~10s) instead of a shorter,
          // separately-hand-rolled wait — a mismatch here made auto-connect
          // give up on Jupyter Server instances that were still starting.
          jupyterStatus = await pollJupyterServerStartupStatus({
            cwd,
            initialStatus: jupyterStatus,
            readStatus: rendererApi.getAnalysisJupyterStatus,
            delay: waitForRendererDelay,
            shouldContinue: () =>
              request === analysisNotebookSessionRequestRef.current && cwd === getActiveCwd(),
            onStatus: setAnalysisJupyterStatus
          })
          if (request !== analysisNotebookSessionRequestRef.current || cwd !== getActiveCwd()) {
            return
          }
        }
        const status = await rendererApi.ensureAnalysisNotebookSession(cwd, file.path, document)
        if (request !== analysisNotebookSessionRequestRef.current || cwd !== getActiveCwd()) {
          return
        }
        analysisNotebookSessionEpochRef.current += 1
        setAnalysisNotebookSessionStatus(status)
        void refreshAnalysisJupyterRuntimeStatus()
      } catch (error) {
        if (request !== analysisNotebookSessionRequestRef.current) return
        setAnalysisJupyterRuntimeStatus((current) =>
          dropUnconfirmedNotebookKernelSession(current, file.path)
        )
        setAnalysisNotebookSessionError(
          notebookEnvironmentErrorMessage(error, analysisCopy.connectKernelFailed)
        )
      } finally {
        if (request === analysisNotebookSessionRequestRef.current) {
          isStartingNotebookSessionRef.current = false
          setIsStartingAnalysisNotebookSession(false)
          setIsStartingAnalysisJupyter(false)
        }
      }
    },
    [
      analysisJupyterStatus,
      analysisKernelDiagnostics,
      getActiveCwd,
      refreshAnalysisJupyterRuntimeStatus,
      rendererApi
    ]
  )

  const onStopAnalysisNotebookSession = useCallback(
    async (file: AnalysisNotebookFile): Promise<void> => {
      const request = ++analysisNotebookSessionRequestRef.current
      const cwd = getActiveCwd()
      isStartingNotebookSessionRef.current = true
      setIsStartingAnalysisNotebookSession(true)
      setAnalysisNotebookSessionError(null)
      try {
        const status = await rendererApi.closeAnalysisNotebookSession(cwd, file.path)
        if (request !== analysisNotebookSessionRequestRef.current || cwd !== getActiveCwd()) {
          return
        }
        analysisNotebookSessionEpochRef.current += 1
        setAnalysisNotebookSessionStatus(status)
        void refreshAnalysisJupyterRuntimeStatus()
      } catch (error) {
        if (request !== analysisNotebookSessionRequestRef.current) return
        setAnalysisNotebookSessionError(
          readableErrorMessage(error, analysisCopy.disconnectKernelFailed)
        )
      } finally {
        if (request === analysisNotebookSessionRequestRef.current) {
          isStartingNotebookSessionRef.current = false
          setIsStartingAnalysisNotebookSession(false)
        }
      }
    },
    [getActiveCwd, refreshAnalysisJupyterRuntimeStatus, rendererApi]
  )

  const onStopRuntimeNotebookSession = useCallback(
    async (notebookPath: string): Promise<void> => {
      const cwd = getActiveCwd()
      if (!cwd) return
      setClosingRuntimeNotebookPath(notebookPath)
      setAnalysisNotebookSessionError(null)
      setAnalysisJupyterRuntimeError(null)
      try {
        const status = await rendererApi.closeAnalysisNotebookSession(cwd, notebookPath)
        if (cwd !== getActiveCwd()) return
        if (activeAnalysisNotebookRef.current?.path === notebookPath) {
          analysisNotebookSessionEpochRef.current += 1
          setAnalysisNotebookSessionStatus(status)
        }
        await refreshAnalysisJupyterRuntimeStatus()
      } catch (error) {
        if (cwd !== getActiveCwd()) return
        setAnalysisJupyterRuntimeError(readableErrorMessage(error, analysisCopy.stopKernelFailed))
      } finally {
        if (cwd === getActiveCwd()) {
          setClosingRuntimeNotebookPath((current) => (current === notebookPath ? null : current))
        }
      }
    },
    [getActiveCwd, refreshAnalysisJupyterRuntimeStatus, rendererApi]
  )

  const onRunAnalysisNotebookCell = useCallback(
    async (
      file: AnalysisNotebookFile,
      document: AnalysisNotebookFile['document'],
      cellId: string
    ): Promise<void> => {
      const request = ++analysisCellExecutionRequestRef.current
      const startedAt = new Date().toISOString()
      const cwd = getActiveCwd()
      setExecutingAnalysisCellId(cellId)
      setAnalysisCellExecutionError(null)
      let executionDocument = document
      try {
        executionDocument = clearNotebookCellOutput(document, cellId)
        setActiveAnalysisNotebook({ ...file, document: executionDocument })
        const executeAnalysisNotebookCell = requireRendererApiMethod(
          rendererApi,
          'executeAnalysisNotebookCell',
          analysisCopy.executeApiUnavailable
        )
        const result = await executeAnalysisNotebookCell(cwd, file.path, executionDocument, cellId)
        if (request !== analysisCellExecutionRequestRef.current || cwd !== getActiveCwd()) {
          return
        }
        setActiveAnalysisNotebook({
          ...file,
          document: result.document
        })
        setAnalysisNotebookSessionStatus(result.sessionStatus)
      } catch (error) {
        if (request !== analysisCellExecutionRequestRef.current) return
        const message = notebookEnvironmentErrorMessage(error, analysisCopy.executeCellFailed)
        setAnalysisCellExecutionError(message)
        // Without this, a failed run (timeout, lost kernel connection, stale
        // session, ...) leaves the cell showing nothing at all once the
        // running indicator clears — the only trace is a banner above the
        // cell list that's easy to miss if the user scrolled down to it.
        try {
          const cell = executionDocument.cells.find((candidate) => candidate.id === cellId)
          if (!cell) return
          const nextDocument = updateNotebookCell(executionDocument, cellId, {
            metadata: notebookCellMetadataWithExecutionDuration(cell.metadata, {
              startedAt,
              completedAt: new Date().toISOString()
            }),
            outputs: [
              {
                outputType: 'error',
                data: {},
                metadata: {},
                ename: 'ExecutionError',
                evalue: message,
                traceback: [message],
                extra: {}
              }
            ]
          })
          setActiveAnalysisNotebook({ ...file, document: nextDocument })
        } catch {
          // Cell may have been deleted/moved while executing; nothing to attach to.
        }
      } finally {
        if (request === analysisCellExecutionRequestRef.current) {
          setExecutingAnalysisCellId(null)
        }
      }
    },
    [getActiveCwd, rendererApi, setActiveAnalysisNotebook]
  )

  const onStopAnalysisNotebookCell = useCallback(
    async (file: AnalysisNotebookFile, cellId: string): Promise<void> => {
      const request = ++analysisCellExecutionRequestRef.current
      const cwd = getActiveCwd()
      setExecutingAnalysisCellId((current) => (current === cellId ? null : current))
      setAnalysisCellExecutionError(null)
      try {
        const interruptAnalysisNotebookExecution = requireRendererApiMethod(
          rendererApi,
          'interruptAnalysisNotebookExecution',
          analysisCopy.stopApiUnavailable
        )
        const status = await interruptAnalysisNotebookExecution(cwd, file.path)
        if (request !== analysisCellExecutionRequestRef.current || cwd !== getActiveCwd()) {
          return
        }
        setAnalysisNotebookSessionStatus(status)
        showSnackbar(analysisCopy.stopCellRequested, 'info')
      } catch (error) {
        if (request !== analysisCellExecutionRequestRef.current) return
        setAnalysisCellExecutionError(readableErrorMessage(error, analysisCopy.stopCellFailed))
      }
    },
    [getActiveCwd, rendererApi, showSnackbar]
  )

  const onGenerateAnalysisNotebookCode = useCallback(
    async (
      file: AnalysisNotebookFile,
      document: AnalysisNotebookFile['document'],
      input: AnalysisNotebookCodeGenerationInput
    ): Promise<AnalysisNotebookCodeGenerationResult> => {
      const generateAnalysisNotebookCode = requireRendererApiMethod(
        rendererApi,
        'generateAnalysisNotebookCode',
        analysisCopy.aiApiUnavailable
      )
      return generateAnalysisNotebookCode(getActiveCwd(), file.path, document, input)
    },
    [getActiveCwd, rendererApi]
  )

  const onCompleteAnalysisNotebookCell = useCallback(
    async (
      file: AnalysisNotebookFile,
      document: AnalysisNotebookFile['document'],
      cellId: string,
      source: string,
      cursorPosition: number
    ): Promise<AnalysisNotebookCompletionResult> => {
      const completeAnalysisNotebookCell = requireRendererApiMethod(
        rendererApi,
        'completeAnalysisNotebookCell',
        analysisCopy.completionApiUnavailable
      )
      return completeAnalysisNotebookCell(getActiveCwd(), {
        path: file.path,
        document,
        cellId,
        source,
        cursorPosition
      })
    },
    [getActiveCwd, rendererApi]
  )

  const onFormatAnalysisNotebookCell = useCallback(
    async (
      file: AnalysisNotebookFile,
      document: AnalysisNotebookFile['document'],
      cellId: string,
      source: string,
      language?: string
    ): Promise<AnalysisNotebookFormatResult> => {
      const formatAnalysisNotebookCell = requireRendererApiMethod(
        rendererApi,
        'formatAnalysisNotebookCell',
        analysisCopy.formatApiUnavailable
      )
      return formatAnalysisNotebookCell(getActiveCwd(), {
        path: file.path,
        document,
        cellId,
        source,
        language
      })
    },
    [getActiveCwd, rendererApi]
  )

  const resetAnalysisJupyterRuntimeForCwdChange = useCallback((): void => {
    notebookScopeEpochRef.current += 1
    analysisNotebookOpenRequestRef.current += 1
    notebookRefreshRequestRef.current += 1
    cancelPendingNotebookSyncs()
    pendingNotebookSavesRef.current.clear()
    notebookRegistryCwdRef.current = null
    analysisJupyterRuntimeRequestRef.current += 1
    analysisNotebookFileCacheRef.current = new Map()
    setAnalysisNotebookRegistry(null)
    setAnalysisKernelDiagnostics(null)
    setAnalysisJupyterStatus(null)
    setAnalysisJupyterRuntimeStatus(null)
    setAnalysisJupyterRuntimeError(null)
    setAnalysisNotebookSessionStatus(null)
  }, [cancelPendingNotebookSyncs])

  const closeActiveNotebook = useCallback((): void => {
    analysisNotebookOpenRequestRef.current += 1
    notebookRefreshRequestRef.current += 1
    setIsOpeningAnalysisNotebook(false)
    setActiveAnalysisNotebook(null)
    setAnalysisNotebookSessionStatus(null)
    setExecutingAnalysisCellId(null)
    setAnalysisCellExecutionError(null)
    setAnalysisNotebookContentError(null)
  }, [setActiveAnalysisNotebook])

  const handleNotebookDraftChanged = useCallback(
    (change: AnalysisNotebookDraftChange): void => {
      if (change.source === 'renderer') return
      if (
        change.projectCwd !== getActiveCwd() &&
        (notebookRegistryCwdRef.current !== getActiveCwd() ||
          change.projectCwd !== analysisNotebookRegistry?.projectCwd)
      )
        return
      const current =
        analysisNotebookFileCacheRef.current.get(change.path) ??
        analysisNotebookFileCacheRef.current.get(change.relativePath)
      if (!current) return
      if (
        pendingNotebookSyncsRef.current.has(current.path) &&
        current.document.revision !== current.savedRevision &&
        current.document.revision !== change.document.revision
      ) {
        if (activeAnalysisNotebookRef.current?.path === current.path) {
          setActiveAnalysisNotebook(current)
          setAnalysisNotebookContentError(analysisCopy.aiLocalConflict)
        }
        return
      }

      const next: AnalysisNotebookFile = {
        ...current,
        path: change.path,
        relativePath: change.relativePath,
        document: change.document,
        savedRevision: change.savedRevision,
        contentHash: change.contentHash ?? current.contentHash
      }
      analysisNotebookFileCacheRef.current = cacheAnalysisNotebookFile(
        analysisNotebookFileCacheRef.current,
        next
      )
      if (activeAnalysisNotebookRef.current?.path !== current.path) return
      setActiveAnalysisNotebook(next)
      const focusCellId = change.focusCellId ?? change.changedCellId
      if (focusCellId && change.document.cells.some((cell) => cell.id === focusCellId)) {
        setAnalysisAgentFocus({
          requestId: `${change.path}:${change.document.revision}:${focusCellId}:${Date.now()}`,
          path: change.path,
          relativePath: change.relativePath,
          cellId: focusCellId,
          changeKind: change.changeKind
        })
      }
      void refreshAnalysisNotebookSessionStatus(next)
      void refreshAnalysisNotebooks()
    },
    [
      analysisNotebookRegistry?.projectCwd,
      getActiveCwd,
      refreshAnalysisNotebookSessionStatus,
      refreshAnalysisNotebooks,
      setActiveAnalysisNotebook
    ]
  )

  const handleNotebookFileChanged = useCallback(
    (change: AnalysisNotebookFileChange): void => {
      if (
        change.projectCwd !== getActiveCwd() &&
        (notebookRegistryCwdRef.current !== getActiveCwd() ||
          change.projectCwd !== analysisNotebookRegistry?.projectCwd)
      )
        return

      void refreshAnalysisNotebooks()
      const current =
        analysisNotebookFileCacheRef.current.get(change.path) ??
        analysisNotebookFileCacheRef.current.get(change.relativePath)
      const active = activeAnalysisNotebookRef.current
      const isActive = active?.path === change.path || active?.relativePath === change.relativePath

      if (change.type === 'changed') {
        const { file, conflict } = reconcileAnalysisNotebookDiskFile(
          current,
          change.file,
          pendingNotebookSavesRef.current.get(`${getActiveCwd()}\0${change.path}`)
        )
        analysisNotebookFileCacheRef.current = cacheAnalysisNotebookFile(
          analysisNotebookFileCacheRef.current,
          file
        )
        if (isActive) {
          setActiveAnalysisNotebook(file)
          setAnalysisNotebookContentError(conflict ? analysisCopy.diskLocalConflict : null)
          if (!conflict) void refreshAnalysisNotebookSessionStatus(file)
        }
        return
      }
      if (change.type === 'deleted') {
        if (current && current.document.revision !== current.savedRevision) {
          if (isActive) {
            setActiveAnalysisNotebook(current)
            setAnalysisNotebookContentError(analysisCopy.notebookDeletedPreserved)
          }
          return
        }
        analysisNotebookFileCacheRef.current = removeAnalysisNotebookFileCacheEntry(
          analysisNotebookFileCacheRef.current,
          change.path
        )
      }

      if (!isActive) return

      if (change.type === 'deleted') {
        closeActiveNotebook()
        setAnalysisNotebookSessionStatus(null)
        setExecutingAnalysisCellId(null)
        setAnalysisCellExecutionError(null)
        setAnalysisNotebookContentError(analysisCopy.notebookDeleted(change.relativePath))
        return
      }

      setAnalysisNotebookContentError(analysisCopy.notebookChangedReadFailed(change.message))
    },
    [
      analysisNotebookRegistry?.projectCwd,
      closeActiveNotebook,
      getActiveCwd,
      refreshAnalysisNotebookSessionStatus,
      refreshAnalysisNotebooks,
      setActiveAnalysisNotebook
    ]
  )

  const refreshActiveNotebookFile = useCallback(async (): Promise<void> => {
    const current = activeAnalysisNotebookRef.current
    const cwd = getActiveCwd()
    if (
      !current ||
      !cwd ||
      current.document.revision !== current.savedRevision ||
      pendingNotebookSavesRef.current.has(`${cwd}\0${current.path}`) ||
      typeof rendererApi.refreshAnalysisNotebook !== 'function'
    )
      return
    const request = ++notebookRefreshRequestRef.current
    const epoch = notebookScopeEpochRef.current
    try {
      const file = await rendererApi.refreshAnalysisNotebook(cwd, current.path)
      const latest = activeAnalysisNotebookRef.current
      if (
        request !== notebookRefreshRequestRef.current ||
        epoch !== notebookScopeEpochRef.current ||
        cwd !== getActiveCwd() ||
        latest?.path !== current.path ||
        latest.document.revision !== current.document.revision ||
        latest.savedRevision !== current.savedRevision ||
        latest.contentHash !== current.contentHash
      )
        return
      handleNotebookFileChanged({
        type: 'changed',
        projectCwd: cwd,
        path: file.path,
        relativePath: file.relativePath,
        file
      })
    } catch (error) {
      if (
        request === notebookRefreshRequestRef.current &&
        epoch === notebookScopeEpochRef.current &&
        cwd === getActiveCwd() &&
        activeAnalysisNotebookRef.current?.path === current.path
      ) {
        setAnalysisNotebookContentError(
          readableErrorMessage(error, analysisCopy.notebookRefreshFailed)
        )
      }
    }
  }, [getActiveCwd, handleNotebookFileChanged, rendererApi])

  useEffect(() => {
    const refresh = (): void => {
      if (document.visibilityState === 'visible') void refreshActiveNotebookFile()
    }
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => {
      notebookRefreshRequestRef.current += 1
      window.removeEventListener('focus', refresh)
      document.removeEventListener('visibilitychange', refresh)
    }
  }, [refreshActiveNotebookFile])

  return {
    analysisNotebookRegistry,
    activeAnalysisNotebook,
    setActiveAnalysisNotebook,
    isLoadingAnalysisNotebooks,
    isOpeningAnalysisNotebook,
    analysisNotebookError,
    analysisNotebookContentError,
    analysisKernelDiagnostics,
    isLoadingAnalysisKernels,
    analysisKernelError,
    analysisJupyterStatus,
    analysisJupyterRuntimeStatus,
    isLoadingAnalysisJupyterRuntime,
    analysisJupyterRuntimeError,
    isStartingAnalysisJupyter,
    analysisJupyterError,
    analysisNotebookSessionStatus,
    isStartingAnalysisNotebookSession,
    closingRuntimeNotebookPath,
    analysisNotebookSessionError,
    executingAnalysisCellId,
    analysisCellExecutionError,
    analysisAgentFocus,
    refreshAnalysisNotebooks,
    onInitializeProjectAnalysis,
    refreshAnalysisNotebookSessionStatus,
    onOpenAnalysisNotebook,
    activateCachedAnalysisNotebook,
    forgetCachedAnalysisNotebook,
    focusAnalysisNotebookCell,
    onSaveAnalysisNotebook,
    onSyncAnalysisNotebookDraft,
    onCreateAnalysisNotebook,
    onDeleteAnalysisNotebook,
    refreshAnalysisKernels,
    refreshAnalysisJupyterStatus,
    onJumpToAnalysisNotebookCell,
    refreshAnalysisJupyterRuntimeStatus,
    onStartAnalysisJupyter,
    onStopAnalysisJupyter,
    onStartAnalysisNotebookSession,
    onStopAnalysisNotebookSession,
    onStopRuntimeNotebookSession,
    onRunAnalysisNotebookCell,
    onStopAnalysisNotebookCell,
    onCompleteAnalysisNotebookCell,
    onFormatAnalysisNotebookCell,
    onGenerateAnalysisNotebookCode,
    closeActiveNotebook,
    resetAnalysisJupyterRuntimeForCwdChange,
    handleNotebookDraftChanged,
    handleNotebookFileChanged
  }
}
