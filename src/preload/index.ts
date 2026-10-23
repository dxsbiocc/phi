import type {
  ModelAvailabilityChange,
  ModelAvailabilitySnapshot
} from '../shared/modelAvailabilityTypes'
import { IPC } from '../shared/ipcChannels'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BrowserRendererBridge, BrowserRendererEventEnvelope } from '../shared/browserTypes'
import type { WebLinkPreview } from '../shared/webLinkPreviewTypes'
import type { TerminalEvent, TerminalRendererBridge } from '../shared/terminalTypes'
import type {
  WorkspaceFileOperationsRendererApi,
  WorkspaceFileOperationTarget,
  WorkspaceFileRenameRequest,
  WorkspaceMarkdownSaveRequest,
  WorkspaceMarkdownSaveResult,
  WorkspaceTextSaveRequest,
  WorkspaceTextSaveResult,
  RemoteWorkspaceFileDownloadRequest
} from '../shared/workspaceFileOperations'
import type {
  RemoteWorkspaceFileRequest,
  RemoteWorkspacePathProbeRequest,
  RemoteWorkspacePathStat
} from '../shared/remoteWorkspacePath'
import type {
  WrapperResultDirectoryRequest,
  WrapperResultDownloadProgress,
  WrapperResultDownloadResult,
  WrapperResultRange,
  WrapperResultRangeRequest,
  WrapperResultReadRequest,
  WrapperResultPreview
} from '../shared/wrapperResultTypes'
import type {
  ProjectLocation,
  RemoteProjectConnectionChange,
  RemoteProjectConnectionRetryRequest,
  RemoteProjectConnectionState,
  RemoteProjectCreateInput,
  RemoteProjectReachability
} from '../shared/projectLocation'
import type { OpenSshHostInput } from '../shared/remoteHostProfile'
import type { RemoteJupyterStartJob } from '../shared/remoteJupyterJobTypes'
import type { NotebookAiGenerationJob } from '../shared/notebookAiJobTypes'
import type { AppUpdateCheck } from '../shared/appUpdateTypes'
import type { ProjectMemorySettings, ProjectMemorySnapshot } from '../shared/projectMemoryTypes'
import type {
  RemoteDirectoryListRequest,
  RemoteDirectoryListing
} from '../shared/remoteDirectoryBrowser'
import type { PromptImageInput, StoredPromptImage } from '../shared/promptImageTypes'
import type { SessionExportResult } from '../shared/sessionExportTypes'
import type { SessionDeleteResult } from '../shared/sessionDeleteTypes'
import type { RuntimeRecoveryApi } from '../shared/runtimeRecoveryTypes'
import type { BackgroundAgentJob, BackgroundShellJob } from '../shared/backgroundJobTypes'
import type {
  AutoCompactionSettingsPatch,
  CurrentAutoCompactionSettings,
  CurrentContextUsage,
  ManualCompactionOutcome,
  ManualCompactionTarget
} from '../shared/contextUsageTypes'
import type { WorkspaceDiffReference } from '../shared/workspaceChangeTypes'
import type { HomeActivitySummary } from '../shared/homeActivityTypes'
import type { SshBootstrapRendererBridge } from '../shared/sshBootstrapTypes'
import type { RemoteRuntimeRootWarningCode } from '../shared/remoteRuntimeRootTypes'
import type { RemoteMicromambaResult } from '../shared/remoteMicromambaTypes'
import type {
  PrepareRemoteProjectUploadInput,
  RemoteProjectUploadJob,
  StartRemoteProjectUploadOptions
} from '../shared/remoteProjectUploadTypes'
import type {
  RemoteRipgrepProgress,
  RemoteRipgrepResult,
  RemoteRipgrepStatusResult
} from '../shared/remoteRipgrepTypes'
import type { PromptAgentSummary, RemoteProjectAgentTrustRequest } from '../shared/promptAgentTypes'
import type { RemoteProjectMcpTrustRequest } from '../shared/remoteProjectMcpTypes'
import type { PlanRunRendererApi } from '../shared/planRunTypes'
import type {
  GithubSourcePreview,
  GithubSourceSummary,
  GithubSourceUpdateCheck
} from '../shared/githubSourceTypes'
import { createPlanRunApi } from './plan-run-api'

// Imported (unlike the other ambient types in this file, which are
// hand-duplicated) because WrapperRunPlan/WrapperRun are large, evolving
// shapes (see docs/design/phi-wrapper-technical-design.md) — duplicating
// them here and in index.d.ts would just be another place for the two to
// drift out of sync.
import type { WrapperCatalogEntry } from '../shared/wrapperCatalogTypes'
import type { WrapperCompositionCatalogItem } from '../shared/wrapperCompositionManifestTypes'
import type { WrapperModuleDetails } from '../shared/wrapperModuleDetailsTypes'
import type { RemoteHpcSettings } from '../shared/wrapperRemoteTypes'
import type {
  RemoteDoctorOptions,
  RemoteDoctorReport,
  RemoteNextflowInstallResult
} from '../shared/remoteDoctorTypes'
import type { SshHostAvailabilityRecord } from '../shared/sshHostAvailability'
import type {
  RemoteEnvironmentSettingInput,
  RemoteEnvironmentToolPaths
} from '../shared/remoteEnvironmentTypes'
import type {
  WrapperRetargetRequest,
  WrapperInputPathMapping,
  WrapperRun,
  WrapperRunPlan,
  WrapperSubmitConfirmation
} from '../shared/wrapperTypes'
import type {
  AgentUserInteractionRequest,
  AgentUserInteractionResponse
} from '../shared/agentInteractionTypes'
import type { PhiAppSettings, PhiAppSettingsPatch } from '../shared/appSettingsTypes'
import type { MenuBarAction } from '../shared/menuBarTypes'
import type {
  SearxngEngineOption,
  WebSearchKeyStatus,
  WebSearchSettings,
  WebSearchSettingsPatch
} from '../shared/webSearchSettingsTypes'
import type {
  EnvironmentGetResult,
  ManagedEnvironmentCleanResult,
  ManagedEnvironmentEntry,
  ManagedEnvironmentRemoveResult,
  EnvironmentSnapshot,
  EnvironmentToolId
} from '../shared/environmentTypes'
import type { EnvironmentBuild } from '../shared/environmentBuildTypes'
import type {
  PhiPluginInstallPreview,
  PhiPluginListItem,
  PhiPluginMutationResult
} from '../shared/phiPluginTypes'
import type {
  KnownPackageRegistryView,
  OfflinePackageImportPreview,
  InstalledPackageView,
  PackageInstallPlanView,
  PackageManagerType,
  PackageRegistryView,
  PackageUpdateView,
  SkillPackageDetailView,
  WrapperPackageDetailView,
  WrapperRemovalPreview,
  WrapperRemovalView
} from '../shared/packageManagerTypes'
import type {
  EnablementItemKey,
  EnablementScope,
  EnablementSnapshot
} from '../shared/enablementTypes'
import type {
  RemoteProjectSkillTrustRequest,
  SkillContent,
  SkillSummary
} from '../shared/skillTypes'
import type {
  FeaturedMcpConnector,
  LocalMcpConnectorRequest,
  LocalMcpRuntimeOption,
  McpConnectorSetupProgress,
  RemoteMcpConnectorOptions
} from '../shared/mcpConnectorCatalog'

type AgentEventSummary = Record<string, unknown>
type Unsubscribe = () => void

const INPUT_FILE_DROP_TARGET_ATTRIBUTE = 'data-phi-file-drop-target'
type InputFileDropTarget = {
  kind: 'chat-composer' | 'wrapper-input' | 'remote-file-tree'
  path?: string
}
const inputFilesDroppedSubscribers = new Set<
  (paths: string[], target: InputFileDropTarget) => void
>()

type AuthStatusItem = {
  providerId: string
  name: string
  configured: boolean
  source?:
    'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command'
  label?: string
  hasApiKey: boolean
  hasOAuth: boolean
  modelKinds?: Array<'chat' | 'decision'>
  hasConfigError: boolean
  statusText: string
}

type AuthPrompt = {
  type: 'text' | 'secret' | 'select' | 'manual_code'
  message: string
  placeholder?: string
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
}

type AuthEvent =
  | {
      type: 'info'
      message: string
      links?: ReadonlyArray<{ url: string; label?: string }>
    }
  | {
      type: 'auth_url'
      url: string
      instructions?: string
    }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | {
      type: 'progress'
      message: string
    }

type AuthInteractionPromptEvent = {
  type: 'prompt'
  requestId: string
  providerId: string
  prompt: AuthPrompt
}

type AuthInteractionNotifyEvent = {
  type: 'notify'
  providerId: string
  event: AuthEvent
}

type AuthInteractionEvent = AuthInteractionPromptEvent | AuthInteractionNotifyEvent

type ModelOption = {
  providerId: string
  modelId: string
  name: string
  thinkingLevels: ThinkingLevel[]
}

type SelectedModel = {
  providerId: string
  modelId: string
} | null

type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type SessionStatus =
  'idle' | 'running' | 'needs_approval' | 'needs_input' | 'failed' | 'completed_unread'
type UnreadKind = 'completed' | 'failed' | 'approval' | 'input'
type LastRunOutcome = 'completed' | 'failed' | 'interrupted' | 'stopped'

type SessionRuntimeState = {
  status: SessionStatus
  unreadKind: UnreadKind | null
  lastRunOutcome?: LastRunOutcome
  currentRunId?: string
  currentRunStartedAt?: string
  lastActivityAt?: string
}

type SessionSummary = SessionRuntimeState & {
  path: string
  id: string
  name?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
  phiSessionId?: string
  legacyRemoteSession?: boolean
}

type SessionSwitchResult = SessionRuntimeState & {
  path: string
  phiSessionId?: string
  cwd: string
  displayCwd?: string
  projectId?: string
  projectLocation?: ProjectLocation
  legacyRemoteSession?: boolean
  sessionGeneration: number
  permissionMode: PermissionMode
  messages: unknown[]
}

type CurrentSession = SessionRuntimeState & {
  path: string | null
  phiSessionId?: string
  cwd: string
  displayCwd?: string
  projectId?: string
  projectLocation?: ProjectLocation
  legacyRemoteSession?: boolean
  sessionGeneration: number
  permissionMode: PermissionMode
  messages?: unknown[]
}

type PromptResult = { path: string | null; phiSessionId?: string; sessionGeneration: number }

type PromptTarget = {
  path: string | null
  phiSessionId?: string
  cwd: string
  sessionGeneration: number
  suppressUserMessageEvent?: boolean
  retryUserMessageId?: string
  images?: PromptImageInput[]
  planMode?: boolean
  planExecute?: boolean
}

type PermissionMode = 'auto' | 'ask' | 'full'

type ProjectRemoteConnection = {
  id: string
  label: string
  hostProfileId: string
  hpc?: RemoteHpcSettings
  runtimeRoot?: string
  inputPathMapping?: WrapperInputPathMapping
}

type RemoteHostProfile = {
  id: string
  label: string
  hostAlias: string
  user?: string
  port?: number
  identityFile?: string
  source?: 'ssh-config'
  runtimeRoot?: string
  downloadMirrorPrefix?: string
  toolPaths?: RemoteEnvironmentToolPaths
}
type OpenSshHost = {
  alias: string
  hostname?: string
  user?: string
  port?: number
  identityFiles: string[]
}

type Project = {
  id: string
  name: string
  location: ProjectLocation
  workingDirectory: string
  permissionMode: PermissionMode
  pathAvailable?: boolean
  remoteReachability?: RemoteProjectReachability
  remoteConnection?: RemoteProjectConnectionState
  remoteHostAlias?: string
  gitStatus?: {
    branch: string
    dirty: boolean
  }
  defaultModel?: { providerId: string; modelId: string }
  defaultThinkingLevel?: ThinkingLevel
  remoteConnections?: ProjectRemoteConnection[]
  defaultRemoteConnectionId?: string
  remoteWorkspaceRoot?: string
  memory?: ProjectMemorySettings
  createdAt: string
}

type ToolApprovalRequest = {
  requestId: string
  agentRunId?: string
  sessionId?: string
  sessionPath?: string
  sessionGeneration?: number
  runId?: string
  cwd?: string
  projectName?: string
  toolName: string
  summary: string
  browser?: {
    origin: string
    action: 'click' | 'typeText' | 'scroll' | 'keypress'
    consequence: 'read' | 'write' | 'irreversible'
    reason: 'external_origin' | 'form_submission' | 'irreversible'
  }
}

type McpServerSummary = {
  id: string
  name: string
  title?: string
  connectorId?: string
  packageId?: string
  category?: string
  command?: string
  args?: string[]
  envKeys?: string[]
  url?: string
  transport?: string
  sourcePath?: string
  managed?: boolean
  userStdio?: boolean
  enabled?: boolean
  userDisabled?: boolean
  status: 'configured'
}

type FilePreview = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  kind: 'text' | 'html' | 'image' | 'pdf'
  mimeType: string
  bytes: number
  previewBytes: number
  truncated: boolean
} & (
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
)

type FileHoverPreview = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  bytes: number
  previewBytes: number
  truncated: boolean
} & (
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

type FileTreeEntry = {
  path: string
  name: string
  displayPath: string
  kind: 'directory' | 'file'
}

type LocalPathStat = {
  path: string
  kind: 'file' | 'directory' | 'missing'
}

type DirectoryListing = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  entries: FileTreeEntry[]
  truncated: boolean
}

type AnalysisNotebookSummary = {
  path: string
  relativePath: string
  name: string
  directory: string
  bytes: number
  modifiedAt: string
}

type AnalysisNotebookRegistry = {
  projectCwd: string | null
  projectName?: string
  notebooks: AnalysisNotebookSummary[]
  truncated: boolean
  initialized: boolean
  message?: string
}

type AnalysisProjectInitialization = {
  notebooksDir: string
  outputsDir: string
}

type AnalysisNotebookFile = {
  path: string
  relativePath: string
  name: string
  bytes: number
  modifiedAt: string
  savedRevision: string
  contentHash?: string
  document: Record<string, unknown>
}

type AnalysisNotebookDraftChange = {
  source: 'agent' | 'renderer'
  projectCwd: string
  path: string
  relativePath: string
  document: Record<string, unknown>
  savedRevision: string
  contentHash?: string
  changeKind?: 'synced' | 'inserted' | 'updated' | 'deleted' | 'executed' | 'saved'
  changedCellId?: string
  focusCellId?: string
}

type AnalysisNotebookFileChange =
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

type SaveAnalysisNotebookInput = {
  path: string
  document: Record<string, unknown>
  expectedRevision?: string
  expectedHash?: string
}

type AnalysisKernelDiagnostics = {
  jupyterServer: {
    available: boolean
    command: 'jupyter'
    version?: string
    error?: string
  }
  kernels: Array<{
    name: string
    displayName: string
    language: 'python' | 'r' | 'other'
    rawLanguage: string
    resourceDir?: string
    executable?: string
    source?: 'managed' | 'host'
  }>
  preferredKernelName?: string
  hasPythonKernel: boolean
  hasRKernel: boolean
  messages: string[]
}

type JupyterServerStatus = {
  projectCwd: string
  state:
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
  runtimeKind?: 'local' | 'ssh'
  serverLabel?: string
  startedAt?: string
  exitedAt?: string
  pid?: number
  port?: number
  remotePort?: number
  hasEndpoint: boolean
  message?: string
  cleanupUnconfirmed?: boolean
  canAbandonCleanup?: boolean
  resources?: Record<string, unknown>
}

type AnalysisNotebookSessionStatus = {
  projectCwd: string
  notebookPath: string
  kernelName?: string
  kernelDisplayName?: string
  sessionId?: string
  state: 'missing' | 'idle' | 'busy' | 'restarting' | 'disconnected' | 'error'
  message?: string
  startedAt?: string
  updatedAt?: string
}

type AnalysisJupyterRuntimeStatus = {
  server: JupyterServerStatus
  notebooks: {
    activeSessionCount: number
    busySessionCount: number
    sessions: AnalysisNotebookSessionStatus[]
  }
}

type AnalysisCellExecutionResult = {
  cellId: string
  executionCount: number | null
  outputs: Record<string, unknown>[]
  state: 'idle' | 'error'
  startedAt: string
  completedAt: string
  document: Record<string, unknown>
  sessionStatus: AnalysisNotebookSessionStatus
}

type AnalysisNotebookCompletionInput = {
  path: string
  document: Record<string, unknown>
  cellId: string
  source: string
  cursorPosition: number
}

type AnalysisNotebookCompletionResult = {
  matches: string[]
  cursorStart: number
  cursorEnd: number
  metadata: Record<string, unknown>
  status: 'ok' | 'error'
  message?: string
}

type AnalysisNotebookFormatInput = {
  path: string
  document: Record<string, unknown>
  cellId: string
  source: string
  language?: string
  lineLength?: number
}

type AnalysisNotebookFormatResult = {
  source: string
  changed: boolean
  formatter: 'ruff' | 'black' | 'none'
  message?: string
}

type AnalysisNotebookCodeGenerationInput = {
  prompt: string
  language: string
  requestId?: string
  model?: {
    providerId: string
    modelId: string
  } | null
  afterCellId?: string | null
  references?: Array<{
    id: string
    kind: 'dataframe' | 'data_source' | 'variable' | 'cell_output'
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
  }>
}

type AnalysisNotebookGeneratedCell = {
  cellType: 'code' | 'markdown'
  source: string
  language?: string
}

type AnalysisNotebookCodeGenerationResult = {
  source: string
  language: string
  cells?: AnalysisNotebookGeneratedCell[]
}

type AnalysisNotebookCodeGenerationProgress = {
  requestId: string
  path: string
  relativePath: string
  source: string
  language: string
  cells: AnalysisNotebookGeneratedCell[]
}

type RemoteMicromambaRequest = {
  requestId: string
  hostProfileId: string
  runtimeRoot: string
  downloadMirrorPrefix?: string
  confirmedWarnings?: readonly RemoteRuntimeRootWarningCode[]
}

type RemoteMicromambaProgress = {
  requestId: string
  stage: 'probe' | 'download' | 'direct-download' | 'desktop-relay' | 'install'
  message: string
  transferredBytes?: number
  totalBytes?: number
}

type RemoteRipgrepRequest = {
  action: 'status' | 'install'
  requestId: string
  hostProfileId: string
  runtimeRoot: string
  confirmedWarnings?: readonly RemoteRuntimeRootWarningCode[]
  forceManaged?: boolean
}

type RemoteRipgrepIpcProgress = RemoteRipgrepProgress & { requestId: string }

type PreloadApiBase = WorkspaceFileOperationsRendererApi & PlanRunRendererApi

type RendererAuthApi = PreloadApiBase & {
  browser: BrowserRendererBridge
  terminal: TerminalRendererBridge
  sshBootstrap: SshBootstrapRendererBridge
  readyWindow: (background: string) => Promise<void>
  closeWindow: () => Promise<void>
  minimizeWindow: () => Promise<void>
  toggleWindowFullscreen: () => Promise<void>
  getWindowFullscreen: () => Promise<boolean>
  onWindowFullscreenChanged: (cb: (fullscreen: boolean) => void) => Unsubscribe
  consumeMenuBarAction: () => Promise<MenuBarAction | null>
  revealPath: (path: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  getFileIcon: (path: string) => Promise<string | null>
  readResourceIcon: (key: string) => Promise<string | null>
  getWebLinkPreview: (url: string) => Promise<WebLinkPreview>
  pickInputFiles: () => Promise<string[]>
  pickLocalUploadFiles: () => Promise<string[]>
  getPathForFile: (file: File) => string
  onInputFilesDropped: (cb: (paths: string[], target: InputFileDropTarget) => void) => Unsubscribe
  previewFile: (path: string) => Promise<FilePreview>
  previewRemoteWorkspaceFile: (request: RemoteWorkspaceFileRequest) => Promise<FilePreview>
  hoverPreviewFile: (path: string) => Promise<FileHoverPreview>
  statLocalPaths: (cwd: string, paths: string[]) => Promise<LocalPathStat[]>
  statRemoteWorkspacePaths: (
    request: RemoteWorkspacePathProbeRequest
  ) => Promise<RemoteWorkspacePathStat[]>
  listDirectory: (path: string) => Promise<DirectoryListing>
  listRemoteWorkspaceDirectory: (request: RemoteWorkspaceFileRequest) => Promise<DirectoryListing>
  listWrapperResultDirectory: (request: WrapperResultDirectoryRequest) => Promise<DirectoryListing>
  previewWrapperResult: (request: WrapperResultReadRequest) => Promise<WrapperResultPreview>
  readWrapperResultRange: (request: WrapperResultRangeRequest) => Promise<WrapperResultRange>
  cancelWrapperResultRead: (requestId: string) => Promise<boolean>
  downloadWrapperResult: (request: WrapperResultReadRequest) => Promise<WrapperResultDownloadResult>
  cancelWrapperResultDownload: (requestId: string) => Promise<boolean>
  onWrapperResultDownloadProgress: (
    cb: (progress: WrapperResultDownloadProgress) => void
  ) => Unsubscribe
  renderMoleculeSvg: (value: string, width: number, height: number) => Promise<string>
  sendPrompt: (text: string, target?: PromptTarget) => Promise<PromptResult | null>
  readPromptImage: (ref: StoredPromptImage) => Promise<PromptImageInput>
  readWorkspaceDiff: (ref: WorkspaceDiffReference) => Promise<string>
  onAgentEvent: (cb: (event: AgentEventSummary) => void) => Unsubscribe
  onAgentUserInteractionRequest: (cb: (event: AgentUserInteractionRequest) => void) => Unsubscribe
  onAgentUserInteractionCancelled: (cb: () => void) => Unsubscribe
  respondAgentUserInteraction: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled?: boolean
  ) => Promise<void>
  getAuthStatus: () => Promise<AuthStatusItem[]>
  loginApiKey: (providerId: string, key: string) => Promise<AuthStatusItem[]>
  loginOAuth: (providerId: string) => Promise<AuthStatusItem[]>
  logout: (providerId: string) => Promise<void>
  submitAuthInteraction: (requestId: string, value: string) => Promise<void>
  onAuthInteraction: (cb: (event: AuthInteractionEvent) => void) => Unsubscribe
  getAppSettings: () => Promise<PhiAppSettings>
  getModelAvailability: () => Promise<ModelAvailabilitySnapshot>
  setModelEnabled: (change: ModelAvailabilityChange) => Promise<ModelAvailabilitySnapshot>
  checkForAppUpdates: () => Promise<AppUpdateCheck>
  openAppReleasesPage: (url?: string) => Promise<void>
  openWebUrl: (url: string) => Promise<void>
  updateAppSettings: (patch: PhiAppSettingsPatch) => Promise<PhiAppSettings>
  getWebSearchSettings: () => Promise<WebSearchSettings>
  updateWebSearchSettings: (patch: WebSearchSettingsPatch) => Promise<WebSearchSettings>
  listSearxngEngines: () => Promise<SearxngEngineOption[]>
  setWebSearchApiKey: (providerId: string, key: string) => Promise<WebSearchKeyStatus>
  clearWebSearchApiKey: (providerId: string) => Promise<WebSearchKeyStatus>
  getEnvironment: () => Promise<EnvironmentGetResult>
  redetectEnvironment: () => Promise<EnvironmentSnapshot>
  dismissEnvironmentSummary: () => Promise<EnvironmentSnapshot>
  setEnvironmentToolPath: (
    toolId: EnvironmentToolId,
    path: string | null
  ) => Promise<EnvironmentSnapshot>
  pickEnvironmentBinary: () => Promise<string | null>
  listManagedEnvironments: (
    projectCwd?: string,
    includeDynamic?: boolean
  ) => Promise<ManagedEnvironmentEntry[]>
  buildManagedEnvironment: (
    ref: string,
    projectCwd?: string,
    pluginId?: string
  ) => Promise<{ envId: string }>
  rebuildManagedEnvironment: (envId: string) => Promise<void>
  removeManagedEnvironment: (envId: string) => Promise<ManagedEnvironmentRemoveResult>
  cleanManagedEnvironments: () => Promise<ManagedEnvironmentCleanResult>
  listModels: () => Promise<ModelOption[]>
  selectModel: (providerId: string | null, modelId: string | null) => Promise<void>
  getSelectedModel: () => Promise<SelectedModel>
  selectThinkingLevel: (level: ThinkingLevel) => Promise<void>
  getThinkingLevel: () => Promise<ThinkingLevel>
  getAppName: () => Promise<string>
  isOnboarded: () => Promise<boolean>
  getPersonaMarkdown: () => Promise<string>
  setPersonaMarkdown: (markdown: string) => Promise<string>
  skipOnboarding: () => Promise<void>
  completeOnboarding: (description: string) => Promise<string>
  listSessions: () => Promise<SessionSummary[]>
  getHomeActivity: () => Promise<HomeActivitySummary>
  getCurrentSession: () => Promise<CurrentSession>
  getCurrentContextUsage: () => Promise<CurrentContextUsage>
  getAutoCompactionSettings: (
    target: ManualCompactionTarget
  ) => Promise<CurrentAutoCompactionSettings>
  setAutoCompactionSettings: (
    target: ManualCompactionTarget,
    patch: AutoCompactionSettingsPatch
  ) => Promise<CurrentAutoCompactionSettings>
  compactCurrentSession: (target: ManualCompactionTarget) => Promise<ManualCompactionOutcome>
  updateCurrentSessionPermissionMode: (
    permissionMode: PermissionMode,
    target: ManualCompactionTarget
  ) => Promise<CurrentSession>
  createSession: () => Promise<CurrentSession>
  getRuntimeRecoveryState: RuntimeRecoveryApi['getRuntimeRecoveryState']
  resumeRuntimeSession: RuntimeRecoveryApi['resumeRuntimeSession']
  continueRuntimeFromSummary: RuntimeRecoveryApi['continueRuntimeFromSummary']
  forkSession: (
    sourceId: string,
    eventId: string
  ) => Promise<{ path: string; phiSessionId: string }>
  switchSession: (path: string) => Promise<SessionSwitchResult | null>
  acknowledgeSession: (path: string) => Promise<SessionSummary | null>
  deleteSession: (path: string, confirmed?: true) => Promise<SessionDeleteResult>
  renameSession: (path: string, name: string) => Promise<void>
  generateSessionTitle: (path: string) => Promise<string>
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
  ) => Unsubscribe
  deleteProject: (id: string) => Promise<void>
  updateProjectPermissionMode: (id: string, permissionMode: PermissionMode) => Promise<Project>
  updateProjectDefaults: (
    id: string,
    defaults: {
      defaultModel?: { providerId: string; modelId: string } | null
      defaultThinkingLevel?: ThinkingLevel | null
    }
  ) => Promise<Project>
  updateProjectMemory: (id: string, settings: ProjectMemorySettings) => Promise<Project>
  getProjectMemory: (id: string) => Promise<ProjectMemorySnapshot>
  deleteProjectMemoryLesson: (
    id: string,
    index: number,
    text: string
  ) => Promise<ProjectMemorySnapshot>
  clearProjectMemory: (id: string) => Promise<ProjectMemorySnapshot>
  listRemoteHosts: () => Promise<RemoteHostProfile[]>
  listRemoteProjectDirectories: (
    request: RemoteDirectoryListRequest
  ) => Promise<RemoteDirectoryListing>
  listOpenSshHosts: () => Promise<OpenSshHost[]>
  saveOpenSshHost: (input: OpenSshHostInput) => Promise<RemoteHostProfile>
  saveRemoteHost: (input: {
    id?: string
    label: string
    hostAlias: string
    user?: string
    port?: number
    identityFile?: string
  }) => Promise<RemoteHostProfile>
  deleteRemoteHost: (id: string) => Promise<void>
  saveRemoteRuntimeRoot: (hostProfileId: string, runtimeRoot?: string) => Promise<RemoteHostProfile>
  saveRemoteEnvironment: (
    hostProfileId: string,
    input: RemoteEnvironmentSettingInput
  ) => Promise<RemoteHostProfile>
  saveRemoteMicromambaMirror: (
    hostProfileId: string,
    downloadMirrorPrefix?: string
  ) => Promise<RemoteHostProfile>
  remoteMicromamba: (request: RemoteMicromambaRequest) => Promise<RemoteMicromambaResult>
  onRemoteMicromambaProgress: (cb: (progress: RemoteMicromambaProgress) => void) => Unsubscribe
  remoteRipgrep: (
    request: RemoteRipgrepRequest
  ) => Promise<RemoteRipgrepStatusResult | RemoteRipgrepResult>
  onRemoteRipgrepProgress: (cb: (progress: RemoteRipgrepIpcProgress) => void) => Unsubscribe
  remoteDoctor: (
    hostProfileId: string,
    remotePath?: string,
    options?: RemoteDoctorOptions
  ) => Promise<RemoteDoctorReport>
  listSshHostAvailability: () => Promise<SshHostAvailabilityRecord[]>
  saveSshHostAvailability: (
    record: SshHostAvailabilityRecord
  ) => Promise<SshHostAvailabilityRecord[]>
  installRemoteNextflow: (hostProfileId: string) => Promise<RemoteNextflowInstallResult>
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
  refreshAnalysisNotebook: (cwd: string, path: string) => Promise<AnalysisNotebookFile>
  saveAnalysisNotebook: (
    cwd: string,
    input: SaveAnalysisNotebookInput
  ) => Promise<AnalysisNotebookFile>
  syncAnalysisNotebookDraft: (
    cwd: string,
    path: string,
    document: Record<string, unknown>,
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
  listAnalysisJupyterRuntimeStatuses: () => Promise<AnalysisJupyterRuntimeStatus[]>
  publishNotebookOutputFrame: (html: string) => Promise<string>
  releaseNotebookOutputFrame: (url: string) => Promise<void>
  startAnalysisJupyter: (cwd: string) => Promise<JupyterServerStatus>
  stopAnalysisJupyter: (
    cwd: string,
    options?: { abandonUnconfirmed?: boolean }
  ) => Promise<JupyterServerStatus>
  getAnalysisNotebookSessionStatus: (
    cwd: string,
    path: string,
    document: Record<string, unknown>
  ) => Promise<AnalysisNotebookSessionStatus>
  ensureAnalysisNotebookSession: (
    cwd: string,
    path: string,
    document: Record<string, unknown>
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
    document: Record<string, unknown>,
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
  listNotebookAiGenerationJobs: () => Promise<NotebookAiGenerationJob[]>
  generateAnalysisNotebookCode: (
    cwd: string,
    path: string,
    document: Record<string, unknown>,
    input: AnalysisNotebookCodeGenerationInput
  ) => Promise<AnalysisNotebookCodeGenerationResult>
  onAnalysisNotebookCodeGenerationProgress: (
    cb: (progress: AnalysisNotebookCodeGenerationProgress) => void
  ) => Unsubscribe
  stopGeneration: () => Promise<void>
  /** Redirect a running agent shown on a delegation card. It reads the message after its current tool call. */
  steerAgentRun: (
    agentSessionId: string,
    agentRunId: string,
    message: string,
    toolCallId?: string
  ) => Promise<void>
  /** Cancel a running agent shown on a delegation card. */
  stopAgentRun: (agentSessionId: string, agentRunId: string) => Promise<void>
  onAnalysisNotebookDraftChanged: (cb: (change: AnalysisNotebookDraftChange) => void) => Unsubscribe
  onAnalysisNotebookFileChanged: (cb: (change: AnalysisNotebookFileChange) => void) => Unsubscribe
  onWrapperRunsChanged: (cb: (change: { runId: string }) => void) => Unsubscribe
  onSessionChanged: (cb: (session: CurrentSession) => void) => Unsubscribe
  onToolApprovalRequest: (cb: (event: ToolApprovalRequest) => void) => Unsubscribe
  onToolApprovalCancelled: (cb: (requestId?: string) => void) => Unsubscribe
  respondToolApproval: (requestId: string, approved: boolean) => Promise<void>
  listPhiPlugins: () => Promise<PhiPluginListItem[]>
  pickPhiPluginDirectory: () => Promise<string | null>
  previewPhiPluginDirectory: (path: string) => Promise<PhiPluginInstallPreview>
  installPhiPluginFromDirectory: (path: string) => Promise<PhiPluginMutationResult>
  setPhiPluginEnabled: (id: string, enabled: boolean) => Promise<PhiPluginMutationResult>
  uninstallPhiPlugin: (id: string) => Promise<PhiPluginMutationResult>
  pickPackageRegistryDirectory: () => Promise<string | null>
  pickPackageArchive: () => Promise<string | null>
  readPackageRegistry: (dir: string) => Promise<PackageRegistryView>
  readOfficialContentCatalog: (forceRefresh?: boolean) => Promise<PackageRegistryView>
  onPackageResourcesChanged: (cb: () => void) => Unsubscribe
  listPackageRegistries: () => Promise<KnownPackageRegistryView[]>
  removePackageRegistry: (id: string) => Promise<KnownPackageRegistryView[]>
  previewPackageImport: (path: string) => Promise<OfflinePackageImportPreview>
  importPackage: (path: string) => Promise<InstalledPackageView[]>
  listPackageUpdates: () => Promise<PackageUpdateView[]>
  applyPackageUpdate: (type: PackageManagerType, id: string) => Promise<InstalledPackageView[]>
  applyAllPackageUpdates: () => Promise<InstalledPackageView[]>
  onPackageUpdatesAvailable: (cb: (updates: PackageUpdateView[]) => void) => Unsubscribe
  planPackageInstall: (
    dir: string,
    type: PackageManagerType,
    id: string,
    version?: string
  ) => Promise<PackageInstallPlanView>
  readWrapperPackageDetail: (dir: string, id: string) => Promise<WrapperPackageDetailView>
  readSkillPackageDetail: (dir: string, id: string) => Promise<SkillPackageDetailView>
  previewWrapperRemoval: (id: string) => Promise<WrapperRemovalPreview>
  removeWrapperPackage: (
    id: string,
    options?: { disableDependents?: boolean }
  ) => Promise<WrapperRemovalView>
  installPackage: (
    dir: string,
    type: PackageManagerType,
    id: string,
    version?: string
  ) => Promise<InstalledPackageView[]>
  uninstallPackage: (type: PackageManagerType, id: string) => Promise<InstalledPackageView[]>
  listInstalledPackages: () => Promise<InstalledPackageView[]>
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
  trustRemoteProjectSkill: (input: RemoteProjectSkillTrustRequest) => Promise<SkillSummary[]>
  revokeRemoteProjectSkillTrust: (input: RemoteProjectSkillTrustRequest) => Promise<SkillSummary[]>
  listPromptAgents: (cwd?: string) => Promise<PromptAgentSummary[]>
  trustRemoteProjectAgent: (input: RemoteProjectAgentTrustRequest) => Promise<PromptAgentSummary[]>
  revokeRemoteProjectAgentTrust: (
    input: RemoteProjectAgentTrustRequest
  ) => Promise<PromptAgentSummary[]>
  listMcpServers: (cwd?: string) => Promise<McpServerSummary[]>
  trustRemoteProjectMcp: (input: RemoteProjectMcpTrustRequest) => Promise<McpServerSummary[]>
  revokeRemoteProjectMcpTrust: (input: RemoteProjectMcpTrustRequest) => Promise<McpServerSummary[]>
  listMcpConnectorCatalog: () => Promise<FeaturedMcpConnector[]>
  previewGithubSource: (url: string) => Promise<GithubSourcePreview>
  addGithubSource: (input: { url: string; sha: string }) => Promise<GithubSourceSummary>
  checkGithubSourceUpdate: (id: string) => Promise<GithubSourceUpdateCheck>
  applyGithubSourceUpdate: (input: { id: string; sha: string }) => Promise<GithubSourceSummary>
  removeGithubSource: (id: string) => Promise<boolean>
  listGithubSources: () => Promise<GithubSourceSummary[]>
  installMcpConnector: (
    id: string,
    version?: string,
    registryDir?: string
  ) => Promise<InstalledPackageView[]>
  uninstallMcpConnector: (id: string) => Promise<InstalledPackageView[]>
  buildMcpConnectorEnvironment: (id: string) => Promise<{ envId: string }>
  onMcpConnectorSetupChanged: (cb: (progress: McpConnectorSetupProgress) => void) => Unsubscribe
  addRemoteMcpConnector: (
    name: string,
    url: string,
    options?: RemoteMcpConnectorOptions
  ) => Promise<void>
  addLocalMcpConnector: (request: LocalMcpConnectorRequest) => Promise<{ tools: string[] }>
  startLocalConnectorAdd: (
    request: LocalMcpConnectorRequest
  ) => Promise<{ started: true; name: string }>
  cancelLocalConnectorAdd: (name: string) => Promise<void>
  retryLocalConnectorAdd: (name: string) => Promise<{ started: true; name: string }>
  listLocalConnectorJobs: () => Promise<McpConnectorSetupProgress[]>
  removeLocalMcpConnector: (name: string) => Promise<void>
  listLocalMcpRuntimes: () => Promise<LocalMcpRuntimeOption[]>
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
  getWrapperPlan: (planId: string) => Promise<WrapperRunPlan | undefined>
  retargetWrapperPlan: (request: WrapperRetargetRequest) => Promise<WrapperRunPlan>
  submitWrapperPlan: (
    planId: string,
    heavyWorkloadAcknowledged?: boolean,
    confirmation?: WrapperSubmitConfirmation
  ) => Promise<WrapperRun>
  cancelWrapperRunPlan: (planId: string) => Promise<WrapperRunPlan>
  listWrapperCatalog: () => Promise<WrapperCatalogEntry[]>
  addCustomWrapper: (sourceDir: string) => Promise<WrapperCatalogEntry>
  listWrapperCompositionCatalog: () => Promise<WrapperCompositionCatalogItem[]>
  getWrapperCompositionDag: (id: string) => Promise<string | undefined>
  getWrapperCompositionModuleDetails: (id: string) => Promise<WrapperModuleDetails | undefined>
  listWrapperRuns: () => Promise<WrapperRun[]>
  listEnvironmentBuilds: () => Promise<EnvironmentBuild[]>
  cancelEnvironmentBuild: (envId: string) => Promise<void>
  onEnvironmentBuildsChanged: (cb: (build: EnvironmentBuild) => void) => Unsubscribe
  prepareRemoteProjectUpload: (
    projectId: string,
    input: PrepareRemoteProjectUploadInput
  ) => Promise<RemoteProjectUploadJob>
  startRemoteProjectUpload: (
    projectId: string,
    jobId: string,
    options?: StartRemoteProjectUploadOptions
  ) => Promise<RemoteProjectUploadJob>
  listRemoteProjectUploads: () => Promise<RemoteProjectUploadJob[]>
  cancelRemoteProjectUpload: (jobId: string) => Promise<void>
  retryRemoteProjectUpload: (jobId: string) => Promise<RemoteProjectUploadJob>
  onRemoteProjectUploadsChanged: (cb: (job: RemoteProjectUploadJob) => void) => Unsubscribe
  listRemoteJupyterJobs: () => Promise<RemoteJupyterStartJob[]>
  onRemoteJupyterJobsChanged: (cb: (job: RemoteJupyterStartJob) => void) => Unsubscribe
  completeWrapperInputUpload: (
    jobId: string,
    planId: string,
    inputId: string,
    expectedRevision: number
  ) => Promise<WrapperRunPlan>
  listAgentJobs: () => Promise<BackgroundAgentJob[]>
  listShellJobs: () => Promise<BackgroundShellJob[]>
  stopShellJob: (agentSessionId: string, jobId: string) => Promise<void>
  getWrapperRun: (runId: string) => Promise<WrapperRun | undefined>
  cancelWrapperRun: (runId: string) => Promise<WrapperRun>
  getWrapperPlanArtifact: (planId: string, fileName: string) => Promise<string | undefined>
  exportWrapperReproducibility: (runId: string) => Promise<string | null>
}

const browserBridge: BrowserRendererBridge = {
  execute: (command) => ipcRenderer.invoke(IPC.browser.execute, command),
  snapshot: () => ipcRenderer.invoke(IPC.browser.snapshot),
  setViewport: (input) => ipcRenderer.invoke(IPC.browser.setViewport, input),
  onEvent: (callback) => {
    const handler = (_: unknown, envelope: BrowserRendererEventEnvelope): void => {
      try {
        void Promise.resolve(callback(envelope)).catch(() => undefined)
      } catch {
        return
      }
    }
    let subscribed = true
    ipcRenderer.on(IPC.browser.event, handler)
    return () => {
      if (!subscribed) return
      subscribed = false
      ipcRenderer.removeListener(IPC.browser.event, handler)
    }
  }
}

const terminalBridge: TerminalRendererBridge = {
  list: (workspace) => ipcRenderer.invoke(IPC.terminal.list, workspace),
  create: (input) => ipcRenderer.invoke(IPC.terminal.create, input),
  attach: (terminalId) => ipcRenderer.invoke(IPC.terminal.attach, terminalId),
  input: (terminalId, data) => ipcRenderer.invoke(IPC.terminal.input, terminalId, data),
  resize: (terminalId, cols, rows) =>
    ipcRenderer.invoke(IPC.terminal.resize, terminalId, cols, rows),
  ack: (terminalId, epoch, bytes) => ipcRenderer.invoke(IPC.terminal.ack, terminalId, epoch, bytes),
  close: (terminalId) => ipcRenderer.invoke(IPC.terminal.close, terminalId),
  generateDraft: (input) => ipcRenderer.invoke(IPC.terminal.generateDraft, input),
  cancelDraft: (requestId) => ipcRenderer.invoke(IPC.terminal.cancelDraft, requestId),
  submitDraft: (input) => ipcRenderer.invoke(IPC.terminal.submitDraft, input),
  onEvent: (callback) => {
    const handler = (_: unknown, event: TerminalEvent): void => {
      try {
        void Promise.resolve(callback(event)).catch(() => undefined)
      } catch {
        return
      }
    }
    let subscribed = true
    ipcRenderer.on(IPC.terminal.event, handler)
    return () => {
      if (!subscribed) return
      subscribed = false
      ipcRenderer.removeListener(IPC.terminal.event, handler)
    }
  }
}

const sshBootstrapBridge: SshBootstrapRendererBridge = {
  inspectTarget: (input) => ipcRenderer.invoke(IPC.sshBootstrap.inspectTarget, input),
  confirmHostKey: (attemptId) => ipcRenderer.invoke(IPC.sshBootstrap.confirmHostKey, attemptId),
  verifyPassword: (attemptId, input) =>
    ipcRenderer.invoke(IPC.sshBootstrap.verifyPassword, attemptId, input),
  completeWithKeyProtection: (attemptId, input) =>
    ipcRenderer.invoke(IPC.sshBootstrap.completeWithKeyProtection, attemptId, input),
  saveConfig: (operationId) => ipcRenderer.invoke(IPC.sshBootstrap.saveConfig, operationId),
  declineConfig: (operationId) => ipcRenderer.invoke(IPC.sshBootstrap.declineConfig, operationId),
  cancel: (id) => ipcRenderer.invoke(IPC.sshBootstrap.cancel, id)
}

const planRunApi = createPlanRunApi(ipcRenderer)

const api: RendererAuthApi = {
  ...planRunApi,
  browser: browserBridge,
  terminal: terminalBridge,
  sshBootstrap: sshBootstrapBridge,
  readyWindow: (background: string): Promise<void> =>
    ipcRenderer.invoke(IPC.window.rendererReady, background),
  closeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.window.close),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke(IPC.window.minimize),
  toggleWindowFullscreen: (): Promise<void> => ipcRenderer.invoke(IPC.window.toggleFullscreen),
  getWindowFullscreen: (): Promise<boolean> => ipcRenderer.invoke(IPC.window.getFullscreen),
  onWindowFullscreenChanged: (cb: (fullscreen: boolean) => void): Unsubscribe => {
    const handler = (_: unknown, fullscreen: unknown): void => {
      if (typeof fullscreen === 'boolean') cb(fullscreen)
    }
    let subscribed = true
    ipcRenderer.on(IPC.window.fullscreenChanged, handler)
    return () => {
      if (!subscribed) return
      subscribed = false
      ipcRenderer.removeListener(IPC.window.fullscreenChanged, handler)
    }
  },
  consumeMenuBarAction: (): Promise<MenuBarAction | null> =>
    ipcRenderer.invoke(IPC.menuBar.consumeAction),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke(IPC.files.reveal, path),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke(IPC.files.openPath, path),
  getFileIcon: (path: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.files.getIcon, path),
  readResourceIcon: (key: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.resources.readIcon, key),
  getWebLinkPreview: (url: string): Promise<WebLinkPreview> =>
    ipcRenderer.invoke(IPC.webLink.preview, url),
  pickInputFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.files.pickInput),
  pickLocalUploadFiles: (): Promise<string[]> => ipcRenderer.invoke(IPC.files.pickLocalUpload),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onInputFilesDropped: (
    cb: (paths: string[], target: InputFileDropTarget) => void
  ): Unsubscribe => {
    inputFilesDroppedSubscribers.add(cb)
    return () => {
      inputFilesDroppedSubscribers.delete(cb)
    }
  },
  saveTextFile: (request: WorkspaceTextSaveRequest): Promise<WorkspaceTextSaveResult> =>
    ipcRenderer.invoke(IPC.files.saveTextFile, request),
  saveMarkdownFile: (request: WorkspaceMarkdownSaveRequest): Promise<WorkspaceMarkdownSaveResult> =>
    ipcRenderer.invoke(IPC.files.saveMarkdownFile, request),
  renameWorkspaceFile: (request: WorkspaceFileRenameRequest): Promise<{ path: string }> =>
    ipcRenderer.invoke(IPC.files.renameWorkspaceFile, request),
  deleteWorkspaceFile: (request: WorkspaceFileOperationTarget): Promise<void> =>
    ipcRenderer.invoke(IPC.files.deleteWorkspaceFile, request),
  downloadRemoteWorkspaceFile: (
    request: RemoteWorkspaceFileDownloadRequest
  ): Promise<WrapperResultDownloadResult> =>
    ipcRenderer.invoke(IPC.remoteWorkspace.download, request),
  previewFile: (path: string): Promise<FilePreview> => ipcRenderer.invoke(IPC.files.preview, path),
  previewRemoteWorkspaceFile: (request: RemoteWorkspaceFileRequest): Promise<FilePreview> =>
    ipcRenderer.invoke(IPC.remoteWorkspace.preview, request),
  hoverPreviewFile: (path: string): Promise<FileHoverPreview> =>
    ipcRenderer.invoke(IPC.files.hoverPreview, path),
  statLocalPaths: (cwd: string, paths: string[]): Promise<LocalPathStat[]> =>
    ipcRenderer.invoke(IPC.files.statLocalPaths, cwd, paths),
  statRemoteWorkspacePaths: (
    request: RemoteWorkspacePathProbeRequest
  ): Promise<RemoteWorkspacePathStat[]> =>
    ipcRenderer.invoke(IPC.remoteWorkspace.statPaths, request),
  listDirectory: (path: string): Promise<DirectoryListing> =>
    ipcRenderer.invoke(IPC.files.listDirectory, path),
  listRemoteWorkspaceDirectory: (request: RemoteWorkspaceFileRequest): Promise<DirectoryListing> =>
    ipcRenderer.invoke(IPC.remoteWorkspace.listDirectory, request),
  listWrapperResultDirectory: (request: WrapperResultDirectoryRequest): Promise<DirectoryListing> =>
    ipcRenderer.invoke(IPC.wrapperResults.listDirectory, request),
  previewWrapperResult: (request: WrapperResultReadRequest): Promise<WrapperResultPreview> =>
    ipcRenderer.invoke(IPC.wrapperResults.preview, request),
  readWrapperResultRange: (request: WrapperResultRangeRequest): Promise<WrapperResultRange> =>
    ipcRenderer.invoke(IPC.wrapperResults.readRange, request),
  cancelWrapperResultRead: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.wrapperResults.cancelRead, requestId),
  downloadWrapperResult: (
    request: WrapperResultReadRequest
  ): Promise<WrapperResultDownloadResult> =>
    ipcRenderer.invoke(IPC.wrapperResults.download, request),
  cancelWrapperResultDownload: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.wrapperResults.cancelDownload, requestId),
  onWrapperResultDownloadProgress: (
    cb: (progress: WrapperResultDownloadProgress) => void
  ): Unsubscribe => {
    const handler = (_: unknown, progress: WrapperResultDownloadProgress): void => cb(progress)
    ipcRenderer.on(IPC.wrapperResults.downloadProgress, handler)
    return () => ipcRenderer.removeListener(IPC.wrapperResults.downloadProgress, handler)
  },
  renderMoleculeSvg: (value: string, width: number, height: number): Promise<string> =>
    ipcRenderer.invoke(IPC.molecules.renderSvg, value, width, height),
  sendPrompt: (text: string, target?: PromptTarget): Promise<PromptResult | null> =>
    ipcRenderer.invoke(IPC.agent.prompt, text, target),
  readPromptImage: (ref: StoredPromptImage): Promise<PromptImageInput> =>
    ipcRenderer.invoke(IPC.agent.readPromptImage, ref),
  readWorkspaceDiff: (ref: WorkspaceDiffReference): Promise<string> =>
    ipcRenderer.invoke(IPC.workspaceChanges.readDiff, ref),
  onAgentEvent: (cb: (event: AgentEventSummary) => void): Unsubscribe => {
    const handler = (_: unknown, event: AgentEventSummary): void => {
      cb(event)
    }

    ipcRenderer.on(IPC.agent.event, handler)

    return () => {
      ipcRenderer.removeListener(IPC.agent.event, handler)
    }
  },
  getAuthStatus: (): Promise<AuthStatusItem[]> => ipcRenderer.invoke(IPC.auth.status),
  loginApiKey: (providerId: string, key: string): Promise<AuthStatusItem[]> =>
    ipcRenderer.invoke(IPC.auth.loginApiKey, providerId, key),
  loginOAuth: (providerId: string): Promise<AuthStatusItem[]> =>
    ipcRenderer.invoke(IPC.auth.loginOAuth, providerId),
  logout: (providerId: string): Promise<void> => ipcRenderer.invoke(IPC.auth.logout, providerId),
  submitAuthInteraction: (requestId: string, value: string): Promise<void> =>
    ipcRenderer.invoke(IPC.auth.interactionResponse, requestId, value),
  onAuthInteraction: (cb: (event: AuthInteractionEvent) => void): Unsubscribe => {
    const handler = (_: unknown, event: AuthInteractionEvent): void => {
      cb(event)
    }

    ipcRenderer.on(IPC.auth.interactionRequested, handler)

    return () => {
      ipcRenderer.removeListener(IPC.auth.interactionRequested, handler)
    }
  },
  getAppSettings: (): Promise<PhiAppSettings> => ipcRenderer.invoke(IPC.settings.get),
  getModelAvailability: (): Promise<ModelAvailabilitySnapshot> =>
    ipcRenderer.invoke(IPC.models.availability),
  setModelEnabled: (change: ModelAvailabilityChange): Promise<ModelAvailabilitySnapshot> =>
    ipcRenderer.invoke(IPC.models.setEnabled, change),
  checkForAppUpdates: (): Promise<AppUpdateCheck> => ipcRenderer.invoke(IPC.app.checkForUpdates),
  openAppReleasesPage: (url?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.app.openReleasesPage, url),
  openWebUrl: (url: string): Promise<void> => ipcRenderer.invoke(IPC.app.openWebUrl, url),
  updateAppSettings: (patch: PhiAppSettingsPatch): Promise<PhiAppSettings> =>
    ipcRenderer.invoke(IPC.settings.update, patch),
  getWebSearchSettings: (): Promise<WebSearchSettings> =>
    ipcRenderer.invoke(IPC.settings.webSearchGet),
  updateWebSearchSettings: (patch: WebSearchSettingsPatch): Promise<WebSearchSettings> =>
    ipcRenderer.invoke(IPC.settings.webSearchUpdate, patch),
  listSearxngEngines: (): Promise<SearxngEngineOption[]> =>
    ipcRenderer.invoke(IPC.settings.webSearchSearxngEngines),
  setWebSearchApiKey: (providerId: string, key: string): Promise<WebSearchKeyStatus> =>
    ipcRenderer.invoke(IPC.settings.webSearchApiKeySet, providerId, key),
  clearWebSearchApiKey: (providerId: string): Promise<WebSearchKeyStatus> =>
    ipcRenderer.invoke(IPC.settings.webSearchApiKeyClear, providerId),
  getEnvironment: (): Promise<EnvironmentGetResult> => ipcRenderer.invoke(IPC.environment.get),
  redetectEnvironment: (): Promise<EnvironmentSnapshot> =>
    ipcRenderer.invoke(IPC.environment.redetect),
  dismissEnvironmentSummary: (): Promise<EnvironmentSnapshot> =>
    ipcRenderer.invoke(IPC.environment.dismissSummary),
  setEnvironmentToolPath: (
    toolId: EnvironmentToolId,
    path: string | null
  ): Promise<EnvironmentSnapshot> => ipcRenderer.invoke(IPC.environment.setToolPath, toolId, path),
  pickEnvironmentBinary: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.environment.pickBinary),
  listManagedEnvironments: (
    projectCwd?: string,
    includeDynamic?: boolean
  ): Promise<ManagedEnvironmentEntry[]> =>
    ipcRenderer.invoke(IPC.managedEnvironments.list, projectCwd, includeDynamic),
  buildManagedEnvironment: (
    ref: string,
    projectCwd?: string,
    pluginId?: string
  ): Promise<{ envId: string }> =>
    ipcRenderer.invoke(IPC.managedEnvironments.build, ref, projectCwd, pluginId),
  rebuildManagedEnvironment: (envId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.managedEnvironments.rebuild, envId),
  removeManagedEnvironment: (envId: string): Promise<ManagedEnvironmentRemoveResult> =>
    ipcRenderer.invoke(IPC.managedEnvironments.remove, envId),
  cleanManagedEnvironments: (): Promise<ManagedEnvironmentCleanResult> =>
    ipcRenderer.invoke(IPC.managedEnvironments.clean),
  listModels: (): Promise<ModelOption[]> => ipcRenderer.invoke(IPC.models.list),
  selectModel: (providerId: string | null, modelId: string | null): Promise<void> =>
    ipcRenderer.invoke(IPC.models.select, providerId, modelId),
  getSelectedModel: (): Promise<SelectedModel> => ipcRenderer.invoke(IPC.models.selected),
  selectThinkingLevel: (level: ThinkingLevel): Promise<void> =>
    ipcRenderer.invoke(IPC.thinking.select, level),
  getThinkingLevel: (): Promise<ThinkingLevel> => ipcRenderer.invoke(IPC.thinking.selected),
  getAppName: (): Promise<string> => ipcRenderer.invoke(IPC.persona.getAppName),
  isOnboarded: (): Promise<boolean> => ipcRenderer.invoke(IPC.persona.isOnboarded),
  getPersonaMarkdown: (): Promise<string> => ipcRenderer.invoke(IPC.persona.getMarkdown),
  setPersonaMarkdown: (markdown: string): Promise<string> =>
    ipcRenderer.invoke(IPC.persona.setMarkdown, markdown),
  skipOnboarding: (): Promise<void> => ipcRenderer.invoke(IPC.persona.skip),
  completeOnboarding: (description: string): Promise<string> =>
    ipcRenderer.invoke(IPC.persona.completeOnboarding, description),
  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke(IPC.sessions.list),
  getHomeActivity: (): Promise<HomeActivitySummary> =>
    ipcRenderer.invoke(IPC.sessions.homeActivity),
  getCurrentSession: (): Promise<CurrentSession> => ipcRenderer.invoke(IPC.sessions.current),
  getCurrentContextUsage: (): Promise<CurrentContextUsage> =>
    ipcRenderer.invoke(IPC.sessions.contextUsage),
  getAutoCompactionSettings: (
    target: ManualCompactionTarget
  ): Promise<CurrentAutoCompactionSettings> =>
    ipcRenderer.invoke(IPC.sessions.autoCompactionSettings, target),
  setAutoCompactionSettings: (
    target: ManualCompactionTarget,
    patch: AutoCompactionSettingsPatch
  ): Promise<CurrentAutoCompactionSettings> =>
    ipcRenderer.invoke(IPC.sessions.autoCompactionSettingsSet, target, patch),
  compactCurrentSession: (target: ManualCompactionTarget): Promise<ManualCompactionOutcome> =>
    ipcRenderer.invoke(IPC.sessions.compact, target),
  updateCurrentSessionPermissionMode: (
    permissionMode: PermissionMode,
    target: ManualCompactionTarget
  ): Promise<CurrentSession> =>
    ipcRenderer.invoke(IPC.sessions.updatePermissionMode, permissionMode, target),
  createSession: (): Promise<CurrentSession> => ipcRenderer.invoke(IPC.sessions.create),
  getRuntimeRecoveryState: (target) => ipcRenderer.invoke(IPC.sessions.runtimeRecovery, target),
  resumeRuntimeSession: (target, replacementModel) =>
    ipcRenderer.invoke(IPC.sessions.resumeRuntime, target, replacementModel),
  continueRuntimeFromSummary: (target, sha256) =>
    ipcRenderer.invoke(IPC.sessions.continueRuntimeSummary, target, sha256),
  forkSession: (
    sourceId: string,
    eventId: string
  ): Promise<{ path: string; phiSessionId: string }> =>
    ipcRenderer.invoke(IPC.sessions.fork, sourceId, eventId),
  switchSession: (path: string): Promise<SessionSwitchResult | null> =>
    ipcRenderer.invoke(IPC.sessions.switch, path),
  acknowledgeSession: (path: string): Promise<SessionSummary | null> =>
    ipcRenderer.invoke(IPC.sessions.acknowledge, path),
  deleteSession: (path: string, confirmed?: true): Promise<SessionDeleteResult> =>
    ipcRenderer.invoke(IPC.sessions.delete, path, confirmed),
  renameSession: (path: string, name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.sessions.rename, path, name),
  generateSessionTitle: (path: string): Promise<string> =>
    ipcRenderer.invoke(IPC.sessions.generateTitle, path),
  exportSession: (sessionId: string): Promise<SessionExportResult | null> =>
    ipcRenderer.invoke(IPC.sessions.export, sessionId),
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke(IPC.projects.list),
  pickProjectDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.projects.pickDirectory),
  createProject: (
    name: string,
    workingDirectory: string,
    permissionMode: PermissionMode
  ): Promise<Project> =>
    ipcRenderer.invoke(IPC.projects.create, name, workingDirectory, permissionMode),
  createRemoteProject: (input: RemoteProjectCreateInput): Promise<Project> =>
    ipcRenderer.invoke(IPC.projects.createRemote, input),
  retryRemoteProjectConnection: (
    request: RemoteProjectConnectionRetryRequest
  ): Promise<RemoteProjectConnectionState> =>
    ipcRenderer.invoke(IPC.projects.retryRemoteConnection, request),
  onRemoteProjectConnectionChanged: (
    cb: (change: RemoteProjectConnectionChange) => void
  ): Unsubscribe => {
    const handler = (_: unknown, change: RemoteProjectConnectionChange): void => cb(change)
    ipcRenderer.on(IPC.projects.remoteConnectionChanged, handler)
    return () => ipcRenderer.removeListener(IPC.projects.remoteConnectionChanged, handler)
  },
  deleteProject: (id: string): Promise<void> => ipcRenderer.invoke(IPC.projects.delete, id),
  updateProjectPermissionMode: (id: string, permissionMode: PermissionMode): Promise<Project> =>
    ipcRenderer.invoke(IPC.projects.updatePermissionMode, id, permissionMode),
  updateProjectDefaults: (
    id: string,
    defaults: {
      defaultModel?: { providerId: string; modelId: string } | null
      defaultThinkingLevel?: ThinkingLevel | null
    }
  ): Promise<Project> => ipcRenderer.invoke(IPC.projects.updateDefaults, id, defaults),
  updateProjectMemory: (id: string, settings: ProjectMemorySettings): Promise<Project> =>
    ipcRenderer.invoke(IPC.projects.updateMemory, id, settings),
  getProjectMemory: (id: string): Promise<ProjectMemorySnapshot> =>
    ipcRenderer.invoke(IPC.memory.snapshot, id),
  deleteProjectMemoryLesson: (
    id: string,
    index: number,
    text: string
  ): Promise<ProjectMemorySnapshot> => ipcRenderer.invoke(IPC.memory.deleteLesson, id, index, text),
  clearProjectMemory: (id: string): Promise<ProjectMemorySnapshot> =>
    ipcRenderer.invoke(IPC.memory.clear, id),
  listRemoteHosts: (): Promise<RemoteHostProfile[]> =>
    ipcRenderer.invoke(IPC.projects.listRemoteHosts),
  listRemoteProjectDirectories: (
    request: RemoteDirectoryListRequest
  ): Promise<RemoteDirectoryListing> =>
    ipcRenderer.invoke(IPC.projects.listRemoteDirectories, request),
  listOpenSshHosts: (): Promise<OpenSshHost[]> => ipcRenderer.invoke(IPC.projects.listOpenSshHosts),
  saveOpenSshHost: (input: OpenSshHostInput): Promise<RemoteHostProfile> =>
    ipcRenderer.invoke(IPC.projects.saveOpenSshHost, input),
  saveRemoteHost: (input: {
    id?: string
    label: string
    hostAlias: string
    user?: string
    port?: number
    identityFile?: string
  }): Promise<RemoteHostProfile> => ipcRenderer.invoke(IPC.projects.saveRemoteHost, input),
  deleteRemoteHost: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.projects.deleteRemoteHost, id),
  saveRemoteRuntimeRoot: (
    hostProfileId: string,
    runtimeRoot?: string
  ): Promise<RemoteHostProfile> =>
    ipcRenderer.invoke(IPC.remote.saveRuntimeRoot, hostProfileId, runtimeRoot),
  saveRemoteEnvironment: (
    hostProfileId: string,
    input: RemoteEnvironmentSettingInput
  ): Promise<RemoteHostProfile> =>
    ipcRenderer.invoke(IPC.remote.saveEnvironment, hostProfileId, input),
  saveRemoteMicromambaMirror: (
    hostProfileId: string,
    downloadMirrorPrefix?: string
  ): Promise<RemoteHostProfile> =>
    ipcRenderer.invoke(IPC.remote.saveMicromambaMirror, hostProfileId, downloadMirrorPrefix),
  remoteMicromamba: (request: RemoteMicromambaRequest): Promise<RemoteMicromambaResult> =>
    ipcRenderer.invoke(IPC.remote.micromamba, request),
  onRemoteMicromambaProgress: (cb: (progress: RemoteMicromambaProgress) => void): Unsubscribe => {
    const handler = (_: unknown, progress: RemoteMicromambaProgress): void => cb(progress)
    ipcRenderer.on(IPC.remote.micromambaProgress, handler)
    return () => ipcRenderer.removeListener(IPC.remote.micromambaProgress, handler)
  },
  remoteRipgrep: (
    request: RemoteRipgrepRequest
  ): Promise<RemoteRipgrepStatusResult | RemoteRipgrepResult> =>
    ipcRenderer.invoke(IPC.remote.ripgrep, request),
  onRemoteRipgrepProgress: (cb: (progress: RemoteRipgrepIpcProgress) => void): Unsubscribe => {
    const handler = (_: unknown, progress: RemoteRipgrepIpcProgress): void => cb(progress)
    ipcRenderer.on(IPC.remote.ripgrepProgress, handler)
    return () => ipcRenderer.removeListener(IPC.remote.ripgrepProgress, handler)
  },
  remoteDoctor: (
    hostProfileId: string,
    remotePath?: string,
    options?: RemoteDoctorOptions
  ): Promise<RemoteDoctorReport> =>
    ipcRenderer.invoke(IPC.remote.doctor, hostProfileId, remotePath, options),
  listSshHostAvailability: (): Promise<SshHostAvailabilityRecord[]> =>
    ipcRenderer.invoke(IPC.remote.listHostAvailability),
  saveSshHostAvailability: (
    record: SshHostAvailabilityRecord
  ): Promise<SshHostAvailabilityRecord[]> =>
    ipcRenderer.invoke(IPC.remote.saveHostAvailability, record),
  installRemoteNextflow: (hostProfileId: string): Promise<RemoteNextflowInstallResult> =>
    ipcRenderer.invoke(IPC.remote.installNextflow, hostProfileId),
  updateProjectRemoteConnection: (
    id: string,
    connectionId: string,
    patch: ProjectRemoteConnection | null
  ): Promise<Project> =>
    ipcRenderer.invoke(IPC.projects.updateRemoteConnection, id, connectionId, patch),
  updateProjectRemoteDefaults: (
    id: string,
    defaults: {
      defaultRemoteConnectionId?: string | null
      remoteWorkspaceRoot?: string | null
    }
  ): Promise<Project> => ipcRenderer.invoke(IPC.projects.updateRemoteDefaults, id, defaults),
  listProjectSessions: (workingDirectory: string): Promise<SessionSummary[]> =>
    ipcRenderer.invoke(IPC.projects.sessions, workingDirectory),
  listProjectSessionsById: (projectId: string): Promise<SessionSummary[]> =>
    ipcRenderer.invoke(IPC.projects.sessionsById, projectId),
  createProjectSession: (
    workingDirectory: string,
    permissionMode: PermissionMode
  ): Promise<CurrentSession> =>
    ipcRenderer.invoke(IPC.projects.newSession, workingDirectory, permissionMode),
  createRemoteProjectSession: (projectId: string): Promise<CurrentSession> =>
    ipcRenderer.invoke(IPC.projects.newRemoteSession, projectId),
  listAnalysisNotebooks: (cwd?: string): Promise<AnalysisNotebookRegistry> =>
    ipcRenderer.invoke(IPC.analysis.listNotebooks, cwd),
  initializeProjectAnalysis: (cwd: string): Promise<AnalysisProjectInitialization> =>
    ipcRenderer.invoke(IPC.analysis.initializeProject, cwd),
  openAnalysisNotebook: (cwd: string, path: string): Promise<AnalysisNotebookFile> =>
    ipcRenderer.invoke(IPC.analysis.openNotebook, cwd, path),
  refreshAnalysisNotebook: (cwd: string, path: string): Promise<AnalysisNotebookFile> =>
    ipcRenderer.invoke(IPC.analysis.refreshNotebook, cwd, path),
  saveAnalysisNotebook: (
    cwd: string,
    input: SaveAnalysisNotebookInput
  ): Promise<AnalysisNotebookFile> => ipcRenderer.invoke(IPC.analysis.saveNotebook, cwd, input),
  syncAnalysisNotebookDraft: (
    cwd: string,
    path: string,
    document: Record<string, unknown>,
    savedRevision?: string
  ): Promise<AnalysisNotebookDraftChange> =>
    ipcRenderer.invoke(IPC.analysis.syncNotebookDraft, cwd, path, document, savedRevision),
  createAnalysisNotebook: (cwd: string, relativePath?: string): Promise<AnalysisNotebookFile> =>
    ipcRenderer.invoke(IPC.analysis.createNotebook, cwd, relativePath),
  closeAnalysisNotebook: (cwd: string, path: string): Promise<{ path: string }> =>
    ipcRenderer.invoke(IPC.analysis.closeNotebook, cwd, path),
  deleteAnalysisNotebook: (
    cwd: string,
    path: string
  ): Promise<{ path: string; relativePath: string }> =>
    ipcRenderer.invoke(IPC.analysis.deleteNotebook, cwd, path),
  listAnalysisKernels: (cwd?: string): Promise<AnalysisKernelDiagnostics> =>
    ipcRenderer.invoke(IPC.analysis.listKernels, cwd),
  getAnalysisJupyterStatus: (cwd: string): Promise<JupyterServerStatus> =>
    ipcRenderer.invoke(IPC.analysis.jupyterStatus, cwd),
  getAnalysisJupyterRuntimeStatus: (cwd: string): Promise<AnalysisJupyterRuntimeStatus> =>
    ipcRenderer.invoke(IPC.analysis.jupyterRuntimeStatus, cwd),
  listAnalysisJupyterRuntimeStatuses: (): Promise<AnalysisJupyterRuntimeStatus[]> =>
    ipcRenderer.invoke(IPC.analysis.listJupyterRuntimeStatuses),
  publishNotebookOutputFrame: (html: string): Promise<string> =>
    ipcRenderer.invoke(IPC.analysis.publishNotebookOutputFrame, html),
  releaseNotebookOutputFrame: (url: string): Promise<void> =>
    ipcRenderer.invoke(IPC.analysis.releaseNotebookOutputFrame, url),
  startAnalysisJupyter: (cwd: string): Promise<JupyterServerStatus> =>
    ipcRenderer.invoke(IPC.analysis.startJupyter, cwd),
  stopAnalysisJupyter: (
    cwd: string,
    options?: { abandonUnconfirmed?: boolean }
  ): Promise<JupyterServerStatus> => ipcRenderer.invoke(IPC.analysis.stopJupyter, cwd, options),
  getAnalysisNotebookSessionStatus: (
    cwd: string,
    path: string,
    document: Record<string, unknown>
  ): Promise<AnalysisNotebookSessionStatus> =>
    ipcRenderer.invoke(IPC.analysis.notebookSessionStatus, cwd, path, document),
  ensureAnalysisNotebookSession: (
    cwd: string,
    path: string,
    document: Record<string, unknown>
  ): Promise<AnalysisNotebookSessionStatus> =>
    ipcRenderer.invoke(IPC.analysis.ensureNotebookSession, cwd, path, document),
  closeAnalysisNotebookSession: (
    cwd: string,
    path: string
  ): Promise<AnalysisNotebookSessionStatus> =>
    ipcRenderer.invoke(IPC.analysis.closeNotebookSession, cwd, path),
  interruptAnalysisNotebookExecution: (
    cwd: string,
    path: string
  ): Promise<AnalysisNotebookSessionStatus> =>
    ipcRenderer.invoke(IPC.analysis.interruptNotebookExecution, cwd, path),
  executeAnalysisNotebookCell: (
    cwd: string,
    path: string,
    document: Record<string, unknown>,
    cellId: string
  ): Promise<AnalysisCellExecutionResult> =>
    ipcRenderer.invoke(IPC.analysis.executeNotebookCell, cwd, path, document, cellId),
  completeAnalysisNotebookCell: (
    cwd: string,
    input: AnalysisNotebookCompletionInput
  ): Promise<AnalysisNotebookCompletionResult> =>
    ipcRenderer.invoke(IPC.analysis.completeNotebookCell, cwd, input),
  formatAnalysisNotebookCell: (
    cwd: string,
    input: AnalysisNotebookFormatInput
  ): Promise<AnalysisNotebookFormatResult> =>
    ipcRenderer.invoke(IPC.analysis.formatNotebookCell, cwd, input),
  listNotebookAiGenerationJobs: (): Promise<NotebookAiGenerationJob[]> =>
    ipcRenderer.invoke(IPC.analysis.listNotebookAiGenerationJobs),
  generateAnalysisNotebookCode: (
    cwd: string,
    path: string,
    document: Record<string, unknown>,
    input: AnalysisNotebookCodeGenerationInput
  ): Promise<AnalysisNotebookCodeGenerationResult> =>
    ipcRenderer.invoke(IPC.analysis.generateNotebookCode, cwd, path, document, input),
  onAnalysisNotebookCodeGenerationProgress: (
    cb: (progress: AnalysisNotebookCodeGenerationProgress) => void
  ): Unsubscribe => {
    const handler = (_: unknown, progress: AnalysisNotebookCodeGenerationProgress): void => {
      cb(progress)
    }

    ipcRenderer.on(IPC.analysis.notebookCodeGenerationProgress, handler)

    return () => {
      ipcRenderer.removeListener(IPC.analysis.notebookCodeGenerationProgress, handler)
    }
  },
  stopGeneration: (): Promise<void> => ipcRenderer.invoke(IPC.agent.stop),
  steerAgentRun: (
    agentSessionId: string,
    agentRunId: string,
    message: string,
    toolCallId?: string
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.agent.steerRun, agentSessionId, agentRunId, message, toolCallId),
  stopAgentRun: (agentSessionId: string, agentRunId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.agent.stopRun, agentSessionId, agentRunId),
  onAnalysisNotebookDraftChanged: (
    cb: (change: AnalysisNotebookDraftChange) => void
  ): Unsubscribe => {
    const handler = (_: unknown, change: AnalysisNotebookDraftChange): void => {
      cb(change)
    }

    ipcRenderer.on(IPC.analysis.notebookDraftChanged, handler)

    return () => {
      ipcRenderer.removeListener(IPC.analysis.notebookDraftChanged, handler)
    }
  },
  onWrapperRunsChanged: (cb: (change: { runId: string }) => void): Unsubscribe => {
    const handler = (_: unknown, change: { runId: string }): void => {
      cb(change)
    }
    ipcRenderer.on(IPC.wrappers.runsChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.wrappers.runsChanged, handler)
    }
  },
  listEnvironmentBuilds: (): Promise<EnvironmentBuild[]> =>
    ipcRenderer.invoke(IPC.environmentBuilds.list),
  cancelEnvironmentBuild: (envId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.environmentBuilds.cancel, envId),
  onEnvironmentBuildsChanged: (cb: (build: EnvironmentBuild) => void): Unsubscribe => {
    const handler = (_: unknown, build: EnvironmentBuild): void => {
      cb(build)
    }
    ipcRenderer.on(IPC.environmentBuilds.changed, handler)
    return () => {
      ipcRenderer.removeListener(IPC.environmentBuilds.changed, handler)
    }
  },
  prepareRemoteProjectUpload: (projectId, input): Promise<RemoteProjectUploadJob> =>
    ipcRenderer.invoke(IPC.remoteProjectUploads.prepare, projectId, input),
  startRemoteProjectUpload: (projectId, jobId, options): Promise<RemoteProjectUploadJob> =>
    ipcRenderer.invoke(IPC.remoteProjectUploads.start, projectId, jobId, options),
  listRemoteProjectUploads: (): Promise<RemoteProjectUploadJob[]> =>
    ipcRenderer.invoke(IPC.remoteProjectUploads.list),
  cancelRemoteProjectUpload: (jobId): Promise<void> =>
    ipcRenderer.invoke(IPC.remoteProjectUploads.cancel, jobId),
  retryRemoteProjectUpload: (jobId): Promise<RemoteProjectUploadJob> =>
    ipcRenderer.invoke(IPC.remoteProjectUploads.retry, jobId),
  onRemoteProjectUploadsChanged: (cb): Unsubscribe => {
    const handler = (_: unknown, job: RemoteProjectUploadJob): void => cb(job)
    ipcRenderer.on(IPC.remoteProjectUploads.changed, handler)
    return () => ipcRenderer.removeListener(IPC.remoteProjectUploads.changed, handler)
  },
  listRemoteJupyterJobs: (): Promise<RemoteJupyterStartJob[]> =>
    ipcRenderer.invoke(IPC.remoteJupyterJobs.list),
  onRemoteJupyterJobsChanged: (cb): Unsubscribe => {
    const handler = (_: unknown, job: RemoteJupyterStartJob): void => cb(job)
    ipcRenderer.on(IPC.remoteJupyterJobs.changed, handler)
    return () => ipcRenderer.removeListener(IPC.remoteJupyterJobs.changed, handler)
  },
  completeWrapperInputUpload: (jobId, planId, inputId, expectedRevision): Promise<WrapperRunPlan> =>
    ipcRenderer.invoke(IPC.wrappers.completeInputUpload, jobId, planId, inputId, expectedRevision),
  onAnalysisNotebookFileChanged: (
    cb: (change: AnalysisNotebookFileChange) => void
  ): Unsubscribe => {
    const handler = (_: unknown, change: AnalysisNotebookFileChange): void => {
      cb(change)
    }

    ipcRenderer.on(IPC.analysis.notebookFileChanged, handler)

    return () => {
      ipcRenderer.removeListener(IPC.analysis.notebookFileChanged, handler)
    }
  },
  onSessionChanged: (cb: (session: CurrentSession) => void): Unsubscribe => {
    const handler = (_: unknown, session: CurrentSession): void => {
      cb(session)
    }

    ipcRenderer.on(IPC.sessions.changed, handler)

    return () => {
      ipcRenderer.removeListener(IPC.sessions.changed, handler)
    }
  },
  onToolApprovalRequest: (cb: (event: ToolApprovalRequest) => void): Unsubscribe => {
    const handler = (_: unknown, event: ToolApprovalRequest): void => {
      cb(event)
    }

    ipcRenderer.on(IPC.tool.approvalRequested, handler)

    return () => {
      ipcRenderer.removeListener(IPC.tool.approvalRequested, handler)
    }
  },
  onToolApprovalCancelled: (cb: (requestId?: string) => void): Unsubscribe => {
    const handler = (_: unknown, requestId?: string): void => {
      cb(requestId)
    }

    ipcRenderer.on(IPC.tool.approvalCancelled, handler)

    return () => {
      ipcRenderer.removeListener(IPC.tool.approvalCancelled, handler)
    }
  },
  respondToolApproval: (requestId: string, approved: boolean): Promise<void> =>
    ipcRenderer.invoke(IPC.tool.approvalResponse, requestId, approved),
  onAgentUserInteractionRequest: (
    cb: (event: AgentUserInteractionRequest) => void
  ): Unsubscribe => {
    const handler = (_: unknown, event: AgentUserInteractionRequest): void => {
      cb(event)
    }

    ipcRenderer.on(IPC.agent.interactionRequested, handler)

    return () => {
      ipcRenderer.removeListener(IPC.agent.interactionRequested, handler)
    }
  },
  onAgentUserInteractionCancelled: (cb: () => void): Unsubscribe => {
    const handler = (): void => {
      cb()
    }

    ipcRenderer.on(IPC.agent.interactionCancelled, handler)

    return () => {
      ipcRenderer.removeListener(IPC.agent.interactionCancelled, handler)
    }
  },
  respondAgentUserInteraction: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled = false
  ): Promise<void> =>
    ipcRenderer.invoke(IPC.agent.interactionResponse, requestId, response, cancelled),
  listPhiPlugins: (): Promise<PhiPluginListItem[]> => ipcRenderer.invoke(IPC.phiPlugins.list),
  pickPhiPluginDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.phiPlugins.pickDirectory),
  previewPhiPluginDirectory: (path: string): Promise<PhiPluginInstallPreview> =>
    ipcRenderer.invoke(IPC.phiPlugins.previewDirectory, path),
  installPhiPluginFromDirectory: (path: string): Promise<PhiPluginMutationResult> =>
    ipcRenderer.invoke(IPC.phiPlugins.installFromDirectory, path),
  setPhiPluginEnabled: (id: string, enabled: boolean): Promise<PhiPluginMutationResult> =>
    ipcRenderer.invoke(IPC.phiPlugins.setEnabled, id, enabled),
  uninstallPhiPlugin: (id: string): Promise<PhiPluginMutationResult> =>
    ipcRenderer.invoke(IPC.phiPlugins.uninstall, id),
  pickPackageRegistryDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke(IPC.packages.pickRegistryDirectory),
  pickPackageArchive: (): Promise<string | null> => ipcRenderer.invoke(IPC.packages.pickArchive),
  readPackageRegistry: (dir: string): Promise<PackageRegistryView> =>
    ipcRenderer.invoke(IPC.packages.registry, dir),
  readOfficialContentCatalog: (forceRefresh?: boolean): Promise<PackageRegistryView> =>
    ipcRenderer.invoke(IPC.packages.contentCatalog, forceRefresh),
  onPackageResourcesChanged: (cb: () => void): Unsubscribe => {
    const listener = (): void => cb()
    ipcRenderer.on(IPC.packages.resourcesChanged, listener)
    return () => ipcRenderer.removeListener(IPC.packages.resourcesChanged, listener)
  },
  listPackageRegistries: (): Promise<KnownPackageRegistryView[]> =>
    ipcRenderer.invoke(IPC.packages.listRegistries),
  removePackageRegistry: (id: string): Promise<KnownPackageRegistryView[]> =>
    ipcRenderer.invoke(IPC.packages.removeRegistry, id),
  previewPackageImport: (path: string): Promise<OfflinePackageImportPreview> =>
    ipcRenderer.invoke(IPC.packages.previewImport, path),
  importPackage: (path: string): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke(IPC.packages.import, path),
  listPackageUpdates: (): Promise<PackageUpdateView[]> =>
    ipcRenderer.invoke(IPC.packages.listUpdates),
  applyPackageUpdate: (type: PackageManagerType, id: string): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke(IPC.packages.applyUpdate, type, id),
  applyAllPackageUpdates: (): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke(IPC.packages.applyAllUpdates),
  onPackageUpdatesAvailable: (cb: (updates: PackageUpdateView[]) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, updates: PackageUpdateView[]): void =>
      cb(updates)
    ipcRenderer.on(IPC.packages.updatesAvailable, listener)
    return () => ipcRenderer.removeListener(IPC.packages.updatesAvailable, listener)
  },
  planPackageInstall: (
    dir: string,
    type: PackageManagerType,
    id: string,
    version?: string
  ): Promise<PackageInstallPlanView> =>
    ipcRenderer.invoke(IPC.packages.plan, dir, type, id, version),
  readWrapperPackageDetail: (dir: string, id: string): Promise<WrapperPackageDetailView> =>
    ipcRenderer.invoke(IPC.packages.wrapperDetail, dir, id),
  readSkillPackageDetail: (dir: string, id: string): Promise<SkillPackageDetailView> =>
    ipcRenderer.invoke(IPC.packages.skillDetail, dir, id),
  previewWrapperRemoval: (id: string): Promise<WrapperRemovalPreview> =>
    ipcRenderer.invoke(IPC.packages.previewWrapperRemoval, id),
  removeWrapperPackage: (
    id: string,
    options?: { disableDependents?: boolean }
  ): Promise<WrapperRemovalView> => ipcRenderer.invoke(IPC.packages.removeWrapper, id, options),
  installPackage: (
    dir: string,
    type: PackageManagerType,
    id: string,
    version?: string
  ): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke(IPC.packages.install, dir, type, id, version),
  uninstallPackage: (type: PackageManagerType, id: string): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke(IPC.packages.uninstall, type, id),
  listInstalledPackages: (): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke(IPC.packages.listInstalled),
  getEnablement: (projectCwd?: string): Promise<EnablementSnapshot> =>
    ipcRenderer.invoke(IPC.enablement.get, projectCwd),
  setEnablement: (
    item: EnablementItemKey,
    value: boolean | null,
    scope: EnablementScope
  ): Promise<EnablementSnapshot> => ipcRenderer.invoke(IPC.enablement.set, item, value, scope),
  listSkills: (cwd?: string): Promise<SkillSummary[]> => ipcRenderer.invoke(IPC.skills.list, cwd),
  readSkillContent: (filePath: string, cwd?: string): Promise<SkillContent> =>
    ipcRenderer.invoke(IPC.skills.read, filePath, cwd),
  setSkillDisabled: (filePath: string, disabled: boolean, cwd?: string): Promise<SkillSummary[]> =>
    ipcRenderer.invoke(IPC.skills.setDisabled, filePath, disabled, cwd),
  deleteSkill: (filePath: string, cwd?: string): Promise<SkillSummary[]> =>
    ipcRenderer.invoke(IPC.skills.delete, filePath, cwd),
  trustRemoteProjectSkill: (input: RemoteProjectSkillTrustRequest): Promise<SkillSummary[]> =>
    ipcRenderer.invoke(IPC.skills.trustRemoteProject, input),
  revokeRemoteProjectSkillTrust: (input: RemoteProjectSkillTrustRequest): Promise<SkillSummary[]> =>
    ipcRenderer.invoke(IPC.skills.revokeRemoteProjectTrust, input),
  listPromptAgents: (cwd?: string): Promise<PromptAgentSummary[]> =>
    ipcRenderer.invoke(IPC.agents.list, cwd),
  trustRemoteProjectAgent: (input: RemoteProjectAgentTrustRequest): Promise<PromptAgentSummary[]> =>
    ipcRenderer.invoke(IPC.agents.trustRemoteProject, input),
  revokeRemoteProjectAgentTrust: (
    input: RemoteProjectAgentTrustRequest
  ): Promise<PromptAgentSummary[]> =>
    ipcRenderer.invoke(IPC.agents.revokeRemoteProjectTrust, input),
  listMcpServers: (cwd?: string): Promise<McpServerSummary[]> =>
    ipcRenderer.invoke(IPC.mcp.listServers, cwd),
  trustRemoteProjectMcp: (input: RemoteProjectMcpTrustRequest): Promise<McpServerSummary[]> =>
    ipcRenderer.invoke(IPC.mcp.trustRemoteProject, input),
  revokeRemoteProjectMcpTrust: (input: RemoteProjectMcpTrustRequest): Promise<McpServerSummary[]> =>
    ipcRenderer.invoke(IPC.mcp.revokeRemoteProjectTrust, input),
  listMcpConnectorCatalog: (): Promise<FeaturedMcpConnector[]> =>
    ipcRenderer.invoke(IPC.mcp.listConnectorCatalog),
  previewGithubSource: (url: string): Promise<GithubSourcePreview> =>
    ipcRenderer.invoke(IPC.sources.previewGithub, url),
  addGithubSource: (input: { url: string; sha: string }): Promise<GithubSourceSummary> =>
    ipcRenderer.invoke(IPC.sources.addGithub, input),
  checkGithubSourceUpdate: (id: string): Promise<GithubSourceUpdateCheck> =>
    ipcRenderer.invoke(IPC.sources.checkGithubUpdate, id),
  applyGithubSourceUpdate: (input: { id: string; sha: string }): Promise<GithubSourceSummary> =>
    ipcRenderer.invoke(IPC.sources.applyGithubUpdate, input),
  removeGithubSource: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.sources.removeGithub, id),
  listGithubSources: (): Promise<GithubSourceSummary[]> =>
    ipcRenderer.invoke(IPC.sources.listGithub),
  installMcpConnector: (
    id: string,
    version?: string,
    registryDir?: string
  ): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke(IPC.mcp.installConnector, id, version, registryDir),
  uninstallMcpConnector: (id: string): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke(IPC.mcp.uninstallConnector, id),
  buildMcpConnectorEnvironment: (id: string): Promise<{ envId: string }> =>
    ipcRenderer.invoke(IPC.mcp.buildConnectorEnvironment, id),
  onMcpConnectorSetupChanged: (cb: (progress: McpConnectorSetupProgress) => void): Unsubscribe => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: McpConnectorSetupProgress
    ): void => cb(progress)
    ipcRenderer.on(IPC.mcp.connectorSetupChanged, handler)
    return () => {
      ipcRenderer.removeListener(IPC.mcp.connectorSetupChanged, handler)
    }
  },
  addRemoteMcpConnector: (
    name: string,
    url: string,
    options?: RemoteMcpConnectorOptions
  ): Promise<void> => ipcRenderer.invoke(IPC.mcp.addRemoteConnector, name, url, options),
  addLocalMcpConnector: (request: LocalMcpConnectorRequest): Promise<{ tools: string[] }> =>
    ipcRenderer.invoke(IPC.mcp.addLocalConnector, request),
  startLocalConnectorAdd: (
    request: LocalMcpConnectorRequest
  ): Promise<{ started: true; name: string }> =>
    ipcRenderer.invoke(IPC.mcp.startLocalConnectorAdd, request),
  cancelLocalConnectorAdd: (name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.cancelLocalConnectorAdd, name),
  retryLocalConnectorAdd: (name: string): Promise<{ started: true; name: string }> =>
    ipcRenderer.invoke(IPC.mcp.retryLocalConnectorAdd, name),
  listLocalConnectorJobs: (): Promise<McpConnectorSetupProgress[]> =>
    ipcRenderer.invoke(IPC.mcp.listLocalConnectorJobs),
  removeLocalMcpConnector: (name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.removeLocalConnector, name),
  listLocalMcpRuntimes: (): Promise<LocalMcpRuntimeOption[]> =>
    ipcRenderer.invoke(IPC.mcp.listLocalRuntimes),
  authorizeRemoteMcpConnector: (name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.authorizeRemoteConnector, name),
  cancelRemoteMcpAuth: (name: string): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.cancelRemoteAuth, name),
  removeRemoteMcpConnector: (name: string, url: string): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.removeRemoteConnector, name, url),
  setMcpConnectorEnabled: (name: string, enabled: boolean, sourcePath?: string): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.setConnectorEnabled, name, enabled, sourcePath),
  listFeaturedMcpTools: (id: string): Promise<string[]> =>
    ipcRenderer.invoke(IPC.mcp.featuredTools, id),
  getFeaturedMcpAuthStatus: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.mcp.featuredAuthStatus, id),
  authorizeFeaturedMcp: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.authorizeFeatured, id),
  cancelFeaturedMcpAuth: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.cancelFeaturedAuth, id),
  getFeaturedMcpApiKeyStatus: (id: string): Promise<boolean> =>
    ipcRenderer.invoke(IPC.mcp.featuredApiKeyStatus, id),
  setFeaturedMcpApiKey: (id: string, key: string): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.setFeaturedApiKey, id, key),
  clearFeaturedMcpApiKey: (id: string): Promise<void> =>
    ipcRenderer.invoke(IPC.mcp.clearFeaturedApiKey, id),
  getWrapperPlan: (planId: string): Promise<WrapperRunPlan | undefined> =>
    ipcRenderer.invoke(IPC.wrappers.getPlan, planId),
  retargetWrapperPlan: (request: WrapperRetargetRequest): Promise<WrapperRunPlan> =>
    ipcRenderer.invoke(IPC.wrappers.retargetPlan, request),
  submitWrapperPlan: (
    planId: string,
    heavyWorkloadAcknowledged?: boolean,
    confirmation?: WrapperSubmitConfirmation
  ): Promise<WrapperRun> =>
    ipcRenderer.invoke(IPC.wrappers.submitPlan, planId, heavyWorkloadAcknowledged, confirmation),
  cancelWrapperRunPlan: (planId: string): Promise<WrapperRunPlan> =>
    ipcRenderer.invoke(IPC.wrappers.cancelPlan, planId),
  listWrapperCatalog: (): Promise<WrapperCatalogEntry[]> =>
    ipcRenderer.invoke(IPC.wrappers.listCatalog),
  addCustomWrapper: (sourceDir: string): Promise<WrapperCatalogEntry> =>
    ipcRenderer.invoke(IPC.wrappers.addCustom, sourceDir),
  listWrapperCompositionCatalog: (): Promise<WrapperCompositionCatalogItem[]> =>
    ipcRenderer.invoke(IPC.wrappers.listCompositionCatalog),
  getWrapperCompositionDag: (id: string): Promise<string | undefined> =>
    ipcRenderer.invoke(IPC.wrappers.getCompositionDag, id),
  getWrapperCompositionModuleDetails: (id: string): Promise<WrapperModuleDetails | undefined> =>
    ipcRenderer.invoke(IPC.wrappers.getCompositionModuleDetails, id),
  listWrapperRuns: (): Promise<WrapperRun[]> => ipcRenderer.invoke(IPC.wrappers.listRuns),
  listAgentJobs: (): Promise<BackgroundAgentJob[]> => ipcRenderer.invoke(IPC.jobs.listAgents),
  listShellJobs: (): Promise<BackgroundShellJob[]> => ipcRenderer.invoke(IPC.jobs.listShell),
  stopShellJob: (agentSessionId: string, jobId: string): Promise<void> =>
    ipcRenderer.invoke(IPC.jobs.stopShell, agentSessionId, jobId),
  getWrapperRun: (runId: string): Promise<WrapperRun | undefined> =>
    ipcRenderer.invoke(IPC.wrappers.getRun, runId),
  cancelWrapperRun: (runId: string): Promise<WrapperRun> =>
    ipcRenderer.invoke(IPC.wrappers.cancelRun, runId),
  getWrapperPlanArtifact: (planId: string, fileName: string): Promise<string | undefined> =>
    ipcRenderer.invoke(IPC.wrappers.getPlanArtifact, planId, fileName),
  exportWrapperReproducibility: (runId: string): Promise<string | null> =>
    ipcRenderer.invoke(IPC.wrappers.exportReproducibility, runId)
}

function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types)
  if (types.includes('Files')) return true
  return Array.from(dataTransfer.items).some((item) => item.kind === 'file')
}

function inputFileDropTargetFromEvent(event: DragEvent): InputFileDropTarget | null {
  const target = event.target
  if (!target || typeof (target as Element).closest !== 'function') return null
  const element = (target as Element).closest(`[${INPUT_FILE_DROP_TARGET_ATTRIBUTE}]`)
  const kind = element?.getAttribute(INPUT_FILE_DROP_TARGET_ATTRIBUTE)
  if (kind !== 'chat-composer' && kind !== 'wrapper-input' && kind !== 'remote-file-tree') {
    return null
  }
  const path = element?.getAttribute('data-phi-file-drop-path')?.trim()
  return { kind, ...(path ? { path } : {}) }
}

function droppedFilePathsFromEvent(event: DragEvent): string[] {
  const files = Array.from(event.dataTransfer?.files ?? [])
  const paths: string[] = []
  const seen = new Set<string>()
  for (const file of files) {
    let path = ''
    try {
      path = webUtils.getPathForFile(file).trim()
    } catch {
      const fallbackPath = (file as File & { path?: unknown }).path
      path = typeof fallbackPath === 'string' ? fallbackPath.trim() : ''
    }
    if (!path || seen.has(path)) continue
    seen.add(path)
    paths.push(path)
  }
  return paths
}

function notifyInputFilesDropped(paths: string[], target: InputFileDropTarget): void {
  for (const subscriber of inputFilesDroppedSubscribers) {
    try {
      subscriber(paths, target)
    } catch (error) {
      console.error(error)
    }
  }
}

window.addEventListener(
  'dragover',
  (event) => {
    if (inputFileDropTargetFromEvent(event) === null || !dataTransferHasFiles(event.dataTransfer))
      return
    event.preventDefault()
    event.dataTransfer!.dropEffect = 'copy'
  },
  true
)

window.addEventListener(
  'drop',
  (event) => {
    const target = inputFileDropTargetFromEvent(event)
    if (!target || !dataTransferHasFiles(event.dataTransfer)) return
    const paths = droppedFilePathsFromEvent(event)
    if (paths.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    notifyInputFilesDropped(paths, target)
  },
  true
)

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
    contextBridge.exposeInMainWorld('platform', process.platform)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.api = api
  // @ts-ignore (define in dts)
  window.platform = process.platform
}
