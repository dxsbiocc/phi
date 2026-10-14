import type { PhiAgentEvent } from './event-types'
export type {
  PhiAgentEvent,
  PhiKnownAgentEvent,
  PhiUnknownAgentEvent,
  PhiEventMessage,
  PhiAssistantMessage,
  PhiAssistantMessageEvent,
  PhiCompactionResult,
  PhiKnownAssistantMessageEvent,
  PhiAgentEventSummary,
  PhiMessageUpdateSummary
} from './event-types'
import type {
  AutoCompactionDefaults,
  AutoCompactionOverrides,
  ContextCompactionSummary,
  ContextUsageSnapshot
} from '../../../shared/contextUsageTypes'
import type { ProjectLocation } from '../../../shared/projectLocation'
import type {
  ProjectMemorySettings,
  ProjectMemorySnapshot
} from '../../../shared/projectMemoryTypes'
import type { RemoteProjectMcpRuntimeServer } from '../../../shared/remoteProjectMcpTypes'
import type { PhiAgentDefinition } from '../agents/definition'

export type PhiToolSite = 'host' | 'runtime'
export type PhiToolApproval = 'read' | 'write' | 'exec'
export type PhiToolLoadMode = 'essential' | 'discoverable'

export type PhiCompactionMethod = 'remote' | 'snapcompact' | 'handoff' | 'soft' | 'shake'

export interface PhiCompactionSettings {
  enabled: boolean
  thresholdPercent: number
  thresholdTokens: number
  methodOrder: PhiCompactionMethod[]
}

export type PhiWebSearchProvider =
  | 'perplexity'
  | 'gemini'
  | 'anthropic'
  | 'codex'
  | 'xai'
  | 'zai'
  | 'exa'
  | 'tinyfish'
  | 'jina'
  | 'kagi'
  | 'tavily'
  | 'firecrawl'
  | 'brave'
  | 'kimi'
  | 'parallel'
  | 'synthetic'
  | 'searxng'
  | 'startpage'
  | 'duckduckgo'
  | 'ecosia'
  | 'google'
  | 'mojeek'
  | 'public'

export interface PhiWebSearchSettings {
  order: PhiWebSearchProvider[]
  excluded: PhiWebSearchProvider[]
  endpoint: string | undefined
  engines: string | undefined
}

export interface PhiSearxngCredentials {
  endpoint: string | undefined
  token: string | undefined
  basicUsername: string | undefined
  basicPassword: string | undefined
}

export type PhiExtensionsSourceLevel = 'user' | 'project'

export interface PhiSettings {
  compaction: {
    read(): PhiCompactionSettings
    override(values: PhiCompactionSettings): void
  }
  webSearch: {
    read(): PhiWebSearchSettings
    write(values: PhiWebSearchSettings): void
    readSearxngCredentials(): PhiSearxngCredentials
  }
  mcp: {
    read(): { enableProjectConfig: boolean; notifications: boolean }
  }
  extensions: {
    read(): { configured: string[]; sourceLevel: PhiExtensionsSourceLevel }
  }
  memory: {
    useLocalBackend(): void
  }
  flush(): Promise<void>
}

export type PhiToolContent =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

export interface PhiToolResult<TDetails = unknown> {
  content: PhiToolContent[]
  details?: TDetails
  isError?: boolean
}

export type PhiToolImage = { type: 'image'; data: string; mimeType: string }

export interface PhiToolContext {
  /** Working directory of the calling session. */
  readonly cwd: string
  /**
   * Images the user attached most recently in this session, read at call time.
   * Same rules as the current `latestUserImages` in `agents/tool.ts`: look back at
   * most 3 user messages, newest first; return the images of the first one that has
   * any, at most 5; only png, jpeg, gif and webp with non-empty data.
   */
  recentUserImages(): PhiToolImage[]
}

export type PhiToolUpdate<TDetails = unknown> = (partial: PhiToolResult<TDetails>) => void

export interface PhiTool<TParams = Record<string, unknown>, TDetails = unknown> {
  name: string
  label: string
  description: string
  /** JSON Schema object for the tool input. */
  parameters: Record<string, unknown>
  /** Where execute() does its work (plan M4). */
  site: PhiToolSite
  strict?: boolean
  hidden?: boolean
  loadMode?: PhiToolLoadMode
  approval?: PhiToolApproval
  /** OMP-recognized metadata, preserved even where its current SDK bridge omits it. */
  lenientArgValidation?: boolean
  execute(
    toolCallId: string,
    params: TParams,
    onUpdate: PhiToolUpdate<TDetails> | undefined,
    ctx: PhiToolContext,
    signal?: AbortSignal
  ): Promise<PhiToolResult<TDetails>>
}

export type PhiCredentialType = 'api_key' | 'oauth'

export interface PhiStoredCredential {
  id: string
  providerId: string
  type: PhiCredentialType
  /** OAuth: email, else accountId, else providerId. API key: providerId. */
  label: string
}

export type PhiCredentialOrigin =
  | 'stored'
  | 'runtime'
  | 'environment'
  | 'fallback'
  | 'models_json_key'
  | 'models_json_command'
  | undefined

export interface PhiCredentialStatus {
  /** hasAuth || hasConcreteAuth (the stored-credential part stays with the caller). */
  available: boolean
  origin: PhiCredentialOrigin
  label: string | undefined
}

export interface PhiLoginCallbacks {
  signal?: AbortSignal
  onAuth(info: { url: string; instructions?: string }): void
  onProgress(message: string): void
  onManualCodeInput(): Promise<string>
  onPrompt(prompt: { message: string; placeholder?: string }): Promise<string>
}

export interface PhiMcpOAuthCredential {
  type: 'oauth'
  refresh: string
  access: string
  expires: number
  enterpriseUrl?: string
  projectId?: string
  email?: string
  accountId?: string
  apiEndpoint?: string
  orgId?: string
  orgName?: string
  authorizedAt?: number
  tokenUrl?: string
  clientId?: string
  clientSecret?: string
  resource?: string
  authorizationUrl?: string
}

export interface PhiAuth {
  listCredentials(authId?: string): PhiStoredCredential[]
  credentialStatus(providerId: string): PhiCredentialStatus
  hasOAuth(providerId: string): boolean
  isFromEnvironment(authId: string): boolean
  setApiKey(providerId: string, key: string): Promise<void>
  replaceApiKey(authId: string, key: string): Promise<void>
  clearApiKeys(authId: string): Promise<void>
  login(providerId: string, callbacks: PhiLoginCallbacks): Promise<void>
  logout(providerId: string): Promise<void>
  hasMcpOAuth(url: string): boolean
  hasMcpOAuthToken(url: string): boolean
  setMcpOAuth(url: string, credential: PhiMcpOAuthCredential): Promise<void>
}

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type RuntimeAuthSource =
  'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command'

export interface RuntimeProvider {
  id: string
  name: string
  auth?: {
    apiKey?: boolean
    oauth?: boolean
  }
}

export interface RuntimeCredential {
  id?: string
  providerId: string
  type?: string
  label?: string
}

export interface RuntimeProviderAuthStatus {
  configured: boolean
  source?: RuntimeAuthSource
  label?: string
}

export interface RuntimeModel {
  provider: string
  id: string
  name: string
  reasoning: boolean
  supportsImages?: boolean
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
}

export type ResourceDiagnostic = {
  type: 'error' | 'warning' | 'info'
  message: string
  path?: string
}

export interface Skill {
  name: string
  description: string
  filePath: string
  disableModelInvocation?: boolean
  sourceInfo: {
    source: string
    scope: 'user' | 'project' | 'temporary'
    origin?: string
    path?: string
    baseDir?: string
  }
  remoteProject?: {
    relativePath: string
    contentHash: string
  }
}

export interface SessionInfo {
  path: string
  id: string
  name?: string
  title?: string
  created: Date
  modified: Date
  messageCount: number
  firstMessage: string
  allMessagesText?: string
  cwd?: string
  size?: number
  status?: string
}

export type RuntimeResourceBundle = {
  extensions?: unknown
  skills: {
    skills: Skill[]
    diagnostics: ResourceDiagnostic[]
  }
  prompts?: unknown
  themes?: unknown
  agentsFiles?: unknown
  systemPrompt?: string
  appendSystemPrompt?: string[]
}

export type RuntimeSnapshot = {
  providers: Array<RuntimeProvider & { status?: RuntimeProviderAuthStatus }>
  models: RuntimeModel[]
  credentials: RuntimeCredential[]
}

export type WorkerSessionState = {
  sessionFile?: string
  messages?: unknown[]
  model?: RuntimeModel
  thinkingLevel?: ThinkingLevel
  cwd?: string
}

export type WorkerCreateSessionResult = {
  sessionId: string
  state: WorkerSessionState
}

export type ToolApprovalRequest = {
  requestId: string
  toolCallId?: string
  toolName?: string
  input?: Record<string, unknown>
  agentRunId?: string
}

export type PhiHostRequestContext = {
  /** Desktop-only cancellation capability; never serialized to worker/RPC payloads. */
  readonly signal?: AbortSignal
  readonly originSessionId?: string
  readonly agentRunId?: string
  readonly toolCallId?: string
}

export type PhiHostRequestHandler = (
  params: unknown,
  context: PhiHostRequestContext
) => unknown | Promise<unknown>

export type PhiSessionCreateParams = {
  sessionId: string
  cwd: string
  agentDir: string
  model?: RuntimeModel
  thinkingLevel?: ThinkingLevel
  autoCompaction?: AutoCompactionOverrides
  noTools?: 'all' | boolean
  sessionManager: {
    kind: 'persistent' | 'memory' | 'open'
    cwd: string
    path?: string
  }
  resourceOptions?: Record<string, unknown>
  enableToolApproval: boolean
  phiAgents?: PhiAgentDefinition[]
  projectBound?: boolean
  memory?: ProjectMemorySettings
  remoteProject?: {
    phiSessionId: string
    projectId: string
    location: Extract<ProjectLocation, { kind: 'ssh' }>
    contextFiles: Array<{ path: string; content: string }>
  }
  remoteProjectMcpServers?: RemoteProjectMcpRuntimeServer[]
  personaMarkdown?: string
}

export interface PhiEngine {
  sessions: {
    create(params: PhiSessionCreateParams): Promise<WorkerCreateSessionResult>
    prompt(params: {
      sessionId: string
      text: string
      options?: Record<string, unknown>
    }): Promise<WorkerSessionState>
    abort(params: { sessionId: string }): Promise<WorkerSessionState>
    dispose(params: { sessionId: string }): Promise<unknown>
    setModel(params: {
      sessionId: string
      agentDir: string
      model: RuntimeModel
    }): Promise<WorkerSessionState>
    setThinkingLevel(params: {
      sessionId: string
      level: ThinkingLevel | undefined
    }): Promise<WorkerSessionState>
    rename(params: { sessionId: string; name: string }): Promise<WorkerSessionState>
    contextUsage(params: { sessionId: string }): Promise<ContextUsageSnapshot | null>
    compact(params: { sessionId: string }): Promise<{
      summary: ContextCompactionSummary
      state: WorkerSessionState
    }>
    setAutoCompactionSettings(params: {
      sessionId: string
      overrides: AutoCompactionOverrides
    }): Promise<unknown>
    enterPlanMode(params: { sessionId: string }): Promise<unknown>
    has(sessionId: string): boolean
  }
  history: {
    list(params: { agentDir: string; cwd: string }): Promise<SessionInfo[]>
    open(params: {
      agentDir: string
      path: string
      cwd?: string
    }): Promise<{ cwd?: string; sessionFile?: string }>
    fork(params: {
      path: string
      cwd: string
      userMessages: string[]
      selectedIndex: number
    }): Promise<{ path: string }>
    rename(params: { agentDir: string; path: string; name: string }): Promise<unknown>
  }
  events: {
    onSessionEvent(sessionId: string, listener: (event: PhiAgentEvent) => void): () => void
    onSessionState(sessionId: string, listener: (state: unknown) => void): () => void
    onToolApproval(sessionId: string, listener: (request: unknown) => void): () => void
    respondToolApproval(requestId: string, result: unknown): Promise<void>
  }
  models: {
    snapshot(params: { agentDir: string }): Promise<RuntimeSnapshot>
    login(params: {
      agentDir: string
      providerId: string
      type: 'api_key' | 'oauth'
      key: string | undefined
    }): Promise<RuntimeSnapshot>
    logout(params: { agentDir: string; providerId: string }): Promise<RuntimeSnapshot>
    onAuthPrompt(
      listener: (request: { requestId: string; providerId: string; prompt: unknown }) => void
    ): () => void
    onAuthNotify(listener: (request: { providerId: string; event: unknown }) => void): () => void
    respondAuthPrompt(requestId: string, value: string): Promise<void>
    rejectAuthPrompt(requestId: string, error: unknown): Promise<void>
  }
  resources: {
    reload(params: Record<string, unknown>): Promise<RuntimeResourceBundle>
  }
  mcp: {
    configuredStdioTools(params: unknown): Promise<string[]>
    cancelConfiguredStdioTools(params: { requestKey: string }): Promise<unknown>
    featuredTools(params: { id: string; url: string; auth: unknown }): Promise<string[]>
    syncFeaturedApiKeys(params: { id: string }): Promise<unknown>
    applyConnectorEnabled(params: { name: string }): Promise<unknown>
    prepareRemoteAuth(params: {
      name: string
      attemptId: string
    }): Promise<{ serverUrl?: unknown; authorizationUrl?: unknown }>
    cancelRemoteAuth(params: { name: string; attemptId: string }): Promise<unknown>
    authorizeRemote(params: {
      name: string
      attemptId: string
      serverUrl: string
    }): Promise<unknown>
    featuredAuthStatus(params: { id: string; url: string }): Promise<boolean>
    cancelFeaturedAuth(params: { id: string }): Promise<unknown>
    authorizeFeatured(params: { id: string; url: string }): Promise<unknown>
  }
  memory: {
    read(params: {
      agentDir: string
      cwd: string
    }): Promise<Omit<ProjectMemorySnapshot, 'projectId' | 'settings'>>
    deleteLesson(params: {
      agentDir: string
      cwd: string
      index: unknown
      text: unknown
    }): Promise<unknown>
    clear(params: { agentDir: string; cwd: string }): Promise<unknown>
  }
  settings: {
    autoCompactionDefaults(params: {
      cwd: string
      agentDir: string
    }): Promise<AutoCompactionDefaults>
    webSearch: {
      get(params: { agentDir: string }): Promise<unknown>
      update(params: { agentDir: string; patch: unknown }): Promise<unknown>
      searxngEngines(params: { agentDir: string }): Promise<unknown>
      setApiKey(params: { agentDir: string; providerId: unknown; key: unknown }): Promise<unknown>
      clearApiKey(params: { agentDir: string; providerId: unknown }): Promise<unknown>
    }
  }
  agentRuns: {
    list(params: Record<string, never>): Promise<unknown>
    steer(params: { sessionId: string; runId: string; message?: string }): Promise<unknown>
    stop(params: { sessionId: string; runId: string }): Promise<unknown>
  }
  shellJobs: {
    list(params: Record<string, never>): Promise<unknown>
    cancel(params: { sessionId: string; jobId: string }): Promise<{ ok?: boolean }>
  }
  host: {
    register(method: string, handler: PhiHostRequestHandler): () => void
  }
  stop(): Promise<void>
}
