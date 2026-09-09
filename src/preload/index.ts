import { contextBridge, ipcRenderer } from 'electron'

type AgentEventSummary = Record<string, unknown>
type Unsubscribe = () => void

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
type SessionStatus = 'idle' | 'running' | 'needs_approval' | 'failed' | 'completed_unread'
type UnreadKind = 'completed' | 'failed' | 'approval'
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
  cwd: string
  sessionGeneration: number
  permissionMode: PermissionMode
  messages: unknown[]
}

type CurrentSession = SessionRuntimeState & {
  path: string | null
  cwd: string
  sessionGeneration: number
  permissionMode: PermissionMode
  messages?: unknown[]
}

type PromptResult = {
  path: string | null
  sessionGeneration: number
}

type PermissionMode = 'auto' | 'ask' | 'full'

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

type SkillSummary = {
  id: string
  name: string
  description: string
  filePath: string
  source: string
  scope: 'user' | 'project' | 'temporary'
  disabled: boolean
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

type RendererAuthApi = {
  closeWindow: () => Promise<void>
  minimizeWindow: () => Promise<void>
  toggleWindowFullscreen: () => Promise<void>
  revealPath: (path: string) => Promise<void>
  copyDiagnostics: () => Promise<string>
  sendPrompt: (text: string) => Promise<PromptResult | null>
  onAgentEvent: (cb: (event: AgentEventSummary) => void) => Unsubscribe
  getAuthStatus: () => Promise<AuthStatusItem[]>
  loginApiKey: (providerId: string, key: string) => Promise<AuthStatusItem[]>
  loginOAuth: (providerId: string) => Promise<AuthStatusItem[]>
  logout: (providerId: string) => Promise<void>
  submitAuthInteraction: (requestId: string, value: string) => Promise<void>
  onAuthInteraction: (cb: (event: AuthInteractionEvent) => void) => Unsubscribe
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
  deleteAnalysisNotebook: (
    cwd: string,
    path: string
  ) => Promise<{ path: string; relativePath: string }>
  listAnalysisKernels: (cwd?: string) => Promise<AnalysisKernelDiagnostics>
  getAnalysisJupyterStatus: (cwd: string) => Promise<JupyterServerStatus>
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
  executeAnalysisNotebookCell: (
    cwd: string,
    path: string,
    document: Record<string, unknown>,
    cellId: string
  ) => Promise<AnalysisCellExecutionResult>
  stopGeneration: () => Promise<void>
  onSessionChanged: (cb: (session: CurrentSession) => void) => Unsubscribe
  onToolApprovalRequest: (cb: (event: ToolApprovalRequest) => void) => Unsubscribe
  onToolApprovalCancelled: (cb: () => void) => Unsubscribe
  respondToolApproval: (requestId: string, approved: boolean) => Promise<void>
  listPlugins: () => Promise<PluginCatalogItem[]>
  installPlugin: (source: string) => Promise<PluginCatalogItem[]>
  removePlugin: (source: string) => Promise<PluginCatalogItem[]>
  listSkills: (cwd?: string) => Promise<SkillSummary[]>
  listMcpServers: (cwd?: string) => Promise<McpServerSummary[]>
}

const api: RendererAuthApi = {
  closeWindow: (): Promise<void> => ipcRenderer.invoke('window:close'),
  minimizeWindow: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  toggleWindowFullscreen: (): Promise<void> => ipcRenderer.invoke('window:toggle-fullscreen'),
  revealPath: (path: string): Promise<void> => ipcRenderer.invoke('files:reveal', path),
  copyDiagnostics: (): Promise<string> => ipcRenderer.invoke('diagnostics:copy'),
  sendPrompt: (text: string): Promise<PromptResult | null> =>
    ipcRenderer.invoke('agent:prompt', text),
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
  executeAnalysisNotebookCell: (
    cwd: string,
    path: string,
    document: Record<string, unknown>,
    cellId: string
  ): Promise<AnalysisCellExecutionResult> =>
    ipcRenderer.invoke('analysis:executeNotebookCell', cwd, path, document, cellId),
  stopGeneration: (): Promise<void> => ipcRenderer.invoke('agent:stop'),
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
  listPlugins: (): Promise<PluginCatalogItem[]> => ipcRenderer.invoke('plugins:list'),
  installPlugin: (source: string): Promise<PluginCatalogItem[]> =>
    ipcRenderer.invoke('plugins:install', source),
  removePlugin: (source: string): Promise<PluginCatalogItem[]> =>
    ipcRenderer.invoke('plugins:remove', source),
  listSkills: (cwd?: string): Promise<SkillSummary[]> => ipcRenderer.invoke('skills:list', cwd),
  listMcpServers: (cwd?: string): Promise<McpServerSummary[]> =>
    ipcRenderer.invoke('mcp:listServers', cwd)
}

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
