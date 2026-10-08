import type {
  NotebookCellType,
  NotebookDocument,
  NotebookOutput
} from '../../shared/notebookDocument'
import type { PhiAppSettings, PhiAppSettingsPatch } from '../../shared/appSettingsTypes'
import type { BrowserRendererBridge } from '../../shared/browserTypes'
import type { TerminalRendererBridge } from '../../shared/terminalTypes'
import type { OfficeRendererBridge } from '../../shared/officeProtocol'
import type {
  EnvironmentGetResult,
  EnvironmentHostDependency,
  EnvironmentHostTool,
  ManagedEnvironmentCleanResult,
  ManagedEnvironmentConsumer,
  ManagedEnvironmentEntry,
  ManagedEnvironmentRemoveResult,
  EnvironmentSnapshot,
  EnvironmentToolId,
  EnvironmentToolState
} from '../../shared/environmentTypes'
import type {
  RemoteProjectConnectionChange,
  RemoteProjectConnectionRetryRequest,
  RemoteProjectConnectionState,
  RemoteProjectCreateInput
} from '../../shared/projectLocation'
import type { OpenSshHostInput } from '../../shared/remoteHostProfile'
import type {
  WorkspaceChangeSummary,
  WorkspaceDiffReference
} from '../../shared/workspaceChangeTypes'
import type { PromptImageInput, StoredPromptImage } from '../../shared/promptImageTypes'
import type { McpServerSummary } from './features/mcp/lib/mcpTypes'
export type { McpServerSummary } from './features/mcp/lib/mcpTypes'
import type {
  FeaturedMcpConnector,
  RemoteMcpConnectorOptions
} from '../../shared/mcpConnectorCatalog'
import type { AgentEventSummary } from './features/chat/lib/agentEventTypes'
import type { SessionExportResult } from '../../shared/sessionExportTypes'
import type {
  EnablementItemKey,
  EnablementScope,
  EnablementSnapshot
} from '../../shared/enablementTypes'
import type {
  KnownPackageRegistryView,
  OfflinePackageImportPreview,
  InstalledPackageView,
  PackageInstallPlanView,
  PackageManagerType,
  PackageRegistryView,
  PackageUpdateView
} from '../../shared/packageManagerTypes'
import type { SkillContent, SkillSummary } from '../../shared/skillTypes'
export type { SkillContent, SkillSourceCategory, SkillSummary } from '../../shared/skillTypes'
import type {
  AutoCompactionApi,
  ContextCompactionDetails,
  CurrentContextUsage,
  ManualCompactionOutcome,
  ManualCompactionTarget
} from '../../shared/contextUsageTypes'
import type { RemoteWorkspaceFileRequest } from '../../shared/remoteWorkspacePath'
import type {
  WrapperResultDirectoryRequest,
  WrapperResultDownloadProgress,
  WrapperResultDownloadResult,
  WrapperResultRange,
  WrapperResultRangeRequest,
  WrapperResultReadRequest,
  WrapperResultPreview
} from '../../shared/wrapperResultTypes'
import type {
  ProjectRemoteConnection,
  RemoteHostProfile,
  RemoteHostProfileInput,
  OpenSshHost
} from './features/wrapper/lib/remoteConnectionTypes'
export type {
  ProjectRemoteConnection,
  RemoteHostProfile,
  OpenSshHost
} from './features/wrapper/lib/remoteConnectionTypes'
import type { AgentExecutionItem } from './lib/agentExecutionTypes'
import type { PlanReviewItem, PresentedFilesItem } from './features/chat/lib/planReviewTypes'
export type { PlanReviewItem, PresentedFilesItem } from './features/chat/lib/planReviewTypes'
import type { AuthInteractionEvent } from './lib/authTypes'
import type { Project } from './lib/projectTypes'
export type { Project } from './lib/projectTypes'
import type {
  CurrentSession,
  PermissionMode,
  PromptResult,
  PromptTarget,
  SessionSummary,
  SessionSwitchResult,
  ToolApprovalRequest
} from './lib/sessionTypes'
export type {
  CurrentSession,
  LastRunOutcome,
  PermissionMode,
  PromptResult,
  PromptTarget,
  SessionRuntimeState,
  SessionStatus,
  SessionSummary,
  SessionSwitchResult,
  ToolApprovalRequest,
  UnreadKind
} from './lib/sessionTypes'
export type {
  ActiveAuthPrompt,
  AuthEvent,
  AuthInteractionEvent,
  AuthPrompt,
  AuthPromptInteraction,
  AuthPromptType
} from './lib/authTypes'

export type { PhiAppSettings, PhiAppSettingsPatch }
export type {
  EnvironmentGetResult,
  EnvironmentHostDependency,
  EnvironmentHostTool,
  ManagedEnvironmentCleanResult,
  ManagedEnvironmentConsumer,
  ManagedEnvironmentEntry,
  ManagedEnvironmentRemoveResult,
  EnvironmentSnapshot,
  EnvironmentToolId,
  EnvironmentToolState
}
export type {
  AgentExecutionItem,
  AgentExecutionStep,
  AgentExecutionSteer
} from './lib/agentExecutionTypes'
export type MessageRole = 'user' | 'assistant' | 'error' | 'warning' | 'thinking'

export type Role = MessageRole

export interface ChatMessage {
  id: string
  role: Role
  content: string
  backgroundJobNotice?: { state: 'completed' | 'failed' | 'cancelled' }
  contextCompaction?: ContextCompactionDetails
  images?: Array<PromptImageInput | StoredPromptImage>
  runId?: string
  createdAt?: string
  completedAt?: string
  durationMs?: number
}

export interface ToolCallItem {
  id: string
  role: 'tool'
  runId?: string
  toolName: string
  argsPreview: string
  argsJson: string
  output: string
  status: 'running' | 'done' | 'error'
  createdAt?: string
  completedAt?: string
  durationMs?: number
  outputPath?: string
  outputBytes?: number
  outputTruncated?: boolean
  outputArtifact?: {
    kind: 'tool_output'
    path: string
    bytes: number
  }
  notebook?: NotebookToolSummary
  todo?: import('./lib/todoTypes').TodoSnapshot
}

export interface NotebookToolSummary {
  kind: string
  path?: string
  relativePath?: string
  cellNumber?: number
  cellId?: string
  cellType?: string
  executionState?: string
  executionCount?: number | null
  summary?: string
}

export interface NotebookCellJumpTarget {
  path?: string
  relativePath?: string
  cellId: string
}

export interface RunLifecycleItem {
  id: string
  role: 'run'
  event: 'started' | 'completed' | 'failed' | 'interrupted'
  runId?: string
  createdAt: string
  durationMs?: number
}

export interface WorkspaceChangeSummaryItem extends WorkspaceChangeSummary {
  id: string
  role: 'workspace_changes'
  runId?: string
  createdAt?: string
}

/**
 * A wrapper run plan created by a `wrapper_<id>` agent tool call (see
 * docs/design/phi-wrapper-technical-design.md, "Chat And UI Integration").
 * Deliberately thin: full plan detail (inputs, resources, command preview,
 * structure diagram) is loaded from the wrapper store by `planId`, not
 * carried in this chat item — large metadata stays out of messages.
 */
export interface WrapperPlanItem {
  id: string
  role: 'wrapper_plan'
  runId?: string
  toolName: string
  /** Undefined until the tool call completes and the result is parsed. */
  planId?: string
  status: 'running' | 'done' | 'error'
  createdAt?: string
  completedAt?: string
  durationMs?: number
}

export type ChatItem =
  | ChatMessage
  | ToolCallItem
  | RunLifecycleItem
  | WorkspaceChangeSummaryItem
  | PresentedFilesItem
  | PlanReviewItem
  | WrapperPlanItem
  | AgentExecutionItem

export interface ProviderAuthStatus {
  providerId: string
  name: string
  configured: boolean
  source?:
    'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command'
  label?: string
  hasApiKey: boolean
  hasOAuth: boolean
  hasConfigError: boolean
  statusText: string
}

export interface ModelOption {
  providerId: string
  modelId: string
  name: string
  supportsImages?: boolean
  thinkingLevels: ThinkingLevel[]
}

export interface AuthProgressEvent {
  type: 'info' | 'auth_url' | 'device_code' | 'progress'
  message?: string
  url?: string
  userCode?: string
  verificationUri?: string
  intervalSeconds?: number
  expiresInSeconds?: number
}

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type AgentUserInteractionOption = {
  label: string
  description: string
  preview?: string
}

export type AgentUserInteractionQuestion = {
  question: string
  header: string
  options: AgentUserInteractionOption[]
  multiSelect?: boolean
}

export type AgentUserInteractionRequest = {
  requestId: string
  questions: AgentUserInteractionQuestion[]
  planReview?: { title: string; content: string; planFilePath: string }
  sessionId?: string
  sessionPath?: string
  sessionGeneration?: number
  runId?: string
  cwd?: string
  projectName?: string
}

export type AgentUserInteractionAnswer = {
  questionIndex: number
  question: string
  kind: 'option' | 'custom' | 'multi'
  answer: string | null
  selected?: string[]
  notes?: string
  preview?: string
}

export type AgentUserInteractionResponse = {
  requestId: string
  answers: AgentUserInteractionAnswer[]
  cancelled?: boolean
  globalNote?: string
  error?: string
}

export type PluginKind = 'extension' | 'skill' | 'prompt' | 'theme' | 'package'

export interface PluginCatalogItem {
  id: string
  name: string
  source: string
  description: string
  author?: string
  kind: PluginKind
  downloads?: string
  updated?: string
  homepageUrl: string
  npmUrl: string
  installed: boolean
  installedPath?: string
}

export interface PromptAgentSummary {
  id: string
  name: string
  description: string
  source: string
  trigger: string
}

export type FilePreviewKind = 'text' | 'html' | 'image' | 'pdf' | 'metadata'

interface FilePreviewBase {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  kind: FilePreviewKind
  mimeType: string
  bytes: number
  previewBytes: number
  truncated: boolean
}

export type FilePreview = FilePreviewBase &
  (
    | {
        kind: 'text'
        mimeType: 'text/plain'
        content: string
        dataUrl?: never
      }
    | {
        kind: 'html'
        mimeType: 'text/html'
        content: string
        dataUrl?: never
      }
    | {
        kind: 'image'
        mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
        dataUrl: string
        content?: never
      }
    | {
        kind: 'pdf'
        mimeType: 'application/pdf'
        dataUrl: string
        content?: never
      }
    | {
        kind: 'metadata'
        mimeType: string
        reason: 'large_file' | 'binary'
        content?: never
        dataUrl?: never
      }
  )

export type FileHoverPreviewKind = 'text' | 'spreadsheet' | 'image' | 'metadata'

interface FileHoverPreviewBase {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  kind: FileHoverPreviewKind
  mimeType: string
  bytes: number
  previewBytes: number
  truncated: boolean
}

export type FileHoverPreview = FileHoverPreviewBase &
  (
    | {
        kind: 'text'
        mimeType: 'text/plain'
        content: string
        dataUrl?: never
        format?: never
        reason?: never
      }
    | {
        kind: 'spreadsheet'
        mimeType: 'text/csv' | 'text/tab-separated-values'
        format: 'csv' | 'tsv'
        content: string
        dataUrl?: never
        reason?: never
      }
    | {
        kind: 'image'
        mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
        dataUrl: string
        content?: never
        format?: never
        reason?: never
      }
    | {
        kind: 'metadata'
        mimeType: string
        reason: 'binary' | 'large_file' | 'pdf' | 'unsupported_media'
        content?: never
        dataUrl?: never
        format?: never
      }
  )

export interface FileTreeEntry {
  path: string
  name: string
  displayPath: string
  kind: 'directory' | 'file'
}

export interface DirectoryListing {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  entries: FileTreeEntry[]
  truncated: boolean
}

export type LocalPathStat = {
  path: string
  kind: 'file' | 'directory' | 'missing'
}

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

export interface AnalysisNotebookGeneratedCell {
  cellType: Extract<NotebookCellType, 'code' | 'markdown'>
  source: string
  language?: string
}

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
}

export type AnalysisKernelLanguage = 'python' | 'r' | 'other'

export interface AnalysisKernelSummary {
  name: string
  displayName: string
  language: AnalysisKernelLanguage
  rawLanguage: string
  resourceDir?: string
  executable?: string
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

export type JupyterServerState = 'stopped' | 'starting' | 'ready' | 'error' | 'exited'

export interface JupyterServerStatus {
  projectCwd: string
  state: JupyterServerState
  startedAt?: string
  exitedAt?: string
  pid?: number
  port?: number
  hasEndpoint: boolean
  message?: string
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

export type RendererApi = AutoCompactionApi & {
  browser: BrowserRendererBridge
  terminal: TerminalRendererBridge
  office: OfficeRendererBridge
  closeWindow: () => Promise<void>
  minimizeWindow: () => Promise<void>
  toggleWindowFullscreen: () => Promise<void>
  getWindowFullscreen: () => Promise<boolean>
  onWindowFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  revealPath: (path: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  getFileIcon: (path: string) => Promise<string | null>
  readResourceIcon: (key: string) => Promise<string | null>
  pickInputFiles: () => Promise<string[]>
  getPathForFile: (file: File) => string
  onInputFilesDropped: (cb: (paths: string[]) => void) => () => void
  previewFile: (path: string) => Promise<FilePreview>
  previewRemoteWorkspaceFile: (request: RemoteWorkspaceFileRequest) => Promise<FilePreview>
  previewWrapperResult: (request: WrapperResultReadRequest) => Promise<WrapperResultPreview>
  hoverPreviewFile: (path: string) => Promise<FileHoverPreview>
  statLocalPaths: (cwd: string, paths: string[]) => Promise<LocalPathStat[]>
  listDirectory: (path: string) => Promise<DirectoryListing>
  listRemoteWorkspaceDirectory: (request: RemoteWorkspaceFileRequest) => Promise<DirectoryListing>
  listWrapperResultDirectory: (request: WrapperResultDirectoryRequest) => Promise<DirectoryListing>
  readWrapperResultRange: (request: WrapperResultRangeRequest) => Promise<WrapperResultRange>
  cancelWrapperResultRead: (requestId: string) => Promise<boolean>
  downloadWrapperResult: (request: WrapperResultReadRequest) => Promise<WrapperResultDownloadResult>
  cancelWrapperResultDownload: (requestId: string) => Promise<boolean>
  onWrapperResultDownloadProgress: (
    cb: (progress: WrapperResultDownloadProgress) => void
  ) => () => void
  renderMoleculeSvg: (value: string, width: number, height: number) => Promise<string>
  copyDiagnostics: () => Promise<string>
  sendPrompt: (text: string, target?: PromptTarget) => Promise<PromptResult | null>
  readPromptImage: (ref: StoredPromptImage) => Promise<PromptImageInput>
  readWorkspaceDiff: (ref: WorkspaceDiffReference) => Promise<string>
  onAgentEvent: (cb: (event: AgentEventSummary) => void) => () => void
  onAgentUserInteractionRequest: (cb: (event: AgentUserInteractionRequest) => void) => () => void
  onAgentUserInteractionCancelled: (cb: () => void) => () => void
  respondAgentUserInteraction: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled?: boolean
  ) => Promise<void>
  getAuthStatus: () => Promise<ProviderAuthStatus[]>
  loginApiKey: (providerId: string, key: string) => Promise<ProviderAuthStatus[]>
  loginOAuth: (providerId: string) => Promise<ProviderAuthStatus[]>
  logout: (providerId: string) => Promise<void>
  submitAuthInteraction: (requestId: string, value: string) => Promise<void>
  onAuthInteraction: (cb: (event: AuthInteractionEvent) => void) => () => void
  getAppSettings: () => Promise<PhiAppSettings>
  updateAppSettings: (patch: PhiAppSettingsPatch) => Promise<PhiAppSettings>
  getEnvironment: () => Promise<EnvironmentGetResult>
  redetectEnvironment: () => Promise<EnvironmentSnapshot>
  dismissEnvironmentSummary: () => Promise<EnvironmentSnapshot>
  setEnvironmentToolPath: (
    toolId: EnvironmentToolId,
    path: string | null
  ) => Promise<EnvironmentSnapshot>
  pickEnvironmentBinary: () => Promise<string | null>
  listManagedEnvironments: (projectCwd?: string) => Promise<ManagedEnvironmentEntry[]>
  buildManagedEnvironment: (
    ref: string,
    projectCwd?: string,
    pluginId?: string
  ) => Promise<{ envId: string }>
  rebuildManagedEnvironment: (envId: string) => Promise<void>
  removeManagedEnvironment: (envId: string) => Promise<ManagedEnvironmentRemoveResult>
  cleanManagedEnvironments: () => Promise<ManagedEnvironmentCleanResult>
  listModels: () => Promise<ModelOption[]>
  selectModel: (providerId: string, modelId: string) => Promise<void>
  getSelectedModel: () => Promise<{ providerId: string; modelId: string } | null>
  selectThinkingLevel: (level: ThinkingLevel) => Promise<void>
  getThinkingLevel: () => Promise<ThinkingLevel>
  getAppName: () => Promise<string>
  isOnboarded: () => Promise<boolean>
  getPersonaMarkdown: () => Promise<string>
  setPersonaMarkdown: (markdown: string) => Promise<string>
  skipOnboarding: () => Promise<void>
  completeOnboarding: (description: string) => Promise<string>
  listSessions: () => Promise<SessionSummary[]>
  getCurrentSession: () => Promise<CurrentSession>
  getCurrentContextUsage: () => Promise<CurrentContextUsage>
  compactCurrentSession: (target: ManualCompactionTarget) => Promise<ManualCompactionOutcome>
  updateCurrentSessionPermissionMode: (permissionMode: PermissionMode) => Promise<CurrentSession>
  createSession: () => Promise<CurrentSession>
  forkSession: (
    sourceId: string,
    eventId: string
  ) => Promise<{ path: string; phiSessionId: string }>
  switchSession: (path: string) => Promise<SessionSwitchResult | null>
  acknowledgeSession: (path: string) => Promise<SessionSummary | null>
  deleteSession: (path: string) => Promise<void>
  renameSession: (path: string, name: string) => Promise<void>
  exportSession: (sessionId: string) => Promise<SessionExportResult | null>
  listProjects: () => Promise<Project[]>
  pickProjectDirectory: () => Promise<string | null>
  createProject: (
    name: string,
    workingDirectory: string,
    permissionMode: PermissionMode
  ) => Promise<Project>
  createRemoteProject: (input: RemoteProjectCreateInput) => Promise<Project>
  retryRemoteProjectConnection: (
    request: RemoteProjectConnectionRetryRequest
  ) => Promise<RemoteProjectConnectionState>
  onRemoteProjectConnectionChanged: (
    cb: (change: RemoteProjectConnectionChange) => void
  ) => () => void
  deleteProject: (id: string) => Promise<void>
  updateProjectPermissionMode: (id: string, permissionMode: PermissionMode) => Promise<Project>
  updateProjectDefaults: (
    id: string,
    defaults: {
      defaultModel?: { providerId: string; modelId: string } | null
      defaultThinkingLevel?: ThinkingLevel | null
    }
  ) => Promise<Project>
  listRemoteHosts: () => Promise<RemoteHostProfile[]>
  listOpenSshHosts: () => Promise<OpenSshHost[]>
  saveOpenSshHost: (input: OpenSshHostInput) => Promise<RemoteHostProfile>
  saveRemoteHost: (input: RemoteHostProfileInput) => Promise<RemoteHostProfile>
  deleteRemoteHost: (id: string) => Promise<void>
  updateProjectRemoteConnection: (
    id: string,
    connectionId: string,
    patch: ProjectRemoteConnection | null
  ) => Promise<Project>
  updateProjectRemoteDefaults: (
    id: string,
    defaults: {
      defaultRemoteConnectionId?: string | null
      remoteWorkspaceRoot?: string | null
    }
  ) => Promise<Project>
  listProjectSessions: (workingDirectory: string) => Promise<SessionSummary[]>
  listProjectSessionsById: (projectId: string) => Promise<SessionSummary[]>
  createProjectSession: (
    workingDirectory: string,
    permissionMode: PermissionMode
  ) => Promise<CurrentSession>
  createRemoteProjectSession: (projectId: string) => Promise<CurrentSession>
  listAnalysisNotebooks: (cwd?: string) => Promise<AnalysisNotebookRegistry>
  initializeProjectAnalysis: (cwd: string) => Promise<AnalysisProjectInitialization>
  openAnalysisNotebook: (cwd: string, path: string) => Promise<AnalysisNotebookFile>
  saveAnalysisNotebook: (
    cwd: string,
    input: SaveAnalysisNotebookInput
  ) => Promise<AnalysisNotebookFile>
  syncAnalysisNotebookDraft: (
    cwd: string,
    path: string,
    document: NotebookDocument,
    savedRevision?: string
  ) => Promise<AnalysisNotebookDraftChange>
  createAnalysisNotebook: (cwd: string, relativePath?: string) => Promise<AnalysisNotebookFile>
  closeAnalysisNotebook: (cwd: string, path: string) => Promise<{ path: string }>
  deleteAnalysisNotebook: (
    cwd: string,
    path: string
  ) => Promise<{ path: string; relativePath: string }>
  listAnalysisKernels: (cwd?: string) => Promise<AnalysisKernelDiagnostics>
  getAnalysisJupyterStatus: (cwd: string) => Promise<JupyterServerStatus>
  getAnalysisJupyterRuntimeStatus: (cwd: string) => Promise<AnalysisJupyterRuntimeStatus>
  startAnalysisJupyter: (cwd: string) => Promise<JupyterServerStatus>
  stopAnalysisJupyter: (cwd: string) => Promise<JupyterServerStatus>
  getAnalysisNotebookSessionStatus: (
    cwd: string,
    path: string,
    document: NotebookDocument
  ) => Promise<AnalysisNotebookSessionStatus>
  ensureAnalysisNotebookSession: (
    cwd: string,
    path: string,
    document: NotebookDocument
  ) => Promise<AnalysisNotebookSessionStatus>
  closeAnalysisNotebookSession: (
    cwd: string,
    path: string
  ) => Promise<AnalysisNotebookSessionStatus>
  interruptAnalysisNotebookExecution: (
    cwd: string,
    path: string
  ) => Promise<AnalysisNotebookSessionStatus>
  executeAnalysisNotebookCell: (
    cwd: string,
    path: string,
    document: NotebookDocument,
    cellId: string
  ) => Promise<AnalysisCellExecutionResult>
  completeAnalysisNotebookCell: (
    cwd: string,
    input: AnalysisNotebookCompletionInput
  ) => Promise<AnalysisNotebookCompletionResult>
  formatAnalysisNotebookCell: (
    cwd: string,
    input: AnalysisNotebookFormatInput
  ) => Promise<AnalysisNotebookFormatResult>
  generateAnalysisNotebookCode: (
    cwd: string,
    path: string,
    document: NotebookDocument,
    input: AnalysisNotebookCodeGenerationInput
  ) => Promise<AnalysisNotebookCodeGenerationResult>
  onAnalysisNotebookCodeGenerationProgress: (
    cb: (progress: AnalysisNotebookCodeGenerationProgress) => void
  ) => () => void
  onAnalysisNotebookDraftChanged: (cb: (change: AnalysisNotebookDraftChange) => void) => () => void
  onAnalysisNotebookFileChanged: (cb: (change: AnalysisNotebookFileChange) => void) => () => void
  stopGeneration: () => Promise<void>
  onSessionChanged: (cb: (session: CurrentSession) => void) => () => void
  onToolApprovalRequest: (cb: (event: ToolApprovalRequest) => void) => () => void
  onToolApprovalCancelled: (cb: (requestId?: string) => void) => () => void
  respondToolApproval: (requestId: string, approved: boolean) => Promise<void>
  listPlugins: () => Promise<PluginCatalogItem[]>
  installPlugin: (source: string) => Promise<PluginCatalogItem[]>
  removePlugin: (source: string) => Promise<PluginCatalogItem[]>
  pickPackageRegistryDirectory: () => Promise<string | null>
  pickPackageArchive: () => Promise<string | null>
  readPackageRegistry: (dir: string) => Promise<PackageRegistryView>
  listPackageRegistries: () => Promise<KnownPackageRegistryView[]>
  removePackageRegistry: (id: string) => Promise<KnownPackageRegistryView[]>
  previewPackageImport: (path: string) => Promise<OfflinePackageImportPreview>
  importPackage: (path: string) => Promise<InstalledPackageView[]>
  listPackageUpdates: () => Promise<PackageUpdateView[]>
  applyPackageUpdate: (type: PackageManagerType, id: string) => Promise<InstalledPackageView[]>
  applyAllPackageUpdates: () => Promise<InstalledPackageView[]>
  onPackageUpdatesAvailable: (cb: (updates: PackageUpdateView[]) => void) => () => void
  planPackageInstall: (
    dir: string,
    type: PackageManagerType,
    id: string,
    version?: string
  ) => Promise<PackageInstallPlanView>
  installPackage: (
    dir: string,
    type: PackageManagerType,
    id: string,
    version?: string
  ) => Promise<InstalledPackageView[]>
  getEnablement: (projectCwd?: string) => Promise<EnablementSnapshot>
  setEnablement: (
    item: EnablementItemKey,
    value: boolean | null,
    scope: EnablementScope
  ) => Promise<EnablementSnapshot>
  listSkills: (cwd?: string) => Promise<SkillSummary[]>
  readSkillContent: (filePath: string, cwd?: string) => Promise<SkillContent>
  setSkillDisabled: (filePath: string, disabled: boolean, cwd?: string) => Promise<SkillSummary[]>
  deleteSkill: (filePath: string, cwd?: string) => Promise<SkillSummary[]>
  listPromptAgents: (cwd?: string) => Promise<PromptAgentSummary[]>
  listMcpServers: (cwd?: string) => Promise<McpServerSummary[]>
  listMcpConnectorCatalog: () => Promise<FeaturedMcpConnector[]>
  installMcpConnector: (
    id: string,
    version?: string,
    registryDir?: string
  ) => Promise<InstalledPackageView[]>
  uninstallMcpConnector: (id: string) => Promise<InstalledPackageView[]>
  buildMcpConnectorEnvironment: (id: string) => Promise<{ envId: string }>
  addRemoteMcpConnector: (
    name: string,
    url: string,
    options?: RemoteMcpConnectorOptions
  ) => Promise<void>
  authorizeRemoteMcpConnector: (name: string) => Promise<void>
  cancelRemoteMcpAuth: (name: string) => Promise<void>
  removeRemoteMcpConnector: (name: string, url: string) => Promise<void>
  setMcpConnectorEnabled: (name: string, enabled: boolean, sourcePath?: string) => Promise<void>
  listFeaturedMcpTools: (id: string) => Promise<string[]>
  getFeaturedMcpAuthStatus: (id: string) => Promise<boolean>
  authorizeFeaturedMcp: (id: string) => Promise<void>
  cancelFeaturedMcpAuth: (id: string) => Promise<void>
  getFeaturedMcpApiKeyStatus: (id: string) => Promise<boolean>
  setFeaturedMcpApiKey: (id: string, key: string) => Promise<void>
  clearFeaturedMcpApiKey: (id: string) => Promise<void>
}

export type { AgentMessage, AgentEventSummary } from './features/chat/lib/agentEventTypes'
