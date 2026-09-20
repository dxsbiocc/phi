import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import {
  ModelRegistry,
  SessionManager,
  Settings,
  discoverAuthStorage,
  type CreateAgentSessionResult,
  type ExtensionFactory
} from '@oh-my-pi/pi-coding-agent'
import {
  DefaultResourceLoader,
  SettingsManager,
  createAgentSession as createLegacyAgentSession,
  type DefaultResourceLoaderOptions,
  type ResourceDiagnostic
} from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim'
import { PluginManager } from '@oh-my-pi/pi-coding-agent/extensibility/plugins/manager'
import type { InstalledPlugin } from '@oh-my-pi/pi-coding-agent/extensibility/plugins/types'
import type { AuthStorage, CredentialOrigin, StoredAuthCredential } from '@oh-my-pi/pi-ai'
import type { Model } from '@oh-my-pi/pi-ai/types'
import {
  parseConfiguredThinkingLevel,
  type ConfiguredThinkingLevel
} from '@oh-my-pi/pi-coding-agent/thinking'
import { authPolicyFor } from '@oh-my-pi/pi-catalog/compat/auth'
import { getCatalogProviderEntry } from '@oh-my-pi/pi-catalog/provider-models/descriptors'
import { buildDefaultDbCustomTools, isDbConnectorRuntimeEnabled } from '../db/tools'
import { buildLibraryCustomTools } from '../library/library-tools'
import { buildNotebookCustomTools } from '../notebook/notebook-tools'
import { readRuntimeSessionMessagesText } from '../runtime/runtime-session-text'
import { buildAskUserQuestionCustomTools } from '../user-interaction-tools'
import { isPhiAgentDefinition, type PhiAgentDefinition } from '../agents/definition'
import { createAgentRunner, type AgentSessionLike } from '../agents/runner'
import { resolveAgentTools } from '../agents/tool-resolution'
import { buildAgentTool } from '../agents/tool'
import { createHostJobClient } from '../wrappers/composition/job-host-client'
import { buildWrapperCompositionTools } from '../wrappers/composition/tools'

type UnknownRecord = Record<string, unknown>
type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
type ProjectResourceName = 'extensions' | 'prompts' | 'skills' | 'themes'
type SerializableResourceOptions = Omit<
  DefaultResourceLoaderOptions,
  | 'settingsManager'
  | 'eventBus'
  | 'extensionFactories'
  | 'extensionsOverride'
  | 'skillsOverride'
  | 'promptsOverride'
  | 'themesOverride'
  | 'agentsFilesOverride'
  | 'systemPromptOverride'
  | 'appendSystemPromptOverride'
>

type RuntimeContext = {
  agentDir: string
  authStorage: AuthStorage
  modelRegistry: ModelRegistry
}

type SessionEntry = {
  result: CreateAgentSessionResult
}

type WorkerPromptOptions = {
  expandPromptTemplates?: boolean
  synthetic?: boolean
  userInitiated?: boolean
  skipCompactionCheck?: boolean
}

type IncomingRequest = {
  id: string
  method: string
  params?: unknown
}

type HostResponse =
  | {
      type: 'hostResponse'
      id: string
      ok: true
      result?: unknown
    }
  | {
      type: 'hostResponse'
      id: string
      ok: false
      error: string
      stack?: string
    }

type RuntimeModelSummary = {
  provider: string
  id: string
  name: string
  reasoning: boolean
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
}

const THINKING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const PHI_PROJECT_CONFIG_DIR_NAME = '.phi'
const CURRENT_SDK_PROJECT_CONFIG_DIR_NAME = '.omp'
const LEGACY_PROJECT_CONFIG_DIR_NAMES = ['.omp', '.pi'] as const
const contexts = new Map<string, Promise<RuntimeContext>>()
const sessions = new Map<string, SessionEntry>()
const pendingHostRequests = new Map<
  string,
  {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
  }
>()
const pendingToolApprovals = new Map<string, (result: unknown) => void>()
const pendingAuthPrompts = new Map<
  string,
  {
    resolve: (value: string) => void
    reject: (error: Error) => void
  }
>()

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function stringArrayValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string')
  return strings.length > 0 ? strings : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function getAdditionalProjectResourcePaths(
  cwd: string,
  resourceName: ProjectResourceName,
  runtimeProjectConfigDir = CURRENT_SDK_PROJECT_CONFIG_DIR_NAME
): string[] {
  const configDirs = [PHI_PROJECT_CONFIG_DIR_NAME, ...LEGACY_PROJECT_CONFIG_DIR_NAMES].filter(
    (dir, index, dirs) => dir !== runtimeProjectConfigDir && dirs.indexOf(dir) === index
  )

  return configDirs.map((dir) => join(cwd, dir, resourceName))
}

function getKnownProjectResourceBaseDir(
  cwd: string,
  resourceName: ProjectResourceName,
  filePath: string
): string | undefined {
  const configDirs = [PHI_PROJECT_CONFIG_DIR_NAME, ...LEGACY_PROJECT_CONFIG_DIR_NAMES]
  const normalizedFile = resolve(filePath)

  for (const dir of configDirs) {
    const baseDir = resolve(cwd, dir, resourceName)
    const relativePath = relative(baseDir, normalizedFile)
    if (relativePath && !relativePath.startsWith('..') && !isAbsolute(relativePath)) {
      return baseDir
    }
  }

  return undefined
}

function toJsonSafe(value: unknown): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString()
      if (typeof item === 'function') return undefined
      return item
    })
  )
}

function send(value: unknown): void {
  process.stdout.write(`${JSON.stringify(toJsonSafe(value))}\n`)
}

function sendEvent(event: string, payload: unknown, extra: UnknownRecord = {}): void {
  send({
    type: 'event',
    event,
    payload,
    ...extra
  })
}

function isHostResponse(value: unknown): value is HostResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'hostResponse' &&
    typeof (value as { id?: unknown }).id === 'string' &&
    typeof (value as { ok?: unknown }).ok === 'boolean'
  )
}

function requestHost(method: string, params: unknown): Promise<unknown> {
  const id = randomUUID()
  send({
    type: 'hostRequest',
    id,
    method,
    params
  })
  return new Promise<unknown>((resolve, reject) => {
    pendingHostRequests.set(id, { resolve, reject })
  })
}

function handleHostResponse(response: HostResponse): void {
  const pending = pendingHostRequests.get(response.id)
  if (!pending) return
  pendingHostRequests.delete(response.id)
  if (response.ok) {
    pending.resolve(response.result)
  } else {
    const error = new Error(response.error)
    if (response.stack) error.stack = response.stack
    pending.reject(error)
  }
}

async function getContext(agentDirParam?: unknown): Promise<RuntimeContext> {
  const agentDir = stringValue(agentDirParam, process.env.PI_CODING_AGENT_DIR)
  const key = agentDir || '__default__'
  const existing = contexts.get(key)
  if (existing) return existing

  const promise = (async (): Promise<RuntimeContext> => {
    if (agentDir) process.env.PI_CODING_AGENT_DIR = agentDir
    const authStorage = await discoverAuthStorage(agentDir || undefined)
    const modelRegistry = new ModelRegistry(authStorage)
    await modelRegistry.hydrateCredentialScopedModelCaches().catch(() => undefined)
    return { agentDir, authStorage, modelRegistry }
  })()
  contexts.set(key, promise)
  return promise
}

function serializeThinkingMap(
  model: Model
): Partial<Record<ThinkingLevel, string | null>> | undefined {
  const thinking = model.thinking as { efforts?: unknown } | undefined
  const efforts = stringArrayValue(thinking?.efforts)
  if (!efforts) return undefined

  return Object.fromEntries(
    THINKING_LEVELS.map((level) => [level, efforts.includes(level) ? level : null])
  ) as Partial<Record<ThinkingLevel, string | null>>
}

function serializeModel(model: Model): RuntimeModelSummary {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    ...(serializeThinkingMap(model) ? { thinkingLevelMap: serializeThinkingMap(model) } : {})
  }
}

function normalizeCredentialOrigin(
  origin: CredentialOrigin | undefined
):
  | 'stored'
  | 'runtime'
  | 'environment'
  | 'fallback'
  | 'models_json_key'
  | 'models_json_command'
  | undefined {
  if (!origin) return undefined
  if (origin.kind === 'config') return 'models_json_key'
  if (origin.kind === 'runtime') return 'runtime'
  if (origin.kind === 'env') return 'environment'
  if (origin.kind === 'oauth' || origin.kind === 'api_key') return 'stored'
  if (origin.kind === 'fallback') return 'fallback'
  return undefined
}

function configuredThinkingLevel(value: unknown): ConfiguredThinkingLevel | undefined {
  return typeof value === 'string' ? parseConfiguredThinkingLevel(value) : undefined
}

function hasOAuth(policy: ReturnType<typeof authPolicyFor>): boolean {
  const kind = policy?.login?.kind
  return kind === 'oauth-code' || kind === 'device-code' || kind === 'custom'
}

function hasApiKey(policy: ReturnType<typeof authPolicyFor>, providerId: string): boolean {
  const entry = getCatalogProviderEntry(providerId) as UnknownRecord | undefined
  const envVars = Array.isArray(entry?.envVars) ? entry.envVars : []
  return policy?.login?.kind === 'api-key' || policy?.result === 'api-key' || envVars.length > 0
}

function providerName(providerId: string): string {
  const policy = authPolicyFor(providerId)
  const catalog = getCatalogProviderEntry(providerId) as UnknownRecord | undefined
  const catalogDiscovery = catalog?.catalogDiscovery
  if (policy?.name) return policy.name
  if (isRecord(catalogDiscovery) && typeof catalogDiscovery.label === 'string') {
    return catalogDiscovery.label
  }
  return providerId
}

async function modelRuntimeSnapshot(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const ctx = await getContext(record.agentDir)
  const models = ctx.modelRegistry.getAll().map(serializeModel)
  const providerIds = [...new Set(models.map((model) => model.provider))].sort()
  const credentials = ctx.authStorage
    .listStoredCredentials()
    .map((credential: StoredAuthCredential) => ({
      id: String(credential.id),
      providerId: credential.provider,
      type: credential.credential.type,
      label:
        credential.credential.type === 'oauth'
          ? (credential.credential.email ?? credential.credential.accountId ?? credential.provider)
          : credential.provider
    }))

  return {
    providers: providerIds.map((id) => {
      const policy = authPolicyFor(id)
      const configured =
        ctx.authStorage.hasAuth(id) ||
        ctx.authStorage.hasConcreteAuth(id) ||
        credentials.some((credential) => credential.providerId === id)

      return {
        id,
        name: providerName(id),
        auth: {
          apiKey: hasApiKey(policy, id),
          oauth: hasOAuth(policy)
        },
        status: {
          configured,
          source: normalizeCredentialOrigin(ctx.authStorage.getCredentialOrigin(id)),
          label: ctx.authStorage.describeCredentialSource(id)
        }
      }
    }),
    models,
    credentials
  }
}

async function loginModelRuntime(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const providerId = stringValue(record.providerId)
  const type = stringValue(record.type)
  const ctx = await getContext(record.agentDir)
  if (!providerId) throw new Error('Missing providerId')

  if (type === 'api_key') {
    const key = stringValue(record.key)
    if (!key) throw new Error('Missing API key')
    await ctx.authStorage.set(providerId, { type: 'api_key', key, source: 'login' })
    await ctx.modelRegistry.refresh('offline').catch(() => undefined)
    return modelRuntimeSnapshot(record)
  }

  if (type !== 'oauth') {
    throw new Error(`Unsupported auth type: ${type}`)
  }

  await ctx.authStorage.login(providerId, {
    signal: undefined,
    onAuth: (info) => {
      sendEvent('authNotify', {
        providerId,
        event: {
          type: 'auth_url',
          url: info.launchUrl ?? info.url,
          instructions: info.instructions
        }
      })
    },
    onProgress: (message) => {
      sendEvent('authNotify', {
        providerId,
        event: {
          type: 'progress',
          message
        }
      })
    },
    onManualCodeInput: () =>
      requestAuthPrompt(providerId, {
        type: 'manual_code',
        message: `输入授权码完成 ${providerId} 登录`
      }),
    onPrompt: (prompt) =>
      requestAuthPrompt(providerId, {
        type: 'text',
        message: prompt.message,
        ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {})
      })
  })
  await ctx.modelRegistry.refresh('offline').catch(() => undefined)
  return modelRuntimeSnapshot(record)
}

async function logoutModelRuntime(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const providerId = stringValue(record.providerId)
  const ctx = await getContext(record.agentDir)
  if (!providerId) throw new Error('Missing providerId')
  await ctx.authStorage.logout(providerId)
  await ctx.modelRegistry.refresh('offline').catch(() => undefined)
  return modelRuntimeSnapshot(record)
}

function requestAuthPrompt(providerId: string, prompt: UnknownRecord): Promise<string> {
  const requestId = randomUUID()
  sendEvent(
    'authPrompt',
    {
      providerId,
      prompt
    },
    { requestId }
  )
  return new Promise<string>((resolve, reject) => {
    pendingAuthPrompts.set(requestId, {
      resolve,
      reject
    })
  })
}

function addExistingProjectResourcePaths(
  cwd: string,
  paths: string[] | undefined,
  resourceName: ProjectResourceName
): string[] | undefined {
  const projectPaths = getAdditionalProjectResourcePaths(cwd, resourceName).filter((path) =>
    existsSync(path)
  )
  const merged = [...new Set([...projectPaths, ...(paths ?? [])])]
  return merged.length > 0 ? merged : paths
}

function resourceOptions(params: unknown): SerializableResourceOptions {
  const record = isRecord(params) ? params : {}
  const cwd = stringValue(record.cwd, process.cwd())
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)

  return {
    cwd,
    agentDir,
    additionalExtensionPaths: addExistingProjectResourcePaths(
      cwd,
      stringArrayValue(record.additionalExtensionPaths),
      'extensions'
    ),
    additionalPromptTemplatePaths: addExistingProjectResourcePaths(
      cwd,
      stringArrayValue(record.additionalPromptTemplatePaths),
      'prompts'
    ),
    additionalSkillPaths: addExistingProjectResourcePaths(
      cwd,
      stringArrayValue(record.additionalSkillPaths),
      'skills'
    ),
    additionalThemePaths: addExistingProjectResourcePaths(
      cwd,
      stringArrayValue(record.additionalThemePaths),
      'themes'
    ),
    noExtensions: booleanValue(record.noExtensions),
    noSkills: booleanValue(record.noSkills),
    noPromptTemplates: booleanValue(record.noPromptTemplates),
    noThemes: booleanValue(record.noThemes),
    noContextFiles: booleanValue(record.noContextFiles),
    systemPrompt: typeof record.systemPrompt === 'string' ? record.systemPrompt : undefined,
    appendSystemPrompt:
      typeof record.appendSystemPrompt === 'string' || Array.isArray(record.appendSystemPrompt)
        ? (record.appendSystemPrompt as string | string[])
        : undefined
  }
}

function serializeSkill(cwd: string, skill: unknown): unknown {
  if (!isRecord(skill)) return skill
  const filePath = stringValue(skill.filePath)
  const sourceMeta = isRecord(skill._source) ? skill._source : undefined
  const existingSourceInfo = isRecord(skill.sourceInfo) ? skill.sourceInfo : undefined
  const projectBaseDir = filePath
    ? getKnownProjectResourceBaseDir(cwd, 'skills', filePath)
    : undefined
  const sourceInfo = {
    source:
      stringValue(existingSourceInfo?.source) ||
      stringValue(skill.source) ||
      stringValue(sourceMeta?.provider, 'local'),
    scope: projectBaseDir
      ? 'project'
      : stringValue(existingSourceInfo?.scope) ||
        (sourceMeta?.level === 'project' ? 'project' : 'user'),
    origin: projectBaseDir
      ? 'top-level'
      : stringValue(existingSourceInfo?.origin) || stringValue(sourceMeta?.origin),
    path: filePath || stringValue(existingSourceInfo?.path),
    baseDir:
      projectBaseDir || stringValue(existingSourceInfo?.baseDir) || stringValue(skill.baseDir)
  }

  return {
    ...skill,
    disableModelInvocation: skill.disableModelInvocation === true || skill.hide === true,
    sourceInfo
  }
}

function markProjectSkills(
  cwd: string,
  result: { skills: unknown[]; diagnostics: ResourceDiagnostic[] }
): { skills: unknown[]; diagnostics: ResourceDiagnostic[] } {
  return {
    ...result,
    skills: result.skills.map((skill) => serializeSkill(cwd, skill))
  }
}

async function reloadResources(params: unknown): Promise<unknown> {
  const options = resourceOptions(params)
  const loader = new DefaultResourceLoader({
    ...options,
    settingsManager: SettingsManager.create(options.cwd, options.agentDir)
  })
  await loader.reload()

  return {
    extensions: loader.getExtensions(),
    skills: markProjectSkills(options.cwd ?? process.cwd(), loader.getSkills()),
    prompts: loader.getPrompts(),
    themes: loader.getThemes(),
    agentsFiles: loader.getAgentsFiles(),
    systemPrompt: loader.getSystemPrompt(),
    appendSystemPrompt: loader.getAppendSystemPrompt()
  }
}

function serializePlugin(plugin: InstalledPlugin): unknown {
  return {
    name: plugin.name,
    version: plugin.version,
    path: plugin.path,
    enabled: plugin.enabled,
    enabledFeatures: plugin.enabledFeatures,
    manifest: plugin.manifest
  }
}

function normalizeInstallSpec(source: string): string {
  const trimmed = source.trim()
  return trimmed.startsWith('npm:') ? trimmed.slice('npm:'.length) : trimmed
}

async function listPlugins(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const manager = new PluginManager(stringValue(record.cwd, process.cwd()))
  const plugins = await manager.list()
  return plugins.map(serializePlugin)
}

async function installPlugin(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const manager = new PluginManager(stringValue(record.cwd, process.cwd()))
  const plugin = await manager.install(normalizeInstallSpec(stringValue(record.source)), {
    force: true
  })
  return serializePlugin(plugin)
}

async function uninstallPlugin(params: unknown): Promise<void> {
  const record = isRecord(params) ? params : {}
  const manager = new PluginManager(stringValue(record.cwd, process.cwd()))
  await manager.uninstall(stringValue(record.name))
}

function modelBySelector(ctx: RuntimeContext, modelLike: unknown): Model | undefined {
  if (!isRecord(modelLike)) return undefined
  const provider = stringValue(modelLike.provider)
  const modelId = stringValue(modelLike.id)
  if (!provider || !modelId) return undefined
  return ctx.modelRegistry.find(provider, modelId)
}

async function makeSessionManager(
  params: unknown,
  cwd: string,
  agentDir: string
): Promise<SessionManager> {
  if (!isRecord(params))
    return SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))
  const kind = stringValue(params.kind, 'persistent')
  if (kind === 'memory') return SessionManager.inMemory(cwd)
  if (kind === 'open') {
    const path = stringValue(params.path)
    if (!path) throw new Error('Missing session path')
    return SessionManager.open(path, undefined, undefined, { initialCwd: cwd })
  }
  return SessionManager.create(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))
}

function requestToolApproval(sessionId: string, event: UnknownRecord): Promise<unknown> {
  const requestId = randomUUID()
  sendEvent(
    'toolApproval',
    {
      requestId,
      toolCallId: stringValue(event.toolCallId, requestId),
      toolName: stringValue(event.toolName),
      input: isRecord(event.input) ? event.input : {}
    },
    { sessionId }
  )
  return new Promise<unknown>((resolve) => {
    pendingToolApprovals.set(requestId, resolve)
  })
}

function createBridgeToolApprovalExtension(sessionId: string): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const result = await requestToolApproval(sessionId, event as unknown as UnknownRecord)
      return result === null ? undefined : result
    })
  }
}

function serializeSessionState(result: CreateAgentSessionResult): unknown {
  const session = result.session
  return {
    sessionFile: session.sessionFile,
    messages: session.messages,
    model: session.model ? serializeModel(session.model) : undefined,
    thinkingLevel: session.thinkingLevel,
    cwd: session.sessionManager.getCwd()
  }
}

/**
 * The Phi tool functions an agent definition may list in `tools:`. Built fresh
 * per agent session so each one binds to that session. Add a provider here to
 * make more Phi tools available to agents; the delegating (main) agent never
 * receives these directly.
 */
function phiToolFunctions(
  originSessionId: string
): Map<string, ReturnType<typeof buildWrapperCompositionTools>[number]> {
  // Wrapper runs are background jobs owned by the main process; these tools only talk to it.
  // Each run is stamped with the session that started it, so its end can be reported there.
  const jobs = createHostJobClient(requestHost, { originSessionId })
  return new Map(buildWrapperCompositionTools(jobs).map((tool) => [tool.name, tool]))
}

/**
 * Builds an in-memory session for one scanned Phi agent. The definition drives
 * everything: its Markdown body is the system prompt, `tools` is the (restricted)
 * toolbox, `skills` the only skills exposed. The session gets its own resource
 * loader (the SDK forbids sharing loaded extension instances across sessions)
 * whose approval extension is bound to the *parent's* sessionId, so its shell
 * and file writes are approved in the chat the user is looking at. The parent's
 * model and thinking level are reused.
 */
async function createPhiAgentSession(
  definition: PhiAgentDefinition,
  deps: {
    sessionId: string
    cwd: string
    agentDir: string
    ctx: RuntimeContext
    resourceOptions: unknown
    enableToolApproval: boolean
    parent: () => CreateAgentSessionResult | undefined
  }
): Promise<AgentSessionLike> {
  const { sessionId, cwd, agentDir, ctx } = deps
  const settings = await Settings.init({ cwd, agentDir })
  const loader = isRecord(deps.resourceOptions)
    ? new DefaultResourceLoader({
        ...resourceOptions({ ...deps.resourceOptions, cwd, agentDir }),
        settingsManager: SettingsManager.create(cwd, agentDir),
        extensionFactories: deps.enableToolApproval
          ? [createBridgeToolApprovalExtension(sessionId)]
          : undefined
      })
    : undefined
  if (loader) await loader.reload()

  const { toolNames, customTools } = resolveAgentTools(
    definition.tools,
    phiToolFunctions(sessionId)
  )
  const parentSession = deps.parent()?.session
  const skills = loader
    ? loader.getSkills().skills.filter((skill) => definition.skills.includes(skill.name))
    : undefined

  const result = await createLegacyAgentSession({
    cwd,
    agentDir,
    settings,
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    sessionManager: SessionManager.inMemory(cwd),
    ...(parentSession?.model ? { model: parentSession.model } : {}),
    ...(parentSession?.thinkingLevel ? { thinkingLevel: parentSession.thinkingLevel } : {}),
    ...(loader ? { resourceLoader: loader } : {}),
    ...(skills ? { skills } : {}),
    appendSystemPrompt: definition.systemPrompt,
    ...(customTools.length > 0 ? { customTools } : {}),
    toolNames,
    restrictToolNames: true,
    // Without this the restriction also drops our Phi tool functions.
    allowRestrictedCustomTools: true,
    enableMCP: false,
    enableLsp: false
  })
  return result.session as unknown as AgentSessionLike
}

async function createSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const sessionId = stringValue(record.sessionId, randomUUID())
  const cwd = stringValue(record.cwd, process.cwd())
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  const ctx = await getContext(agentDir)
  const settings = await Settings.init({ cwd, agentDir })
  const sessionManager = await makeSessionManager(record.sessionManager, cwd, agentDir)
  const noTools = record.noTools === 'all' || record.noTools === true
  const resources = isRecord(record.resourceOptions)
    ? new DefaultResourceLoader({
        ...resourceOptions({ ...record.resourceOptions, cwd, agentDir }),
        settingsManager: SettingsManager.create(cwd, agentDir),
        extensionFactories: record.enableToolApproval
          ? [createBridgeToolApprovalExtension(sessionId)]
          : undefined
      })
    : undefined

  if (resources) {
    await resources.reload()
  }

  // Registered via the SDK's `customTools` option, not `resources`'
  // `extensionFactories` — that path is the tool-call *approval* hook (see
  // `createBridgeToolApprovalExtension` above), unrelated to adding a new
  // LLM-callable tool. See docs/design/phi-wrapper-technical-design.md,
  // "Integration With The Existing Runtime (Confirmed By Milestone P1.0)".
  // Never let a wrapper-catalog problem block an otherwise-ordinary chat
  // session from starting.
  // The main agent leads: it gets one delegation tool per scanned Phi agent,
  // named after the agent (e.g. `Wrapper`), and none of the agents' own tool
  // functions (wrapper_search, …), so their catalogs and logs stay out of the
  // main conversation. Definitions come from the main process's scan.
  const parentRef: { current?: CreateAgentSessionResult } = {}
  const phiAgents = Array.isArray(record.phiAgents)
    ? record.phiAgents.filter(isPhiAgentDefinition)
    : []
  const agentCustomTools = phiAgents.map((definition) =>
    buildAgentTool(
      definition,
      createAgentRunner({
        agent: definition.name,
        createSession: () =>
          createPhiAgentSession(definition, {
            sessionId,
            cwd,
            agentDir,
            ctx,
            resourceOptions: record.resourceOptions,
            enableToolApproval: Boolean(record.enableToolApproval),
            parent: () => parentRef.current
          })
      })
    )
  )
  let dbCustomTools: ReturnType<typeof buildDefaultDbCustomTools> = []
  const enableDbConnectorTools =
    isDbConnectorRuntimeEnabled(record.enableDbConnectorTools) ||
    isDbConnectorRuntimeEnabled(process.env.PHI_ENABLE_DB_CONNECTOR_TOOLS)
  if (enableDbConnectorTools) {
    try {
      dbCustomTools = buildDefaultDbCustomTools(agentDir)
    } catch {
      dbCustomTools = []
    }
  }
  const notebookCustomTools = buildNotebookCustomTools(async (request) =>
    requestHost('notebookTool.execute', request)
  )
  const libraryCustomTools = buildLibraryCustomTools()
  const userInteractionCustomTools = buildAskUserQuestionCustomTools(sessionId, async (request) =>
    requestHost('agentInteraction.request', request)
  )
  const customTools = [
    ...agentCustomTools,
    ...dbCustomTools,
    ...notebookCustomTools,
    ...libraryCustomTools,
    ...userInteractionCustomTools
  ]

  const result = await createLegacyAgentSession({
    cwd,
    agentDir,
    settings,
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    sessionManager,
    thinkingLevel: configuredThinkingLevel(record.thinkingLevel),
    ...(modelBySelector(ctx, record.model) ? { model: modelBySelector(ctx, record.model) } : {}),
    ...(resources ? { resourceLoader: resources } : {}),
    ...(customTools.length > 0 ? { customTools } : {}),
    ...(noTools
      ? {
          enableMCP: false,
          enableLsp: false,
          disableExtensionDiscovery: true,
          toolNames: [],
          restrictToolNames: true,
          skills: [],
          contextFiles: [],
          promptTemplates: [],
          slashCommands: []
        }
      : {})
  })

  parentRef.current = result

  result.session.subscribe((event) => {
    sendEvent('sessionEvent', event, { sessionId })
    sendEvent('sessionState', serializeSessionState(result), { sessionId })
  })
  sessions.set(sessionId, { result })
  return {
    sessionId,
    state: serializeSessionState(result)
  }
}

function getSession(sessionId: unknown): CreateAgentSessionResult {
  const id = stringValue(sessionId)
  const entry = sessions.get(id)
  if (!entry) throw new Error(`Unknown session: ${id}`)
  return entry.result
}

function promptOptions(value: unknown): WorkerPromptOptions | undefined {
  if (!isRecord(value)) return undefined
  const options: WorkerPromptOptions = {}
  if (typeof value.expandPromptTemplates === 'boolean') {
    options.expandPromptTemplates = value.expandPromptTemplates
  }
  if (typeof value.synthetic === 'boolean') {
    options.synthetic = value.synthetic
  }
  if (typeof value.userInitiated === 'boolean') {
    options.userInitiated = value.userInitiated
  }
  if (typeof value.skipCompactionCheck === 'boolean') {
    options.skipCompactionCheck = value.skipCompactionCheck
  }
  return Object.keys(options).length > 0 ? options : undefined
}

async function promptSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const result = getSession(record.sessionId)
  await result.session.prompt(stringValue(record.text), promptOptions(record.options))
  return serializeSessionState(result)
}

async function abortSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const result = getSession(record.sessionId)
  await result.session.abort()
  return serializeSessionState(result)
}

async function disposeSession(params: unknown): Promise<void> {
  const record = isRecord(params) ? params : {}
  const sessionId = stringValue(record.sessionId)
  const result = getSession(sessionId)
  sessions.delete(sessionId)
  await result.session.dispose()
}

async function setSessionModel(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const result = getSession(record.sessionId)
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  const ctx = await getContext(agentDir)
  const model = modelBySelector(ctx, record.model)
  if (!model) throw new Error('Unknown model')
  await result.session.setModel(model)
  return serializeSessionState(result)
}

async function setSessionThinkingLevel(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const result = getSession(record.sessionId)
  const level = stringValue(record.level)
  result.session.setThinkingLevel(configuredThinkingLevel(level))
  return serializeSessionState(result)
}

async function renameLiveSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const result = getSession(record.sessionId)
  await result.session.sessionManager.setSessionName(stringValue(record.name), 'user')
  return serializeSessionState(result)
}

async function listSessions(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const cwd = stringValue(record.cwd, process.cwd())
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  const infos = await SessionManager.list(cwd, SessionManager.getDefaultSessionDir(cwd, agentDir))
  return Promise.all(
    infos.map(async (info) => {
      const allMessagesText = await readRuntimeSessionMessagesText(info.path)
      return allMessagesText ? { ...info, allMessagesText } : info
    })
  )
}

async function openSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const path = stringValue(record.path)
  const cwd = stringValue(record.cwd, process.cwd())
  const manager = await SessionManager.open(path, undefined, undefined, { initialCwd: cwd })
  const result = {
    cwd: manager.getCwd(),
    sessionFile: manager.getSessionFile(),
    name: manager.getSessionName()
  }
  await manager.close()
  return result
}

async function renameSession(params: unknown): Promise<void> {
  const record = isRecord(params) ? params : {}
  const path = stringValue(record.path)
  const name = stringValue(record.name)
  const manager = await SessionManager.open(path)
  await manager.setSessionName(name, 'user')
  await manager.close()
}

async function handleRequest(method: string, params: unknown): Promise<unknown> {
  switch (method) {
    case 'modelRuntime.snapshot':
      return modelRuntimeSnapshot(params)
    case 'modelRuntime.login':
      return loginModelRuntime(params)
    case 'modelRuntime.logout':
      return logoutModelRuntime(params)
    case 'resources.reload':
      return reloadResources(params)
    case 'plugins.list':
      return listPlugins(params)
    case 'plugins.install':
      return installPlugin(params)
    case 'plugins.uninstall':
      return uninstallPlugin(params)
    case 'session.create':
      return createSession(params)
    case 'session.prompt':
      return promptSession(params)
    case 'session.abort':
      return abortSession(params)
    case 'session.dispose':
      return disposeSession(params)
    case 'session.setModel':
      return setSessionModel(params)
    case 'session.setThinkingLevel':
      return setSessionThinkingLevel(params)
    case 'session.rename':
      return renameLiveSession(params)
    case 'sessions.list':
      return listSessions(params)
    case 'sessions.open':
      return openSession(params)
    case 'sessions.rename':
      return renameSession(params)
    case 'toolApproval.result': {
      const record = isRecord(params) ? params : {}
      const requestId = stringValue(record.requestId)
      const resolve = pendingToolApprovals.get(requestId)
      if (resolve) {
        pendingToolApprovals.delete(requestId)
        resolve(record.result ?? null)
      }
      return undefined
    }
    case 'auth.promptResult': {
      const record = isRecord(params) ? params : {}
      const requestId = stringValue(record.requestId)
      const pending = pendingAuthPrompts.get(requestId)
      if (pending) {
        pendingAuthPrompts.delete(requestId)
        if (typeof record.error === 'string' && record.error) {
          pending.reject(new Error(record.error))
        } else {
          pending.resolve(stringValue(record.value))
        }
      }
      return undefined
    }
    default:
      throw new Error(`Unknown OMP worker method: ${method}`)
  }
}

const input = createInterface({ input: process.stdin })
input.on('line', (line) => {
  void (async () => {
    let request: IncomingRequest | undefined
    try {
      const message = JSON.parse(line) as unknown
      if (isHostResponse(message)) {
        handleHostResponse(message)
        return
      }
      request = message as IncomingRequest
      const result = await handleRequest(request.method, request.params)
      send({ id: request.id, ok: true, result })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const stack = error instanceof Error ? error.stack : undefined
      send({ id: request?.id ?? '', ok: false, error: message, stack })
    }
  })()
})
