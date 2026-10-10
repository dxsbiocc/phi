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
import { updateNotebookCell } from '../../../../../shared/notebookDocument'
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
  notebookEnvironmentErrorMessage,
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
  const [activeAnalysisNotebook, setActiveAnalysisNotebook] = useState<AnalysisNotebookFile | null>(
    null
  )
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

  useEffect(() => {
    activeAnalysisNotebookRef.current = activeAnalysisNotebook
    if (activeAnalysisNotebook) {
      analysisNotebookFileCacheRef.current = cacheAnalysisNotebookFile(
        analysisNotebookFileCacheRef.current,
        activeAnalysisNotebook
      )
    }
  }, [activeAnalysisNotebook])

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
      setAnalysisNotebookRegistry(registry)
    } catch (error) {
      if (request !== analysisNotebooksRequestRef.current) return
      setAnalysisNotebookError(readableErrorMessage(error, '无法读取项目 notebooks'))
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
        setAnalysisNotebookError(readableErrorMessage(error, '无法初始化分析目录'))
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
        setAnalysisNotebookSessionError(
          readableErrorMessage(error, '无法读取 notebook kernel 状态')
        )
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
        showSnackbar('请先选择一个 workspace 后再打开 notebook', 'warning')
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
        setAnalysisNotebookContentError(readableErrorMessage(error, '无法打开 notebook'))
        return null
      } finally {
        if (request === analysisNotebookOpenRequestRef.current) {
          setIsOpeningAnalysisNotebook(false)
        }
      }
    },
    [getActiveAnalysisCwd, refreshAnalysisNotebookSessionStatus, rendererApi, showSnackbar]
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
    [refreshAnalysisNotebookSessionStatus]
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
        showSnackbar('这个 cell 已不在当前 notebook 中', 'warning')
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
    ): Promise<void> => {
      const cwd = getActiveCwd()
      setAnalysisNotebookContentError(null)
      try {
        const saved = await rendererApi.saveAnalysisNotebook(cwd, {
          path: file.path,
          document,
          expectedRevision: file.savedRevision,
          ...(file.contentHash ? { expectedHash: file.contentHash } : {})
        })
        setActiveAnalysisNotebook(saved)
        void refreshAnalysisNotebookSessionStatus(saved)
        await refreshAnalysisNotebooks()
      } catch (error) {
        setAnalysisNotebookContentError(readableErrorMessage(error, '无法保存 notebook'))
      }
    },
    [getActiveCwd, refreshAnalysisNotebookSessionStatus, refreshAnalysisNotebooks, rendererApi]
  )

  const onSyncAnalysisNotebookDraft = useCallback(
    async (
      file: AnalysisNotebookFile,
      document: AnalysisNotebookFile['document']
    ): Promise<void> => {
      const cwd = getActiveCwd()
      analysisNotebookFileCacheRef.current = cacheAnalysisNotebookFile(
        analysisNotebookFileCacheRef.current,
        { ...file, document }
      )
      try {
        await rendererApi.syncAnalysisNotebookDraft(cwd, file.path, document, file.savedRevision)
      } catch (error) {
        if (cwd !== getActiveCwd()) return
        setAnalysisNotebookContentError(readableErrorMessage(error, '无法同步 notebook 草稿'))
      }
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
        setAnalysisNotebookContentError(readableErrorMessage(error, '无法新建 notebook'))
      } finally {
        setIsOpeningAnalysisNotebook(false)
      }
    },
    [refreshAnalysisNotebookSessionStatus, refreshAnalysisNotebooks, rendererApi]
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
        showSnackbar(`已删除 ${file.relativePath}`, 'success')
      } catch (error) {
        setAnalysisNotebookContentError(readableErrorMessage(error, '无法删除 notebook'))
      }
    },
    [activeAnalysisNotebook, getActiveCwd, refreshAnalysisNotebooks, rendererApi, showSnackbar]
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
        'Notebook kernel API 尚未加载，请重启 Phi 后再试'
      )
      const diagnostics = await listAnalysisKernels(cwd)
      if (request !== analysisKernelsRequestRef.current || cwd !== getActiveCwd()) return
      setAnalysisKernelDiagnostics(diagnostics)
    } catch (error) {
      if (request !== analysisKernelsRequestRef.current) return
      setAnalysisKernelError(readableErrorMessage(error, '无法检测 Jupyter kernels'))
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
        'Jupyter Server API 尚未加载，请重启 Phi 后再试'
      )
      const status = await getAnalysisJupyterStatus(cwd)
      if (request !== analysisJupyterRequestRef.current || cwd !== getActiveCwd()) return
      setAnalysisJupyterStatus(status)
    } catch (error) {
      if (request !== analysisJupyterRequestRef.current) return
      setAnalysisJupyterError(readableErrorMessage(error, '无法读取 Jupyter Server 状态'))
      setAnalysisJupyterStatus(null)
    }
  }, [getActiveCwd, rendererApi])

  const onJumpToAnalysisNotebookCell = useCallback(
    (target: NotebookCellJumpTarget): void => {
      const notebookPath = target.path ?? target.relativePath
      if (!notebookPath) {
        showSnackbar('这个工具调用没有记录 notebook 路径', 'warning')
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
            notebookEnvironmentErrorMessage(fallbackError, '无法读取 Jupyter Server 状态')
          )
          setAnalysisJupyterRuntimeStatus(null)
          return
        }
      }
      setAnalysisJupyterRuntimeError(
        notebookEnvironmentErrorMessage(error, '无法读取 Jupyter runtime 状态')
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
        setAnalysisJupyterError(notebookEnvironmentErrorMessage(error, '无法启动 Jupyter Server'))
      } finally {
        if (request === analysisJupyterRequestRef.current) {
          setIsStartingAnalysisJupyter(false)
        }
      }
    },
    [getActiveCwd, refreshAnalysisKernels, rendererApi]
  )

  const onStopAnalysisJupyter = useCallback(
    async (cwd: string): Promise<void> => {
      const request = ++analysisJupyterRequestRef.current
      setIsStartingAnalysisJupyter(true)
      setAnalysisJupyterError(null)
      try {
        const status = await rendererApi.stopAnalysisJupyter(cwd)
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
        setAnalysisJupyterError(readableErrorMessage(error, '无法停止 Jupyter Server'))
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
            kernels: analysisKernelDiagnostics?.kernels
          }),
          analysisJupyterStatus
        )
      )
      try {
        let jupyterStatus = analysisJupyterStatus
        if (!jupyterServerIsReady(jupyterStatus)) {
          if (remoteJupyterRequiresExplicitStart(jupyterStatus)) {
            throw new Error('请先在 Runtime 面板显式启动远程 Jupyter，再连接 notebook kernel。')
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
          notebookEnvironmentErrorMessage(error, '无法连接 notebook kernel')
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
        setAnalysisNotebookSessionError(readableErrorMessage(error, '无法断开 notebook kernel'))
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
        setAnalysisJupyterRuntimeError(readableErrorMessage(error, '无法停止 notebook kernel'))
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
      const cwd = getActiveCwd()
      setExecutingAnalysisCellId(cellId)
      setAnalysisCellExecutionError(null)
      try {
        const executeAnalysisNotebookCell = requireRendererApiMethod(
          rendererApi,
          'executeAnalysisNotebookCell',
          'Notebook cell 执行 API 尚未加载，请重启 Phi 后再试'
        )
        const result = await executeAnalysisNotebookCell(cwd, file.path, document, cellId)
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
        const message = notebookEnvironmentErrorMessage(error, '无法执行 notebook cell')
        setAnalysisCellExecutionError(message)
        // Without this, a failed run (timeout, lost kernel connection, stale
        // session, ...) leaves the cell showing nothing at all once the
        // running indicator clears — the only trace is a banner above the
        // cell list that's easy to miss if the user scrolled down to it.
        try {
          const nextDocument = updateNotebookCell(document, cellId, {
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
    [getActiveCwd, rendererApi]
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
          'Notebook cell 停止 API 尚未加载，请重启 Phi 后再试'
        )
        const status = await interruptAnalysisNotebookExecution(cwd, file.path)
        if (request !== analysisCellExecutionRequestRef.current || cwd !== getActiveCwd()) {
          return
        }
        setAnalysisNotebookSessionStatus(status)
        showSnackbar('已请求停止 notebook cell', 'info')
      } catch (error) {
        if (request !== analysisCellExecutionRequestRef.current) return
        setAnalysisCellExecutionError(readableErrorMessage(error, '无法停止 notebook cell'))
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
        'Notebook AI 生成 API 尚未加载，请重启 Phi 后再试'
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
        'Notebook code completion API 尚未加载，请重启 Phi 后再试'
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
        'Notebook code formatting API 尚未加载，请重启 Phi 后再试'
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
    analysisJupyterRuntimeRequestRef.current += 1
    analysisNotebookFileCacheRef.current = new Map()
    setAnalysisKernelDiagnostics(null)
    setAnalysisJupyterStatus(null)
    setAnalysisJupyterRuntimeStatus(null)
    setAnalysisJupyterRuntimeError(null)
    setAnalysisNotebookSessionStatus(null)
  }, [])

  const closeActiveNotebook = useCallback((): void => {
    setActiveAnalysisNotebook(null)
    setAnalysisNotebookSessionStatus(null)
    setExecutingAnalysisCellId(null)
    setAnalysisCellExecutionError(null)
    setAnalysisNotebookContentError(null)
  }, [])

  const handleNotebookDraftChanged = useCallback(
    (change: AnalysisNotebookDraftChange): void => {
      if (change.source === 'renderer') return
      if (
        change.projectCwd !== getActiveCwd() &&
        change.projectCwd !== analysisNotebookRegistry?.projectCwd
      ) {
        return
      }

      const current = activeAnalysisNotebookRef.current
      if (!current) return
      if (current.path !== change.path && current.relativePath !== change.relativePath) return

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
      refreshAnalysisNotebooks
    ]
  )

  const handleNotebookFileChanged = useCallback(
    (change: AnalysisNotebookFileChange): void => {
      if (
        change.projectCwd !== getActiveCwd() &&
        change.projectCwd !== analysisNotebookRegistry?.projectCwd
      ) {
        return
      }

      void refreshAnalysisNotebooks()

      if (change.type === 'changed') {
        analysisNotebookFileCacheRef.current = cacheAnalysisNotebookFile(
          analysisNotebookFileCacheRef.current,
          change.file
        )
      }
      if (change.type === 'deleted') {
        analysisNotebookFileCacheRef.current = removeAnalysisNotebookFileCacheEntry(
          analysisNotebookFileCacheRef.current,
          change.path
        )
      }

      const current = activeAnalysisNotebookRef.current
      if (!current) return
      if (current.path !== change.path && current.relativePath !== change.relativePath) return

      if (change.type === 'changed') {
        setAnalysisNotebookContentError(null)
        setActiveAnalysisNotebook(change.file)
        void refreshAnalysisNotebookSessionStatus(change.file)
        return
      }

      if (change.type === 'deleted') {
        setActiveAnalysisNotebook(null)
        setAnalysisNotebookSessionStatus(null)
        setExecutingAnalysisCellId(null)
        setAnalysisCellExecutionError(null)
        setAnalysisNotebookContentError(`Notebook 已在磁盘上删除: ${change.relativePath}`)
        return
      }

      setAnalysisNotebookContentError(`Notebook 已变化，但无法重新读取: ${change.message}`)
    },
    [
      analysisNotebookRegistry?.projectCwd,
      getActiveCwd,
      refreshAnalysisNotebookSessionStatus,
      refreshAnalysisNotebooks
    ]
  )

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
