import type {
  NotebookDocument,
  NotebookGeneratedCell,
  NotebookOutput
} from '../../../../../shared/notebookDocument'

/** Analysis notebook, kernel and Jupyter runtime shapes shared by the renderer API. */

export interface AnalysisNotebookSummary {
  path: string
  relativePath: string
  name: string
  directory: string
  bytes: number
  modifiedAt: string
}

export interface AnalysisNotebookRegistry {
  projectCwd: string | null
  projectName?: string
  notebooks: AnalysisNotebookSummary[]
  truncated: boolean
  initialized: boolean
  message?: string
}

export interface AnalysisProjectInitialization {
  notebooksDir: string
  outputsDir: string
}

export interface AnalysisNotebookFile {
  path: string
  relativePath: string
  name: string
  bytes: number
  modifiedAt: string
  savedRevision: string
  contentHash?: string
  document: NotebookDocument
}

export type AnalysisNotebookDraftChangeKind =
  'synced' | 'inserted' | 'updated' | 'deleted' | 'executed' | 'saved'

export interface AnalysisNotebookDraftChange {
  source: 'agent' | 'renderer'
  projectCwd: string
  path: string
  relativePath: string
  document: NotebookDocument
  savedRevision: string
  contentHash?: string
  changeKind?: AnalysisNotebookDraftChangeKind
  changedCellId?: string
  focusCellId?: string
}

export type AnalysisNotebookFileChange =
  | {
      type: 'changed'
      projectCwd: string
      path: string
      relativePath: string
      file: AnalysisNotebookFile
    }
  | {
      type: 'deleted'
      projectCwd: string
      path: string
      relativePath: string
    }
  | {
      type: 'error'
      projectCwd: string
      path: string
      relativePath: string
      message: string
    }

export interface AnalysisNotebookCodeGenerationInput {
  prompt: string
  language: string
  requestId?: string
  model?: {
    providerId: string
    modelId: string
  } | null
  afterCellId?: string | null
  references?: AnalysisNotebookContextReference[]
}

export type AnalysisNotebookContextReferenceKind =
  'dataframe' | 'data_source' | 'variable' | 'cell_output'

export interface AnalysisNotebookContextReference {
  id: string
  kind: AnalysisNotebookContextReferenceKind
  name: string
  detail?: string
  cellId?: string
  preview?: {
    source?: string
    code?: string
    output?: string
    value?: string
    shape?: string
    columns?: Array<{ name: string; type?: string }>
  }
}

export type AnalysisNotebookGeneratedCell = NotebookGeneratedCell
export interface AnalysisNotebookCodeGenerationResult {
  source: string
  language: string
  cells?: AnalysisNotebookGeneratedCell[]
}
export interface AnalysisNotebookCodeGenerationProgress {
  requestId: string
  path: string
  relativePath: string
  source: string
  language: string
  cells: AnalysisNotebookGeneratedCell[]
}
export interface SaveAnalysisNotebookInput {
  path: string
  document: NotebookDocument
  expectedRevision?: string
  expectedHash?: string
}
export type AnalysisKernelLanguage = 'python' | 'r' | 'other'

export interface AnalysisKernelSummary {
  name: string
  displayName: string
  language: AnalysisKernelLanguage
  rawLanguage: string
  resourceDir?: string
  executable?: string
  source?: 'managed' | 'host'
}

export interface AnalysisKernelDiagnostics {
  jupyterServer: {
    available: boolean
    command: 'jupyter'
    version?: string
    error?: string
  }
  kernels: AnalysisKernelSummary[]
  preferredKernelName?: string
  hasPythonKernel: boolean
  hasRKernel: boolean
  messages: string[]
}

export type JupyterServerState =
  | 'stopped'
  | 'starting'
  | 'ready'
  | 'error'
  | 'exited'
  | 'preparing_environment'
  | 'allocating_ports'
  | 'starting_lease'
  | 'probing_through_tunnel'
  | 'stopping'
  | 'disconnected'
  | 'cleaning'
  | 'reconciling'

export type JupyterServerMessageCode =
  | 'starting'
  | 'stopped'
  | 'ready'
  | 'exited'
  | 'port_in_use'
  | 'abnormal_exit'
  | 'preparing_environment'
  | 'reconciling'
  | 'disconnected'

export interface JupyterServerMessageParams {
  port?: number
  exitCode?: number
  signal?: string
}

export interface JupyterServerStatus {
  projectCwd: string
  state: JupyterServerState
  runtimeKind?: 'local' | 'ssh'
  serverLabel?: string
  startedAt?: string
  exitedAt?: string
  pid?: number
  port?: number
  remotePort?: number
  hasEndpoint: boolean
  message?: string
  messageCode?: JupyterServerMessageCode
  messageParams?: JupyterServerMessageParams
  cleanupUnconfirmed?: boolean
  canAbandonCleanup?: boolean
  resources?: Record<string, unknown>
}

export type AnalysisNotebookKernelState =
  'missing' | 'idle' | 'busy' | 'restarting' | 'disconnected' | 'error'

export interface AnalysisNotebookSessionStatus {
  projectCwd: string
  notebookPath: string
  kernelName?: string
  kernelDisplayName?: string
  sessionId?: string
  state: AnalysisNotebookKernelState
  message?: string
  startedAt?: string
  updatedAt?: string
}

export interface AnalysisNotebookRuntimeSummary {
  activeSessionCount: number
  busySessionCount: number
  sessions: AnalysisNotebookSessionStatus[]
}

export interface AnalysisJupyterRuntimeStatus {
  server: JupyterServerStatus
  notebooks: AnalysisNotebookRuntimeSummary
}

export interface AnalysisCellExecutionResult {
  cellId: string
  executionCount: number | null
  outputs: NotebookOutput[]
  state: 'idle' | 'error'
  startedAt: string
  completedAt: string
  document: NotebookDocument
  sessionStatus: AnalysisNotebookSessionStatus
}

export interface AnalysisNotebookCompletionInput {
  path: string
  document: NotebookDocument
  cellId: string
  source: string
  cursorPosition: number
}

export interface AnalysisNotebookCompletionResult {
  matches: string[]
  cursorStart: number
  cursorEnd: number
  metadata: Record<string, unknown>
  status: 'ok' | 'error'
  message?: string
}

export interface AnalysisNotebookFormatInput {
  path: string
  document: NotebookDocument
  cellId: string
  source: string
  language?: string
  lineLength?: number
}

export interface AnalysisNotebookFormatResult {
  source: string
  changed: boolean
  formatter: 'ruff' | 'black' | 'none'
  message?: string
}
