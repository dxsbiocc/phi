import type { NotebookDocument } from '../../shared/notebookDocument'

export type MessageRole = 'user' | 'assistant' | 'error' | 'warning' | 'thinking'

export type Role = MessageRole

export interface ChatMessage {
  id: string
  role: Role
  content: string
  runId?: string
  createdAt?: string
  completedAt?: string
  durationMs?: number
}

export interface ToolCallItem {
  id: string
  role: 'tool'
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
}

export interface RunLifecycleItem {
  id: string
  role: 'run'
  event: 'started' | 'completed' | 'failed' | 'interrupted'
  runId?: string
  createdAt: string
  durationMs?: number
}

export type ChatItem = ChatMessage | ToolCallItem | RunLifecycleItem

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

export type AuthPromptType = 'text' | 'secret' | 'select' | 'manual_code'

export interface AuthPrompt {
  type: AuthPromptType
  message: string
  placeholder?: string
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
}

export interface AuthPromptInteraction {
  requestId: string
  providerId: string
  prompt: AuthPrompt
  value: string
}

export type ActiveAuthPrompt = AuthPromptInteraction

export interface ModelOption {
  providerId: string
  modelId: string
  name: string
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
export type SessionStatus = 'idle' | 'running' | 'needs_approval' | 'failed' | 'completed_unread'
export type UnreadKind = 'completed' | 'failed' | 'approval'
export type LastRunOutcome = 'completed' | 'failed' | 'interrupted' | 'stopped'

export interface SessionRuntimeState {
  status: SessionStatus
  unreadKind: UnreadKind | null
  lastRunOutcome?: LastRunOutcome
  currentRunId?: string
  currentRunStartedAt?: string
  lastActivityAt?: string
}

export interface SessionSummary extends SessionRuntimeState {
  path: string
  id: string
  name?: string
  created: string
  modified: string
  messageCount: number
  firstMessage: string
  phiSessionId?: string
}

export interface SessionSwitchResult extends SessionRuntimeState {
  path: string
  cwd: string
  sessionGeneration: number
  permissionMode: PermissionMode
  messages: unknown[]
}

export interface CurrentSession extends SessionRuntimeState {
  path: string | null
  cwd: string
  sessionGeneration: number
  permissionMode: PermissionMode
  messages?: unknown[]
}

export interface PromptResult {
  path: string | null
  sessionGeneration: number
}

export type PermissionMode = 'auto' | 'ask' | 'full'

export interface Project {
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
  createdAt: string
}

export interface ToolApprovalRequest {
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

export interface SkillSummary {
  id: string
  name: string
  description: string
  filePath: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  disabled: boolean
}

export interface McpServerSummary {
  id: string
  name: string
  command?: string
  args?: string[]
  envKeys?: string[]
  sourcePath?: string
  status: 'configured'
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

export type RendererApi = {
  closeWindow: () => Promise<void>
  minimizeWindow: () => Promise<void>
  toggleWindowFullscreen: () => Promise<void>
  revealPath: (path: string) => Promise<void>
  copyDiagnostics: () => Promise<string>
  sendPrompt: (text: string) => Promise<PromptResult | null>
  onAgentEvent: (cb: (event: AgentEventSummary) => void) => () => void
  getAuthStatus: () => Promise<ProviderAuthStatus[]>
  loginApiKey: (providerId: string, key: string) => Promise<ProviderAuthStatus[]>
  loginOAuth: (providerId: string) => Promise<ProviderAuthStatus[]>
  logout: (providerId: string) => Promise<void>
  submitAuthInteraction: (requestId: string, value: string) => Promise<void>
  onAuthInteraction: (cb: (event: AuthInteractionEvent) => void) => () => void
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
  createAnalysisNotebook: (cwd: string, relativePath?: string) => Promise<AnalysisNotebookFile>
  closeAnalysisNotebook: (cwd: string, path: string) => Promise<{ path: string }>
  listAnalysisKernels: (cwd?: string) => Promise<AnalysisKernelDiagnostics>
  stopGeneration: () => Promise<void>
  onSessionChanged: (cb: (session: CurrentSession) => void) => () => void
  onToolApprovalRequest: (cb: (event: ToolApprovalRequest) => void) => () => void
  onToolApprovalCancelled: (cb: () => void) => () => void
  respondToolApproval: (requestId: string, approved: boolean) => Promise<void>
  listPlugins: () => Promise<PluginCatalogItem[]>
  installPlugin: (source: string) => Promise<PluginCatalogItem[]>
  removePlugin: (source: string) => Promise<PluginCatalogItem[]>
  listSkills: (cwd?: string) => Promise<SkillSummary[]>
  listMcpServers: (cwd?: string) => Promise<McpServerSummary[]>
}

export interface AgentMessage {
  role?: string
  stopReason?: string
  errorMessage?: string
  content?: Array<{ type?: string; text?: string; thinking?: string }>
}

export interface AgentEventSummary {
  source?: string
  type: string
  eventId?: string
  createdAt?: string
  runId?: string
  durationMs?: number
  approvalId?: string
  sessionGeneration?: number
  sessionPath?: string | null
  cwd?: string
  message?: AgentMessage
  assistantMessageEvent?: {
    type?: string
    delta?: string
    contentIndex?: number
  }
  toolCallId?: string
  toolName?: string
  args?: unknown
  activeCount?: number
  partialResult?: unknown
  result?: unknown
  isError?: boolean
  reason?: string
  action?: string
  aborted?: boolean
  willRetry?: boolean
  skipped?: boolean
  errorMessage?: string
  fromProviderId?: string
  fromModelId?: string
  toProviderId?: string
  toModelId?: string
  toModelName?: string
}

export type AuthEvent =
  | {
      type: 'info'
      message: string
      links?: ReadonlyArray<{ url: string; label?: string }>
    }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | { type: 'progress'; message: string }

export type AuthInteractionEvent =
  | {
      type: 'prompt'
      requestId: string
      providerId: string
      prompt: AuthPrompt
    }
  | {
      type: 'notify'
      providerId: string
      event: AuthEvent
    }
