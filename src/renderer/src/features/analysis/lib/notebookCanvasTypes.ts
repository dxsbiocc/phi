import type { NotebookDocument } from '../../../../../shared/notebookDocument'
import type {
  AnalysisKernelDiagnostics,
  AnalysisNotebookCodeGenerationInput,
  AnalysisNotebookCodeGenerationProgress,
  AnalysisNotebookCodeGenerationResult,
  AnalysisNotebookCompletionResult,
  AnalysisNotebookFile,
  AnalysisNotebookFormatResult,
  AnalysisNotebookSessionStatus,
  ModelOption
} from '../../../types'
import type { NotebookListEntry } from './notebookViewModel'

export type AnalysisNotebookAgentFocus = {
  requestId: string
  path: string
  relativePath: string
  cellId: string
  changeKind?: 'synced' | 'inserted' | 'updated' | 'deleted' | 'executed' | 'saved'
}

export type PendingKernelSwitch = {
  file: AnalysisNotebookFile
  currentKernelLabel: string
  nextKernelLabel: string
  hasCurrentLiveSession: boolean
  nextDocument: NotebookDocument
  nextAutoConnectKey: string
}

export type NotebookCanvasProps = {
  activeNotebookPath: string
  notebooks: NotebookListEntry[]
  notebookFile?: AnalysisNotebookFile | null
  initialDocument: NotebookDocument | null
  isOpening?: boolean
  error?: string | null
  kernelDiagnostics?: AnalysisKernelDiagnostics | null
  isLoadingKernels?: boolean
  kernelError?: string | null
  notebookSessionStatus?: AnalysisNotebookSessionStatus | null
  isStartingNotebookSession?: boolean
  notebookSessionError?: string | null
  executingCellId?: string | null
  cellExecutionError?: string | null
  availableNotebooks?: NotebookListEntry[]
  projectCwd?: string | null
  onSaveNotebook?: (file: AnalysisNotebookFile, document: NotebookDocument) => void | Promise<void>
  onSyncNotebookDraft?: (file: AnalysisNotebookFile, document: NotebookDocument) => void
  onStartNotebookSession?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument
  ) => void | Promise<void>
  onStopNotebookSession?: (file: AnalysisNotebookFile) => void | Promise<void>
  onRunNotebookCell?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument,
    cellId: string
  ) => void
  onStopNotebookCell?: (file: AnalysisNotebookFile, cellId: string) => void
  onCompleteNotebookCell?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument,
    cellId: string,
    source: string,
    cursorPosition: number
  ) => Promise<AnalysisNotebookCompletionResult>
  onFormatNotebookCell?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument,
    cellId: string,
    source: string,
    language?: string
  ) => Promise<AnalysisNotebookFormatResult>
  onGenerateNotebookCode?: (
    file: AnalysisNotebookFile,
    document: NotebookDocument,
    input: AnalysisNotebookCodeGenerationInput
  ) => Promise<AnalysisNotebookCodeGenerationResult>
  onNotebookCodeGenerationProgress?: (
    cb: (progress: AnalysisNotebookCodeGenerationProgress) => void
  ) => () => void
  aiModelOptions?: ModelOption[]
  aiDefaultModel?: ModelOption | null
  onPickContextFiles?: () => Promise<string[]>
  onSelectNotebook?: (notebook: NotebookListEntry) => void
  onCreateNotebook?: (cwd: string) => void
  onCloseNotebook?: (notebook: NotebookListEntry) => void
  agentFocus?: AnalysisNotebookAgentFocus | null
}
