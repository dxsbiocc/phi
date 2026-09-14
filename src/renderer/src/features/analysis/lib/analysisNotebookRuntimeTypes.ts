import type { MutableRefObject } from 'react'
import type {
  AnalysisJupyterRuntimeStatus,
  AnalysisNotebookCompletionResult,
  AnalysisKernelDiagnostics,
  AnalysisNotebookCodeGenerationInput,
  AnalysisNotebookCodeGenerationResult,
  AnalysisNotebookDraftChange,
  AnalysisNotebookFile,
  AnalysisNotebookFileChange,
  AnalysisNotebookFormatResult,
  AnalysisNotebookRegistry,
  AnalysisNotebookSessionStatus,
  JupyterServerStatus,
  NotebookCellJumpTarget,
  Project,
  RendererApi
} from '../../../types'
import type { AnalysisNotebookAgentFocus } from './notebookCanvasTypes'

export type AnalysisNotebookRuntimeDeps = {
  rendererApi: RendererApi
  getActiveCwd: () => string
  projectsRef: MutableRefObject<Project[]>
  showSnackbar: (message: string, severity?: 'error' | 'info' | 'success' | 'warning') => void
  onNavigateToNotebookView: () => void
}

export type AnalysisNotebookRuntimeState = {
  analysisNotebookRegistry: AnalysisNotebookRegistry | null
  analysisInspectorCollapsed: boolean
  setAnalysisInspectorCollapsed: (value: boolean | ((prev: boolean) => boolean)) => void
  activeAnalysisNotebook: AnalysisNotebookFile | null
  setActiveAnalysisNotebook: (file: AnalysisNotebookFile | null) => void
  isLoadingAnalysisNotebooks: boolean
  isOpeningAnalysisNotebook: boolean
  analysisNotebookError: string | null
  analysisNotebookContentError: string | null
  analysisKernelDiagnostics: AnalysisKernelDiagnostics | null
  isLoadingAnalysisKernels: boolean
  analysisKernelError: string | null
  analysisJupyterStatus: JupyterServerStatus | null
  analysisJupyterRuntimeStatus: AnalysisJupyterRuntimeStatus | null
  isLoadingAnalysisJupyterRuntime: boolean
  analysisJupyterRuntimeError: string | null
  isStartingAnalysisJupyter: boolean
  analysisJupyterError: string | null
  analysisNotebookSessionStatus: AnalysisNotebookSessionStatus | null
  isStartingAnalysisNotebookSession: boolean
  closingRuntimeNotebookPath: string | null
  analysisNotebookSessionError: string | null
  executingAnalysisCellId: string | null
  analysisCellExecutionError: string | null
  analysisAgentFocus: AnalysisNotebookAgentFocus | null
  refreshAnalysisNotebooks: () => Promise<void>
  onInitializeProjectAnalysis: (cwd: string) => Promise<void>
  refreshAnalysisNotebookSessionStatus: (file: AnalysisNotebookFile) => Promise<void>
  onOpenAnalysisNotebook: (path: string) => Promise<AnalysisNotebookFile | null>
  activateCachedAnalysisNotebook: (path: string) => AnalysisNotebookFile | null
  forgetCachedAnalysisNotebook: (path: string) => void
  focusAnalysisNotebookCell: (file: AnalysisNotebookFile, target: NotebookCellJumpTarget) => boolean
  onSaveAnalysisNotebook: (
    file: AnalysisNotebookFile,
    document: AnalysisNotebookFile['document']
  ) => Promise<void>
  onSyncAnalysisNotebookDraft: (
    file: AnalysisNotebookFile,
    document: AnalysisNotebookFile['document']
  ) => Promise<void>
  onCreateAnalysisNotebook: (cwd: string) => Promise<void>
  onDeleteAnalysisNotebook: (file: { path: string; relativePath: string }) => Promise<void>
  refreshAnalysisKernels: () => Promise<void>
  refreshAnalysisJupyterStatus: () => Promise<void>
  onJumpToAnalysisNotebookCell: (target: NotebookCellJumpTarget) => void
  refreshAnalysisJupyterRuntimeStatus: () => Promise<void>
  onStartAnalysisJupyter: (cwd: string) => Promise<void>
  onStopAnalysisJupyter: (cwd: string) => Promise<void>
  onStartAnalysisNotebookSession: (
    file: AnalysisNotebookFile,
    document: AnalysisNotebookFile['document']
  ) => Promise<void>
  onStopAnalysisNotebookSession: (file: AnalysisNotebookFile) => Promise<void>
  onStopRuntimeNotebookSession: (notebookPath: string) => Promise<void>
  onRunAnalysisNotebookCell: (
    file: AnalysisNotebookFile,
    document: AnalysisNotebookFile['document'],
    cellId: string
  ) => Promise<void>
  onCompleteAnalysisNotebookCell: (
    file: AnalysisNotebookFile,
    document: AnalysisNotebookFile['document'],
    cellId: string,
    source: string,
    cursorPosition: number
  ) => Promise<AnalysisNotebookCompletionResult>
  onFormatAnalysisNotebookCell: (
    file: AnalysisNotebookFile,
    document: AnalysisNotebookFile['document'],
    cellId: string,
    source: string,
    language?: string
  ) => Promise<AnalysisNotebookFormatResult>
  onGenerateAnalysisNotebookCode: (
    file: AnalysisNotebookFile,
    document: AnalysisNotebookFile['document'],
    input: AnalysisNotebookCodeGenerationInput
  ) => Promise<AnalysisNotebookCodeGenerationResult>
  closeActiveNotebook: () => void
  resetAnalysisJupyterRuntimeForCwdChange: () => void
  handleNotebookDraftChanged: (change: AnalysisNotebookDraftChange) => void
  handleNotebookFileChanged: (change: AnalysisNotebookFileChange) => void
}
