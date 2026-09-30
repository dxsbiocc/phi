import { randomUUID } from 'node:crypto'
import { editDiffString } from '@oh-my-pi/pi-natives'
import { cpSync, existsSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { createInterface } from 'node:readline'

import {
  ModelRegistry,
  SessionManager,
  Settings,
  discoverAuthStorage,
  type CreateAgentSessionResult,
  type CustomTool,
  type ExtensionFactory
} from '@oh-my-pi/pi-coding-agent'
import {
  DefaultResourceLoader,
  SettingsManager,
  createAgentSession as createLegacyAgentSession,
  type DefaultResourceLoaderOptions,
  type ResourceDiagnostic
} from '@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim'
import { initializeExtensions } from '@oh-my-pi/pi-coding-agent/modes/runtime-init'
import { mcpOAuthCredentialId } from '@oh-my-pi/pi-coding-agent/mcp/oauth-flow'
import { estimateToolSchemaTokens } from '@oh-my-pi/pi-coding-agent/modes/utils/context-usage'
import {
  DEFAULT_COMPACTION_METHOD_ORDER,
  resolveCompactionMethodOrder
} from '@oh-my-pi/pi-coding-agent/session/compaction-methods'
import { resolveApprovedPlan } from '@oh-my-pi/pi-coding-agent/plan-mode/approved-plan'
import { listPlanFiles, readPlanFile } from '@oh-my-pi/pi-coding-agent/plan-mode/plan-files'
import { PluginManager } from '@oh-my-pi/pi-coding-agent/extensibility/plugins/manager'
import { applyProviderGlobalsFromSettings } from '@oh-my-pi/pi-coding-agent/config/provider-globals'
import type { InstalledPlugin } from '@oh-my-pi/pi-coding-agent/extensibility/plugins/types'
import type { AuthStorage, CredentialOrigin, StoredAuthCredential } from '@oh-my-pi/pi-ai'
import type { Model } from '@oh-my-pi/pi-ai/types'
import {
  parseConfiguredThinkingLevel,
  type ConfiguredThinkingLevel
} from '@oh-my-pi/pi-coding-agent/thinking'
import { authPolicyFor } from '@oh-my-pi/pi-catalog/compat/auth'
import { createNextActionInstructionExtension } from './next-action-extension'
import { cursorModelWithBridge } from './cursor-model-routing'
import { getCatalogProviderEntry } from '@oh-my-pi/pi-catalog/provider-models/descriptors'
import { buildDefaultDbCustomTools } from '../db/tools'
import { buildProjectDownloadTool } from '../download/project-download-tool'
import { buildPresentFilesTool } from '../deliverables/present-tool'
import { enterPlanReviewMode, type PlanReviewChoice } from '../plan/plan-review-mode'
import { planModeToolDecision } from '../plan/plan-tool-policy'
import type { PresentedFile } from '../../../shared/presentedFileTypes'
import { featuredMcpConnectors } from '../../../shared/mcpConnectorCatalog'
import { authorizeFeaturedMcp, listFeaturedMcpTools } from './featured-mcp-auth'
import {
  API_KEY_CONNECTOR_IDS,
  apiKeyConnector,
  featuredApiKeyMcpConfig,
  isFeaturedMcpApiKeyInstalled
} from '../mcp-key-credentials'
import {
  disableFeaturedApiKeyAutoDiscovery,
  isMcpConnectorUserDisabled,
  readMcpServerEntry
} from '../mcp-connectors'
import type {
  AutoCompactionDefaults,
  AutoCompactionOverrides,
  ContextCompactionSummary,
  ContextUsageSnapshot
} from '../../../shared/contextUsageTypes'
import { contextUsageSnapshot, partitionMcpTools } from './context-usage-snapshot'
import { buildRemoteWorkspaceReadTool } from '../remote-workspace-read-tool'
import type { RemoteWorkspaceReadResult } from '../remote-workspace-read'
import {
  buildRemoteWorkspaceGlobTool,
  buildRemoteWorkspaceGrepTool
} from '../remote-workspace-search-tools'
import type { RemoteGlobResult, RemoteGrepResult } from '../remote-workspace-search'
import { buildRemoteWorkspaceBashTool } from '../remote-workspace-bash-tool'
import type { RemoteBashResult } from '../remote-workspace-bash'
import { buildRemoteWorkspaceWriteTool } from '../remote-workspace-write-tool'
import type { RemoteMutationResult } from '../remote-workspace-edit'
import { buildRemoteWorkspaceEditTool } from '../remote-workspace-edit-tool'
import { buildLibraryCustomTools } from '../library/library-tools'
import { buildPaletteRecommendationTool } from '../palettes/tools'
import {
  listSearxngEngines,
  normalizeWebSearchSettingsPatch,
  webSearchSettingsFromValues
} from '../web-search-settings'
import { buildNotebookCustomTools } from '../notebook/notebook-tools'
import { readRuntimeSessionMessagesText } from '../runtime/runtime-session-text'
import { buildAskUserQuestionCustomTools } from '../user-interaction-tools'
import { isPhiAgentDefinition, type PhiAgentDefinition } from '../agents/definition'
import { controlAgentRun } from '../agents/run-control'
import { AGENT_RUN_HOST_METHODS } from '../agents/run-host'
import { AgentRunRegistry } from '../agents/registry'
import { buildAgentRunTools } from '../agents/run-tools'
import { createAgentRunner, type AgentSessionLike } from '../agents/runner'
import { appendAgentUsageRecord, pruneAgentUsageLogs } from '../agents/usage-log'
import {
  buildScopedPhiToolMap,
  resolveAgentTools,
  visualizationToolNamesForWorkflow,
  type VisualizationWorkflow
} from '../agents/tool-resolution'
import { buildAgentTool } from '../agents/tool'
import { createSpecialistFallbackExtension } from '../agents/fallback-policy'
import { createProjectToolBoundaryExtension } from '../agents/project-tool-boundary'
import { createRemoteUrlGuardExtension } from '../agents/remote-url-guard'
import {
  createRemoteProjectToolGuardExtension,
  remoteWorkspaceToolsVerified
} from '../agents/remote-project-tool-guard'
import { AGENT_REPORT_PROTOCOL } from '../agents/report'
import {
  buildPhiMainSystemPrompt,
  buildPhiRemoteProjectSystemPrompt,
  filterPersonaContextFile
} from '../main-system-prompt'
import { buildVisualizationTools } from '../visualization/tools'
import { createHostJobClient } from '../wrappers/composition/job-host-client'
import { buildWrapperCompositionTools } from '../wrappers/composition/tools'

type UnknownRecord = Record<string, unknown>
type AutoCompactionBaseline = {
  enabled: boolean
  thresholdPercent: number
  thresholdTokens: number
  methodOrder: Array<(typeof DEFAULT_COMPACTION_METHOD_ORDER)[number]>
}
const autoCompactionBaselines = new WeakMap<Settings, AutoCompactionBaseline>()
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
  agentDir: string
  /** The runs of this session's specialist agents; stopped with the session. */
  agentRuns?: AgentRunRegistry
  /** Stops telling the main process about those runs (used when the session goes away). */
  stopAgentRunNotices?: () => void
}

type WorkerPromptOptions = {
  images?: Array<{ type: 'image'; data: string; mimeType: string }>
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
  supportsImages: boolean
  thinkingLevelMap?: Partial<Record<ThinkingLevel, string | null>>
}

const THINKING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const PHI_PROJECT_CONFIG_DIR_NAME = '.phi'
const CURRENT_SDK_PROJECT_CONFIG_DIR_NAME = '.omp'
const LEGACY_PROJECT_CONFIG_DIR_NAMES = ['.omp', '.pi'] as const
const contexts = new Map<string, Promise<RuntimeContext>>()
const sessions = new Map<string, SessionEntry>()
type WorkerAgentSession = CreateAgentSessionResult['session']
type ToolSchema = WorkerAgentSession['agent']['state']['tools'][number]
const mcpUsageCache = new WeakMap<
  WorkerAgentSession,
  {
    tokenizer: WorkerAgentSession['agent']['tokenizer']
    directTools: ToolSchema[]
    deferredTools: ToolSchema[]
    directTokens: number
    deferredTokens: number
  }
>()
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
const featuredAuthAbort = new Map<string, AbortController>()

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
    supportsImages: model.input.includes('image'),
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

async function modelBySelector(
  ctx: RuntimeContext,
  modelLike: unknown
): Promise<Model | undefined> {
  if (!isRecord(modelLike)) return undefined
  const provider = stringValue(modelLike.provider)
  const modelId = stringValue(modelLike.id)
  if (!provider || !modelId) return undefined
  const model = ctx.modelRegistry.find(provider, modelId)
  return cursorModelWithBridge(model, async () => {
    const response = await requestHost('cursorBridge.ensure', {})
    if (!isRecord(response) || typeof response.baseUrl !== 'string') {
      throw new Error('Cursor HTTP/2 桥接不可用')
    }
    return response.baseUrl
  })
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

function requestToolApproval(
  sessionId: string,
  event: UnknownRecord,
  agentRunId?: string
): Promise<unknown> {
  const requestId = randomUUID()
  sendEvent(
    'toolApproval',
    {
      requestId,
      toolCallId: stringValue(event.toolCallId, requestId),
      toolName: stringValue(event.toolName),
      input: isRecord(event.input) ? event.input : {},
      ...(agentRunId ? { agentRunId } : {})
    },
    { sessionId }
  )
  return new Promise<unknown>((resolve) => {
    pendingToolApprovals.set(requestId, resolve)
  })
}

function createBridgeToolApprovalExtension(
  sessionId: string,
  agentRunId?: string
): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const result = await requestToolApproval(
        sessionId,
        event as unknown as UnknownRecord,
        agentRunId
      )
      return result === null ? undefined : result
    })
  }
}

function createPlanReviewToolGuardExtension(isPlanModeActive: () => boolean): ExtensionFactory {
  return (pi) => {
    pi.on('tool_call', async (event) => {
      const decision = planModeToolDecision(isPlanModeActive(), event.toolName, event.input)
      return decision.allowed ? undefined : { block: true, reason: decision.reason }
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
  originSessionId: string,
  agentDir: string,
  agentName: string
): Map<string, CustomTool> {
  let wrapperTools: CustomTool[] = []
  let databaseTools: CustomTool[] = []
  if (agentName === 'Wrapper') {
    // Wrapper runs are background jobs owned by the main process; these tools only talk to it.
    // Each run is stamped with the session that started it, so its end can be reported there.
    const jobs = createHostJobClient(requestHost, { originSessionId })
    wrapperTools = [...buildWrapperCompositionTools(jobs)]
  }
  if (agentName === 'Database') {
    try {
      databaseTools = buildDefaultDbCustomTools(agentDir, {}, { enforceRouting: true })
    } catch {
      // A broken connector catalog must not prevent the specialist session from starting.
    }
  }
  // The figure tools only run local scripts and write inside the delegating session's project.
  const visualizationTools = agentName === 'Visualization' ? buildVisualizationTools() : []
  return buildScopedPhiToolMap(agentName, {
    wrapper: wrapperTools,
    database: databaseTools,
    visualization: visualizationTools
  })
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
    agentRunId?: string
    workflow?: VisualizationWorkflow
    remoteRoot?: string
    remoteContextFiles?: Array<{ path: string; content: string }>
    remoteTools?: () => CustomTool[]
    parent: () => CreateAgentSessionResult | undefined
  }
): Promise<AgentSessionLike> {
  const { sessionId, cwd, agentDir, ctx } = deps
  const sessionCwd = deps.remoteRoot ? agentDir : cwd
  const settings = await Settings.init({ cwd: sessionCwd, agentDir })
  const loader =
    isRecord(deps.resourceOptions) || deps.remoteRoot
      ? new DefaultResourceLoader({
          ...resourceOptions({
            ...(isRecord(deps.resourceOptions) ? deps.resourceOptions : {}),
            cwd: sessionCwd,
            agentDir,
            ...(deps.remoteRoot
              ? {
                  noExtensions: true,
                  noSkills: true,
                  noPromptTemplates: true,
                  noThemes: true,
                  noContextFiles: true,
                  appendSystemPrompt: []
                }
              : {})
          }),
          settingsManager: SettingsManager.create(sessionCwd, agentDir),
          extensionFactories: [
            ...(deps.remoteRoot ? [createRemoteProjectToolGuardExtension()] : []),
            ...(deps.enableToolApproval
              ? [createBridgeToolApprovalExtension(sessionId, deps.agentRunId)]
              : [])
          ]
        })
      : undefined
  if (loader) await loader.reload()

  const availableTools = phiToolFunctions(sessionId, agentDir, definition.name)
  for (const tool of deps.remoteTools?.() ?? []) availableTools.set(tool.name, tool)
  const declaredTools =
    definition.name === 'Visualization'
      ? visualizationToolNamesForWorkflow(definition.tools, deps.workflow)
      : definition.tools
  const { toolNames, customTools } = resolveAgentTools(declaredTools, availableTools)
  const parentSession = deps.parent()?.session
  const skills = deps.remoteRoot
    ? []
    : loader
      ? loader.getSkills().skills.filter((skill) => definition.skills.includes(skill.name))
      : undefined

  const result = await createLegacyAgentSession({
    agentId: `phi-agent-${sessionId}-${randomUUID()}`,
    agentDisplayName: definition.name,
    cwd: sessionCwd,
    agentDir,
    settings,
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    sessionManager: SessionManager.inMemory(sessionCwd),
    ...(parentSession?.model ? { model: parentSession.model } : {}),
    ...(parentSession?.thinkingLevel ? { thinkingLevel: parentSession.thinkingLevel } : {}),
    ...(loader ? { resourceLoader: loader } : {}),
    extensions: [createRemoteUrlGuardExtension()],
    ...(skills ? { skills } : {}),
    appendSystemPrompt: `${definition.systemPrompt}${deps.remoteRoot ? `\n\nRemote project root: ${JSON.stringify(deps.remoteRoot)}.` : ''}\n\n${AGENT_REPORT_PROTOCOL}`,
    ...(customTools.length > 0 ? { customTools } : {}),
    toolNames,
    restrictToolNames: true,
    // Without this the restriction also drops our Phi tool functions.
    allowRestrictedCustomTools: true,
    enableMCP: false,
    enableLsp: false,
    ...(deps.remoteRoot
      ? {
          disableExtensionDiscovery: true,
          includeWorkspaceTree: false,
          contextFiles: deps.remoteContextFiles ?? [],
          promptTemplates: [],
          slashCommands: []
        }
      : {})
  })
  if (deps.remoteRoot) {
    await initializeExtensions(result.session, {
      reportSendError: () =>
        process.stderr.write('Phi remote specialist extension message failed\n'),
      reportRuntimeError: () =>
        process.stderr.write('Phi remote specialist extension handler failed\n')
    })
    const verified = remoteWorkspaceToolsVerified(result.session.getAllToolInfos())
    if (!verified) {
      await result.session.dispose()
      throw new Error('远程专家文件/命令工具未覆盖本地实现；专家会话已拒绝启动')
    }
  }
  return result.session as unknown as AgentSessionLike
}

async function syncFeaturedApiKeysForSession(
  result: CreateAgentSessionResult,
  agentDir: string,
  id?: string
): Promise<void> {
  const manager = result.mcpManager
  if (!manager) return
  const ids = id ? [id] : API_KEY_CONNECTOR_IDS
  for (const connectorId of ids) {
    const connector = apiKeyConnector(connectorId)
    const existing = manager.getServerConfig(connectorId)
    // Never replace an unrelated project server that happens to use the same name.
    if (existing && (existing.type !== 'http' || existing.url !== connector.url)) continue
    if (existing) await manager.disconnectServer(connectorId)
    if (!isFeaturedMcpApiKeyInstalled(connectorId, agentDir)) continue
    if (isMcpConnectorUserDisabled(connectorId, agentDir)) continue
    const key = await requestHost('mcp.featuredApiKey', { id: connectorId })
    if (typeof key !== 'string' || !key) continue
    try {
      await manager.connectServers({ [connectorId]: featuredApiKeyMcpConfig(connectorId, key) }, {})
    } catch {
      // A failed connector must not prevent the ordinary chat session from starting.
    }
  }
  await result.session.refreshMCPTools(manager.getTools())
}

type LiveMcpManager = {
  disconnectServer(name: string): Promise<void>
  connectServers(
    configs: Record<string, Record<string, unknown>>,
    sources: Record<string, unknown>
  ): Promise<unknown>
  getTools(): unknown
}

function liveMcpManager(result: CreateAgentSessionResult): LiveMcpManager | undefined {
  const manager = result.mcpManager as Partial<LiveMcpManager> | undefined
  if (
    !manager ||
    typeof manager.disconnectServer !== 'function' ||
    typeof manager.connectServers !== 'function' ||
    typeof manager.getTools !== 'function'
  ) {
    return undefined
  }
  return manager as LiveMcpManager
}

function injectableServerConfig(
  entry: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (typeof entry.command === 'string') {
    return {
      type: 'stdio',
      command: entry.command,
      ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
      enabled: true
    }
  }
  if (typeof entry.url !== 'string') return undefined
  return {
    type: entry.type === 'sse' ? 'sse' : 'http',
    url: entry.url,
    enabled: true,
    timeout: typeof entry.timeout === 'number' ? entry.timeout : 10_000
  }
}

async function applyConnectorEnabledForSession(
  result: CreateAgentSessionResult,
  agentDir: string,
  name: string
): Promise<void> {
  if (API_KEY_CONNECTOR_IDS.includes(name as (typeof API_KEY_CONNECTOR_IDS)[number])) {
    await syncFeaturedApiKeysForSession(result, agentDir, name)
    return
  }
  const manager = liveMcpManager(result)
  if (!manager) return
  const entry = readMcpServerEntry(name, agentDir)
  const disabled = isMcpConnectorUserDisabled(name, agentDir) || entry?.enabled === false
  if (disabled) {
    await manager.disconnectServer(name)
  } else if (entry) {
    const config = injectableServerConfig(entry)
    if (config) await manager.connectServers({ [name]: config }, {})
  }
  await result.session.refreshMCPTools(manager.getTools() as never)
}

async function applyConnectorEnabled(name: string): Promise<void> {
  await Promise.all(
    [...sessions.values()].map((entry) =>
      applyConnectorEnabledForSession(entry.result, entry.agentDir, name)
    )
  )
}

async function syncFeaturedApiKeys(id?: string): Promise<void> {
  if (id && !API_KEY_CONNECTOR_IDS.includes(id as (typeof API_KEY_CONNECTOR_IDS)[number])) return
  await Promise.all(
    [...sessions.values()].map((entry) =>
      syncFeaturedApiKeysForSession(entry.result, entry.agentDir, id)
    )
  )
}

async function createSession(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const sessionId = stringValue(record.sessionId, randomUUID())
  const cwd = stringValue(record.cwd, process.cwd())
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  const remoteRecord = isRecord(record.remoteProject) ? record.remoteProject : null
  const remoteLocation =
    remoteRecord && isRecord(remoteRecord.location) ? remoteRecord.location : null
  const remoteRoot =
    remoteLocation?.kind === 'ssh' &&
    typeof remoteLocation.remoteRoot === 'string' &&
    remoteLocation.remoteRoot.startsWith('/') &&
    typeof remoteRecord?.projectId === 'string' &&
    typeof remoteRecord.phiSessionId === 'string' &&
    remoteRecord.phiSessionId.length > 0
      ? remoteLocation.remoteRoot
      : null
  if (record.remoteProject !== undefined && !remoteRoot) {
    throw new Error('Invalid remote project session context')
  }
  const remoteContextFiles =
    remoteRoot &&
    Array.isArray(remoteRecord?.contextFiles) &&
    remoteRecord.contextFiles.length <= 3 &&
    remoteRecord.contextFiles.every(
      (file) =>
        isRecord(file) &&
        typeof file.path === 'string' &&
        file.path.startsWith('ssh://') &&
        typeof file.content === 'string' &&
        Buffer.byteLength(file.content, 'utf-8') <= 64 * 1024
    )
      ? (remoteRecord.contextFiles as Array<{ path: string; content: string }>)
      : null
  if (remoteRoot && !remoteContextFiles) {
    throw new Error('Invalid remote project instruction context')
  }
  const ctx = await getContext(agentDir)
  const settingsCwd = remoteRoot ? agentDir : cwd
  const baseSettings = await Settings.init({ cwd: settingsCwd, agentDir })
  const settings = await baseSettings.cloneForCwd(settingsCwd)
  applyAutoCompactionOverrides(settings, autoCompactionOverrides(record.autoCompaction))
  const sessionManager = await makeSessionManager(record.sessionManager, cwd, agentDir)
  const noTools = record.noTools === 'all' || record.noTools === true
  if (!remoteRoot && !noTools) disableFeaturedApiKeyAutoDiscovery(agentDir)
  const personaMarkdown = stringValue(record.personaMarkdown).trim()
  const phiAgents = Array.isArray(record.phiAgents)
    ? record.phiAgents.filter(isPhiAgentDefinition)
    : []
  // One registry per conversation: parallel and background delegations share its limits,
  // and the run tools and controlled-fallback policy below act on it.
  const agentRuns = new AgentRunRegistry()
  const parentRef: { current?: CreateAgentSessionResult } = {}
  const extensionFactories = [
    createNextActionInstructionExtension(
      async () => (await requestHost('settings.nextActionSuggestionsEnabled', {})) === true
    ),
    createPlanReviewToolGuardExtension(
      () => parentRef.current?.session.getPlanModeState()?.enabled === true
    ),
    ...(remoteRoot ? [createRemoteProjectToolGuardExtension()] : []),
    createRemoteUrlGuardExtension(),
    ...(record.projectBound && !remoteRoot ? [createProjectToolBoundaryExtension(cwd)] : []),
    ...(phiAgents.length > 0 ? [createSpecialistFallbackExtension(phiAgents, agentRuns)] : []),
    ...(record.enableToolApproval ? [createBridgeToolApprovalExtension(sessionId)] : [])
  ]
  const resources =
    isRecord(record.resourceOptions) || extensionFactories.length > 0
      ? new DefaultResourceLoader({
          ...resourceOptions({
            ...(isRecord(record.resourceOptions) ? record.resourceOptions : {}),
            cwd: settingsCwd,
            agentDir
          }),
          settingsManager: SettingsManager.create(settingsCwd, agentDir),
          ...(personaMarkdown
            ? {
                agentsFilesOverride: (base) =>
                  filterPersonaContextFile(base, join(agentDir, 'AGENTS.md'))
              }
            : {}),
          ...(extensionFactories.length > 0 ? { extensionFactories } : {})
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
  // named after the agent (for example `Wrapper` or `Database`), and none of
  // the specialists' own tool functions, so internal catalogs and query tools
  // stay out of the main conversation. Definitions come from the main process's scan.
  if (phiAgents.length > 0) pruneAgentUsageLogs(agentDir)
  const agentCustomTools = phiAgents.map((definition) =>
    buildAgentTool(
      definition,
      createAgentRunner({
        agent: definition.name,
        // What each delegation cost, for judging prompt and tool changes; see agents/usage.ts.
        onUsage: (record) => appendAgentUsageRecord(agentDir, { ...record, sessionId }),
        createSession: ({ runId, workflow }) =>
          createPhiAgentSession(definition, {
            sessionId,
            cwd,
            agentDir,
            ctx,
            resourceOptions: record.resourceOptions,
            enableToolApproval: Boolean(record.enableToolApproval),
            ...(runId ? { agentRunId: runId } : {}),
            ...(workflow ? { workflow } : {}),
            ...(remoteRoot
              ? {
                  remoteRoot,
                  remoteContextFiles: remoteContextFiles ?? [],
                  remoteTools: () =>
                    customTools.filter((tool) =>
                      ['read', 'bash', 'glob', 'grep', 'write', 'edit'].includes(tool.name)
                    )
                }
              : {}),
            parent: () => parentRef.current
          })
      }),
      agentRuns,
      { cwd }
    )
  )
  const agentRunTools = phiAgents.length > 0 ? buildAgentRunTools(agentRuns) : []
  // A background run outlives the tool call that started it, so its end is reported to the
  // main process, which owns the conversation: it notes it in the timeline and can wake the
  // main agent. A run whose report the agent already collected is reported as such, so it
  // is not announced a second time. Foreground runs are never announced: the agent waited.
  const stopAgentRunNotices = agentRuns.subscribe({
    onFinish: (run) => {
      if (!run.background) return
      void requestHost(AGENT_RUN_HOST_METHODS.finished, {
        originSessionId: sessionId,
        run
      }).catch(() => undefined)
    },
    // Its steps go to the card that shows it; a foreground run's steps already do, through
    // the tool call that is waiting on it.
    onStep: (run, step) => {
      if (!run.background) return
      void requestHost(AGENT_RUN_HOST_METHODS.step, {
        originSessionId: sessionId,
        run: { id: run.id, agent: run.agent, toolCallId: run.toolCallId },
        step
      }).catch(() => undefined)
    },
    onReported: (run) => {
      if (!run.background) return
      void requestHost(AGENT_RUN_HOST_METHODS.reported, {
        originSessionId: sessionId,
        runId: run.id
      }).catch(() => undefined)
    }
  })
  const notebookCustomTools = buildNotebookCustomTools(async (request) =>
    requestHost('notebookTool.execute', request)
  )
  const libraryCustomTools = buildLibraryCustomTools()
  const userInteractionCustomTools = buildAskUserQuestionCustomTools(sessionId, async (request) =>
    requestHost('agentInteraction.request', request)
  )
  const customTools = [
    ...(remoteRoot
      ? [
          buildRemoteWorkspaceEditTool(async (toolCallId, input, signal) => {
            if (signal?.aborted) throw new Error('远程编辑在提交前已取消')
            const requestId = randomUUID()
            const identity = {
              sessionId: remoteRecord?.phiSessionId,
              projectId: remoteRecord?.projectId,
              requestId
            }
            const cancel = (): void => {
              void requestHost('remoteWorkspace.cancelEdit', identity).catch(() => undefined)
            }
            const pending = requestHost('remoteWorkspace.edit', {
              ...identity,
              toolCallId,
              ...input
            })
            signal?.addEventListener('abort', cancel, { once: true })
            if (signal?.aborted) cancel()
            try {
              const result = (await pending) as RemoteMutationResult
              if (result.status !== 'updated') return result
              const preview = editDiffString(result.oldText, result.newText, result.path)
              return { ...result, ...preview }
            } finally {
              signal?.removeEventListener('abort', cancel)
            }
          })
        ]
      : []),
    ...(remoteRoot
      ? [
          buildRemoteWorkspaceWriteTool(async (toolCallId, path, content, signal) => {
            if (signal?.aborted) throw new Error('远程写入在提交前已取消')
            const requestId = randomUUID()
            const identity = {
              sessionId: remoteRecord?.phiSessionId,
              projectId: remoteRecord?.projectId,
              requestId
            }
            const cancel = (): void => {
              void requestHost('remoteWorkspace.cancelWrite', identity).catch(() => undefined)
            }
            const pending = requestHost('remoteWorkspace.write', {
              ...identity,
              toolCallId,
              path,
              content
            })
            signal?.addEventListener('abort', cancel, { once: true })
            if (signal?.aborted) cancel()
            try {
              return (await pending) as RemoteMutationResult
            } finally {
              signal?.removeEventListener('abort', cancel)
            }
          })
        ]
      : []),
    ...(remoteRoot
      ? [
          buildRemoteWorkspaceReadTool(
            async (path) =>
              (await requestHost('remoteWorkspace.read', {
                sessionId: remoteRecord?.phiSessionId,
                projectId: remoteRecord?.projectId,
                path
              })) as RemoteWorkspaceReadResult
          )
        ]
      : []),
    ...(remoteRoot
      ? [
          buildRemoteWorkspaceGlobTool(
            async (input) =>
              (await requestHost('remoteWorkspace.glob', {
                ...input,
                sessionId: remoteRecord?.phiSessionId,
                projectId: remoteRecord?.projectId
              })) as RemoteGlobResult
          ),
          buildRemoteWorkspaceGrepTool(
            async (input) =>
              (await requestHost('remoteWorkspace.grep', {
                ...input,
                sessionId: remoteRecord?.phiSessionId,
                projectId: remoteRecord?.projectId
              })) as RemoteGrepResult
          )
        ]
      : []),
    ...(remoteRoot
      ? [
          buildRemoteWorkspaceBashTool(async (toolCallId, input, signal) => {
            if (signal?.aborted) throw new Error('远程命令在提交前已取消')
            const requestId = randomUUID()
            const identity = {
              sessionId: remoteRecord?.phiSessionId,
              projectId: remoteRecord?.projectId,
              requestId
            }
            const cancel = (): void => {
              void requestHost('remoteWorkspace.cancelBash', identity).catch(() => undefined)
            }
            const pending = requestHost('remoteWorkspace.bash', {
              ...input,
              ...identity,
              toolCallId
            })
            signal?.addEventListener('abort', cancel, { once: true })
            if (signal?.aborted) cancel()
            try {
              return (await pending) as RemoteBashResult
            } finally {
              signal?.removeEventListener('abort', cancel)
            }
          })
        ]
      : []),
    ...agentCustomTools,
    ...agentRunTools,
    ...(!remoteRoot
      ? [
          buildPresentFilesTool(
            sessionId,
            (request) =>
              requestHost('deliverables.present', request) as Promise<{ files: PresentedFile[] }>
          )
        ]
      : []),
    buildProjectDownloadTool(cwd, agentDir),
    ...notebookCustomTools,
    ...libraryCustomTools,
    buildPaletteRecommendationTool(),
    ...userInteractionCustomTools
  ]

  const selectedModel = await modelBySelector(ctx, record.model)
  const result = await createLegacyAgentSession({
    agentId: `phi-main-${sessionId}`,
    agentDisplayName: 'Main',
    // The session manager retains the private history anchor. SDK discovery uses
    // Phi's global directory so it never treats that anchor as a project root.
    cwd: settingsCwd,
    agentDir,
    settings,
    authStorage: ctx.authStorage,
    modelRegistry: ctx.modelRegistry,
    sessionManager,
    thinkingLevel: configuredThinkingLevel(record.thinkingLevel),
    systemPrompt: (defaultPrompt) =>
      remoteRoot
        ? buildPhiRemoteProjectSystemPrompt(defaultPrompt, cwd, remoteRoot, {
            ...(personaMarkdown ? { personaMarkdown } : {})
          })
        : buildPhiMainSystemPrompt(defaultPrompt, {
            ...(personaMarkdown ? { personaMarkdown } : {})
          }),
    ...(selectedModel ? { model: selectedModel } : {}),
    ...(resources ? { resourceLoader: resources } : {}),
    ...(customTools.length > 0 ? { customTools } : {}),
    ...(remoteRoot
      ? {
          enableMCP: false,
          enableLsp: false,
          disableExtensionDiscovery: true,
          includeWorkspaceTree: false,
          contextFiles: remoteContextFiles ?? [],
          promptTemplates: [],
          slashCommands: []
        }
      : {}),
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

  if (!remoteRoot && !noTools) await syncFeaturedApiKeysForSession(result, agentDir)

  if (remoteRoot) {
    await initializeExtensions(result.session, {
      reportSendError: () => {
        process.stderr.write('Phi remote extension message failed\n')
      },
      reportRuntimeError: () => {
        process.stderr.write('Phi remote extension handler failed\n')
      }
    })
  }

  if (remoteRoot && !remoteWorkspaceToolsVerified(result.session.getAllToolInfos())) {
    await result.session.dispose()
    throw new Error(
      '远程 read/bash/glob/grep/write/edit 工具未覆盖本地实现；远程会话已拒绝启动工具'
    )
  }

  parentRef.current = result

  result.session.subscribe((event) => {
    const tokensAfter =
      event.type === 'auto_compaction_end' && !event.aborted && !event.skipped
        ? event.action === 'shake'
          ? contextTokensNow(result.session)
          : compactedTokensAfter(result.session)
        : undefined
    sendEvent('sessionEvent', tokensAfter === undefined ? event : { ...event, tokensAfter }, {
      sessionId
    })
    sendEvent('sessionState', serializeSessionState(result), { sessionId })
  })
  sessions.set(sessionId, { result, agentDir, agentRuns, stopAgentRunNotices })
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
  if (Array.isArray(value.images)) {
    options.images = value.images as WorkerPromptOptions['images']
  }
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

function sessionContextUsage(params: unknown): ContextUsageSnapshot | null {
  const record = isRecord(params) ? params : {}
  const session = getSession(record.sessionId).session
  const usage = session.getContextUsage()
  try {
    const firstPrompt = session.systemPrompt[0]
    const firstSystemPromptTokens = firstPrompt?.startsWith('§ Phi Role')
      ? session.agent.tokenizer.countTokens(firstPrompt)
      : undefined
    return contextUsageSnapshot(
      usage,
      session.getContextBreakdown(),
      firstSystemPromptTokens,
      sessionMcpUsage(session)
    )
  } catch {
    return contextUsageSnapshot(usage)
  }
}

function sessionMcpUsage(session: WorkerAgentSession): {
  directTokens: number
  deferredTokens: number
} {
  const { directTools, deferredTools } = partitionMcpTools(
    session.agent.state.tools,
    session.getSelectedMCPToolNames(),
    (name) => session.getToolByName(name)
  )
  const cached = mcpUsageCache.get(session)
  const tokenizer = session.agent.tokenizer
  if (
    cached &&
    cached.tokenizer === tokenizer &&
    cached.directTools.length === directTools.length &&
    cached.deferredTools.length === deferredTools.length &&
    directTools.every((tool, index) => tool === cached.directTools[index]) &&
    deferredTools.every((tool, index) => tool === cached.deferredTools[index])
  ) {
    return cached
  }
  const result = {
    tokenizer,
    directTools,
    deferredTools,
    directTokens: directTools.length ? estimateToolSchemaTokens(directTools, tokenizer) : 0,
    deferredTokens: deferredTools.length ? estimateToolSchemaTokens(deferredTools, tokenizer) : 0
  }
  mcpUsageCache.set(session, result)
  return result
}

function autoCompactionOverrides(value: unknown): AutoCompactionOverrides {
  if (!isRecord(value)) return {}
  return {
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
    ...(value.thresholdPercent === 70 ||
    value.thresholdPercent === 80 ||
    value.thresholdPercent === 90
      ? { thresholdPercent: value.thresholdPercent }
      : {})
  }
}

function applyAutoCompactionOverrides(
  settings: Settings,
  overrides: AutoCompactionOverrides
): void {
  let baseline = autoCompactionBaselines.get(settings)
  if (!baseline) {
    baseline = {
      enabled: settings.get('compaction.enabled'),
      thresholdPercent: settings.get('compaction.thresholdPercent'),
      thresholdTokens: settings.get('compaction.thresholdTokens'),
      methodOrder: [...settings.get('compaction.methodOrder')]
    }
    autoCompactionBaselines.set(settings, baseline)
  }
  settings.override('compaction.enabled', overrides.enabled ?? baseline.enabled)
  settings.override(
    'compaction.thresholdPercent',
    overrides.thresholdPercent ?? baseline.thresholdPercent
  )
  // The SDK gives a fixed token limit precedence over a percentage preset.
  settings.override(
    'compaction.thresholdTokens',
    overrides.thresholdPercent === undefined ? baseline.thresholdTokens : -1
  )
  if (
    overrides.enabled === true &&
    resolveCompactionMethodOrder(baseline.methodOrder).length === 0
  ) {
    settings.override('compaction.methodOrder', [...DEFAULT_COMPACTION_METHOD_ORDER])
  } else {
    settings.override('compaction.methodOrder', [...baseline.methodOrder])
  }
}

async function readAutoCompactionDefaults(params: unknown): Promise<AutoCompactionDefaults> {
  const record = isRecord(params) ? params : {}
  const settings = await Settings.loadReadOnly({
    cwd: stringValue(record.cwd, process.cwd()),
    agentDir: stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  })
  return {
    enabled:
      settings.get('compaction.enabled') &&
      resolveCompactionMethodOrder(settings.get('compaction.methodOrder')).length > 0,
    thresholdPercent: settings.get('compaction.thresholdPercent'),
    thresholdTokens: settings.get('compaction.thresholdTokens')
  }
}

function setSessionAutoCompactionSettings(params: unknown): AutoCompactionDefaults {
  const record = isRecord(params) ? params : {}
  const session = getSession(record.sessionId).session
  applyAutoCompactionOverrides(session.settings, autoCompactionOverrides(record.overrides))
  return {
    enabled: session.autoCompactionEnabled,
    thresholdPercent: session.settings.get('compaction.thresholdPercent'),
    thresholdTokens: session.settings.get('compaction.thresholdTokens')
  }
}

function contextTokensNow(session: CreateAgentSessionResult['session']): number | undefined {
  try {
    const tokens = session.getContextUsage()?.tokens
    return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined
  } catch {
    return undefined
  }
}

function compactedTokensAfter(session: CreateAgentSessionResult['session']): number | undefined {
  try {
    const leaf = session.sessionManager.getLeafEntry()
    if (
      leaf?.type === 'compaction' &&
      typeof leaf.tokensAfter === 'number' &&
      Number.isFinite(leaf.tokensAfter) &&
      leaf.tokensAfter >= 0
    ) {
      return leaf.tokensAfter
    }
    return contextTokensNow(session)
  } catch {
    return undefined
  }
}

async function compactSession(params: unknown): Promise<{
  summary: ContextCompactionSummary
  state: ReturnType<typeof serializeSessionState>
}> {
  const record = isRecord(params) ? params : {}
  const entry = getSession(record.sessionId)
  if (entry.session.isCompacting) throw new Error('上下文压缩正在进行')
  const result = await entry.session.compact()
  const tokensAfter = compactedTokensAfter(entry.session)
  return {
    summary: {
      summary: result.summary,
      ...(result.shortSummary ? { shortSummary: result.shortSummary } : {}),
      tokensBefore: result.tokensBefore,
      ...(tokensAfter === undefined ? {} : { tokensAfter })
    },
    state: serializeSessionState(entry)
  }
}

async function enterSessionPlanMode(params: unknown): Promise<{ enabled: true }> {
  const record = isRecord(params) ? params : {}
  const runtimeSessionId = stringValue(record.sessionId)
  const { session } = getSession(runtimeSessionId)
  const sessionManager = session.sessionManager
  const localProtocolOptions = {
    getArtifactsDir: () => sessionManager.getArtifactsDir(),
    getSessionId: () => sessionManager.getSessionId()
  }
  await enterPlanReviewMode(
    session,
    async (title, planFilePath) => {
      const proposal = await resolveApprovedPlan({
        suppliedTitle: title,
        statePlanFilePath: planFilePath,
        readPlan: (path) =>
          readPlanFile(path, { localProtocolOptions, cwd: sessionManager.getCwd() }),
        listPlanFiles: () => listPlanFiles({ localProtocolOptions })
      })
      return {
        title: proposal.title,
        content: proposal.planContent,
        planFilePath: proposal.planFilePath
      }
    },
    async (proposal) =>
      (await requestHost('planReview.request', {
        runtimeSessionId,
        title: proposal.title,
        planContent: proposal.content,
        planFilePath: proposal.planFilePath
      })) as PlanReviewChoice
  )
  return { enabled: true }
}

/** A delegation card steers or stops the agent run it shows (see agent/agents/run-control.ts). */
async function controlSessionAgentRun(
  action: 'steer' | 'stop',
  params: unknown
): Promise<{ ok: true }> {
  const record = isRecord(params) ? params : {}
  return controlAgentRun(sessions.get(stringValue(record.sessionId))?.agentRuns, action, record)
}

function listSessionShellJobs(): unknown[] {
  return [...sessions.entries()].flatMap(([agentSessionId, entry]) => {
    const manager = entry.result.session.asyncJobManager
    if (!manager) return []
    return manager.getAllJobs().flatMap((job) => {
      if (job.type !== 'bash') return []
      const output = (job.errorText || job.resultText || '').trim()
      return [
        {
          agentSessionId,
          jobId: job.id,
          state: job.queued && job.status === 'running' ? 'queued' : job.status,
          command: job.label,
          startedAt: job.startTime,
          ...(output ? { output: output.slice(-400) } : {})
        }
      ]
    })
  })
}

function cancelSessionShellJob(params: unknown): { ok: boolean } {
  const record = isRecord(params) ? params : {}
  const entry = sessions.get(stringValue(record.sessionId))
  const jobId = stringValue(record.jobId)
  const manager = entry?.result.session.asyncJobManager
  if (!entry || !jobId || !manager) return { ok: false }
  return { ok: manager.cancel(jobId) }
}

async function listSessionAgentRuns(): Promise<unknown[]> {
  return [...sessions.entries()].flatMap(([agentSessionId, entry]) =>
    (entry.agentRuns?.list() ?? [])
      .filter((run) => run.background)
      .map((run) => ({
        agentSessionId,
        agentRunId: run.id,
        agentName: run.agent,
        task: run.task,
        state: run.state,
        background: run.background,
        startedAt: run.startedAt,
        ...(run.completedAt !== undefined ? { completedAt: run.completedAt } : {}),
        ...(run.lastStep ? { lastStep: run.lastStep } : {}),
        ...(run.toolCalls !== undefined ? { toolCalls: run.toolCalls } : {}),
        ...(run.toolCallId ? { toolCallId: run.toolCallId } : {})
      }))
  )
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
  // Background runs outlive their tool call, not their conversation. Stopping them is the
  // session going away, not news, so it is not announced.
  const entry = sessions.get(sessionId)
  entry?.stopAgentRunNotices?.()
  entry?.agentRuns?.stopAll()
  sessions.delete(sessionId)
  await result.session.dispose()
}

async function setSessionModel(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const result = getSession(record.sessionId)
  const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
  const ctx = await getContext(agentDir)
  const model = await modelBySelector(ctx, record.model)
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

function userMessageText(message: unknown): string | null {
  if (!isRecord(message) || message.role !== 'user') return null
  if (message.synthetic === true) return null
  if (typeof message.content === 'string') return message.content
  if (!Array.isArray(message.content)) return null
  return message.content
    .filter((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string')
    .map((part) => (part as { text: string }).text)
    .join('')
}

async function forkSession(params: unknown): Promise<{ path: string }> {
  const record = isRecord(params) ? params : {}
  const path = stringValue(record.path)
  const cwd = stringValue(record.cwd)
  const userMessages = record.userMessages
  const selectedIndex = record.selectedIndex
  if (
    !path ||
    !cwd ||
    !Array.isArray(userMessages) ||
    !userMessages.every((value) => typeof value === 'string') ||
    typeof selectedIndex !== 'number' ||
    !Number.isInteger(selectedIndex) ||
    selectedIndex < 0 ||
    selectedIndex >= userMessages.length
  ) {
    throw new Error('无效的会话分叉请求')
  }
  const manager = await SessionManager.open(path, undefined, undefined, { initialCwd: cwd })
  try {
    const branch = manager.getBranch()
    let searchFrom = 0
    const matched: number[] = []
    for (const text of userMessages) {
      const index = branch.findIndex(
        (entry, index) =>
          index >= searchFrom && entry.type === 'message' && userMessageText(entry.message) === text
      )
      if (index < 0) throw new Error('会话历史与界面消息无法对应，请重新打开会话后重试')
      matched.push(index)
      searchFrom = index + 1
    }
    const nextUserIndex = matched[selectedIndex + 1]
    const leaf = branch[(nextUserIndex ?? branch.length) - 1]
    if (!leaf) throw new Error('无法定位会话分叉点')
    const forkPath = manager.createBranchedSession(leaf.id)
    if (!forkPath) throw new Error('无法保存分叉会话')
    if (path.endsWith('.jsonl') && forkPath.endsWith('.jsonl')) {
      const sourceArtifacts = path.slice(0, -6)
      if (existsSync(sourceArtifacts))
        cpSync(sourceArtifacts, forkPath.slice(0, -6), { recursive: true })
    }
    return { path: forkPath }
  } finally {
    await manager.close()
  }
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
    case 'mcp.featuredTools': {
      const id = isRecord(params) ? stringValue(params.id) : ''
      const connector = featuredMcpConnectors.find((entry) => entry.id === id)
      if (!connector || (connector.signIn === '需要登录' && !connector.oauthAuthorizationOrigin)) {
        throw new Error('该连接器需要授权，暂无法读取实际工具列表')
      }
      const authStorage = connector.oauthAuthorizationOrigin
        ? (await getContext()).authStorage
        : undefined
      if (authStorage && !authStorage.get(mcpOAuthCredentialId(connector.url))) {
        throw new Error(`请先授权登录 ${connector.name}`)
      }
      const apiKey = connector.apiKey
        ? await requestHost('mcp.featuredApiKey', { id: connector.id })
        : undefined
      if (connector.apiKey && (typeof apiKey !== 'string' || !apiKey)) {
        throw new Error(`请先保存 ${connector.name} API key 并添加连接器`)
      }
      return listFeaturedMcpTools(
        connector.id,
        connector.url,
        authStorage,
        typeof apiKey === 'string' ? apiKey : undefined
      )
    }
    case 'mcp.syncFeaturedApiKeys': {
      const id = isRecord(params) ? stringValue(params.id) : ''
      await syncFeaturedApiKeys(id || undefined)
      return undefined
    }
    case 'mcp.applyConnectorEnabled': {
      const name = isRecord(params) ? stringValue(params.name) : ''
      if (!name) return undefined
      await applyConnectorEnabled(name)
      return undefined
    }
    case 'mcp.featuredAuthStatus': {
      const id = isRecord(params) ? stringValue(params.id) : ''
      const connector = featuredMcpConnectors.find(
        (entry) => entry.id === id && entry.oauthAuthorizationOrigin
      )
      if (!connector) throw new Error('该连接器尚不支持登录状态查询')
      const { authStorage } = await getContext()
      return authStorage.get(mcpOAuthCredentialId(connector.url))?.type === 'oauth'
    }
    case 'mcp.cancelFeaturedAuth': {
      const id = isRecord(params) ? stringValue(params.id) : ''
      featuredAuthAbort.get(id)?.abort('授权已取消')
      return undefined
    }
    case 'mcp.authorizeFeatured': {
      const id = isRecord(params) ? stringValue(params.id) : ''
      const connector = featuredMcpConnectors.find(
        (entry) => entry.id === id && entry.oauthAuthorizationOrigin
      )
      if (!connector) throw new Error('该连接器尚不支持 OAuth 授权')
      const ctx = await getContext()
      const cancel = new AbortController()
      featuredAuthAbort.set(id, cancel)
      try {
        await authorizeFeaturedMcp(
          connector.url,
          ctx.authStorage,
          (url) => requestHost('mcp.openAuthUrl', { id, url }) as Promise<void>,
          cancel.signal
        )
      } finally {
        featuredAuthAbort.delete(id)
      }
      return undefined
    }
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
    case 'session.contextUsage':
      return sessionContextUsage(params)
    case 'settings.autoCompactionDefaults':
      return readAutoCompactionDefaults(params)
    case 'settings.webSearch.get': {
      const agentDir = isRecord(params)
        ? stringValue(params.agentDir, process.env.PI_CODING_AGENT_DIR)
        : stringValue(process.env.PI_CODING_AGENT_DIR)
      const settings = await Settings.loadReadOnly({ cwd: agentDir, agentDir })
      return webSearchSettingsFromValues({
        order: settings.get('providers.webSearchOrder'),
        excluded: settings.get('providers.webSearchExclude'),
        endpoint: settings.get('searxng.endpoint'),
        engines: settings.get('searxng.engines')
      })
    }
    case 'settings.webSearch.update': {
      const record = isRecord(params) ? params : {}
      const agentDir = stringValue(record.agentDir, process.env.PI_CODING_AGENT_DIR)
      const next = normalizeWebSearchSettingsPatch(record.patch)
      const settings = await Settings.init({ cwd: agentDir, agentDir })
      settings.set('providers.webSearchOrder', next.order)
      settings.set('providers.webSearchExclude', next.excluded)
      settings.set('searxng.endpoint', next.endpoint)
      settings.set('searxng.engines', next.engines)
      await settings.flush()
      applyProviderGlobalsFromSettings(settings)
      const persisted = await Settings.loadReadOnly({ cwd: agentDir, agentDir })
      return webSearchSettingsFromValues({
        order: persisted.get('providers.webSearchOrder'),
        excluded: persisted.get('providers.webSearchExclude'),
        endpoint: persisted.get('searxng.endpoint'),
        engines: persisted.get('searxng.engines')
      })
    }
    case 'settings.webSearch.searxngEngines': {
      const agentDir = isRecord(params)
        ? stringValue(params.agentDir, process.env.PI_CODING_AGENT_DIR)
        : stringValue(process.env.PI_CODING_AGENT_DIR)
      const settings = await Settings.loadReadOnly({ cwd: agentDir, agentDir })
      return listSearxngEngines({
        endpoint: settings.get('searxng.endpoint'),
        token: settings.get('searxng.token'),
        basicUsername: settings.get('searxng.basicUsername'),
        basicPassword: settings.get('searxng.basicPassword')
      })
    }
    case 'session.setAutoCompactionSettings':
      return setSessionAutoCompactionSettings(params)
    case 'session.compact':
      return compactSession(params)
    case 'session.plan.enter':
      return enterSessionPlanMode(params)
    case 'session.abort':
      return abortSession(params)
    case 'session.dispose':
      return disposeSession(params)
    case 'agentRun.steer':
      return controlSessionAgentRun('steer', params)
    case 'agentRun.stop':
      return controlSessionAgentRun('stop', params)
    case 'agentRuns.list':
      return listSessionAgentRuns()
    case 'shellJobs.list':
      return listSessionShellJobs()
    case 'shellJobs.cancel':
      return cancelSessionShellJob(params)
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
    case 'sessions.fork':
      return forkSession(params)
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
