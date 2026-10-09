import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { BrowserRendererBridge, BrowserRendererEventEnvelope } from '../shared/browserTypes'
import type { TerminalEvent, TerminalRendererBridge } from '../shared/terminalTypes'
import type {
  OfficePromptTargetFailure,
  OfficeRendererBridge,
  OfficeSelectionEvent,
  OfficeTargetInput
} from '../shared/officeProtocol'
import { sanitizePromptTargetForIpc } from './promptTarget'
import type { RemoteWorkspaceFileRequest } from '../shared/remoteWorkspacePath'
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
import type {
  RemoteDirectoryListRequest,
  RemoteDirectoryListing
} from '../shared/remoteDirectoryBrowser'
import type { PromptImageInput, StoredPromptImage } from '../shared/promptImageTypes'
import type { SessionExportResult } from '../shared/sessionExportTypes'
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
  PackageUpdateView
} from '../shared/packageManagerTypes'
import type {
  EnablementItemKey,
  EnablementScope,
  EnablementSnapshot
} from '../shared/enablementTypes'
import type { SkillContent, SkillSummary } from '../shared/skillTypes'
import type {
  FeaturedMcpConnector,
  McpConnectorSetupProgress,
  RemoteMcpConnectorOptions
} from '../shared/mcpConnectorCatalog'

type AgentEventSummary = Record<string, unknown>
type Unsubscribe = () => void

const INPUT_FILE_DROP_TARGET_ATTRIBUTE = 'data-phi-file-drop-target'
const inputFilesDroppedSubscribers = new Set<(paths: string[]) => void>()

type AuthStatusItem = {
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
}

type SessionSwitchResult = SessionRuntimeState & {
  path: string
  phiSessionId?: string
  cwd: string
  displayCwd?: string
  projectId?: string
  projectLocation?: ProjectLocation
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
  sessionGeneration: number
  permissionMode: PermissionMode
  messages?: unknown[]
}

type PromptResult =
  | { path: string | null; phiSessionId?: string; sessionGeneration: number }
  | OfficePromptTargetFailure

type PromptTarget = {
  path: string | null
  phiSessionId?: string
  cwd: string
  sessionGeneration: number
  suppressUserMessageEvent?: boolean
  retryUserMessageId?: string
  images?: PromptImageInput[]
  planMode?: boolean
  officeTarget?: OfficeTargetInput
}

type PermissionMode = 'auto' | 'ask' | 'full'

type ProjectRemoteConnection = {
  id: string
  label: string
  hostProfileId: string
  hpc?: RemoteHpcSettings
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

type PluginCatalogItem = {
  id: string
  name: string
  source: string
  description: string
  author?: string
  kind: 'extension' | 'skill' | 'prompt' | 'theme' | 'package'
  downloads?: string
  updated?: string
  homepageUrl: string
  npmUrl: string
  installed: boolean
  installedPath?: string
}

type PromptAgentSummary = {
  id: string
  name: string
  description: string
  source: string
  trigger: string
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
  document: Record<string, unknown>
}

type AnalysisNotebookDraftChange = {
  source: 'agent' | 'renderer'
  projectCwd: string
  path: string
  relativePath: string
  document: Record<string, unknown>
  savedRevision: string
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
  }>
  preferredKernelName?: string
  hasPythonKernel: boolean
  hasRKernel: boolean
  messages: string[]
}

type JupyterServerStatus = {
  projectCwd: string
  state: 'stopped' | 'starting' | 'ready' | 'error' | 'exited'
  startedAt?: string
  exitedAt?: string
  pid?: number
  port?: number
  hasEndpoint: boolean
  message?: string
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

type RendererAuthApi = {
  browser: BrowserRendererBridge
  terminal: TerminalRendererBridge
  office: OfficeRendererBridge
  readyWindow: (background: string) => Promise<void>
  closeWindow: () => Promise<void>
  minimizeWindow: () => Promise<void>
  toggleWindowFullscreen: () => Promise<void>
  getWindowFullscreen: () => Promise<boolean>
  onWindowFullscreenChanged: (cb: (fullscreen: boolean) => void) => Unsubscribe
  revealPath: (path: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  getFileIcon: (path: string) => Promise<string | null>
  readResourceIcon: (key: string) => Promise<string | null>
  pickInputFiles: () => Promise<string[]>
  getPathForFile: (file: File) => string
  onInputFilesDropped: (cb: (paths: string[]) => void) => Unsubscribe
  previewFile: (path: string) => Promise<FilePreview>
  previewRemoteWorkspaceFile: (request: RemoteWorkspaceFileRequest) => Promise<FilePreview>
  hoverPreviewFile: (path: string) => Promise<FileHoverPreview>
  statLocalPaths: (cwd: string, paths: string[]) => Promise<LocalPathStat[]>
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
  copyDiagnostics: () => Promise<string>
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
  remoteDoctor: (
    hostProfileId: string,
    remotePath?: string,
    options?: RemoteDoctorOptions
  ) => Promise<RemoteDoctorReport>
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
  publishNotebookOutputFrame: (html: string) => Promise<string>
  releaseNotebookOutputFrame: (url: string) => Promise<void>
  startAnalysisJupyter: (cwd: string) => Promise<JupyterServerStatus>
  stopAnalysisJupyter: (cwd: string) => Promise<JupyterServerStatus>
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
  listPlugins: () => Promise<PluginCatalogItem[]>
  installPlugin: (source: string) => Promise<PluginCatalogItem[]>
  removePlugin: (source: string) => Promise<PluginCatalogItem[]>
  listPhiPlugins: () => Promise<PhiPluginListItem[]>
  pickPhiPluginDirectory: () => Promise<string | null>
  previewPhiPluginDirectory: (path: string) => Promise<PhiPluginInstallPreview>
  installPhiPluginFromDirectory: (path: string) => Promise<PhiPluginMutationResult>
  setPhiPluginEnabled: (id: string, enabled: boolean) => Promise<PhiPluginMutationResult>
  uninstallPhiPlugin: (id: string) => Promise<PhiPluginMutationResult>
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
  onPackageUpdatesAvailable: (cb: (updates: PackageUpdateView[]) => void) => Unsubscribe
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
  onMcpConnectorSetupChanged: (cb: (progress: McpConnectorSetupProgress) => void) => Unsubscribe
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
  listAgentJobs: () => Promise<BackgroundAgentJob[]>
  listShellJobs: () => Promise<BackgroundShellJob[]>
  stopShellJob: (agentSessionId: string, jobId: string) => Promise<void>
  getWrapperRun: (runId: string) => Promise<WrapperRun | undefined>
  cancelWrapperRun: (runId: string) => Promise<WrapperRun>
  getWrapperPlanArtifact: (planId: string, fileName: string) => Promise<string | undefined>
  exportWrapperReproducibility: (runId: string) => Promise<string | null>
}

const browserBridge: BrowserRendererBridge = {
  execute: (command) => ipcRenderer.invoke('browser:execute', command),
  snapshot: () => ipcRenderer.invoke('browser:snapshot'),
  setViewport: (input) => ipcRenderer.invoke('browser:setViewport', input),
  onEvent: (callback) => {
    const handler = (_: unknown, envelope: BrowserRendererEventEnvelope): void => {
      try {
        void Promise.resolve(callback(envelope)).catch(() => undefined)
      } catch {
        return
      }
    }
    let subscribed = true
    ipcRenderer.on('browser:event', handler)
    return () => {
      if (!subscribed) return
      subscribed = false
      ipcRenderer.removeListener('browser:event', handler)
    }
  }
}

const terminalBridge: TerminalRendererBridge = {
  list: (workspace) => ipcRenderer.invoke('terminal:list', workspace),
  create: (input) => ipcRenderer.invoke('terminal:create', input),
  attach: (terminalId) => ipcRenderer.invoke('terminal:attach', terminalId),
  input: (terminalId, data) => ipcRenderer.invoke('terminal:input', terminalId, data),
  resize: (terminalId, cols, rows) => ipcRenderer.invoke('terminal:resize', terminalId, cols, rows),
  ack: (terminalId, epoch, bytes) => ipcRenderer.invoke('terminal:ack', terminalId, epoch, bytes),
  close: (terminalId) => ipcRenderer.invoke('terminal:close', terminalId),
  generateDraft: (input) => ipcRenderer.invoke('terminal:generateDraft', input),
  cancelDraft: (requestId) => ipcRenderer.invoke('terminal:cancelDraft', requestId),
  submitDraft: (input) => ipcRenderer.invoke('terminal:submitDraft', input),
  onEvent: (callback) => {
    const handler = (_: unknown, event: TerminalEvent): void => {
      try {
        void Promise.resolve(callback(event)).catch(() => undefined)
      } catch {
        return
      }
    }
    let subscribed = true
    ipcRenderer.on('terminal:event', handler)
    return () => {
      if (!subscribed) return
      subscribed = false
      ipcRenderer.removeListener('terminal:event', handler)
    }
  }
}

const officeBridge: OfficeRendererBridge = {
  enabled: typeof process !== 'undefined' && process.env?.PHI_OFFICE_DEV === '1',
  create: (input) => ipcRenderer.invoke('office:create', input),
  cancelCreate: (input) => ipcRenderer.invoke('office:cancelCreate', input),
  importFile: (input) => ipcRenderer.invoke('office:import', input),
  cancelImport: (input) => ipcRenderer.invoke('office:cancelImport', input),
  open: (input) => ipcRenderer.invoke('office:open', input),
  close: (input) => ipcRenderer.invoke('office:close', input),
  clearSelection: (input) => ipcRenderer.invoke('office:clearSelection', input),
  reconcile: (input) => ipcRenderer.invoke('office:reconcile', input),
  save: (input) => ipcRenderer.invoke('office:save', input),
  saveAs: (input) => ipcRenderer.invoke('office:saveAs', input),
  exportSheet: (input) => ipcRenderer.invoke('office:export', input),
  cancelExport: (input) => ipcRenderer.invoke('office:cancelExport', input),
  revealOutput: (input) => ipcRenderer.invoke('office:revealOutput', input),
  resolveOutput: (input) => ipcRenderer.invoke('office:resolveOutput', input),
  status: (input) => ipcRenderer.invoke('office:status', input),
  setPreviewPreferences: (input) => ipcRenderer.invoke('office:setPreviewPreferences', input),
  onSelection: (listener) => {
    const handler = (_event: unknown, selection: OfficeSelectionEvent): void => listener(selection)
    let subscribed = true
    ipcRenderer.on('office:selection', handler)
    return () => {
      if (!subscribed) return
      subscribed = false
      ipcRenderer.removeListener('office:selection', handler)
    }
  }
}

const api: RendererAuthApi = {
  browser: browserBridge,
  terminal: terminalBridge,
  office: officeBridge,
  readyWindow: (background: string): Promise<void> =>
    ipcRenderer.invoke('window:renderer-ready', background),
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleWindowFullscreen: (): Promise<void> => ipcRenderer.invoke('window:toggle-fullscreen'),
  getWindowFullscreen: (): Promise<boolean> => ipcRenderer.invoke('window:get-fullscreen'),
  onWindowFullscreenChanged: (cb: (fullscreen: boolean) => void): Unsubscribe => {
    const handler = (_: unknown, fullscreen: unknown): void => {
      if (typeof fullscreen === 'boolean') cb(fullscreen)
    }
    let subscribed = true
    ipcRenderer.on('window:fullscreen-changed', handler)
    return () => {
      if (!subscribed) return
      subscribed = false
      ipcRenderer.removeListener('window:fullscreen-changed', handler)
    }
  },
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('files:reveal', path),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('files:openPath', path),
  getFileIcon: (path: string): Promise<string | null> => ipcRenderer.invoke('files:getIcon', path),
  readResourceIcon: (key: string): Promise<string | null> =>
    ipcRenderer.invoke('resources:readIcon', key),
  pickInputFiles: (): Promise<string[]> => ipcRenderer.invoke('files:pickInput'),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onInputFilesDropped: (cb: (paths: string[]) => void): Unsubscribe => {
    inputFilesDroppedSubscribers.add(cb)
    return () => {
      inputFilesDroppedSubscribers.delete(cb)
    }
  },
  previewFile: (path: string): Promise<FilePreview> => ipcRenderer.invoke('files:preview', path),
  previewRemoteWorkspaceFile: (request: RemoteWorkspaceFileRequest): Promise<FilePreview> =>
    ipcRenderer.invoke('remoteWorkspace:preview', request),
  hoverPreviewFile: (path: string): Promise<FileHoverPreview> =>
    ipcRenderer.invoke('files:hoverPreview', path),
  statLocalPaths: (cwd: string, paths: string[]): Promise<LocalPathStat[]> =>
    ipcRenderer.invoke('files:statLocalPaths', cwd, paths),
  listDirectory: (path: string): Promise<DirectoryListing> =>
    ipcRenderer.invoke('files:listDirectory', path),
  listRemoteWorkspaceDirectory: (request: RemoteWorkspaceFileRequest): Promise<DirectoryListing> =>
    ipcRenderer.invoke('remoteWorkspace:listDirectory', request),
  listWrapperResultDirectory: (request: WrapperResultDirectoryRequest): Promise<DirectoryListing> =>
    ipcRenderer.invoke('wrapperResults:listDirectory', request),
  previewWrapperResult: (request: WrapperResultReadRequest): Promise<WrapperResultPreview> =>
    ipcRenderer.invoke('wrapperResults:preview', request),
  readWrapperResultRange: (request: WrapperResultRangeRequest): Promise<WrapperResultRange> =>
    ipcRenderer.invoke('wrapperResults:readRange', request),
  cancelWrapperResultRead: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke('wrapperResults:cancelRead', requestId),
  downloadWrapperResult: (
    request: WrapperResultReadRequest
  ): Promise<WrapperResultDownloadResult> => ipcRenderer.invoke('wrapperResults:download', request),
  cancelWrapperResultDownload: (requestId: string): Promise<boolean> =>
    ipcRenderer.invoke('wrapperResults:cancelDownload', requestId),
  onWrapperResultDownloadProgress: (
    cb: (progress: WrapperResultDownloadProgress) => void
  ): Unsubscribe => {
    const handler = (_: unknown, progress: WrapperResultDownloadProgress): void => cb(progress)
    ipcRenderer.on('wrapperResults:downloadProgress', handler)
    return () => ipcRenderer.removeListener('wrapperResults:downloadProgress', handler)
  },
  renderMoleculeSvg: (value: string, width: number, height: number): Promise<string> =>
    ipcRenderer.invoke('molecules:renderSvg', value, width, height),
  copyDiagnostics: (): Promise<string> => ipcRenderer.invoke('diagnostics:copy'),
  sendPrompt: (text: string, target?: PromptTarget): Promise<PromptResult | null> =>
    ipcRenderer.invoke('agent:prompt', text, sanitizePromptTargetForIpc(target)),
  readPromptImage: (ref: StoredPromptImage): Promise<PromptImageInput> =>
    ipcRenderer.invoke('agent:readPromptImage', ref),
  readWorkspaceDiff: (ref: WorkspaceDiffReference): Promise<string> =>
    ipcRenderer.invoke('workspaceChanges:readDiff', ref),
  onAgentEvent: (cb: (event: AgentEventSummary) => void): Unsubscribe => {
    const handler = (_: unknown, event: AgentEventSummary): void => {
      cb(event)
    }

    ipcRenderer.on('agent:event', handler)

    return () => {
      ipcRenderer.removeListener('agent:event', handler)
    }
  },
  getAuthStatus: (): Promise<AuthStatusItem[]> => ipcRenderer.invoke('auth:status'),
  loginApiKey: (providerId: string, key: string): Promise<AuthStatusItem[]> =>
    ipcRenderer.invoke('auth:loginApiKey', providerId, key),
  loginOAuth: (providerId: string): Promise<AuthStatusItem[]> =>
    ipcRenderer.invoke('auth:loginOAuth', providerId),
  logout: (providerId: string): Promise<void> => ipcRenderer.invoke('auth:logout', providerId),
  submitAuthInteraction: (requestId: string, value: string): Promise<void> =>
    ipcRenderer.invoke('auth:interaction-response', requestId, value),
  onAuthInteraction: (cb: (event: AuthInteractionEvent) => void): Unsubscribe => {
    const handler = (_: unknown, event: AuthInteractionEvent): void => {
      cb(event)
    }

    ipcRenderer.on('auth:interaction', handler)

    return () => {
      ipcRenderer.removeListener('auth:interaction', handler)
    }
  },
  getAppSettings: (): Promise<PhiAppSettings> => ipcRenderer.invoke('settings:get'),
  updateAppSettings: (patch: PhiAppSettingsPatch): Promise<PhiAppSettings> =>
    ipcRenderer.invoke('settings:update', patch),
  getWebSearchSettings: (): Promise<WebSearchSettings> =>
    ipcRenderer.invoke('settings:webSearch:get'),
  updateWebSearchSettings: (patch: WebSearchSettingsPatch): Promise<WebSearchSettings> =>
    ipcRenderer.invoke('settings:webSearch:update', patch),
  listSearxngEngines: (): Promise<SearxngEngineOption[]> =>
    ipcRenderer.invoke('settings:webSearch:searxngEngines'),
  setWebSearchApiKey: (providerId: string, key: string): Promise<WebSearchKeyStatus> =>
    ipcRenderer.invoke('settings:webSearch:apiKey:set', providerId, key),
  clearWebSearchApiKey: (providerId: string): Promise<WebSearchKeyStatus> =>
    ipcRenderer.invoke('settings:webSearch:apiKey:clear', providerId),
  getEnvironment: (): Promise<EnvironmentGetResult> => ipcRenderer.invoke('environment:get'),
  redetectEnvironment: (): Promise<EnvironmentSnapshot> =>
    ipcRenderer.invoke('environment:redetect'),
  dismissEnvironmentSummary: (): Promise<EnvironmentSnapshot> =>
    ipcRenderer.invoke('environment:dismissSummary'),
  setEnvironmentToolPath: (
    toolId: EnvironmentToolId,
    path: string | null
  ): Promise<EnvironmentSnapshot> => ipcRenderer.invoke('environment:setToolPath', toolId, path),
  pickEnvironmentBinary: (): Promise<string | null> => ipcRenderer.invoke('environment:pickBinary'),
  listManagedEnvironments: (projectCwd?: string): Promise<ManagedEnvironmentEntry[]> =>
    ipcRenderer.invoke('managedEnvironments:list', projectCwd),
  buildManagedEnvironment: (
    ref: string,
    projectCwd?: string,
    pluginId?: string
  ): Promise<{ envId: string }> =>
    ipcRenderer.invoke('managedEnvironments:build', ref, projectCwd, pluginId),
  rebuildManagedEnvironment: (envId: string): Promise<void> =>
    ipcRenderer.invoke('managedEnvironments:rebuild', envId),
  removeManagedEnvironment: (envId: string): Promise<ManagedEnvironmentRemoveResult> =>
    ipcRenderer.invoke('managedEnvironments:remove', envId),
  cleanManagedEnvironments: (): Promise<ManagedEnvironmentCleanResult> =>
    ipcRenderer.invoke('managedEnvironments:clean'),
  listModels: (): Promise<ModelOption[]> => ipcRenderer.invoke('models:list'),
  selectModel: (providerId: string, modelId: string): Promise<void> =>
    ipcRenderer.invoke('models:select', providerId, modelId),
  getSelectedModel: (): Promise<SelectedModel> => ipcRenderer.invoke('models:selected'),
  selectThinkingLevel: (level: ThinkingLevel): Promise<void> =>
    ipcRenderer.invoke('thinking:select', level),
  getThinkingLevel: (): Promise<ThinkingLevel> => ipcRenderer.invoke('thinking:selected'),
  getAppName: (): Promise<string> => ipcRenderer.invoke('persona:getAppName'),
  isOnboarded: (): Promise<boolean> => ipcRenderer.invoke('persona:isOnboarded'),
  getPersonaMarkdown: (): Promise<string> => ipcRenderer.invoke('persona:getMarkdown'),
  setPersonaMarkdown: (markdown: string): Promise<string> =>
    ipcRenderer.invoke('persona:setMarkdown', markdown),
  skipOnboarding: (): Promise<void> => ipcRenderer.invoke('persona:skip'),
  completeOnboarding: (description: string): Promise<string> =>
    ipcRenderer.invoke('persona:completeOnboarding', description),
  listSessions: (): Promise<SessionSummary[]> => ipcRenderer.invoke('sessions:list'),
  getHomeActivity: (): Promise<HomeActivitySummary> => ipcRenderer.invoke('sessions:homeActivity'),
  getCurrentSession: (): Promise<CurrentSession> => ipcRenderer.invoke('sessions:current'),
  getCurrentContextUsage: (): Promise<CurrentContextUsage> =>
    ipcRenderer.invoke('sessions:contextUsage'),
  getAutoCompactionSettings: (
    target: ManualCompactionTarget
  ): Promise<CurrentAutoCompactionSettings> =>
    ipcRenderer.invoke('sessions:autoCompactionSettings', target),
  setAutoCompactionSettings: (
    target: ManualCompactionTarget,
    patch: AutoCompactionSettingsPatch
  ): Promise<CurrentAutoCompactionSettings> =>
    ipcRenderer.invoke('sessions:autoCompactionSettings:set', target, patch),
  compactCurrentSession: (target: ManualCompactionTarget): Promise<ManualCompactionOutcome> =>
    ipcRenderer.invoke('sessions:compact', target),
  updateCurrentSessionPermissionMode: (permissionMode: PermissionMode): Promise<CurrentSession> =>
    ipcRenderer.invoke('sessions:updatePermissionMode', permissionMode),
  createSession: (): Promise<CurrentSession> => ipcRenderer.invoke('sessions:create'),
  forkSession: (
    sourceId: string,
    eventId: string
  ): Promise<{ path: string; phiSessionId: string }> =>
    ipcRenderer.invoke('sessions:fork', sourceId, eventId),
  switchSession: (path: string): Promise<SessionSwitchResult | null> =>
    ipcRenderer.invoke('sessions:switch', path),
  acknowledgeSession: (path: string): Promise<SessionSummary | null> =>
    ipcRenderer.invoke('sessions:acknowledge', path),
  deleteSession: (path: string): Promise<void> => ipcRenderer.invoke('sessions:delete', path),
  renameSession: (path: string, name: string): Promise<void> =>
    ipcRenderer.invoke('sessions:rename', path, name),
  exportSession: (sessionId: string): Promise<SessionExportResult | null> =>
    ipcRenderer.invoke('sessions:export', sessionId),
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
  pickProjectDirectory: (): Promise<string | null> => ipcRenderer.invoke('projects:pickDirectory'),
  createProject: (
    name: string,
    workingDirectory: string,
    permissionMode: PermissionMode
  ): Promise<Project> =>
    ipcRenderer.invoke('projects:create', name, workingDirectory, permissionMode),
  createRemoteProject: (input: RemoteProjectCreateInput): Promise<Project> =>
    ipcRenderer.invoke('projects:createRemote', input),
  retryRemoteProjectConnection: (
    request: RemoteProjectConnectionRetryRequest
  ): Promise<RemoteProjectConnectionState> =>
    ipcRenderer.invoke('projects:retryRemoteConnection', request),
  onRemoteProjectConnectionChanged: (
    cb: (change: RemoteProjectConnectionChange) => void
  ): Unsubscribe => {
    const handler = (_: unknown, change: RemoteProjectConnectionChange): void => cb(change)
    ipcRenderer.on('projects:remoteConnectionChanged', handler)
    return () => ipcRenderer.removeListener('projects:remoteConnectionChanged', handler)
  },
  deleteProject: (id: string): Promise<void> => ipcRenderer.invoke('projects:delete', id),
  updateProjectPermissionMode: (id: string, permissionMode: PermissionMode): Promise<Project> =>
    ipcRenderer.invoke('projects:updatePermissionMode', id, permissionMode),
  updateProjectDefaults: (
    id: string,
    defaults: {
      defaultModel?: { providerId: string; modelId: string } | null
      defaultThinkingLevel?: ThinkingLevel | null
    }
  ): Promise<Project> => ipcRenderer.invoke('projects:updateDefaults', id, defaults),
  listRemoteHosts: (): Promise<RemoteHostProfile[]> =>
    ipcRenderer.invoke('projects:listRemoteHosts'),
  listRemoteProjectDirectories: (
    request: RemoteDirectoryListRequest
  ): Promise<RemoteDirectoryListing> =>
    ipcRenderer.invoke('projects:listRemoteDirectories', request),
  listOpenSshHosts: (): Promise<OpenSshHost[]> => ipcRenderer.invoke('projects:listOpenSshHosts'),
  saveOpenSshHost: (input: OpenSshHostInput): Promise<RemoteHostProfile> =>
    ipcRenderer.invoke('projects:saveOpenSshHost', input),
  saveRemoteHost: (input: {
    id?: string
    label: string
    hostAlias: string
    user?: string
    port?: number
    identityFile?: string
  }): Promise<RemoteHostProfile> => ipcRenderer.invoke('projects:saveRemoteHost', input),
  deleteRemoteHost: (id: string): Promise<void> =>
    ipcRenderer.invoke('projects:deleteRemoteHost', id),
  remoteDoctor: (
    hostProfileId: string,
    remotePath?: string,
    options?: RemoteDoctorOptions
  ): Promise<RemoteDoctorReport> =>
    ipcRenderer.invoke('remote:doctor', hostProfileId, remotePath, options),
  installRemoteNextflow: (hostProfileId: string): Promise<RemoteNextflowInstallResult> =>
    ipcRenderer.invoke('remote:installNextflow', hostProfileId),
  updateProjectRemoteConnection: (
    id: string,
    connectionId: string,
    patch: ProjectRemoteConnection | null
  ): Promise<Project> =>
    ipcRenderer.invoke('projects:updateRemoteConnection', id, connectionId, patch),
  updateProjectRemoteDefaults: (
    id: string,
    defaults: {
      defaultRemoteConnectionId?: string | null
      remoteWorkspaceRoot?: string | null
    }
  ): Promise<Project> => ipcRenderer.invoke('projects:updateRemoteDefaults', id, defaults),
  listProjectSessions: (workingDirectory: string): Promise<SessionSummary[]> =>
    ipcRenderer.invoke('projects:sessions', workingDirectory),
  listProjectSessionsById: (projectId: string): Promise<SessionSummary[]> =>
    ipcRenderer.invoke('projects:sessionsById', projectId),
  createProjectSession: (
    workingDirectory: string,
    permissionMode: PermissionMode
  ): Promise<CurrentSession> =>
    ipcRenderer.invoke('projects:newSession', workingDirectory, permissionMode),
  createRemoteProjectSession: (projectId: string): Promise<CurrentSession> =>
    ipcRenderer.invoke('projects:newRemoteSession', projectId),
  listAnalysisNotebooks: (cwd?: string): Promise<AnalysisNotebookRegistry> =>
    ipcRenderer.invoke('analysis:listNotebooks', cwd),
  initializeProjectAnalysis: (cwd: string): Promise<AnalysisProjectInitialization> =>
    ipcRenderer.invoke('analysis:initializeProject', cwd),
  openAnalysisNotebook: (cwd: string, path: string): Promise<AnalysisNotebookFile> =>
    ipcRenderer.invoke('analysis:openNotebook', cwd, path),
  saveAnalysisNotebook: (
    cwd: string,
    input: SaveAnalysisNotebookInput
  ): Promise<AnalysisNotebookFile> => ipcRenderer.invoke('analysis:saveNotebook', cwd, input),
  syncAnalysisNotebookDraft: (
    cwd: string,
    path: string,
    document: Record<string, unknown>,
    savedRevision?: string
  ): Promise<AnalysisNotebookDraftChange> =>
    ipcRenderer.invoke('analysis:syncNotebookDraft', cwd, path, document, savedRevision),
  createAnalysisNotebook: (cwd: string, relativePath?: string): Promise<AnalysisNotebookFile> =>
    ipcRenderer.invoke('analysis:createNotebook', cwd, relativePath),
  closeAnalysisNotebook: (cwd: string, path: string): Promise<{ path: string }> =>
    ipcRenderer.invoke('analysis:closeNotebook', cwd, path),
  deleteAnalysisNotebook: (
    cwd: string,
    path: string
  ): Promise<{ path: string; relativePath: string }> =>
    ipcRenderer.invoke('analysis:deleteNotebook', cwd, path),
  listAnalysisKernels: (cwd?: string): Promise<AnalysisKernelDiagnostics> =>
    ipcRenderer.invoke('analysis:listKernels', cwd),
  getAnalysisJupyterStatus: (cwd: string): Promise<JupyterServerStatus> =>
    ipcRenderer.invoke('analysis:jupyterStatus', cwd),
  getAnalysisJupyterRuntimeStatus: (cwd: string): Promise<AnalysisJupyterRuntimeStatus> =>
    ipcRenderer.invoke('analysis:jupyterRuntimeStatus', cwd),
  publishNotebookOutputFrame: (html: string): Promise<string> =>
    ipcRenderer.invoke('analysis:publishNotebookOutputFrame', html),
  releaseNotebookOutputFrame: (url: string): Promise<void> =>
    ipcRenderer.invoke('analysis:releaseNotebookOutputFrame', url),
  startAnalysisJupyter: (cwd: string): Promise<JupyterServerStatus> =>
    ipcRenderer.invoke('analysis:startJupyter', cwd),
  stopAnalysisJupyter: (cwd: string): Promise<JupyterServerStatus> =>
    ipcRenderer.invoke('analysis:stopJupyter', cwd),
  getAnalysisNotebookSessionStatus: (
    cwd: string,
    path: string,
    document: Record<string, unknown>
  ): Promise<AnalysisNotebookSessionStatus> =>
    ipcRenderer.invoke('analysis:notebookSessionStatus', cwd, path, document),
  ensureAnalysisNotebookSession: (
    cwd: string,
    path: string,
    document: Record<string, unknown>
  ): Promise<AnalysisNotebookSessionStatus> =>
    ipcRenderer.invoke('analysis:ensureNotebookSession', cwd, path, document),
  closeAnalysisNotebookSession: (
    cwd: string,
    path: string
  ): Promise<AnalysisNotebookSessionStatus> =>
    ipcRenderer.invoke('analysis:closeNotebookSession', cwd, path),
  interruptAnalysisNotebookExecution: (
    cwd: string,
    path: string
  ): Promise<AnalysisNotebookSessionStatus> =>
    ipcRenderer.invoke('analysis:interruptNotebookExecution', cwd, path),
  executeAnalysisNotebookCell: (
    cwd: string,
    path: string,
    document: Record<string, unknown>,
    cellId: string
  ): Promise<AnalysisCellExecutionResult> =>
    ipcRenderer.invoke('analysis:executeNotebookCell', cwd, path, document, cellId),
  completeAnalysisNotebookCell: (
    cwd: string,
    input: AnalysisNotebookCompletionInput
  ): Promise<AnalysisNotebookCompletionResult> =>
    ipcRenderer.invoke('analysis:completeNotebookCell', cwd, input),
  formatAnalysisNotebookCell: (
    cwd: string,
    input: AnalysisNotebookFormatInput
  ): Promise<AnalysisNotebookFormatResult> =>
    ipcRenderer.invoke('analysis:formatNotebookCell', cwd, input),
  generateAnalysisNotebookCode: (
    cwd: string,
    path: string,
    document: Record<string, unknown>,
    input: AnalysisNotebookCodeGenerationInput
  ): Promise<AnalysisNotebookCodeGenerationResult> =>
    ipcRenderer.invoke('analysis:generateNotebookCode', cwd, path, document, input),
  onAnalysisNotebookCodeGenerationProgress: (
    cb: (progress: AnalysisNotebookCodeGenerationProgress) => void
  ): Unsubscribe => {
    const handler = (_: unknown, progress: AnalysisNotebookCodeGenerationProgress): void => {
      cb(progress)
    }

    ipcRenderer.on('analysis:notebookCodeGenerationProgress', handler)

    return () => {
      ipcRenderer.removeListener('analysis:notebookCodeGenerationProgress', handler)
    }
  },
  stopGeneration: (): Promise<void> => ipcRenderer.invoke('agent:stop'),
  steerAgentRun: (
    agentSessionId: string,
    agentRunId: string,
    message: string,
    toolCallId?: string
  ): Promise<void> =>
    ipcRenderer.invoke('agent:steerRun', agentSessionId, agentRunId, message, toolCallId),
  stopAgentRun: (agentSessionId: string, agentRunId: string): Promise<void> =>
    ipcRenderer.invoke('agent:stopRun', agentSessionId, agentRunId),
  onAnalysisNotebookDraftChanged: (
    cb: (change: AnalysisNotebookDraftChange) => void
  ): Unsubscribe => {
    const handler = (_: unknown, change: AnalysisNotebookDraftChange): void => {
      cb(change)
    }

    ipcRenderer.on('analysis:notebookDraftChanged', handler)

    return () => {
      ipcRenderer.removeListener('analysis:notebookDraftChanged', handler)
    }
  },
  onWrapperRunsChanged: (cb: (change: { runId: string }) => void): Unsubscribe => {
    const handler = (_: unknown, change: { runId: string }): void => {
      cb(change)
    }
    ipcRenderer.on('wrappers:runsChanged', handler)
    return () => {
      ipcRenderer.removeListener('wrappers:runsChanged', handler)
    }
  },
  listEnvironmentBuilds: (): Promise<EnvironmentBuild[]> =>
    ipcRenderer.invoke('environmentBuilds:list'),
  cancelEnvironmentBuild: (envId: string): Promise<void> =>
    ipcRenderer.invoke('environmentBuilds:cancel', envId),
  onEnvironmentBuildsChanged: (cb: (build: EnvironmentBuild) => void): Unsubscribe => {
    const handler = (_: unknown, build: EnvironmentBuild): void => {
      cb(build)
    }
    ipcRenderer.on('environmentBuilds:changed', handler)
    return () => {
      ipcRenderer.removeListener('environmentBuilds:changed', handler)
    }
  },
  onAnalysisNotebookFileChanged: (
    cb: (change: AnalysisNotebookFileChange) => void
  ): Unsubscribe => {
    const handler = (_: unknown, change: AnalysisNotebookFileChange): void => {
      cb(change)
    }

    ipcRenderer.on('analysis:notebookFileChanged', handler)

    return () => {
      ipcRenderer.removeListener('analysis:notebookFileChanged', handler)
    }
  },
  onSessionChanged: (cb: (session: CurrentSession) => void): Unsubscribe => {
    const handler = (_: unknown, session: CurrentSession): void => {
      cb(session)
    }

    ipcRenderer.on('sessions:changed', handler)

    return () => {
      ipcRenderer.removeListener('sessions:changed', handler)
    }
  },
  onToolApprovalRequest: (cb: (event: ToolApprovalRequest) => void): Unsubscribe => {
    const handler = (_: unknown, event: ToolApprovalRequest): void => {
      cb(event)
    }

    ipcRenderer.on('tool:approval-request', handler)

    return () => {
      ipcRenderer.removeListener('tool:approval-request', handler)
    }
  },
  onToolApprovalCancelled: (cb: (requestId?: string) => void): Unsubscribe => {
    const handler = (_: unknown, requestId?: string): void => {
      cb(requestId)
    }

    ipcRenderer.on('tool:approval-cancelled', handler)

    return () => {
      ipcRenderer.removeListener('tool:approval-cancelled', handler)
    }
  },
  respondToolApproval: (requestId: string, approved: boolean): Promise<void> =>
    ipcRenderer.invoke('tool:approval-response', requestId, approved),
  onAgentUserInteractionRequest: (
    cb: (event: AgentUserInteractionRequest) => void
  ): Unsubscribe => {
    const handler = (_: unknown, event: AgentUserInteractionRequest): void => {
      cb(event)
    }

    ipcRenderer.on('agent:interaction-request', handler)

    return () => {
      ipcRenderer.removeListener('agent:interaction-request', handler)
    }
  },
  onAgentUserInteractionCancelled: (cb: () => void): Unsubscribe => {
    const handler = (): void => {
      cb()
    }

    ipcRenderer.on('agent:interaction-cancelled', handler)

    return () => {
      ipcRenderer.removeListener('agent:interaction-cancelled', handler)
    }
  },
  respondAgentUserInteraction: (
    requestId: string,
    response: AgentUserInteractionResponse,
    cancelled = false
  ): Promise<void> =>
    ipcRenderer.invoke('agent:interaction-response', requestId, response, cancelled),
  listPlugins: (): Promise<PluginCatalogItem[]> => ipcRenderer.invoke('plugins:list'),
  installPlugin: (source: string): Promise<PluginCatalogItem[]> =>
    ipcRenderer.invoke('plugins:install', source),
  removePlugin: (source: string): Promise<PluginCatalogItem[]> =>
    ipcRenderer.invoke('plugins:remove', source),
  listPhiPlugins: (): Promise<PhiPluginListItem[]> => ipcRenderer.invoke('phiPlugins:list'),
  pickPhiPluginDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('phiPlugins:pickDirectory'),
  previewPhiPluginDirectory: (path: string): Promise<PhiPluginInstallPreview> =>
    ipcRenderer.invoke('phiPlugins:previewDirectory', path),
  installPhiPluginFromDirectory: (path: string): Promise<PhiPluginMutationResult> =>
    ipcRenderer.invoke('phiPlugins:installFromDirectory', path),
  setPhiPluginEnabled: (id: string, enabled: boolean): Promise<PhiPluginMutationResult> =>
    ipcRenderer.invoke('phiPlugins:setEnabled', id, enabled),
  uninstallPhiPlugin: (id: string): Promise<PhiPluginMutationResult> =>
    ipcRenderer.invoke('phiPlugins:uninstall', id),
  pickPackageRegistryDirectory: (): Promise<string | null> =>
    ipcRenderer.invoke('packages:pickRegistryDirectory'),
  pickPackageArchive: (): Promise<string | null> => ipcRenderer.invoke('packages:pickArchive'),
  readPackageRegistry: (dir: string): Promise<PackageRegistryView> =>
    ipcRenderer.invoke('packages:registry', dir),
  listPackageRegistries: (): Promise<KnownPackageRegistryView[]> =>
    ipcRenderer.invoke('packages:listRegistries'),
  removePackageRegistry: (id: string): Promise<KnownPackageRegistryView[]> =>
    ipcRenderer.invoke('packages:removeRegistry', id),
  previewPackageImport: (path: string): Promise<OfflinePackageImportPreview> =>
    ipcRenderer.invoke('packages:previewImport', path),
  importPackage: (path: string): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke('packages:import', path),
  listPackageUpdates: (): Promise<PackageUpdateView[]> =>
    ipcRenderer.invoke('packages:listUpdates'),
  applyPackageUpdate: (type: PackageManagerType, id: string): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke('packages:applyUpdate', type, id),
  applyAllPackageUpdates: (): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke('packages:applyAllUpdates'),
  onPackageUpdatesAvailable: (cb: (updates: PackageUpdateView[]) => void): Unsubscribe => {
    const listener = (_event: Electron.IpcRendererEvent, updates: PackageUpdateView[]): void =>
      cb(updates)
    ipcRenderer.on('packages:updatesAvailable', listener)
    return () => ipcRenderer.removeListener('packages:updatesAvailable', listener)
  },
  planPackageInstall: (
    dir: string,
    type: PackageManagerType,
    id: string,
    version?: string
  ): Promise<PackageInstallPlanView> => ipcRenderer.invoke('packages:plan', dir, type, id, version),
  installPackage: (
    dir: string,
    type: PackageManagerType,
    id: string,
    version?: string
  ): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke('packages:install', dir, type, id, version),
  uninstallPackage: (type: PackageManagerType, id: string): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke('packages:uninstall', type, id),
  listInstalledPackages: (): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke('packages:listInstalled'),
  getEnablement: (projectCwd?: string): Promise<EnablementSnapshot> =>
    ipcRenderer.invoke('enablement:get', projectCwd),
  setEnablement: (
    item: EnablementItemKey,
    value: boolean | null,
    scope: EnablementScope
  ): Promise<EnablementSnapshot> => ipcRenderer.invoke('enablement:set', item, value, scope),
  listSkills: (cwd?: string): Promise<SkillSummary[]> => ipcRenderer.invoke('skills:list', cwd),
  readSkillContent: (filePath: string, cwd?: string): Promise<SkillContent> =>
    ipcRenderer.invoke('skills:read', filePath, cwd),
  setSkillDisabled: (filePath: string, disabled: boolean, cwd?: string): Promise<SkillSummary[]> =>
    ipcRenderer.invoke('skills:setDisabled', filePath, disabled, cwd),
  deleteSkill: (filePath: string, cwd?: string): Promise<SkillSummary[]> =>
    ipcRenderer.invoke('skills:delete', filePath, cwd),
  listPromptAgents: (cwd?: string): Promise<PromptAgentSummary[]> =>
    ipcRenderer.invoke('agents:list', cwd),
  listMcpServers: (cwd?: string): Promise<McpServerSummary[]> =>
    ipcRenderer.invoke('mcp:listServers', cwd),
  listMcpConnectorCatalog: (): Promise<FeaturedMcpConnector[]> =>
    ipcRenderer.invoke('mcp:listConnectorCatalog'),
  installMcpConnector: (
    id: string,
    version?: string,
    registryDir?: string
  ): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke('mcp:installConnector', id, version, registryDir),
  uninstallMcpConnector: (id: string): Promise<InstalledPackageView[]> =>
    ipcRenderer.invoke('mcp:uninstallConnector', id),
  buildMcpConnectorEnvironment: (id: string): Promise<{ envId: string }> =>
    ipcRenderer.invoke('mcp:buildConnectorEnvironment', id),
  onMcpConnectorSetupChanged: (cb: (progress: McpConnectorSetupProgress) => void): Unsubscribe => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      progress: McpConnectorSetupProgress
    ): void => cb(progress)
    ipcRenderer.on('mcp:connectorSetupChanged', handler)
    return () => {
      ipcRenderer.removeListener('mcp:connectorSetupChanged', handler)
    }
  },
  addRemoteMcpConnector: (
    name: string,
    url: string,
    options?: RemoteMcpConnectorOptions
  ): Promise<void> => ipcRenderer.invoke('mcp:addRemoteConnector', name, url, options),
  authorizeRemoteMcpConnector: (name: string): Promise<void> =>
    ipcRenderer.invoke('mcp:authorizeRemoteConnector', name),
  cancelRemoteMcpAuth: (name: string): Promise<void> =>
    ipcRenderer.invoke('mcp:cancelRemoteAuth', name),
  removeRemoteMcpConnector: (name: string, url: string): Promise<void> =>
    ipcRenderer.invoke('mcp:removeRemoteConnector', name, url),
  setMcpConnectorEnabled: (name: string, enabled: boolean, sourcePath?: string): Promise<void> =>
    ipcRenderer.invoke('mcp:setConnectorEnabled', name, enabled, sourcePath),
  listFeaturedMcpTools: (id: string): Promise<string[]> =>
    ipcRenderer.invoke('mcp:featuredTools', id),
  getFeaturedMcpAuthStatus: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('mcp:featuredAuthStatus', id),
  authorizeFeaturedMcp: (id: string): Promise<void> =>
    ipcRenderer.invoke('mcp:authorizeFeatured', id),
  cancelFeaturedMcpAuth: (id: string): Promise<void> =>
    ipcRenderer.invoke('mcp:cancelFeaturedAuth', id),
  getFeaturedMcpApiKeyStatus: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('mcp:featuredApiKeyStatus', id),
  setFeaturedMcpApiKey: (id: string, key: string): Promise<void> =>
    ipcRenderer.invoke('mcp:setFeaturedApiKey', id, key),
  clearFeaturedMcpApiKey: (id: string): Promise<void> =>
    ipcRenderer.invoke('mcp:clearFeaturedApiKey', id),
  getWrapperPlan: (planId: string): Promise<WrapperRunPlan | undefined> =>
    ipcRenderer.invoke('wrappers:getPlan', planId),
  retargetWrapperPlan: (request: WrapperRetargetRequest): Promise<WrapperRunPlan> =>
    ipcRenderer.invoke('wrappers:retargetPlan', request),
  submitWrapperPlan: (
    planId: string,
    heavyWorkloadAcknowledged?: boolean,
    confirmation?: WrapperSubmitConfirmation
  ): Promise<WrapperRun> =>
    ipcRenderer.invoke('wrappers:submitPlan', planId, heavyWorkloadAcknowledged, confirmation),
  cancelWrapperRunPlan: (planId: string): Promise<WrapperRunPlan> =>
    ipcRenderer.invoke('wrappers:cancelPlan', planId),
  listWrapperCatalog: (): Promise<WrapperCatalogEntry[]> =>
    ipcRenderer.invoke('wrappers:listCatalog'),
  addCustomWrapper: (sourceDir: string): Promise<WrapperCatalogEntry> =>
    ipcRenderer.invoke('wrappers:addCustom', sourceDir),
  listWrapperCompositionCatalog: (): Promise<WrapperCompositionCatalogItem[]> =>
    ipcRenderer.invoke('wrappers:listCompositionCatalog'),
  getWrapperCompositionDag: (id: string): Promise<string | undefined> =>
    ipcRenderer.invoke('wrappers:getCompositionDag', id),
  getWrapperCompositionModuleDetails: (id: string): Promise<WrapperModuleDetails | undefined> =>
    ipcRenderer.invoke('wrappers:getCompositionModuleDetails', id),
  listWrapperRuns: (): Promise<WrapperRun[]> => ipcRenderer.invoke('wrappers:listRuns'),
  listAgentJobs: (): Promise<BackgroundAgentJob[]> => ipcRenderer.invoke('jobs:listAgents'),
  listShellJobs: (): Promise<BackgroundShellJob[]> => ipcRenderer.invoke('jobs:listShell'),
  stopShellJob: (agentSessionId: string, jobId: string): Promise<void> =>
    ipcRenderer.invoke('jobs:stopShell', agentSessionId, jobId),
  getWrapperRun: (runId: string): Promise<WrapperRun | undefined> =>
    ipcRenderer.invoke('wrappers:getRun', runId),
  cancelWrapperRun: (runId: string): Promise<WrapperRun> =>
    ipcRenderer.invoke('wrappers:cancelRun', runId),
  getWrapperPlanArtifact: (planId: string, fileName: string): Promise<string | undefined> =>
    ipcRenderer.invoke('wrappers:getPlanArtifact', planId, fileName),
  exportWrapperReproducibility: (runId: string): Promise<string | null> =>
    ipcRenderer.invoke('wrappers:exportReproducibility', runId)
}

function dataTransferHasFiles(dataTransfer: DataTransfer | null): boolean {
  if (!dataTransfer) return false
  const types = Array.from(dataTransfer.types)
  if (types.includes('Files')) return true
  return Array.from(dataTransfer.items).some((item) => item.kind === 'file')
}

function inputFileDropTargetFromEvent(event: DragEvent): Element | null {
  const target = event.target
  if (!target || typeof (target as Element).closest !== 'function') return null
  return (target as Element).closest(`[${INPUT_FILE_DROP_TARGET_ATTRIBUTE}="chat-composer"]`)
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

function notifyInputFilesDropped(paths: string[]): void {
  for (const subscriber of inputFilesDroppedSubscribers) {
    try {
      subscriber(paths)
    } catch (error) {
      console.error(error)
    }
  }
}

window.addEventListener(
  'dragover',
  (event) => {
    if (!inputFileDropTargetFromEvent(event) || !dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer!.dropEffect = 'copy'
  },
  true
)

window.addEventListener(
  'drop',
  (event) => {
    if (!inputFileDropTargetFromEvent(event) || !dataTransferHasFiles(event.dataTransfer)) return
    const paths = droppedFilePathsFromEvent(event)
    if (paths.length === 0) return
    event.preventDefault()
    event.stopPropagation()
    notifyInputFilesDropped(paths)
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
