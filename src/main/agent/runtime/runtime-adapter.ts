import type { PhiAgentDefinition } from '../agents/definition'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { ProjectLocation } from '../../../shared/projectLocation'
import type {
  AutoCompactionDefaults,
  AutoCompactionOverrides,
  ContextCompactionSummary,
  ContextUsageSnapshot
} from '../../../shared/contextUsageTypes'
import { getOmpBridge, type OmpBridge } from '../omp/omp-bridge'
import { listBundledPlugins } from '../plugins/bundled'
import {
  getAdditionalProjectResourcePaths,
  getKnownProjectResourceBaseDir,
  getPhiAgentDir,
  type ProjectResourceName
} from '../runtime-paths'

export const AGENT_RUNTIME_ID = 'omp-sdk'
export const AGENT_RUNTIME_PACKAGE = '@oh-my-pi/pi-coding-agent'
const nodeRequire = createRequire(import.meta.url)

export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
export type RuntimeAuthSource =
  'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command'

export type AuthPrompt =
  | {
      type: 'text'
      message: string
      placeholder?: string
      signal?: AbortSignal
    }
  | {
      type: 'secret'
      message: string
      placeholder?: string
      signal?: AbortSignal
    }
  | {
      type: 'select'
      message: string
      options: ReadonlyArray<{ id: string; label: string; description?: string }>
      signal?: AbortSignal
    }
  | {
      type: 'manual_code'
      message: string
      placeholder?: string
      signal?: AbortSignal
    }

export type AuthEvent =
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

export type AuthInteraction = {
  signal?: AbortSignal
  prompt(prompt: AuthPrompt): Promise<string>
  notify(event: AuthEvent): void
}

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

export interface ModelRuntime {
  getProviders(): RuntimeProvider[]
  getModels(): RuntimeModel[]
  getModel(providerId: string, modelId: string): RuntimeModel | undefined
  getProviderAuthStatus(providerId: string): RuntimeProviderAuthStatus
  listCredentials(): Promise<RuntimeCredential[]>
  login(providerId: string, type: 'api_key' | 'oauth', interaction: AuthInteraction): Promise<void>
  logout(providerId: string): Promise<void>
}

export type AgentSessionEvent = { type: string } & Record<string, unknown>
export type RuntimePromptOptions = {
  preflightResult?: (accepted: boolean) => void
  images?: Array<{ type: 'image'; data: string; mimeType: string }>
  expandPromptTemplates?: boolean
  synthetic?: boolean
  userInitiated?: boolean
  skipCompactionCheck?: boolean
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

type ToolCallEvent = {
  type?: 'tool_call'
  toolCallId?: string
  toolName: string
  input: Record<string, unknown>
  agentRunId?: string
}

type ToolCallContext = {
  signal?: AbortSignal
}

type ToolCallHandler = (
  event: ToolCallEvent,
  context: ToolCallContext
) => Promise<unknown> | unknown

type ExtensionApiLike = {
  on(eventName: string, handler: ToolCallHandler | ((...args: unknown[]) => unknown)): void
}

export type InlineExtension =
  | {
      name?: string
      hidden?: boolean
      factory(api: ExtensionApiLike): void | Promise<void>
    }
  | ((api: ExtensionApiLike) => void | Promise<void>)

type RuntimeResourceBundle = {
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

export type RuntimeSettingsManager = {
  cwd?: string
  agentDir?: string
  projectTrusted?: boolean
}

export type ResourceLoaderOptions = {
  cwd: string
  agentDir?: string
  settingsManager?: RuntimeSettingsManager
  additionalExtensionPaths?: string[]
  additionalSkillPaths?: string[]
  additionalPromptTemplatePaths?: string[]
  additionalThemePaths?: string[]
  extensionFactories?: InlineExtension[]
  noExtensions?: boolean
  noSkills?: boolean
  noPromptTemplates?: boolean
  noThemes?: boolean
  noContextFiles?: boolean
  systemPrompt?: string
  appendSystemPrompt?: string | string[]
  skillsOverride?: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
    skills: Skill[]
    diagnostics: ResourceDiagnostic[]
  }
}

export type RuntimeSessionManagerKind = 'persistent' | 'memory' | 'open'

export interface RuntimeSessionManager {
  kind: RuntimeSessionManagerKind
  cwd: string
  path?: string
  getCwd(): string
  getSessionFile(): string | undefined
  appendSessionInfo(name: string): void
  setSessionName(name: string, source?: 'user' | 'auto'): Promise<boolean>
}

export interface RuntimeResourceLoader {
  readonly __phiResourceLoader: true
  readonly options: ResourceLoaderOptions
  reload(): Promise<void>
  getExtensions(): unknown
  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] }
  getPrompts(): unknown
  getThemes(): unknown
  getAgentsFiles(): unknown
  getSystemPrompt(): string | undefined
  getAppendSystemPrompt(): string[]
  getToolCallHandlers(): Promise<ToolCallHandler[]>
}

export interface RuntimeAgentSession {
  readonly runtimeSessionId: string
  readonly sessionManager: RuntimeSessionManager
  messages: unknown[]
  sessionFile?: string
  model?: RuntimeModel
  thinkingLevel?: ThinkingLevel
  subscribe(listener: (event: AgentSessionEvent) => void): () => void
  prompt(text: string, options?: RuntimePromptOptions): Promise<void>
  getContextUsage(): Promise<ContextUsageSnapshot | null>
  compact(): Promise<ContextCompactionSummary>
  setAutoCompactionSettings(overrides: AutoCompactionOverrides): Promise<void>
  abort(): Promise<void>
  dispose(): Promise<void>
  setModel(model: RuntimeModel): Promise<void>
  setThinkingLevel(level: ThinkingLevel | undefined): void
}

export interface CreateAgentSessionResult {
  session: RuntimeAgentSession
  extensionsResult?: unknown
  setToolUIContext?: (...args: unknown[]) => void
  mcpManager?: unknown
  modelFallbackMessage?: string
  lspServers?: unknown[]
  startBackgroundModelDiscovery?: () => Promise<void>
  eventBus?: unknown
}

export type CreateAgentSessionOptions = {
  cwd?: string
  agentDir?: string
  modelRuntime?: ModelRuntime
  model?: RuntimeModel
  thinkingLevel?: ThinkingLevel
  autoCompaction?: AutoCompactionOverrides
  noTools?: 'all' | boolean
  sessionManager?: RuntimeSessionManager
  resourceLoader?: RuntimeResourceLoader
  /** Phi agents scanned by the main process; the worker exposes each as a delegation tool. */
  phiAgents?: PhiAgentDefinition[]
  /** Restrict explicit file paths in project sessions to the selected project. */
  projectBound?: boolean
  remoteProject?: {
    phiSessionId: string
    projectId: string
    location: Extract<ProjectLocation, { kind: 'ssh' }>
    contextFiles: Array<{ path: string; content: string }>
  }
  /** Phi-managed user persona, injected explicitly into the main system prompt. */
  personaMarkdown?: string
}

type RuntimeSnapshot = {
  providers: Array<RuntimeProvider & { status?: RuntimeProviderAuthStatus }>
  models: RuntimeModel[]
  credentials: RuntimeCredential[]
}

type WorkerSessionState = {
  sessionFile?: string
  messages?: unknown[]
  model?: RuntimeModel
  thinkingLevel?: ThinkingLevel
  cwd?: string
}

type WorkerCreateSessionResult = {
  sessionId: string
  state: WorkerSessionState
}

type ToolApprovalRequest = {
  requestId: string
  toolCallId?: string
  toolName?: string
  input?: Record<string, unknown>
  agentRunId?: string
}

function dedupePaths(paths: string[]): string[] {
  return [...new Set(paths)]
}

function firstExistingPath(paths: string[]): string {
  const candidates = dedupePaths(paths)
  return candidates.find((path) => existsSync(path)) ?? candidates[0]
}

function resourceDirCandidates(resourceName: string, appPath?: string): string[] {
  const candidates: string[] = []

  if (appPath) {
    let current = resolve(appPath)
    for (let depth = 0; depth < 4; depth += 1) {
      candidates.push(join(current, 'resources', resourceName))
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
  }

  candidates.push(join(process.cwd(), 'resources', resourceName))
  return candidates
}

export function getBundledResourceDir(resourceName: string): string {
  const electronModule = nodeRequire('electron') as
    | {
        app?: {
          isPackaged: boolean
          getAppPath(): string
        }
      }
    | string
  const electronApp = typeof electronModule === 'object' ? electronModule.app : undefined
  if (!electronApp) return firstExistingPath(resourceDirCandidates(resourceName))

  if (!electronApp.isPackaged) {
    return firstExistingPath(resourceDirCandidates(resourceName, electronApp.getAppPath()))
  }

  return firstExistingPath([
    join(process.resourcesPath, 'app.asar.unpacked', 'resources', resourceName),
    ...resourceDirCandidates(resourceName, electronApp.getAppPath())
  ])
}

export function getBundledSkillsDir(): string {
  return getBundledResourceDir('skills')
}

/** Phi's own bundled agent definitions (`resources/agents`). */
export function getBundledAgentsDir(): string {
  return getBundledResourceDir('agents')
}

function pathIsInside(path: string, root: string): boolean {
  const relativePath = relative(resolve(root), resolve(path))
  return (
    relativePath === '' ||
    (!!relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath))
  )
}

function bundledSkillDirectories(): string[] {
  const directories = [getBundledSkillsDir()]
  for (const plugin of listBundledPlugins()) {
    if (plugin.skillsDir) directories.push(plugin.skillsDir)
  }
  return directories
}

function appendExistingBundledSkillPaths(paths: string[] | undefined): string[] | undefined {
  const bundledPaths = bundledSkillDirectories().filter((path) => existsSync(path))
  const merged = dedupePaths([...bundledPaths, ...(paths ?? [])])
  return merged.length > 0 ? merged : paths
}

function appendExistingProjectResourcePaths(
  paths: string[] | undefined,
  cwd: string,
  resourceName: ProjectResourceName
): string[] | undefined {
  const projectPaths = getAdditionalProjectResourcePaths(cwd, resourceName).filter((path) =>
    existsSync(path)
  )
  const merged = dedupePaths([...projectPaths, ...(paths ?? [])])
  return merged.length > 0 ? merged : paths
}

function markBundledSystemSkills(options: ResourceLoaderOptions): ResourceLoaderOptions {
  const existingOverride = options.skillsOverride

  return {
    ...options,
    skillsOverride: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
      const resolved = existingOverride ? existingOverride(base) : base
      const bundledRoots = bundledSkillDirectories()

      return {
        ...resolved,
        skills: resolved.skills.map((skill) => {
          const baseDir = bundledRoots.find((root) => pathIsInside(skill.filePath, root))
          if (!baseDir) return skill

          return {
            ...skill,
            sourceInfo: {
              ...skill.sourceInfo,
              path: skill.filePath,
              source: 'bundled',
              scope: 'user',
              origin: 'resources',
              baseDir
            }
          }
        })
      }
    }
  }
}

function markPhiProjectSkills(options: ResourceLoaderOptions): ResourceLoaderOptions {
  const existingOverride = options.skillsOverride

  return {
    ...options,
    skillsOverride: (base: { skills: Skill[]; diagnostics: ResourceDiagnostic[] }) => {
      const resolved = existingOverride ? existingOverride(base) : base

      return {
        ...resolved,
        skills: resolved.skills.map((skill) => {
          const baseDir = getKnownProjectResourceBaseDir(options.cwd, 'skills', skill.filePath)
          if (!baseDir) return skill

          return {
            ...skill,
            sourceInfo: {
              ...skill.sourceInfo,
              path: skill.filePath,
              source: 'local',
              scope: 'project',
              origin: 'top-level',
              baseDir
            }
          }
        })
      }
    }
  }
}

function withPhiProjectResources(options: ResourceLoaderOptions): ResourceLoaderOptions {
  return markPhiProjectSkills(
    markBundledSystemSkills({
      ...options,
      additionalExtensionPaths: appendExistingProjectResourcePaths(
        options.additionalExtensionPaths,
        options.cwd,
        'extensions'
      ),
      additionalPromptTemplatePaths: appendExistingProjectResourcePaths(
        options.additionalPromptTemplatePaths,
        options.cwd,
        'prompts'
      ),
      additionalSkillPaths: appendExistingProjectResourcePaths(
        appendExistingBundledSkillPaths(options.additionalSkillPaths),
        options.cwd,
        'skills'
      ),
      additionalThemePaths: appendExistingProjectResourcePaths(
        options.additionalThemePaths,
        options.cwd,
        'themes'
      )
    })
  )
}

function serializableResourceOptions(options: ResourceLoaderOptions): Record<string, unknown> {
  return {
    cwd: options.cwd,
    agentDir: options.agentDir,
    additionalExtensionPaths: options.additionalExtensionPaths,
    additionalSkillPaths: options.additionalSkillPaths,
    additionalPromptTemplatePaths: options.additionalPromptTemplatePaths,
    additionalThemePaths: options.additionalThemePaths,
    noExtensions: options.noExtensions,
    noSkills: options.noSkills,
    noPromptTemplates: options.noPromptTemplates,
    noThemes: options.noThemes,
    noContextFiles: options.noContextFiles,
    systemPrompt: options.systemPrompt,
    appendSystemPrompt: options.appendSystemPrompt
  }
}

function isRuntimeResourceLoader(value: unknown): value is RuntimeResourceLoader {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __phiResourceLoader?: unknown }).__phiResourceLoader === true
  )
}

function applySessionState(session: RuntimeAgentSessionProxy, state: WorkerSessionState): void {
  session.sessionFile = state.sessionFile
  session.messages = Array.isArray(state.messages) ? state.messages : session.messages
  session.model = state.model
  session.thinkingLevel = state.thinkingLevel
  if (state.cwd) {
    session.sessionManager.cwd = state.cwd
  }
}

function runtimePromptOptionsForWorker(
  options: RuntimePromptOptions | undefined
): Record<string, unknown> | undefined {
  if (!options) return undefined
  const promptOptions = {
    ...(options.images?.length ? { images: options.images } : {}),
    ...(typeof options.expandPromptTemplates === 'boolean'
      ? { expandPromptTemplates: options.expandPromptTemplates }
      : {}),
    ...(typeof options.synthetic === 'boolean' ? { synthetic: options.synthetic } : {}),
    ...(typeof options.userInitiated === 'boolean' ? { userInitiated: options.userInitiated } : {}),
    ...(typeof options.skipCompactionCheck === 'boolean'
      ? { skipCompactionCheck: options.skipCompactionCheck }
      : {})
  }
  return Object.keys(promptOptions).length > 0 ? promptOptions : undefined
}

class OmpModelRuntimeFacade implements ModelRuntime {
  private providers: RuntimeSnapshot['providers']
  private models: RuntimeModel[]
  private credentials: RuntimeCredential[]

  constructor(
    private readonly bridge: OmpBridge,
    private readonly agentDir: string,
    snapshot: RuntimeSnapshot
  ) {
    this.providers = snapshot.providers
    this.models = snapshot.models
    this.credentials = snapshot.credentials
  }

  static async create(agentDir = getPhiAgentDir()): Promise<OmpModelRuntimeFacade> {
    const bridge = getOmpBridge()
    const snapshot = await bridge.request<RuntimeSnapshot>('modelRuntime.snapshot', { agentDir })
    return new OmpModelRuntimeFacade(bridge, agentDir, snapshot)
  }

  getProviders(): RuntimeProvider[] {
    return this.providers
  }

  getModels(): RuntimeModel[] {
    return this.models
  }

  getModel(providerId: string, modelId: string): RuntimeModel | undefined {
    return this.models.find((model) => model.provider === providerId && model.id === modelId)
  }

  getProviderAuthStatus(providerId: string): RuntimeProviderAuthStatus {
    return (
      this.providers.find((provider) => provider.id === providerId)?.status ?? {
        configured: false
      }
    )
  }

  async listCredentials(): Promise<RuntimeCredential[]> {
    return this.credentials
  }

  async login(
    providerId: string,
    type: 'api_key' | 'oauth',
    interaction: AuthInteraction
  ): Promise<void> {
    const cleanups: Array<() => void> = []
    cleanups.push(
      this.bridge.onAuthNotify(({ providerId: notifiedProviderId, event }) => {
        if (notifiedProviderId !== providerId) return
        interaction.notify(event as AuthEvent)
      })
    )
    cleanups.push(
      this.bridge.onAuthPrompt(({ providerId: promptProviderId, requestId, prompt }) => {
        if (promptProviderId !== providerId) return
        void interaction
          .prompt(prompt as AuthPrompt)
          .then((value) => this.bridge.sendAuthPromptResult(requestId, value))
          .catch((error: unknown) => this.bridge.sendAuthPromptError(requestId, error))
      })
    )

    try {
      const key =
        type === 'api_key' ? await interaction.prompt({ type: 'secret', message: '' }) : undefined
      const snapshot = await this.bridge.request<RuntimeSnapshot>('modelRuntime.login', {
        agentDir: this.agentDir,
        providerId,
        type,
        key
      })
      this.update(snapshot)
    } finally {
      cleanups.forEach((cleanup) => cleanup())
    }
  }

  async logout(providerId: string): Promise<void> {
    const snapshot = await this.bridge.request<RuntimeSnapshot>('modelRuntime.logout', {
      agentDir: this.agentDir,
      providerId
    })
    this.update(snapshot)
  }

  private update(snapshot: RuntimeSnapshot): void {
    this.providers = snapshot.providers
    this.models = snapshot.models
    this.credentials = snapshot.credentials
  }
}

class RuntimeResourceLoaderProxy implements RuntimeResourceLoader {
  readonly __phiResourceLoader = true
  readonly options: ResourceLoaderOptions
  private readonly bridge = getOmpBridge()
  private bundle: RuntimeResourceBundle = {
    skills: {
      skills: [],
      diagnostics: []
    }
  }
  private handlerPromise: Promise<ToolCallHandler[]> | null = null

  constructor(options: ResourceLoaderOptions) {
    this.options = withPhiProjectResources(options)
  }

  async reload(): Promise<void> {
    const bundle = await this.bridge.request<RuntimeResourceBundle>(
      'resources.reload',
      serializableResourceOptions(this.options)
    )
    this.bundle = {
      ...bundle,
      skills: this.options.skillsOverride
        ? this.options.skillsOverride(bundle.skills)
        : bundle.skills
    }
  }

  getExtensions(): unknown {
    return this.bundle.extensions
  }

  getSkills(): { skills: Skill[]; diagnostics: ResourceDiagnostic[] } {
    return this.bundle.skills
  }

  getPrompts(): unknown {
    return this.bundle.prompts
  }

  getThemes(): unknown {
    return this.bundle.themes
  }

  getAgentsFiles(): unknown {
    return this.bundle.agentsFiles
  }

  getSystemPrompt(): string | undefined {
    return this.bundle.systemPrompt
  }

  getAppendSystemPrompt(): string[] {
    return this.bundle.appendSystemPrompt ?? []
  }

  async getToolCallHandlers(): Promise<ToolCallHandler[]> {
    this.handlerPromise ??= collectToolCallHandlers(this.options.extensionFactories)
    return this.handlerPromise
  }
}

class RuntimeSessionManagerProxy implements RuntimeSessionManager {
  constructor(
    public kind: RuntimeSessionManagerKind,
    public cwd: string,
    public path?: string
  ) {}

  getCwd(): string {
    return this.cwd
  }

  getSessionFile(): string | undefined {
    return this.path
  }

  appendSessionInfo(name: string): void {
    void this.setSessionName(name)
  }

  async setSessionName(name: string): Promise<boolean> {
    if (!this.path) return false
    await getOmpBridge().request('sessions.rename', {
      agentDir: getPhiAgentDir(),
      path: this.path,
      name
    })
    return true
  }
}

class ActiveRuntimeSessionManagerProxy extends RuntimeSessionManagerProxy {
  constructor(
    base: RuntimeSessionManager,
    private readonly bridge: OmpBridge,
    private readonly sessionId: string
  ) {
    super(base.kind, base.cwd, base.path)
  }

  override appendSessionInfo(name: string): void {
    void this.setSessionName(name)
  }

  override async setSessionName(name: string): Promise<boolean> {
    const state = await this.bridge.request<WorkerSessionState>('session.rename', {
      sessionId: this.sessionId,
      name
    })
    this.path = state.sessionFile ?? this.path
    if (state.cwd) this.cwd = state.cwd
    return true
  }
}

class RuntimeAgentSessionProxy implements RuntimeAgentSession {
  readonly runtimeSessionId: string
  messages: unknown[] = []
  sessionFile?: string
  model?: RuntimeModel
  thinkingLevel?: ThinkingLevel
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>()
  private readonly cleanupFns: Array<() => void> = []
  private readonly approvalAbortController = new AbortController()
  private recovery: Promise<void> | null = null
  readonly sessionManager: RuntimeSessionManager

  constructor(
    private readonly bridge: OmpBridge,
    private readonly sessionId: string,
    sessionManager: RuntimeSessionManager,
    state: WorkerSessionState,
    private readonly toolCallHandlers: ToolCallHandler[],
    private readonly recreate?: (current: RuntimeAgentSessionProxy) => Promise<WorkerSessionState>
  ) {
    this.runtimeSessionId = sessionId
    this.sessionManager = new ActiveRuntimeSessionManagerProxy(sessionManager, bridge, sessionId)
    applySessionState(this, state)
    this.cleanupFns.push(
      bridge.onSessionEvent(sessionId, (event) => {
        for (const listener of this.listeners) {
          listener(event as AgentSessionEvent)
        }
      })
    )
    this.cleanupFns.push(
      bridge.onSessionState(sessionId, (nextState) => {
        applySessionState(this, nextState as WorkerSessionState)
      })
    )
    this.cleanupFns.push(
      bridge.onSessionToolApproval(sessionId, (request) => {
        void this.resolveToolApproval(request as ToolApprovalRequest)
      })
    )
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Sessions live only in the worker's memory. If the worker exited since this session
   * was created (crash, idle stop), rebuild it in the new worker under the same id —
   * resuming from the session file — instead of failing every later call with
   * "Unknown session".
   */
  private async ensureLive(): Promise<void> {
    if (!this.recreate || this.bridge.hasSession(this.sessionId)) return
    this.recovery ??= this.recreate(this)
      .then((state) => applySessionState(this, state))
      .finally(() => {
        this.recovery = null
      })
    await this.recovery
  }

  async prompt(text: string, options?: RuntimePromptOptions): Promise<void> {
    await this.ensureLive()
    options?.preflightResult?.(true)
    const state = await this.bridge.request<WorkerSessionState>('session.prompt', {
      sessionId: this.sessionId,
      text,
      options: runtimePromptOptionsForWorker(options)
    })
    applySessionState(this, state)
  }

  async getContextUsage(): Promise<ContextUsageSnapshot | null> {
    await this.ensureLive()
    return this.bridge.request<ContextUsageSnapshot | null>('session.contextUsage', {
      sessionId: this.sessionId
    })
  }

  async compact(): Promise<ContextCompactionSummary> {
    await this.ensureLive()
    const result = await this.bridge.request<{
      summary: ContextCompactionSummary
      state: WorkerSessionState
    }>('session.compact', { sessionId: this.sessionId })
    applySessionState(this, result.state)
    return result.summary
  }

  async setAutoCompactionSettings(overrides: AutoCompactionOverrides): Promise<void> {
    await this.ensureLive()
    await this.bridge.request('session.setAutoCompactionSettings', {
      sessionId: this.sessionId,
      overrides
    })
  }

  async abort(): Promise<void> {
    this.approvalAbortController.abort()
    // A session the worker no longer holds has nothing running to abort.
    if (this.recreate && !this.bridge.hasSession(this.sessionId)) return
    const state = await this.bridge.request<WorkerSessionState>('session.abort', {
      sessionId: this.sessionId
    })
    applySessionState(this, state)
  }

  async dispose(): Promise<void> {
    this.approvalAbortController.abort()
    for (const cleanup of this.cleanupFns.splice(0)) {
      cleanup()
    }
    if (this.recreate && !this.bridge.hasSession(this.sessionId)) return
    await this.bridge.request('session.dispose', {
      sessionId: this.sessionId
    })
  }

  async setModel(model: RuntimeModel): Promise<void> {
    await this.ensureLive()
    const state = await this.bridge.request<WorkerSessionState>('session.setModel', {
      sessionId: this.sessionId,
      agentDir: getPhiAgentDir(),
      model
    })
    applySessionState(this, state)
  }

  setThinkingLevel(level: ThinkingLevel | undefined): void {
    this.thinkingLevel = level
    void this.ensureLive()
      .then(() =>
        this.bridge.request<WorkerSessionState>('session.setThinkingLevel', {
          sessionId: this.sessionId,
          level
        })
      )
      .then((state) => applySessionState(this, state))
      .catch(() => undefined)
  }

  private async resolveToolApproval(request: ToolApprovalRequest): Promise<void> {
    const event: ToolCallEvent = {
      type: 'tool_call',
      toolCallId: request.toolCallId ?? request.requestId,
      toolName: request.toolName ?? '',
      input: request.input ?? {},
      ...(request.agentRunId ? { agentRunId: request.agentRunId } : {})
    }
    const context: ToolCallContext = {
      signal: this.approvalAbortController.signal
    }

    let result: unknown
    try {
      for (const handler of this.toolCallHandlers) {
        const next = await handler(event, context)
        if (next !== undefined) {
          result = next
        }
      }
    } catch (error) {
      result = {
        block: true,
        reason: error instanceof Error ? error.message : String(error)
      }
    }

    await this.bridge.sendToolApprovalResult(request.requestId, result)
  }
}

async function collectToolCallHandlers(
  extensionFactories: InlineExtension[] | undefined
): Promise<ToolCallHandler[]> {
  const handlers: ToolCallHandler[] = []
  if (!extensionFactories) return handlers

  const api: ExtensionApiLike = {
    on(eventName: string, handler: (...args: unknown[]) => unknown): void {
      if (eventName === 'tool_call') {
        handlers.push(handler as ToolCallHandler)
      }
    }
  }

  for (const extension of extensionFactories) {
    const factory = typeof extension === 'function' ? extension : extension.factory
    await factory(api)
  }

  return handlers
}

export function createModelRuntime(agentDir = getPhiAgentDir()): Promise<ModelRuntime> {
  return OmpModelRuntimeFacade.create(agentDir)
}

export function readAutoCompactionDefaults(
  cwd: string,
  agentDir = getPhiAgentDir()
): Promise<AutoCompactionDefaults> {
  return getOmpBridge().request('settings.autoCompactionDefaults', { cwd, agentDir })
}

export async function createRuntimeAgentSession(
  options: CreateAgentSessionOptions = {}
): Promise<CreateAgentSessionResult> {
  const cwd = options.cwd ?? process.cwd()
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const bridge = getOmpBridge()
  const resourceLoader = isRuntimeResourceLoader(options.resourceLoader)
    ? options.resourceLoader
    : undefined
  const toolCallHandlers = resourceLoader ? await resourceLoader.getToolCallHandlers() : []
  const sessionManager = options.sessionManager ?? createRuntimeSessionManager(cwd)
  const sessionId = randomUUID()
  const createParams = {
    sessionId,
    cwd,
    agentDir,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    autoCompaction: options.autoCompaction,
    noTools: options.noTools,
    sessionManager: {
      kind: sessionManager.kind,
      cwd: sessionManager.cwd,
      path: sessionManager.path
    },
    resourceOptions: resourceLoader
      ? serializableResourceOptions(resourceLoader.options)
      : undefined,
    enableToolApproval: toolCallHandlers.length > 0,
    phiAgents: options.phiAgents,
    projectBound: options.projectBound,
    remoteProject: options.remoteProject,
    personaMarkdown: options.personaMarkdown
  }
  const created = await bridge.request<WorkerCreateSessionResult>('session.create', createParams)
  // Same params with the session's current model/thinking level, reopening its file when
  // one exists so the conversation carries over into a replacement worker.
  const recreate = async (current: RuntimeAgentSession): Promise<WorkerSessionState> => {
    const file = current.sessionFile
    const resumable = sessionManager.kind !== 'memory' && file && existsSync(file)
    const result = await bridge.request<WorkerCreateSessionResult>('session.create', {
      ...createParams,
      model: current.model ?? createParams.model,
      thinkingLevel: current.thinkingLevel ?? createParams.thinkingLevel,
      sessionManager: resumable
        ? { kind: 'open', cwd: current.sessionManager.getCwd(), path: file }
        : createParams.sessionManager
    })
    return result.state
  }
  const session = new RuntimeAgentSessionProxy(
    bridge,
    created.sessionId,
    sessionManager,
    created.state,
    toolCallHandlers,
    recreate
  )

  return {
    session,
    setToolUIContext: () => undefined
  }
}

export function createRuntimeResourceLoader(options: ResourceLoaderOptions): RuntimeResourceLoader {
  return new RuntimeResourceLoaderProxy(options)
}

export function createRuntimeSettingsManager(
  cwd?: string,
  agentDir?: string,
  options?: { projectTrusted?: boolean }
): RuntimeSettingsManager {
  return {
    cwd,
    agentDir,
    projectTrusted: options?.projectTrusted
  }
}

export function createRuntimeSessionManager(cwd: string): RuntimeSessionManager {
  return new RuntimeSessionManagerProxy('persistent', cwd)
}

export function createInMemoryRuntimeSessionManager(cwd: string): RuntimeSessionManager {
  return new RuntimeSessionManagerProxy('memory', cwd)
}

export async function openRuntimeSessionManager(
  path: string,
  cwd?: string
): Promise<RuntimeSessionManager> {
  const result = await getOmpBridge().request<{ cwd?: string; sessionFile?: string }>(
    'sessions.open',
    {
      agentDir: getPhiAgentDir(),
      path,
      cwd
    }
  )
  return new RuntimeSessionManagerProxy(
    'open',
    result.cwd ?? cwd ?? process.cwd(),
    result.sessionFile ?? path
  )
}

export async function listRuntimeSessions(cwd: string): Promise<SessionInfo[]> {
  const infos = await getOmpBridge().request<SessionInfo[]>('sessions.list', {
    agentDir: getPhiAgentDir(),
    cwd
  })
  return infos.map((info) => ({
    ...info,
    created: new Date(info.created),
    modified: new Date(info.modified),
    name: info.name ?? info.title
  }))
}

export async function listRuntimePlugins(cwd: string): Promise<
  Array<{
    name: string
    version?: string
    path?: string
    enabled?: boolean
    manifest?: {
      description?: string
      name?: string
    }
  }>
> {
  return getOmpBridge().request('plugins.list', {
    agentDir: getPhiAgentDir(),
    cwd
  })
}

export async function installRuntimePlugin(cwd: string, source: string): Promise<void> {
  await getOmpBridge().request('plugins.install', {
    agentDir: getPhiAgentDir(),
    cwd,
    source
  })
}

export async function removeRuntimePlugin(cwd: string, source: string): Promise<void> {
  await getOmpBridge().request('plugins.uninstall', {
    agentDir: getPhiAgentDir(),
    cwd,
    name: source.replace(/^npm:/, '').replace(/^git:/, '').trim()
  })
}
