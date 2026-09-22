import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DatabaseWebImagePreview } from '../shared/databaseWebPreview'

// Imported (unlike the other ambient types in this file, which are
// hand-duplicated) because WrapperRunPlan/WrapperRun are large, evolving
// shapes (see docs/design/phi-wrapper-technical-design.md) — duplicating
// them here and in index.d.ts would just be another place for the two to
// drift out of sync.
import type { WrapperCatalogEntry } from '../shared/wrapperCatalogTypes'
import type { WrapperCompositionManifest } from '../shared/wrapperCompositionManifestTypes'
import type { WrapperModuleDetails } from '../shared/wrapperModuleDetailsTypes'
import type { RemoteHpcSettings } from '../shared/wrapperRemoteTypes'
import type { WrapperRun, WrapperRunPlan } from '../shared/wrapperTypes'
import type {
  AgentUserInteractionRequest,
  AgentUserInteractionResponse
} from '../shared/agentInteractionTypes'
import type {
  DefaultProxyMode,
  PhiAppSettings,
  PhiAppSettingsPatch
} from '../shared/appSettingsTypes'
import type { DbConnectorSettingsItem } from '../shared/dbConnectorTypes'
import type {
  EnvironmentGetResult,
  EnvironmentSnapshot,
  EnvironmentToolId
} from '../shared/environmentTypes'

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
  sessionGeneration: number
  permissionMode: PermissionMode
  messages: unknown[]
}

type CurrentSession = SessionRuntimeState & {
  path: string | null
  phiSessionId?: string
  cwd: string
  sessionGeneration: number
  permissionMode: PermissionMode
  messages?: unknown[]
}

type PromptResult = {
  path: string | null
  phiSessionId?: string
  sessionGeneration: number
}

type PromptTarget = {
  path: string | null
  phiSessionId?: string
  cwd: string
  sessionGeneration: number
  suppressUserMessageEvent?: boolean
  retryUserMessageId?: string
}

type PermissionMode = 'auto' | 'ask' | 'full'

type ProjectRemoteConnection = {
  id: string
  label: string
  host: string
  port?: number
  username: string
  privateKeyPath: string
  hasPassphrase?: boolean
  hpc?: RemoteHpcSettings
}

type Project = {
  id: string
  name: string
  workingDirectory: string
  permissionMode: PermissionMode
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
  sessionId?: string
  sessionPath?: string
  sessionGeneration?: number
  runId?: string
  cwd?: string
  projectName?: string
  toolName: string
  summary: string
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

type SkillSourceCategory = 'system' | 'third-party' | 'user' | 'generated'

type SkillSummary = {
  id: string
  name: string
  description: string
  filePath: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  sourceCategory: SkillSourceCategory
  sourceCategoryLabel: string
  disabled: boolean
}

type SkillContent = {
  filePath: string
  content: string
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
  command?: string
  args?: string[]
  envKeys?: string[]
  sourcePath?: string
  status: 'configured'
}

type FilePreview = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  kind: 'text' | 'image' | 'pdf'
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
      kind: 'image'
      mimeType: 'image/png'
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
  closeWindow: () => Promise<void>
  minimizeWindow: () => Promise<void>
  toggleWindowFullscreen: () => Promise<void>
  revealPath: (path: string) => Promise<void>
  openPath: (path: string) => Promise<void>
  getFileIcon: (path: string) => Promise<string | null>
  pickInputFiles: () => Promise<string[]>
  getPathForFile: (file: File) => string
  onInputFilesDropped: (cb: (paths: string[]) => void) => Unsubscribe
  previewFile: (path: string) => Promise<FilePreview>
  hoverPreviewFile: (path: string) => Promise<FileHoverPreview>
  statLocalPaths: (cwd: string, paths: string[]) => Promise<LocalPathStat[]>
  listDirectory: (path: string) => Promise<DirectoryListing>
  renderMoleculeSvg: (value: string, width: number, height: number) => Promise<string>
  previewDatabaseWebImage: (url: string) => Promise<DatabaseWebImagePreview>
  copyDiagnostics: () => Promise<string>
  sendPrompt: (text: string, target?: PromptTarget) => Promise<PromptResult | null>
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
  updateDefaultProxyMode: (mode: DefaultProxyMode) => Promise<PhiAppSettings>
  getEnvironment: () => Promise<EnvironmentGetResult>
  redetectEnvironment: () => Promise<EnvironmentSnapshot>
  dismissEnvironmentSummary: () => Promise<EnvironmentSnapshot>
  setEnvironmentToolPath: (
    toolId: EnvironmentToolId,
    path: string | null
  ) => Promise<EnvironmentSnapshot>
  pickEnvironmentBinary: () => Promise<string | null>
  listDbConnectors: () => Promise<DbConnectorSettingsItem[]>
  setDbConnectorEnabled: (id: string, enabled: boolean) => Promise<DbConnectorSettingsItem[]>
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
  getCurrentSession: () => Promise<CurrentSession>
  updateCurrentSessionPermissionMode: (permissionMode: PermissionMode) => Promise<CurrentSession>
  createSession: () => Promise<CurrentSession>
  switchSession: (path: string) => Promise<SessionSwitchResult | null>
  acknowledgeSession: (path: string) => Promise<SessionSummary | null>
  deleteSession: (path: string) => Promise<void>
  renameSession: (path: string, name: string) => Promise<void>
  listProjects: () => Promise<Project[]>
  pickProjectDirectory: () => Promise<string | null>
  createProject: (
    name: string,
    workingDirectory: string,
    permissionMode: PermissionMode
  ) => Promise<Project>
  deleteProject: (id: string) => Promise<void>
  updateProjectPermissionMode: (id: string, permissionMode: PermissionMode) => Promise<Project>
  updateProjectDefaults: (
    id: string,
    defaults: {
      defaultModel?: { providerId: string; modelId: string } | null
      defaultThinkingLevel?: ThinkingLevel | null
    }
  ) => Promise<Project>
  pickPrivateKeyFile: () => Promise<string | null>
  isRemoteCredentialStorageAvailable: () => Promise<boolean>
  updateProjectRemoteConnection: (
    id: string,
    connectionId: string,
    patch: ProjectRemoteConnection | null,
    passphrase?: string | null
  ) => Promise<Project>
  updateProjectRemoteDefaults: (
    id: string,
    defaults: {
      defaultRemoteConnectionId?: string | null
      remoteWorkspaceRoot?: string | null
    }
  ) => Promise<Project>
  listProjectSessions: (workingDirectory: string) => Promise<SessionSummary[]>
  createProjectSession: (
    workingDirectory: string,
    permissionMode: PermissionMode
  ) => Promise<CurrentSession>
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
  onToolApprovalCancelled: (cb: () => void) => Unsubscribe
  respondToolApproval: (requestId: string, approved: boolean) => Promise<void>
  listPlugins: () => Promise<PluginCatalogItem[]>
  installPlugin: (source: string) => Promise<PluginCatalogItem[]>
  removePlugin: (source: string) => Promise<PluginCatalogItem[]>
  listSkills: (cwd?: string) => Promise<SkillSummary[]>
  readSkillContent: (filePath: string, cwd?: string) => Promise<SkillContent>
  setSkillDisabled: (filePath: string, disabled: boolean, cwd?: string) => Promise<SkillSummary[]>
  deleteSkill: (filePath: string, cwd?: string) => Promise<SkillSummary[]>
  listPromptAgents: (cwd?: string) => Promise<PromptAgentSummary[]>
  listMcpServers: (cwd?: string) => Promise<McpServerSummary[]>
  getWrapperPlan: (planId: string) => Promise<WrapperRunPlan | undefined>
  submitWrapperPlan: (planId: string, heavyWorkloadAcknowledged?: boolean) => Promise<WrapperRun>
  cancelWrapperRunPlan: (planId: string) => Promise<WrapperRunPlan>
  listWrapperCatalog: () => Promise<WrapperCatalogEntry[]>
  addCustomWrapper: (sourceDir: string) => Promise<WrapperCatalogEntry>
  listWrapperCompositionCatalog: () => Promise<WrapperCompositionManifest[]>
  getWrapperCompositionDag: (id: string) => Promise<string | undefined>
  getWrapperCompositionModuleDetails: (id: string) => Promise<WrapperModuleDetails | undefined>
  listWrapperRuns: () => Promise<WrapperRun[]>
  getWrapperRun: (runId: string) => Promise<WrapperRun | undefined>
  cancelWrapperRun: (runId: string) => Promise<WrapperRun>
  getWrapperPlanArtifact: (planId: string, fileName: string) => Promise<string | undefined>
  exportWrapperReproducibility: (runId: string) => Promise<string | null>
}

const api: RendererAuthApi = {
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleWindowFullscreen: (): Promise<void> => ipcRenderer.invoke('window:toggle-fullscreen'),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('files:reveal', path),
  openPath: (path: string): Promise<void> => ipcRenderer.invoke('files:openPath', path),
  getFileIcon: (path: string): Promise<string | null> => ipcRenderer.invoke('files:getIcon', path),
  pickInputFiles: (): Promise<string[]> => ipcRenderer.invoke('files:pickInput'),
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  onInputFilesDropped: (cb: (paths: string[]) => void): Unsubscribe => {
    inputFilesDroppedSubscribers.add(cb)
    return () => {
      inputFilesDroppedSubscribers.delete(cb)
    }
  },
  previewFile: (path: string): Promise<FilePreview> => ipcRenderer.invoke('files:preview', path),
  hoverPreviewFile: (path: string): Promise<FileHoverPreview> =>
    ipcRenderer.invoke('files:hoverPreview', path),
  statLocalPaths: (cwd: string, paths: string[]): Promise<LocalPathStat[]> =>
    ipcRenderer.invoke('files:statLocalPaths', cwd, paths),
  listDirectory: (path: string): Promise<DirectoryListing> =>
    ipcRenderer.invoke('files:listDirectory', path),
  renderMoleculeSvg: (value: string, width: number, height: number): Promise<string> =>
    ipcRenderer.invoke('molecules:renderSvg', value, width, height),
  previewDatabaseWebImage: (url: string): Promise<DatabaseWebImagePreview> =>
    ipcRenderer.invoke('database:webImagePreview', url),
  copyDiagnostics: (): Promise<string> => ipcRenderer.invoke('diagnostics:copy'),
  sendPrompt: (text: string, target?: PromptTarget): Promise<PromptResult | null> =>
    ipcRenderer.invoke('agent:prompt', text, target),
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
  updateDefaultProxyMode: (mode: DefaultProxyMode): Promise<PhiAppSettings> =>
    ipcRenderer.invoke('settings:updateDefaultProxyMode', mode),
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
  listDbConnectors: (): Promise<DbConnectorSettingsItem[]> =>
    ipcRenderer.invoke('db:listConnectors'),
  setDbConnectorEnabled: (id: string, enabled: boolean): Promise<DbConnectorSettingsItem[]> =>
    ipcRenderer.invoke('db:setConnectorEnabled', id, enabled),
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
  getCurrentSession: (): Promise<CurrentSession> => ipcRenderer.invoke('sessions:current'),
  updateCurrentSessionPermissionMode: (permissionMode: PermissionMode): Promise<CurrentSession> =>
    ipcRenderer.invoke('sessions:updatePermissionMode', permissionMode),
  createSession: (): Promise<CurrentSession> => ipcRenderer.invoke('sessions:create'),
  switchSession: (path: string): Promise<SessionSwitchResult | null> =>
    ipcRenderer.invoke('sessions:switch', path),
  acknowledgeSession: (path: string): Promise<SessionSummary | null> =>
    ipcRenderer.invoke('sessions:acknowledge', path),
  deleteSession: (path: string): Promise<void> => ipcRenderer.invoke('sessions:delete', path),
  renameSession: (path: string, name: string): Promise<void> =>
    ipcRenderer.invoke('sessions:rename', path, name),
  listProjects: (): Promise<Project[]> => ipcRenderer.invoke('projects:list'),
  pickProjectDirectory: (): Promise<string | null> => ipcRenderer.invoke('projects:pickDirectory'),
  createProject: (
    name: string,
    workingDirectory: string,
    permissionMode: PermissionMode
  ): Promise<Project> =>
    ipcRenderer.invoke('projects:create', name, workingDirectory, permissionMode),
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
  pickPrivateKeyFile: (): Promise<string | null> =>
    ipcRenderer.invoke('projects:pickPrivateKeyFile'),
  isRemoteCredentialStorageAvailable: (): Promise<boolean> =>
    ipcRenderer.invoke('projects:isRemoteCredentialStorageAvailable'),
  updateProjectRemoteConnection: (
    id: string,
    connectionId: string,
    patch: ProjectRemoteConnection | null,
    passphrase?: string | null
  ): Promise<Project> =>
    ipcRenderer.invoke('projects:updateRemoteConnection', id, connectionId, patch, passphrase),
  updateProjectRemoteDefaults: (
    id: string,
    defaults: {
      defaultRemoteConnectionId?: string | null
      remoteWorkspaceRoot?: string | null
    }
  ): Promise<Project> => ipcRenderer.invoke('projects:updateRemoteDefaults', id, defaults),
  listProjectSessions: (workingDirectory: string): Promise<SessionSummary[]> =>
    ipcRenderer.invoke('projects:sessions', workingDirectory),
  createProjectSession: (
    workingDirectory: string,
    permissionMode: PermissionMode
  ): Promise<CurrentSession> =>
    ipcRenderer.invoke('projects:newSession', workingDirectory, permissionMode),
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
  onToolApprovalCancelled: (cb: () => void): Unsubscribe => {
    const handler = (): void => {
      cb()
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
  getWrapperPlan: (planId: string): Promise<WrapperRunPlan | undefined> =>
    ipcRenderer.invoke('wrappers:getPlan', planId),
  submitWrapperPlan: (planId: string, heavyWorkloadAcknowledged?: boolean): Promise<WrapperRun> =>
    ipcRenderer.invoke('wrappers:submitPlan', planId, heavyWorkloadAcknowledged),
  cancelWrapperRunPlan: (planId: string): Promise<WrapperRunPlan> =>
    ipcRenderer.invoke('wrappers:cancelPlan', planId),
  listWrapperCatalog: (): Promise<WrapperCatalogEntry[]> =>
    ipcRenderer.invoke('wrappers:listCatalog'),
  addCustomWrapper: (sourceDir: string): Promise<WrapperCatalogEntry> =>
    ipcRenderer.invoke('wrappers:addCustom', sourceDir),
  listWrapperCompositionCatalog: (): Promise<WrapperCompositionManifest[]> =>
    ipcRenderer.invoke('wrappers:listCompositionCatalog'),
  getWrapperCompositionDag: (id: string): Promise<string | undefined> =>
    ipcRenderer.invoke('wrappers:getCompositionDag', id),
  getWrapperCompositionModuleDetails: (id: string): Promise<WrapperModuleDetails | undefined> =>
    ipcRenderer.invoke('wrappers:getCompositionModuleDetails', id),
  listWrapperRuns: (): Promise<WrapperRun[]> => ipcRenderer.invoke('wrappers:listRuns'),
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
