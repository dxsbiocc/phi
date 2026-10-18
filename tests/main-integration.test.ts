import * as runtimeRecoveryIpc from '../src/main/agent/session/runtime-recovery-ipc'
import * as recoverySummary from '../src/main/agent/session/recovery-summary'
import * as recoveryFailures from '../src/main/agent/engine/rpc/session-recovery'
import * as runtimeReference from '../src/main/agent/session/runtime-reference'
import { createWrapperJobHostScope } from '../src/main/agent/wrappers/composition/job-host-handlers'
import { createWebLinkPreviewService } from '../src/main/web-link-preview'
import * as permissionModeControl from '../src/main/agent/session/permission-mode-control'
import * as workspaceFileIpc from '../src/main/workspace-file-ipc'
import * as nativeUiCopy from '../src/main/native-ui-copy'
import { systemUiLanguage } from '../src/shared/uiLanguage'
import * as runtimeSelection from '../src/main/agent/engine/rpc/runtime-selection-control'
import * as desktopWebSearch from '../src/main/agent/engine/rpc/desktop-websearch-adapter'
import * as desktopMcp from '../src/main/agent/engine/rpc/desktop-mcp-adapter'
import * as remoteLibrary from '../src/main/agent/engine/rpc/remote-library-service'
import { controlRemoteRuntimeWorkspace } from '../src/main/agent/remote-runtime/controller'
import { NotebookToolHostRouter } from '../src/main/agent/notebook/notebook-tool-host-router'
import { discoverPhiAgents } from '../src/main/agent/agents/discovery'
import * as connectorSetup from '../src/main/agent/mcp/connector-setup'
import { createInProcessEngine } from '../src/main/agent/engine/in-process-engine'
import * as engineEvents from '../src/main/agent/engine/events'
import type { OmpBridge } from '../src/main/agent/engine/omp-bridge'
import * as windowStartup from '../src/main/window-startup'
import { loadRemoteWrapperAgent } from '../src/main/agent/agents/remote-wrapper-agent'
import { BackgroundAgentApprovalTracker } from '../src/main/agent/agents/background-approval'
import * as jobContinue from '../src/main/agent/wrappers/composition/job-continue'
import { MAX_AUTOMATIC_CONTINUATIONS } from '../src/main/agent/wrappers/composition/job-continue'
import { deliverWrapperRunFinished } from '../src/main/agent/wrappers/composition/job-notify'
import { buildAgentLeaderPrompt } from '../src/main/agent/agents/leader-prompt'
import { isSecretMetadataKey } from '../src/main/agent/redaction'
import * as agentRunContinue from '../src/main/agent/agents/run-continue'
import { agentRunHostHandlers } from '../src/main/agent/agents/run-host'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import * as notebookCodeGeneration from '../src/main/agent/notebook/notebook-code-generation'
import * as notebookCompletion from '../src/main/agent/notebook/notebook-completion'
import * as lifecycle from '../src/main/agent/session/session-lifecycle'
import * as automaticModelFallback from '../src/main/agent/session/automatic-model-fallback'
import * as notebookDocument from '../src/shared/notebookDocument'
import * as notebookExecutionMetadata from '../src/shared/notebookExecutionMetadata'
import * as sessionTitle from '../src/shared/sessionTitle'
import * as sessionTitleGeneration from '../src/main/agent/session/session-title-generation'
import * as htmlReportPreview from '../src/shared/htmlReportPreview'
import * as phiPluginProblems from '../src/shared/phiPluginProblems'
import * as projectMemoryTypes from '../src/shared/projectMemoryTypes'
import * as remoteJupyterStartJobs from '../src/main/agent/notebook/remote-jupyter-start-jobs'
import * as notebookAiGenerationJobs from '../src/main/agent/notebook/notebook-ai-generation-jobs'
import type { NotebookAiGenerationJob } from '../src/shared/notebookAiJobTypes'
import * as appUpdateCheck from '../src/main/app-update-check'
import * as phiPluginDetails from '../src/main/agent/plugins/details'
import type { WorkspaceChangeSummary } from '../src/shared/workspaceChangeTypes'
import type { ContextUsageSnapshot } from '../src/shared/contextUsageTypes'
import type { HomeActivitySummary } from '../src/shared/homeActivityTypes'
import { declaredExternalOutputRoot } from '../src/shared/wrapperResultTypes'
import { hoverMediaPreviewType, mediaPreviewType } from '../src/main/file-preview-media'
import { createBeforeQuitHandler } from '../src/main/app-quit'
import { validateWrapperResultDownloadRequest } from '../src/main/agent/wrappers/remote-result-download'
import * as localFileAccess from '../src/main/agent/local-file-access'
import * as browserIpc from '../src/main/browser/browser-ipc'
import * as browserToolHost from '../src/main/agent/browser/browser-tool-host'
import * as browserWorkspaceRegistry from '../src/main/browser/browser-workspace-registry'
import { validRemoteAbsolutePath } from '../src/main/agent/remote-workspace-boundary'
import { isRemotePathInside } from '../src/main/agent/remote-path-containment'
import * as electronBrowserEngine from '../src/main/browser/electron-browser-engine'
import { assertBoundaryIdentity } from './helpers/remoteBoundaryIdentity'
import * as capabilityApproval from '../src/main/agent/packages/capability-approval'
import * as capabilityHost from '../src/main/agent/packages/capability-host'
import * as capabilityService from '../src/main/agent/packages/capability-service'
import * as externalSkills from '../src/main/agent/packages/external-skills'
import type {
  LocalRegistry,
  RegistryPackageEntry
} from '../src/main/agent/packages/installer-types'

const fixtureStateDir = mkdtempSync(path.join(tmpdir(), 'phi-main-integration-'))

function assertRemoteWorkspaceFileRequest(
  input: unknown
): asserts input is { sessionId: string; projectId: string; path: string } {
  assert.ok(typeof input === 'object' && input !== null && !Array.isArray(input))
  const record = input as Record<string, unknown>
  assert.deepEqual(
    Object.keys(record).sort(),
    ['path', 'projectId', 'sessionId'],
    'remote file request fake must reject undeclared fields'
  )
  assertBoundaryIdentity({ sessionId: record.sessionId, projectId: record.projectId })
  assert.equal(typeof record.sessionId, 'string')
  assert.notEqual(record.sessionId, '')
  assert.equal(typeof record.projectId, 'string')
  assert.notEqual(record.projectId, '')
  assert.equal(typeof record.path, 'string')
  assert.notEqual(record.path, '')
}

const pendingStartupWindows = new Set<EventEmitter>()
test.after(() => {
  try {
    // Shown or closed startup controllers clear their deadlines. A hidden
    // fixture left here would retain a timer even after this suite completes.
    assert.equal(pendingStartupWindows.size, 0, 'all startup gates must finish or be disposed')
  } finally {
    rmSync(fixtureStateDir, { recursive: true, force: true })
  }
})

const officialRegistryFixture = {
  id: 'phi-packages',
  dir: `/isolated/cache/registries/phi-packages/generations/${'a'.repeat(64)}`,
  trust: 'official',
  schemaVersion: 1,
  generatedAt: '2026-10-08T00:00:00.000Z',
  packages: []
}
const officialConnectorRegistryFixture = {
  ...officialRegistryFixture,
  dir: `/isolated/cache/registries/phi-connectors-api/generations/${'b'.repeat(64)}`,
  kind: 'official',
  trust: 'imported',
  label: 'Phi 官网'
}
const installedFigurePreviewFixture =
  '/installed/packages/plugin/visualization/1.0.0/skills/omics-visualization/preview.png'
const bundledCreateWrapperSkillDir = path.join(
  process.cwd(),
  'resources',
  'skills',
  'create-wrapper'
)
const bundledCreateWrapperGuideFixture = path.join(
  bundledCreateWrapperSkillDir,
  'references',
  'guide.md'
)

const officialSourceDetailsFixture = {
  id: 'phi-packages',
  kind: 'official',
  label: 'Phi Packages',
  path: 'phi-packages',
  removable: false,
  trust: 'official',
  status: 'ready',
  packageCount: 0
}

const connectorCatalogFixture = [
  {
    id: 'notion',
    version: '1.0.0',
    name: 'Notion',
    description: 'Notion connector',
    publisher: 'Notion',
    category: '生产力',
    signIn: '需要登录',
    transport: 'http',
    auth: 'oauth',
    url: 'https://mcp.notion.com/mcp',
    registryDir: officialRegistryFixture.dir,
    added: false
  },
  {
    id: 'composio',
    version: '1.0.0',
    name: 'Composio Connect',
    description: 'Composio connector',
    publisher: 'Composio',
    category: '生产力',
    signIn: '需要登录',
    transport: 'http',
    auth: 'oauth',
    url: 'https://connect.composio.dev/mcp',
    registryDir: officialRegistryFixture.dir,
    added: false
  },
  {
    id: 'pubmed',
    version: '1.0.0',
    name: 'PubMed',
    description: 'PubMed connector',
    publisher: 'Anthropic',
    category: '健康与生命科学',
    signIn: '无需登录',
    transport: 'http',
    auth: 'none',
    url: 'https://pubmed.mcp.claude.com/mcp',
    registryDir: officialRegistryFixture.dir,
    added: false
  },
  {
    id: 'cbioportal',
    version: '1.0.0',
    name: 'cBioPortal',
    description: 'cBioPortal connector',
    publisher: 'cBioPortal',
    category: '健康与生命科学',
    signIn: '需要登录',
    transport: 'http',
    auth: 'oauth',
    url: 'https://mcp.cbioportal.org/db/mcp',
    registryDir: officialRegistryFixture.dir,
    added: false
  },
  ...[
    ['tavily', 'https://mcp.tavily.com/mcp'],
    ['serpapi', 'https://mcp.serpapi.com/mcp'],
    ['firecrawl', 'https://mcp.firecrawl.dev/v2/mcp'],
    ['browser-use', 'https://api.browser-use.com/v3/mcp']
  ].map(([id, url]) => ({
    id,
    version: '1.0.0',
    name: id,
    description: `${id} connector`,
    publisher: id,
    category: '生产力',
    signIn: '需要凭据',
    transport: 'http',
    auth: 'header',
    url,
    registryDir: officialRegistryFixture.dir,
    added: false
  }))
]

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function fakeBashApprovalDigest(input: Record<string, unknown>): string {
  const env =
    input.env && typeof input.env === 'object' && !Array.isArray(input.env)
      ? Object.fromEntries(
          Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right))
        )
      : input.env
  return JSON.stringify({
    command: input.command,
    cwd: input.cwd,
    timeout: input.timeout,
    env,
    pty: input.pty,
    async: input.async
  })
}

function fakeWriteApprovalDigest(input: Record<string, unknown>): string {
  return JSON.stringify({ path: input.path, content: input.content, operation: 'write' })
}

function fakeEditApprovalDigest(input: Record<string, unknown>): string {
  return JSON.stringify({
    path: input.path,
    old_string: input.old_string,
    new_string: input.new_string,
    replace_all: input.replace_all,
    operation: 'edit'
  })
}

type PromptOptions = {
  preflightResult?: (accepted: boolean) => void
  images?: Array<{ type: 'image'; data: string; mimeType: string }>
  expandPromptTemplates?: boolean
  synthetic?: boolean
  userInitiated?: boolean
  skipCompactionCheck?: boolean
}
let fakeRuntimeSessionCounter = 0

type CompactionControl = { assertCurrent(): void }

class FakeSession {
  readonly runtimeSessionId = `runtime-${++fakeRuntimeSessionCounter}`
  readonly messages: unknown[] = []
  readonly listeners: Array<(event: unknown) => void> = []
  readonly log: string[] = []
  readonly promptTexts: string[] = []
  readonly promptOptions: PromptOptions[] = []
  readonly sessionNameCalls: string[] = []
  hasActiveAgentRuns?: () => boolean
  readonly sessionManager = {
    setSessionName: async (
      name: string,
      _source?: 'user' | 'auto',
      control?: CompactionControl
    ): Promise<boolean> => {
      void _source
      control?.assertCurrent()
      this.sessionNameCalls.push(name)
      return true
    }
  }
  model?: { provider: string; id: string; supportsImages?: boolean }
  thinkingLevel?: string
  preflight = Promise.resolve()
  abortGate = Promise.resolve()
  readonly finish = deferred<void>()
  toolEvents: unknown[] = []
  hold = false
  started = false
  disposed = false
  skipFinalAssistantMessage = false
  promptError?: Error
  materializedSessionFile?: string
  contextUsage: ContextUsageSnapshot | null = null
  contextUsageGate = Promise.resolve()
  autoCompactionOverrides: { enabled?: boolean; thresholdPercent?: 70 | 80 | 90 } = {}
  autoCompactionSettingsCalls = 0
  getAutoCompactionSettings?: (control?: CompactionControl) => Promise<{
    enabled: boolean
    thresholdPercent: number
    thresholdTokens: number
    defaults?: { enabled: boolean; thresholdPercent: number; thresholdTokens: number }
  }>
  compactCalls = 0
  compactGate = Promise.resolve()
  compactError?: Error
  constructor(public sessionFile: string | undefined) {}
  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener)
    return () => undefined
  }
  async prompt(text: string, options?: PromptOptions): Promise<void> {
    this.promptTexts.push(text)
    this.promptOptions.push(options ?? {})
    await this.preflight
    options?.preflightResult?.(true)
    this.started = true
    this.log.push('started')
    for (const event of this.toolEvents) {
      this.listeners.forEach((listener) => listener(event))
    }
    this.sessionFile ??= this.materializedSessionFile
    if (this.promptError) throw this.promptError
    if (this.hold) await this.finish.promise
    if (!this.skipFinalAssistantMessage) {
      this.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'done' }] })
    }
    this.log.push('saved')
  }
  async abort(): Promise<void> {
    this.log.push('abort')
    await this.abortGate
    if (this.started) this.finish.resolve()
  }
  async getContextUsage(): Promise<{
    tokens: number
    contextWindow: number
    percent: number
  } | null> {
    await this.contextUsageGate
    return this.contextUsage
  }
  async setAutoCompactionSettings(
    overrides: {
      enabled?: boolean
      thresholdPercent?: 70 | 80 | 90
    },
    control?: CompactionControl
  ): Promise<unknown> {
    control?.assertCurrent()
    this.autoCompactionSettingsCalls += 1
    this.autoCompactionOverrides = { ...overrides }
    return undefined
  }
  async compact(control?: CompactionControl): Promise<{
    summary: string
    shortSummary: string
    tokensBefore: number
    tokensAfter?: number
  }> {
    control?.assertCurrent()
    this.compactCalls += 1
    await this.compactGate
    control?.assertCurrent()
    if (this.compactError) throw this.compactError
    return {
      summary: 'Earlier work was summarized.',
      shortSummary: 'Earlier work',
      tokensBefore: 24000,
      ...(this.contextUsage ? { tokensAfter: this.contextUsage.tokens } : {})
    }
  }
  dispose(): void {
    this.log.push('dispose')
    this.disposed = true
  }
  async setModel(model: { provider: string; id: string; supportsImages?: boolean }): Promise<void> {
    this.model = model
  }
  setThinkingLevel(level: string): void {
    this.thinkingLevel = level
  }
}

type Handler = (_event: unknown, ...args: unknown[]) => unknown
type HostContext = {
  originSessionId?: string
  agentRunId?: string
  toolCallId?: string
  signal?: AbortSignal
}
type HostHandler = (params: unknown, context?: HostContext) => Promise<unknown>
type HarnessOptions = {
  systemLanguages?: string[]
  uiLanguage?: 'en' | 'zh-CN'
  capabilityServiceCreate?: typeof capabilityService.createCapabilityService
  officialPackageEntries?: RegistryPackageEntry[]
  customPackageRegistries?: LocalRegistry[]
  moduleApproval?: (
    request: Record<string, unknown>,
    signal: AbortSignal
  ) => Promise<'approved' | 'denied' | 'cancelled'>
  lastSelectedModel?: { providerId: string; modelId: string } | null
  remoteDefaultModel?: { providerId: string; modelId: string } | null
  titleRequest?: sessionTitleGeneration.SessionTitleGeneratorOptions['request']
  useTitleRuntime?: boolean
  holdRendererReady?: boolean
  environmentGet?: () => Promise<unknown>
  modelRuntimeGet?: () => Promise<void>
  notebookOpenError?: Error
  remoteRpc?: boolean
  remoteRpcResources?: boolean
  remoteNotebookBinding?: () => string
  remoteNotebookBackendCreate?: () => void
  remotePresentGate?: Promise<void>
  onRemotePresentInspect?: () => void
  routedRuntime?: (id: string) => boolean
  compactionDefaultsRead?: () => Promise<{
    enabled: boolean
    thresholdPercent: number
    thresholdTokens: number
  }>
  rpcCompactionPolicyRead?: (overrides: Record<string, unknown>) => Promise<unknown>
  remoteHostBinding?: () => string
  remoteWrapperTarget?: boolean
  remoteMemorySettings?: { enabled: boolean; learn: boolean }
  personaRead?: () => string
  remoteInstructionsRead?: () => Promise<Array<{ path: string; content: string }>>
  projectMemoryRetire?: (projectId: string) => Promise<void>
  projectMemoryAdapterCreate?: (options: Record<string, unknown>) => Promise<unknown>
  remoteResourceScripts?: () => Promise<{ tools: unknown[]; problems: string[] }>
  coldRuntimeOrigin?: (id: string) => { phiSessionId: string; cwd: string } | undefined
  remoteRuntimeWorkspace?: () => Promise<unknown>
  readyEnvironmentRead?: () => Promise<unknown>
  coldChildRuns?: (phiSessionId: string) => readonly Record<string, unknown>[]
  runtimeSessionReady?: () => boolean
  childResourceOwner?: (
    runtimeId: string,
    childId: string
  ) => { readonly toolOwner: string; readonly allowedSkills: readonly string[] }
  remoteScriptRun?: (
    params: unknown,
    control?: import('../src/main/agent/remote-runtime/controller').RemoteRuntimeDispatchControl
  ) => Promise<unknown>
  onCreateSession?: (
    options: Record<string, unknown>,
    control?: { signal?: AbortSignal; assertCurrent(): void }
  ) => Promise<void>
}
type BrowserIntegrationView = {
  options: { webPreferences: { partition: string; [key: string]: unknown } }
  webContents: EventEmitter & {
    loadedUrls: string[]
    closeCalls: number
    closeError: Error | null
  }
  bounds: Array<{ x: number; y: number; width: number; height: number }>
  visibility: boolean[]
}
type HarnessResult = {
  hostHandlers: Map<string, HostHandler>
  setAgentInteractionResponse: (response: Record<string, unknown>) => void
  setBridgeAgentJobs: (jobs: unknown[]) => void
  bridgeRequests: Array<{ method: string; params: unknown }>
  bridgeStopCount: () => number
  failBridgeRequests: (error: Error | undefined) => void
  failMcpApiKeyValidation: (error: Error | undefined) => void
  mcpApiKeyValidationCallCount: () => number
  setCustomMcpBridgeRequest: (
    handler: (method: string, params: unknown) => Promise<unknown>
  ) => void
  setCustomRemoteConnector: (
    name: string,
    connector:
      { name: string; url: string; oauth: { clientId: string; clientSecret?: string } } | undefined
  ) => void
  addedRemoteMcpConnectors: Array<{
    name: string
    url: string
    agentDir?: string
    options?: unknown
  }>
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
  invokeFromForeign: (channel: string, ...args: unknown[]) => Promise<unknown>
  sessions: FakeSession[]
  deleted: string[]
  events: Array<{ channel: string; data: unknown }>
  approvalOptions: Array<Record<string, unknown>>
  runnerEvents: Array<Record<string, unknown>>
  runStartInputs: Array<Record<string, unknown>>
  createdPhiSessions: Array<Record<string, unknown>>
  remoteConnectionChecks: Array<{ sessionId: string; projectId: string }>
  remoteAgentMutations: Array<{ operation: 'trust' | 'revoke'; input: Record<string, unknown> }>
  remoteSkillMutations: Array<{ operation: 'trust' | 'revoke'; input: Record<string, unknown> }>
  remoteMcpMutations: Array<{ operation: 'trust' | 'revoke'; input: Record<string, unknown> }>
  wrapperJobOptions: Record<string, unknown>
  remoteResolverProjectIds: string[]
  remoteDoctorCalls: Array<{ hostProfileId: string; remotePath?: string; options?: unknown }>
  remoteDirectoryCalls: Array<{ hostProfileId: string; path: string }>
  setWrapperPlan: (
    plan:
      | {
          revision?: number
          targetSelection?: {
            projectId: string
            target: string
            hostProfileId?: string
            remoteRoot?: string
            projectLocation?: { kind: string }
          }
        }
      | undefined
  ) => void
  setRemoteProjectPhase: (phase: 'reachable' | 'offline') => void
  retargetRequests: Array<Record<string, unknown>>
  submitPlanCalls: Array<{ planId: string; heavyWorkloadAcknowledged?: boolean }>
  setRemoteConnectionCheck: (impl: () => Promise<{ phase: string }>) => void
  createdAgentOptions: Array<Record<string, unknown>>
  remoteRoutingOptions: Array<Record<string, unknown>>
  renamedSessions: Array<{ path: string; name: string }>
  savedPersonas: string[]
  resourceLoaderOptions: Array<Record<string, unknown>>
  contentSourceCalls: Array<{
    phase: string
    source: string
    type?: string
    id?: string
    agentDir?: string
  }>
  contentFetchRequests: string[]
  updatedProjectDefaults: Array<Record<string, unknown>>
  updatedSessionManifests: Array<{ sessionId: string; patch: Record<string, unknown> }>
  appendedSessionEvents: Array<Record<string, unknown>>
  persistedToolOutputs: Array<Record<string, unknown>>
  revealedPaths: string[]
  openedPaths: string[]
  fileIconRequests: string[]
  execFileCalls: Array<{ file: string; args: string[] }>
  previewReadRequests: Array<{ filePath: string; length: number }>
  appLogs: Array<Record<string, unknown>>
  acknowledgedSessions: Array<{ file: string; cwd: string }>
  jupyterServerCalls: Array<{ action: string; cwd: string }>
  notebookSessionCalls: Array<{ action: string; cwd: string; path?: string }>
  remoteNotebookCalls: Array<{ action: string; path?: string }>
  notebookExecutionCalls: Array<{
    cellId: string
    source: string
    kernelId: string
    language?: string
    cursorPosition?: number
  }>
  setNotebookExecutionState: (state: 'idle' | 'error') => void
  notebookFormatCalls: Array<{
    projectCwd: string
    source: string
    language?: string
    lineLength?: number
  }>
  managedEnvironmentBuildCalls: Array<{
    ref: unknown
    projectCwd: unknown
    pluginId: unknown
  }>
  openDialogOptions: Array<Record<string, unknown>>
  saveDialogOptions: Array<Record<string, unknown>>
  downloadCalls: Array<{ request: unknown; destination: string }>
  setSaveDialogResult: (result: { canceled: boolean; filePath?: string }) => void
  setDownloadImpl: (
    impl: (
      request: unknown,
      destination: string,
      options: {
        signal: AbortSignal
        onProgress?: (progress: {
          requestId: string
          phase: 'downloading' | 'verifying' | 'saving'
          bytesDownloaded: number
          totalBytes: number
        }) => void
      }
    ) => Promise<unknown>
  ) => void
  operationLog: Array<Record<string, unknown>>
  setOpenDialogResult: (result: { canceled: boolean; filePaths: string[] }) => void
  exportedSessions: Array<{ sessionId: string; destination: string }>
  setWorkspaceChangeSummary: (summary: WorkspaceChangeSummary | null) => void
  setWorkspaceDiffPatch: (patch: string | null) => void
  savedWorkspaceDiff: () => string | undefined
  tryFrameNavigation: (input: { isMainFrame: boolean; frameName?: string; url: string }) => boolean
  browserViews: BrowserIntegrationView[]
  closeMainWindow: () => void
  activateApp: () => void
  browserWindowCount: () => number
  tryWindowOpen: (details: { url: string; disposition?: string; postBody?: unknown }) => {
    action: string
  }
  openedExternalUrls: string[]
  approvalResolveCalls: Array<{ requestId: string; approved: boolean; trusted: boolean }>
  beforeQuit: () => number
  appQuitCount: () => number
}

async function harness(
  factory?: (cwd: string, file: string) => Promise<FakeSession>,
  options: HarnessOptions = {}
): Promise<HarnessResult> {
  const harnessOptions = options
  const handlers = new Map<string, Handler>()
  const sessions: FakeSession[] = []
  const deleted: string[] = []
  const events: Array<{ channel: string; data: unknown }> = []
  const approvalOptions: Array<Record<string, unknown>> = []
  let appQuitCalls = 0
  const approvalResolveCalls: Array<{
    requestId: string
    approved: boolean
    trusted: boolean
  }> = []
  const resolvedApprovalIds = new Set<string>()
  const runnerEvents: Array<Record<string, unknown>> = []
  const runStartInputs: Array<Record<string, unknown>> = []
  const createdPhiSessions: Array<Record<string, unknown>> = []
  const remoteConnectionChecks: Array<{ sessionId: string; projectId: string }> = []
  const remoteAgentMutations: Array<{
    operation: 'trust' | 'revoke'
    input: Record<string, unknown>
  }> = []
  const remoteSkillMutations: Array<{
    operation: 'trust' | 'revoke'
    input: Record<string, unknown>
  }> = []
  const remoteMcpMutations: Array<{
    operation: 'trust' | 'revoke'
    input: Record<string, unknown>
  }> = []
  const wrapperJobOptions: Record<string, unknown> = {}
  const remoteResolverProjectIds: string[] = []
  const remoteDoctorCalls: Array<{
    hostProfileId: string
    remotePath?: string
    options?: unknown
  }> = []
  const remoteDirectoryCalls: Array<{ hostProfileId: string; path: string }> = []
  let wrapperPlan:
    | {
        revision?: number
        targetSelection?: {
          projectId: string
          target: string
          hostProfileId?: string
          remoteRoot?: string
          projectLocation?: { kind: string }
        }
      }
    | undefined
  let remoteProjectPhase: 'reachable' | 'offline' = 'reachable'
  const retargetRequests: Array<Record<string, unknown>> = []
  const submitPlanCalls: Array<{ planId: string; heavyWorkloadAcknowledged?: boolean }> = []
  let remoteConnectionCheck: () => Promise<{ phase: string }> = async () => ({ phase: 'reachable' })
  const createdAgentOptions: Array<Record<string, unknown>> = []
  const remoteRoutingOptions: Array<Record<string, unknown>> = []
  const renamedSessions: Array<{ path: string; name: string }> = []
  const savedPersonas: string[] = []
  let personaMarkdown = options.remoteRpc && !options.remoteRpcResources ? '' : 'persona'
  const resourceLoaderOptions: Array<Record<string, unknown>> = []
  const contentSourceCalls: Array<{
    phase: string
    source: string
    type?: string
    id?: string
    agentDir?: string
  }> = []
  const contentFetchRequests: string[] = []
  const updatedProjectDefaults: Array<Record<string, unknown>> = []
  const updatedSessionManifests: Array<{ sessionId: string; patch: Record<string, unknown> }> = []
  const appendedSessionEvents: Array<Record<string, unknown>> = []
  const enablementGlobal: Record<string, boolean> = {}
  const enablementProjects: Record<string, Record<string, boolean>> = {}
  let installedPhiPlugins: unknown[] = []
  let appFocused = true
  const reportedWrapperRuns = new Set<string>()
  const wrapperJobFinishListeners: Array<(run: unknown, status: unknown) => void> = []
  const hostHandlers = new Map<string, HostHandler>()
  let agentInteractionResponse: Record<string, unknown> = { answers: [] }
  let bridgeAgentJobs: unknown[] = []
  const bridgeRequests: Array<{ method: string; params: unknown }> = []
  let bridgeStops = 0
  const addedRemoteMcpConnectors: Array<{
    name: string
    url: string
    agentDir?: string
    options?: unknown
  }> = []
  const customRemoteConnectors = new Map<
    string,
    { name: string; url: string; oauth: { clientId: string; clientSecret?: string } }
  >()
  let customMcpBridgeRequest: ((method: string, params: unknown) => Promise<unknown>) | undefined
  const mcpApiKeys = new Map<string, string>()
  let mcpApiKeyValidationFailure: Error | undefined
  let mcpApiKeyValidationCalls = 0
  let bridgeFailure: Error | undefined
  const osNotifications: Array<{ title: string; body: string }> = []
  const persistedToolOutputs: Array<Record<string, unknown>> = []
  const revealedPaths: string[] = []
  const openedPaths: string[] = []
  const fileIconRequests: string[] = []
  const execFileCalls: Array<{ file: string; args: string[] }> = []
  const previewReadRequests: Array<{ filePath: string; length: number }> = []
  const exportedSessions: Array<{ sessionId: string; destination: string }> = []
  let workspaceChangeSummary: WorkspaceChangeSummary | null = null
  let workspaceDiffPatch: string | null = null
  let savedWorkspaceDiff: string | undefined
  let frameNavigationHandler:
    | ((event: {
        isMainFrame: boolean
        frame: { name: string } | null
        url: string
        preventDefault: () => void
      }) => void)
    | undefined
  const appLogs: Array<Record<string, unknown>> = []
  const acknowledgedSessions: Array<{ file: string; cwd: string }> = []
  const jupyterServerCalls: Array<{ action: string; cwd: string }> = []
  const notebookSessionCalls: Array<{ action: string; cwd: string; path?: string }> = []
  const remoteNotebookCalls: Array<{ action: string; path?: string }> = []
  let remoteNotebookState = 'stopped'
  const remoteNotebookDocument = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Remote Python', language: 'python', name: 'phi-python' }
    },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: 'print("ran")'
      }
    ]
  })
  const remoteNotebookFile = (
    path = '/canonical/project/notebooks/remote.ipynb'
  ): {
    path: string
    relativePath: string
    name: string
    bytes: number
    modifiedAt: string
    savedRevision: string
    contentHash: string
    document: notebookDocument.NotebookDocument
  } => ({
    path,
    relativePath: path.replace('/canonical/project/', ''),
    name: path.split('/').at(-1) ?? 'remote.ipynb',
    bytes: 256,
    modifiedAt: '2026-10-10T00:00:00.000Z',
    savedRevision: remoteNotebookDocument.revision,
    contentHash: 'remote-content-hash',
    document: remoteNotebookDocument
  })
  const notebookExecutionCalls: Array<{
    cellId: string
    source: string
    kernelId: string
    language?: string
    cursorPosition?: number
  }> = []
  let notebookExecutionState: 'idle' | 'error' = 'idle'
  const notebookFormatCalls: Array<{
    projectCwd: string
    source: string
    language?: string
    lineLength?: number
  }> = []
  const managedEnvironmentBuildCalls: Array<{
    ref: unknown
    projectCwd: unknown
    pluginId: unknown
  }> = []
  const openDialogOptions: Array<Record<string, unknown>> = []
  const saveDialogOptions: Array<Record<string, unknown>> = []
  const downloadCalls: Array<{ request: unknown; destination: string }> = []
  let downloadImpl: (
    request: unknown,
    destination: string,
    options: { signal: AbortSignal; onProgress?: (progress: unknown) => void }
  ) => Promise<unknown> = async (_request, destination) => ({
    status: 'saved',
    path: destination,
    bytes: 3,
    sha256: 'sha256:test',
    remoteDigestVerified: true
  })
  const operationLog: Array<Record<string, unknown>> = []
  const browserViews: BrowserIntegrationView[] = []
  const openedExternalUrls: string[] = []
  let windowOpenHandler:
    | ((details: { url: string; disposition?: string; postBody?: unknown }) => {
        action: string
      })
    | undefined
  const appNoProjectTaskFolder = '/workspace'
  let allowExternalFileRead = false
  let appUiLanguage = options.uiLanguage
  let systemLanguage: 'en' | 'zh-CN' = 'en'
  let openDialogResult: { canceled: boolean; filePaths: string[] } = {
    canceled: true,
    filePaths: []
  }
  let saveDialogResult: { canceled: boolean; filePath?: string } = { canceled: true }
  const previewFiles = new Map<string, Buffer>([
    ['/projects/current/src/App.tsx', Buffer.from('export const app = true\n')],
    ['/projects/current/README.md', Buffer.from('# Project\n')],
    ['/projects/current/qc-demo.csv', Buffer.from('sample_id,value_a\nS001,1.75\n')],
    ['/projects/current/notebooks/eda.ipynb', Buffer.from('{"nbformat":4,"cells":[]}')],
    ['/projects/current/large.txt', Buffer.alloc(320010, 'a')],
    ['/projects/current/plot.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    [installedFigurePreviewFixture, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])],
    ['/projects/current/photo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xd9])],
    ['/projects/current/animation.gif', Buffer.from('GIF89a\x01\x00\x01\x00', 'binary')],
    [
      '/projects/current/chart.webp',
      Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])
    ],
    [
      '/projects/current/large-plot.png',
      Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        Buffer.alloc(2 * 1024 * 1024, 0xff)
      ])
    ],
    ['/projects/current/report.pdf', Buffer.from('%PDF-1.7\n')],
    [
      '/projects/current/report.html',
      Buffer.from(
        '<!doctype html><html><body><h1>QC report</h1><script>alert(1)</script></body></html>'
      )
    ],
    ['/projects/other/secret.txt', Buffer.from('secret\n')],
    [bundledCreateWrapperGuideFixture, Buffer.from('# Agent-Facing Nextflow Wrappers\n')],
    ['/projects/saved/README.md', Buffer.from('# saved\n')],
    ['/isolated/sessions/session-1/tool-outputs/out.txt', Buffer.from('saved output\n')],
    ['/projects/current/binary.dat', Buffer.from([0, 1, 2])]
  ])
  const previewDirectories = new Map<string, Array<{ name: string; kind: 'directory' | 'file' }>>([
    [bundledCreateWrapperSkillDir, [{ name: 'references', kind: 'directory' }]],
    [path.join(bundledCreateWrapperSkillDir, 'references'), [{ name: 'guide.md', kind: 'file' }]],
    [
      '/projects/current',
      [
        { name: 'src', kind: 'directory' },
        { name: 'README.md', kind: 'file' },
        { name: 'large.txt', kind: 'file' }
      ]
    ],
    ['/projects/current/src', [{ name: 'App.tsx', kind: 'file' }]],
    ['/projects/saved', [{ name: 'README.md', kind: 'file' }]],
    [
      path.join(
        process.cwd(),
        'resources',
        'plugins',
        'visualization',
        'skills',
        'omics-visualization'
      ),
      []
    ],
    ['/isolated', [{ name: 'sessions', kind: 'directory' }]],
    ['/isolated/sessions', [{ name: 'session-1', kind: 'directory' }]],
    ['/isolated/sessions/session-1', [{ name: 'tool-outputs', kind: 'directory' }]],
    ['/isolated/sessions/session-1/tool-outputs', [{ name: 'out.txt', kind: 'file' }]]
  ])
  const previewRealpaths = new Map<string, string>([
    ['/projects/current/link-out.txt', '/projects/other/secret.txt']
  ])
  const previewFileDescriptors = new Map<number, { path: string; content: Buffer }>()
  let nextPreviewFileDescriptor = 100
  const runtimeSessionCwds = new Map<string, string>()
  const noop = (): undefined => undefined
  let phiSessionCounter = 0
  class RunnerRegistry {
    readonly maxActiveRuns: number
    runs = new Map<
      string,
      {
        controller: AbortController
        sessionId: string
        signal: AbortSignal
        done: Promise<void>
        runId: string
        startedAt: string
        status: 'running' | 'needs_approval' | 'needs_input'
      }
    >()
    constructor(options: { maxActiveRuns?: number } = {}) {
      this.maxActiveRuns = options.maxActiveRuns ?? 4
    }
    startRun(input: {
      sessionId: string
      runId: string
      loadedSkills?: readonly string[]
      execute: (context: { signal: AbortSignal }) => Promise<void>
      getRecordedFailure?: () => string | null | undefined
    }): { done: Promise<void> } {
      if (this.runs.has(input.sessionId)) throw new Error('会话正在运行')
      if (this.runs.size >= this.maxActiveRuns) throw new Error('运行中的会话已达上限')
      const controller = new AbortController()
      runStartInputs.push({
        sessionId: input.sessionId,
        loadedSkills: input.loadedSkills
      })
      const run = {
        controller,
        sessionId: input.sessionId,
        signal: controller.signal,
        runId: input.runId,
        startedAt: '2026-09-05T00:00:00.000Z',
        status: 'running' as const,
        done: Promise.resolve()
          .then(() => input.execute({ signal: controller.signal }))
          .then(() => {
            const recordedFailure = input.getRecordedFailure?.()
            if (recordedFailure) {
              appendedSessionEvents.push({
                sessionId: input.sessionId,
                event: {
                  type: 'run_failed',
                  runId: input.runId,
                  errorMessage: recordedFailure
                }
              })
              runnerEvents.push({
                type: 'recorded_failure',
                sessionId: input.sessionId,
                runId: input.runId,
                errorMessage: recordedFailure
              })
            }
          })
          .finally(() => {
            this.runs.delete(input.sessionId)
          })
      }
      this.runs.set(input.sessionId, run)
      return run
    }
    getActiveRun(sessionId: string): {
      sessionId: string
      signal: AbortSignal
      runId: string
      startedAt: string
      status: 'running' | 'needs_approval' | 'needs_input'
    } | null {
      return this.runs.get(sessionId) ?? null
    }
    stopRun(sessionId: string): void {
      this.runs.get(sessionId)?.controller.abort()
    }
    stopAll(): void {
      runnerEvents.push({ type: 'stop_all' })
      for (const run of this.runs.values()) {
        run.controller.abort()
      }
    }
    markNeedsApproval(
      sessionId: string,
      approvalId: string,
      metadata?: Record<string, unknown>
    ): void {
      const run = this.runs.get(sessionId)
      if (run) run.status = 'needs_approval'
      runnerEvents.push({ type: 'approval_requested', sessionId, approvalId, metadata })
    }
    markApprovalApproved(sessionId: string, approvalId: string): void {
      const run = this.runs.get(sessionId)
      if (run) run.status = 'running'
      runnerEvents.push({ type: 'approval_approved', sessionId, approvalId })
    }
    markApprovalDenied(sessionId: string, approvalId: string): void {
      runnerEvents.push({ type: 'approval_denied', sessionId, approvalId })
    }
    markApprovalCancelled(sessionId: string, approvalId: string): void {
      runnerEvents.push({ type: 'approval_cancelled', sessionId, approvalId })
    }
    markNeedsInput(
      sessionId: string,
      interactionId: string,
      metadata?: Record<string, unknown>
    ): void {
      const run = this.runs.get(sessionId)
      if (run) run.status = 'needs_input'
      runnerEvents.push({ type: 'input_requested', sessionId, interactionId, metadata })
    }
    markInputAnswered(sessionId: string, interactionId: string): void {
      const run = this.runs.get(sessionId)
      if (run) run.status = 'running'
      runnerEvents.push({ type: 'input_answered', sessionId, interactionId })
    }
    markInputCancelled(sessionId: string, interactionId: string): void {
      const run = this.runs.get(sessionId)
      if (run) run.status = 'running'
      runnerEvents.push({ type: 'input_cancelled', sessionId, interactionId })
    }
  }
  class BrowserSession extends EventEmitter {
    permissionCheckHandler: unknown
    permissionRequestHandler: unknown

    setPermissionCheckHandler(handler: unknown): void {
      this.permissionCheckHandler = handler
    }

    setPermissionRequestHandler(handler: unknown): void {
      this.permissionRequestHandler = handler
    }
  }

  class BrowserContents extends EventEmitter {
    readonly session = new BrowserSession()
    readonly loadedUrls: string[] = []
    readonly history: string[] = ['about:blank']
    historyIndex = 0
    closeCalls = 0
    closeError: Error | null = null
    windowOpenHandler: ((details: Record<string, unknown>) => { action: string }) | null = null
    readonly navigationHistory = {
      canGoBack: (): boolean => this.historyIndex > 0,
      canGoForward: (): boolean => this.historyIndex < this.history.length - 1,
      goBack: (): void => {
        if (this.historyIndex > 0) this.historyIndex -= 1
      },
      goForward: (): void => {
        if (this.historyIndex < this.history.length - 1) this.historyIndex += 1
      }
    }

    async loadURL(url: string): Promise<void> {
      this.loadedUrls.push(url)
      if (url === 'about:blank' && this.loadedUrls.length === 1) return
      this.history.splice(this.historyIndex + 1)
      this.history.push(url)
      this.historyIndex = this.history.length - 1
      this.emit('did-start-loading')
      this.emit('did-frame-navigate', {}, url, 200, 'OK', true)
      this.emit('page-title-updated', {}, `Title: ${url}`)
      this.emit('did-stop-loading')
    }

    reload(): void {
      this.emit('did-start-loading')
      this.emit('did-frame-navigate', {}, this.history[this.historyIndex], 200, 'OK', true)
      this.emit('did-stop-loading')
    }

    stop(): void {
      this.emit('did-stop-loading')
    }

    setWindowOpenHandler(handler: (details: Record<string, unknown>) => { action: string }): void {
      this.windowOpenHandler = handler
    }

    close(): void {
      this.closeCalls += 1
      if (this.closeError) throw this.closeError
    }

    closeDevTools(): void {
      return
    }

    async capturePage(): Promise<{
      toPNG: () => Buffer
      getSize: () => { width: number; height: number }
    }> {
      return {
        toPNG: () => Buffer.from('png'),
        getSize: () => ({ width: 800, height: 600 })
      }
    }

    sendInputEvent(): void {
      return
    }
  }

  class WebContentsView {
    readonly webContents = new BrowserContents()
    readonly bounds: Array<{ x: number; y: number; width: number; height: number }> = []
    readonly visibility: boolean[] = []

    constructor(readonly options: BrowserIntegrationView['options']) {
      browserViews.push(this)
    }

    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.bounds.push({ ...bounds })
    }

    setVisible(visible: boolean): void {
      this.visibility.push(visible)
    }
  }

  class Window extends EventEmitter {
    static windows: Window[] = []
    readonly childViews: WebContentsView[] = []
    minimized = false
    visible = true
    readonly contentView = {
      addChildView: (view: WebContentsView): void => {
        if (!this.childViews.includes(view)) this.childViews.push(view)
      },
      removeChildView: (view: WebContentsView): void => {
        const index = this.childViews.indexOf(view)
        if (index >= 0) this.childViews.splice(index, 1)
      }
    }
    webContents = {
      mainFrame: {},
      send: (channel: string, data: unknown): void => {
        operationLog.push({ type: 'webContents.send', channel, data })
        events.push({ channel, data })
      },
      setWindowOpenHandler: (
        handler: (details: { url: string; disposition?: string; postBody?: unknown }) => {
          action: string
        }
      ): void => {
        windowOpenHandler = handler
      },
      on: (name: string, handler: NonNullable<typeof frameNavigationHandler>): void => {
        if (name === 'will-frame-navigate') frameNavigationHandler = handler
      },
      setBackgroundThrottling: noop,
      isDestroyed: (): boolean => false
    }
    constructor(windowOptions: { show?: boolean; backgroundColor?: string }) {
      super()
      this.visible = windowOptions.show !== false
      if (!this.visible) pendingStartupWindows.add(this)
      operationLog.push({ type: 'window.create', ...windowOptions })
      Window.windows.push(this)
    }
    static getAllWindows(): Window[] {
      return Window.windows
    }
    static getFocusedWindow(): Window | null {
      return appFocused ? (Window.windows[0] ?? null) : null
    }
    isDestroyed(): boolean {
      return false
    }
    close(): void {
      this.emit('close')
      const index = Window.windows.indexOf(this)
      if (index >= 0) Window.windows.splice(index, 1)
      this.emit('closed')
      pendingStartupWindows.delete(this)
    }
    getContentBounds(): { x: number; y: number; width: number; height: number } {
      return { x: 0, y: 0, width: 1200, height: 800 }
    }
    isMinimized(): boolean {
      return this.minimized
    }
    isVisible(): boolean {
      return this.visible
    }
    minimize(): void {
      this.minimized = true
      this.emit('minimize')
    }
    restore(): void {
      this.minimized = false
      this.emit('restore')
    }
    hide(): void {
      this.visible = false
      this.emit('hide')
    }
    isFullScreen = (): boolean => false
    setBackgroundColor = (background: string): void => {
      operationLog.push({ type: 'window.background', background })
    }
    setFullScreen = noop
    setVibrancy = noop
    setWindowButtonVisibility = noop
    show = (): void => {
      this.visible = true
      pendingStartupWindows.delete(this)
      operationLog.push({ type: 'window.show' })
      this.emit('show')
    }
    loadURL = async (): Promise<void> => {
      this.emit('ready-to-show')
      if (!options.holdRendererReady) {
        const ready = handlers.get('window:renderer-ready')
        assert.ok(ready, 'Missing startup IPC handler')
        await ready(
          { sender: this.webContents, senderFrame: this.webContents.mainFrame },
          '#0D1218'
        )
      }
    }
    loadFile = this.loadURL
  }
  class TestJupyterServerRegistry {
    connection(workingDirectory: string): Record<string, unknown> | null {
      jupyterServerCalls.push({ action: 'connection', cwd: workingDirectory })
      return null
    }
    status(workingDirectory: string): Record<string, unknown> {
      jupyterServerCalls.push({ action: 'status', cwd: workingDirectory })
      return {
        projectCwd: workingDirectory,
        state: 'stopped',
        hasEndpoint: false
      }
    }
    start(workingDirectory: string): Record<string, unknown> {
      jupyterServerCalls.push({ action: 'start', cwd: workingDirectory })
      return {
        projectCwd: workingDirectory,
        state: 'starting',
        pid: 2026,
        hasEndpoint: false,
        message: '正在启动 Jupyter Server'
      }
    }
    stop(workingDirectory: string): Record<string, unknown> {
      jupyterServerCalls.push({ action: 'stop', cwd: workingDirectory })
      return {
        projectCwd: workingDirectory,
        state: 'stopped',
        hasEndpoint: false,
        message: 'Jupyter Server 已停止'
      }
    }
    disposeAll(): void {
      jupyterServerCalls.push({ action: 'disposeAll', cwd: '*' })
    }
  }
  class TestAnalysisNotebookSessionRegistry {
    status(input: { projectCwd: string; notebookPath: string }): Record<string, unknown> {
      notebookSessionCalls.push({
        action: 'status',
        cwd: input.projectCwd,
        path: input.notebookPath
      })
      return {
        projectCwd: input.projectCwd,
        notebookPath: input.notebookPath,
        state: 'disconnected',
        message: 'Notebook 尚未连接 kernel'
      }
    }
    ensureSession(input: { projectCwd: string; notebookPath: string }): Record<string, unknown> {
      notebookSessionCalls.push({
        action: 'ensure',
        cwd: input.projectCwd,
        path: input.notebookPath
      })
      return {
        projectCwd: input.projectCwd,
        notebookPath: input.notebookPath,
        kernelName: 'python3',
        sessionId: 'session-1',
        state: 'idle',
        message: 'Notebook kernel 已连接'
      }
    }
    closeSession(projectCwd: string, notebookPath: string): Record<string, unknown> {
      notebookSessionCalls.push({ action: 'close', cwd: projectCwd, path: notebookPath })
      return {
        projectCwd,
        notebookPath,
        state: 'disconnected',
        message: 'Notebook kernel 已断开'
      }
    }
    interruptSession(projectCwd: string, notebookPath: string): Record<string, unknown> {
      notebookSessionCalls.push({ action: 'interrupt', cwd: projectCwd, path: notebookPath })
      return {
        projectCwd,
        notebookPath,
        kernelName: 'python3',
        sessionId: 'session-1',
        state: 'idle',
        message: 'Notebook kernel 停止请求已发送'
      }
    }
    closeProject(projectCwd: string): void {
      notebookSessionCalls.push({ action: 'closeProject', cwd: projectCwd })
    }
    projectSummary(projectCwd: string): Record<string, unknown> {
      notebookSessionCalls.push({ action: 'summary', cwd: projectCwd })
      return {
        activeSessionCount: 1,
        busySessionCount: 0,
        sessions: [
          {
            projectCwd,
            notebookPath: `${projectCwd}/notebooks/demo.ipynb`,
            kernelName: 'python3',
            kernelDisplayName: 'Python 3',
            sessionId: 'session-1',
            state: 'idle',
            message: 'Notebook kernel 已连接',
            startedAt: '2026-09-10T01:00:00.000Z',
            updatedAt: '2026-09-10T01:02:00.000Z'
          }
        ]
      }
    }
    executionTarget(): Record<string, unknown> {
      return {
        connection: { url: 'http://127.0.0.1:8888/lab', token: 'secret' },
        sessionId: 'session-1',
        kernelId: 'kernel-1',
        kernelName: 'python3'
      }
    }
    updateSessionState(
      projectCwd: string,
      notebookPath: string,
      state: string,
      message?: string
    ): Record<string, unknown> {
      notebookSessionCalls.push({ action: `state:${state}`, cwd: projectCwd, path: notebookPath })
      return {
        projectCwd,
        notebookPath,
        kernelName: 'python3',
        sessionId: 'session-1',
        state,
        message
      }
    }
  }
  class TestAnalysisNotebookExecutor {
    async executeCell(input: {
      kernelId: string
      cell: { id: string; source: string }
    }): Promise<Record<string, unknown>> {
      notebookExecutionCalls.push({
        cellId: input.cell.id,
        source: input.cell.source,
        kernelId: input.kernelId
      })
      return {
        cellId: input.cell.id,
        executionCount: 2,
        outputs: [
          {
            outputType: 'stream',
            data: {},
            metadata: {},
            name: 'stdout',
            text: 'ran\n',
            extra: {}
          }
        ],
        state: notebookExecutionState,
        startedAt: '2026-09-09T00:00:00.000Z',
        completedAt: '2026-09-09T00:00:01.000Z'
      }
    }

    async introspectVariables(input: {
      kernelId: string
      variableNames: string[]
      language?: string
    }): Promise<
      Array<{
        name: string
        exists: boolean
        datatype?: string
        shape?: string
        columns?: Array<{ name: string; type?: string }>
        preview?: string
      }>
    > {
      notebookExecutionCalls.push({
        cellId: '__introspection__',
        source: input.variableNames.join(','),
        kernelId: input.kernelId,
        language: input.language
      })
      if (input.language?.toLocaleLowerCase() === 'r') {
        return input.variableNames.map((name) =>
          name === 'df'
            ? {
                name,
                exists: true,
                datatype: 'data.frame',
                shape: '2 x 3',
                columns: [
                  { name: 'Year', type: 'character' },
                  { name: 'Income', type: 'numeric' }
                ],
                preview: '  Year Income\\n1 19th 1208.7'
              }
            : { name, exists: false }
        )
      }
      return input.variableNames.map((name) =>
        name === 'df'
          ? {
              name,
              exists: true,
              datatype: 'pandas.core.frame.DataFrame',
              shape: '2 x 3',
              columns: [
                { name: 'Year', type: 'object' },
                { name: 'Income', type: 'float64' }
              ],
              preview: '| Year | Income |\\n| 19th | 1208.7 |'
            }
          : { name, exists: false }
      )
    }

    async completeCode(input: {
      kernelId: string
      code: string
      cursorPosition: number
    }): Promise<Record<string, unknown>> {
      notebookExecutionCalls.push({
        cellId: '__completion__',
        source: input.code,
        kernelId: input.kernelId,
        cursorPosition: input.cursorPosition
      })
      return {
        matches: ['df', 'df.head'],
        cursorStart: 0,
        cursorEnd: input.cursorPosition,
        metadata: {},
        status: 'ok'
      }
    }
  }
  const app = Object.assign(new EventEmitter(), {
    setName: noop,
    getPreferredSystemLanguages: (): string[] => options.systemLanguages ?? ['en-US'],
    getVersion: (): string => '9.8.7',
    whenReady: (): Promise<void> => Promise.resolve(),
    getFileIcon: async (
      filePath: string
    ): Promise<{ isEmpty: () => boolean; toDataURL: () => string }> => {
      fileIconRequests.push(filePath)
      return {
        isEmpty: () => false,
        toDataURL: () => 'data:image/png;base64,aWNvbg=='
      }
    },
    quit: (): void => {
      appQuitCalls += 1
    }
  })
  class MemoryBrowserCheckpointStore {
    readonly values = new Map<string, unknown>()

    load(sessionId: string): unknown {
      return this.values.get(sessionId) ?? null
    }

    save(sessionId: string, checkpoint: unknown): void {
      this.values.set(sessionId, structuredClone(checkpoint))
    }

    remove(sessionId: string): void {
      this.values.delete(sessionId)
    }
  }
  const fakeOmpBridge = {
    registerHostHandler: (method: string, handler: HostHandler) => {
      hostHandlers.set(method, handler)
      return () => hostHandlers.delete(method)
    },
    request: async (method: string, params: unknown) => {
      bridgeRequests.push({ method, params })
      if (bridgeFailure) throw bridgeFailure
      if (
        customMcpBridgeRequest &&
        ['mcp.prepareRemoteAuth', 'mcp.authorizeRemote', 'mcp.cancelRemoteAuth'].includes(method)
      )
        return customMcpBridgeRequest(method, params)
      if (method === 'agentRuns.list') return bridgeAgentJobs
      if (method === 'mcp.featuredTools') return ['search_articles']
      if (method === 'mcp.featuredAuthStatus') return true
      return { ok: true }
    },
    hasSession: (): boolean => options.runtimeSessionReady?.() ?? false,
    stop: async () => {
      bridgeStops += 1
    }
  } as unknown as OmpBridge
  const phiEngine = createInProcessEngine(fakeOmpBridge)
  if (options.childResourceOwner) phiEngine.agentRuns.resourceOwner = options.childResourceOwner
  const modules: Record<string, unknown> = {
    './window-startup': windowStartup,
    './native-ui-copy': nativeUiCopy,
    './startup-splash': {
      createStartupSplashWindow: async () => {
        operationLog.push({ type: 'splash.create' })
        return null
      },
      dismissStartupSplashWindow: (_splash: unknown, window: { show: () => void }) => {
        operationLog.push({ type: 'splash.dismiss' })
        window.show()
      }
    },
    './menu-bar': {
      createMacMenuBar: () => null
    },
    'node:crypto': { createHash, randomUUID },
    semver: { gt: (left: string, right: string): boolean => left > right },
    './agent-env': {},
    './app-quit': { createBeforeQuitHandler },
    './file-preview-media': { hoverMediaPreviewType, mediaPreviewType },
    '../shared/wrapperResultTypes': { declaredExternalOutputRoot },
    '../shared/htmlReportPreview': htmlReportPreview,
    '../shared/phiPluginProblems': phiPluginProblems,
    '../shared/projectMemoryTypes': projectMemoryTypes,
    './agent/notebook/remote-jupyter-start-jobs': remoteJupyterStartJobs,
    './agent/notebook/notebook-ai-generation-jobs': notebookAiGenerationJobs,
    './app-update-check': appUpdateCheck,
    './agent/plugins/details': phiPluginDetails,
    '../shared/presentedFileTypes': { MAX_PRESENTED_FILES: 4 },
    '../shared/remoteHostProfile': { sshConfigHostId: (alias: string) => `ssh-config:${alias}` },
    './molecule-renderer': {
      renderMoleculeSvg: async (): Promise<string> => '<svg xmlns="http://www.w3.org/2000/svg"/>'
    },
    './agent/environment': {
      createManagedEnvironmentActions: () => ({
        list: async () => [],
        build: (ref: unknown, projectCwd: unknown, pluginId: unknown) => {
          managedEnvironmentBuildCalls.push({ ref, projectCwd, pluginId })
          return { envId: 'plugin-demo-owner-demo-0123456789ab' }
        },
        rebuild: async () => undefined,
        remove: async () => ({ removed: true, bytesFreed: 0 }),
        clean: async () => ({
          removed: [],
          orphans: [],
          skipped: [],
          logsRemoved: 0,
          bytesFreed: 0
        })
      }),
      detectConfiguredAnalysisKernels: () => ({
        jupyterServer: { available: true, command: 'jupyter', version: '2.14.0' },
        kernels: [
          {
            name: 'python3',
            displayName: 'Python 3',
            language: 'python',
            rawLanguage: 'python'
          }
        ],
        preferredKernelName: 'python3',
        hasPythonKernel: true,
        hasRKernel: false,
        messages: ['未检测到 R kernel。']
      }),
      dismissEnvironmentSummary: (): void => {},
      getEnvironment: (): Record<string, never> => ({}),
      listManagedEnvironments: async () => [],
      redetectEnvironment: (): Record<string, never> => ({}),
      setEnvironmentToolPath: (): Record<string, never> => ({})
    },
    './agent/environment/background': {
      createBackgroundEnvironment: () => ({
        get: async () => (options.environmentGet ? options.environmentGet() : {}),
        redetect: async () => ({}),
        dismissSummary: async () => ({}),
        setToolPath: async (id: string, path: string | null) => {
          operationLog.push({ type: 'environment.background.setToolPath', id, path })
          return {}
        },
        dispose: async () => {
          operationLog.push({ type: 'environment.background.dispose' })
        }
      })
    },
    'node:child_process': {
      execFile: (
        file: string,
        args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string, stderr: string) => void
      ): void => {
        execFileCalls.push({ file, args })
        if (file === '/usr/bin/mdfind') {
          const query = String(args[0] ?? '')
          callback(
            null,
            query.includes('com.microsoft.vscode') ? '/Applications/Visual Studio Code.app\n' : '',
            ''
          )
          return
        }
        if (file !== '/usr/bin/plutil') {
          callback(new Error(`Unexpected command: ${file}`), '', '')
          return
        }
        callback(
          null,
          JSON.stringify({
            LSHandlers: [
              {
                LSHandlerContentTagClass: 'public.filename-extension',
                LSHandlerContentTag: 'tsx',
                LSHandlerRoleAll: 'com.microsoft.vscode'
              },
              {
                LSHandlerContentType: 'public.comma-separated-values-text',
                LSHandlerRoleAll: 'com.microsoft.excel'
              }
            ]
          }),
          ''
        )
      }
    },
    'node:os': { homedir: (): string => '/fake-home' },
    'node:fs': {
      existsSync: (filePath: string): boolean => {
        const target = path.resolve(filePath)
        return (
          target === path.resolve(process.cwd(), 'resources', 'skills', 'create-wrapper') ||
          previewFiles.has(target) ||
          previewDirectories.has(target)
        )
      },
      openSync: (filePath: string): number => {
        const target = path.resolve(filePath)
        const content = previewFiles.get(target)
        if (!content) throw new Error(`ENOENT ${target}`)
        const fd = nextPreviewFileDescriptor++
        previewFileDescriptors.set(fd, { path: target, content })
        return fd
      },
      readSync: (
        fd: number,
        buffer: Buffer,
        offset: number,
        length: number,
        position: number | null
      ): number => {
        const file = previewFileDescriptors.get(fd)
        if (!file) throw new Error(`EBADF ${fd}`)
        const start = typeof position === 'number' ? position : 0
        const chunk = file.content.subarray(start, start + length)
        chunk.copy(buffer, offset)
        previewReadRequests.push({ filePath: file.path, length })
        return chunk.byteLength
      },
      closeSync: (fd: number): void => {
        previewFileDescriptors.delete(fd)
      },
      watch: (): { close: () => void } => ({
        close: noop
      }),
      // Startup creates the no-project task folder before scanning plugin namespaces.
      mkdirSync: (): undefined => undefined,
      readdirSync: (
        filePath: string
      ): Array<{
        name: string
        isDirectory: () => boolean
        isFile: () => boolean
      }> => {
        const target = path.resolve(filePath)
        const entries = previewDirectories.get(target)
        if (!entries) throw new Error(`ENOTDIR ${target}`)
        return entries.map((entry) => ({
          name: entry.name,
          isDirectory: () => entry.kind === 'directory',
          isFile: () => entry.kind === 'file'
        }))
      },
      realpathSync: (filePath: string): string => {
        const target = path.resolve(filePath)
        const realpath = previewRealpaths.get(target) ?? target
        if (!previewFiles.has(realpath) && !previewDirectories.has(realpath)) {
          throw new Error(`ENOENT ${target}`)
        }
        return realpath
      },
      statSync: (
        filePath: string
      ): { isDirectory: () => boolean; isFile: () => boolean; size: number } => {
        const target = path.resolve(filePath)
        const content = previewFiles.get(target)
        const directory = previewDirectories.get(target)
        return {
          isDirectory: () => Boolean(directory),
          isFile: () => Boolean(content),
          size: content?.byteLength ?? 0
        }
      }
    },
    path,
    electron: {
      net: {
        fetch: async (input: string): Promise<Response> => {
          contentFetchRequests.push(String(input))
          return new Response('{}')
        }
      },
      app,
      BrowserWindow: Window,
      WebContentsView,
      shell: {
        openExternal: async (url: string): Promise<void> => {
          openedExternalUrls.push(url)
        },
        openPath: async (filePath: string): Promise<string> => {
          openedPaths.push(filePath)
          return ''
        },
        showItemInFolder: (filePath: string): void => {
          revealedPaths.push(filePath)
        }
      },
      dialog: {
        showOpenDialog: async (
          ...args: unknown[]
        ): Promise<{ canceled: boolean; filePaths: string[] }> => {
          const options = (args.length === 2 ? args[1] : args[0]) as Record<string, unknown>
          openDialogOptions.push(options)
          return openDialogResult
        },
        showSaveDialog: async (
          ...args: unknown[]
        ): Promise<{ canceled: boolean; filePath?: string }> => {
          const options = (args.length === 2 ? args[1] : args[0]) as Record<string, unknown>
          saveDialogOptions.push(options)
          return saveDialogResult
        }
      },
      ipcMain: {
        on: noop,
        handle: (name: string, handler: Handler): void => {
          handlers.set(name, handler)
        }
      },
      Notification: class {
        static isSupported(): boolean {
          return true
        }
        constructor(readonly options: { title: string; body: string }) {}
        on(): void {
          // click handling is not exercised here
        }
        show(): void {
          osNotifications.push(this.options)
        }
      },
      nativeImage: {
        createFromPath: () => ({
          isEmpty: () => false,
          toDataURL: () => 'data:image/png;base64,aWNvbg=='
        })
      },
      nativeTheme: { shouldUseDarkColors: false }
    },
    './browser/browser-ipc': browserIpc,
    './terminal/terminal-ipc': {
      TerminalIpcCoordinator: class {
        sendEvent(): boolean {
          return true
        }
      },
      registerTerminalRendererIpc: noop
    },
    './terminal/terminal-command-draft': {
      TerminalDraftService: class {
        terminalClosed(): void {
          return undefined
        }
        async dispose(): Promise<void> {
          return undefined
        }
      }
    },
    './terminal/terminal-draft-session': {
      buildTerminalDraftSessionFactory: (): (() => never) => () => {
        throw new Error('terminal draft sessions are not exercised by this harness')
      }
    },
    './terminal/terminal-manager': {
      TerminalManager: class {
        async closeWorkspace(): Promise<void> {
          return undefined
        }
        async dispose(): Promise<void> {
          return undefined
        }
      }
    },
    './terminal/terminal-workspace': {
      resolveTerminalWorkspace: (): never => {
        throw new Error('terminal workspace is not exercised by this harness')
      }
    },
    './agent/browser/browser-tool-host': browserToolHost,
    './browser/browser-checkpoints': {
      FileSystemBrowserCheckpointStore: MemoryBrowserCheckpointStore
    },
    './browser/electron-browser-engine': electronBrowserEngine,
    './browser/browser-workspace-registry': browserWorkspaceRegistry,
    '@electron-toolkit/utils': {
      electronApp: { setAppUserModelId: noop },
      optimizer: { watchWindowShortcuts: noop },
      is: { dev: false }
    },
    './agent/runtime/runtime-adapter': {
      readAutoCompactionDefaults: async (): Promise<{
        enabled: boolean
        thresholdPercent: number
        thresholdTokens: number
      }> =>
        options.compactionDefaultsRead?.() ?? {
          enabled: true,
          thresholdPercent: -1,
          thresholdTokens: -1
        },
      createRuntimeResourceLoader: (options: Record<string, unknown>): unknown => {
        resourceLoaderOptions.push(options)
        return {
          options,
          async reload(): Promise<void> {
            return
          },
          getSkills: (): unknown => ({ skills: [], diagnostics: [] })
        }
      },
      getCoreAuthoringSkillDir: (): string =>
        path.join(process.cwd(), 'resources', 'skills', 'create-wrapper'),
      getBundledAgentsDir: (): string => path.join(process.cwd(), 'resources', 'agents'),
      getBundledResourceDir: (name: string): string => path.join(process.cwd(), 'resources', name),
      createInMemoryRuntimeSessionManager: (cwd: string): { file: string; cwd: string } => ({
        file: 'in-memory',
        cwd
      }),
      openRuntimeSessionManager: (file: string): { getCwd: () => string } => ({
        getCwd: () => runtimeSessionCwds.get(file) ?? `/projects/${file}`
      })
    },
    './agent/session/session-title-generation': {
      ...sessionTitleGeneration,
      SessionTitleGenerator: class extends sessionTitleGeneration.SessionTitleGenerator {
        constructor(input: sessionTitleGeneration.SessionTitleGeneratorOptions) {
          super({
            ...input,
            request:
              harnessOptions.titleRequest ??
              (harnessOptions.useTitleRuntime ? input.request : async () => '')
          })
        }
      }
    },
    './agent/session/automatic-model-fallback': automaticModelFallback,
    './agent/session/session-manager': {
      createAgentSession: async (
        options: {
          cwd: string
          sessionManager: { file: string }
          model?: { provider: string; id: string }
          thinkingLevel?: string
        },
        onEvent?: (summary: Record<string, unknown>) => void,
        control?: { signal?: AbortSignal; assertCurrent(): void }
      ): Promise<{ session: FakeSession }> => {
        createdAgentOptions.push(options)
        await harnessOptions.onCreateSession?.(options, control)
        const session = factory
          ? await factory(options.cwd, options.sessionManager.file)
          : new FakeSession(options.sessionManager.file)
        if (options.model) session.model = options.model
        session.thinkingLevel = options.thinkingLevel
        if (onEvent) {
          session.subscribe((event) => onEvent(event as Record<string, unknown>))
        }
        sessions.push(session)
        return { session }
      }
    },
    './agent/auth-manager': {
      getAuthManager: (): unknown => ({
        logout: async (): Promise<void> => undefined,
        getProviderStatuses: async () => [
          {
            providerId: 'openai',
            name: 'OpenAI',
            configured: true,
            source: 'stored',
            hasApiKey: true,
            hasOAuth: false,
            hasConfigError: false,
            statusText: 'ready'
          }
        ],
        getRuntime: async () => {
          await options.modelRuntimeGet?.()
          return {
            getModels: () => [
              {
                provider: 'openai',
                id: 'gpt-test',
                name: 'GPT Test',
                reasoning: true
              },
              {
                provider: 'openai',
                id: 'gpt-vision-test',
                name: 'GPT Vision Test',
                reasoning: false,
                supportsImages: true
              },
              {
                provider: 'kimi-code',
                id: 'kimi-k2.5',
                name: 'Kimi K2.5',
                reasoning: true
              },
              {
                provider: 'kimi-code',
                id: 'kimi-for-coding',
                name: 'K2.7 Coding',
                reasoning: true
              }
            ],
            getModel: (providerId: string, modelId: string) =>
              providerId === 'missing'
                ? undefined
                : {
                    provider: providerId,
                    id: modelId,
                    name: modelId,
                    reasoning: true,
                    ...(modelId === 'gpt-vision-test' ? { supportsImages: true } : {})
                  }
          }
        }
      })
    },
    './agent/persona-manager': {
      setPersonaMarkdown: (value: string): void => {
        savedPersonas.push(value)
        personaMarkdown = value
      },
      getPersonaMarkdown: (): string => options.personaRead?.() ?? personaMarkdown
    },
    './agent/session/sessions': {
      WORKSPACE_DIR: '/workspace',
      phiOnlySessionPath: (sessionId: string): string => `phi-session:${sessionId}`,
      phiSessionIdFromPath: (path: string): string | null =>
        path.startsWith('phi-session:') ? path.slice('phi-session:'.length) : null,
      isPhiOnlySessionPath: (path: string | null | undefined): boolean =>
        typeof path === 'string' && path.startsWith('phi-session:'),
      createSessionManager: (cwd: string, file?: string): { file: string } => {
        const sessionFile = file ?? 'fresh.jsonl'
        runtimeSessionCwds.set(sessionFile, cwd)
        return { file: sessionFile }
      },
      renameSession: async (file: string, name: string): Promise<void> => {
        renamedSessions.push({ path: file, name })
      },
      listSessions: async (): Promise<unknown[]> => [],
      acknowledgeSession: (file: string, cwd: string): null => {
        acknowledgedSessions.push({ file, cwd })
        return null
      },
      deleteSession: (file: string): void => {
        deleted.push(file)
      }
    },
    './agent/session/home-activity': {
      getHomeActivity: (): HomeActivitySummary => ({
        generatedAt: '2026-10-09T00:00:00.000Z',
        dayBuckets: [],
        periods: {
          week: { durationMs: 0, completedRuns: 0, totalRuns: 0, activeDays: 0 },
          month: { durationMs: 0, completedRuns: 0, totalRuns: 0, activeDays: 0 },
          year: { durationMs: 0, completedRuns: 0, totalRuns: 0, activeDays: 0 }
        }
      })
    },
    './agent/projects': {
      subscribeRemoteProjectConnection: (): (() => void) => noop,
      deleteProject: (): void => undefined,
      getProject: (id: string) => {
        if (id === 'remote-project-1') {
          return {
            id,
            ...(options.remoteMemorySettings ? { memory: options.remoteMemorySettings } : {}),
            name: 'Remote project',
            ...(options.remoteDefaultModel
              ? { defaultModel: options.remoteDefaultModel }
              : options.remoteRpc && options.remoteDefaultModel !== null
                ? { defaultModel: { providerId: 'openai', modelId: 'gpt-test' } }
                : {}),
            location: {
              kind: 'ssh',
              hostProfileId: 'host-1',
              remoteRoot: '/cluster/project',
              canonicalRoot: '/canonical/project'
            },
            permissionMode: 'ask',
            workingDirectory: '/cluster/project',
            createdAt: '2026-09-24T00:00:00.000Z'
          }
        }
        if (id.startsWith('project-/projects/')) {
          const workingDirectory = id.slice('project-'.length)
          return {
            id,
            name: `Project ${workingDirectory}`,
            location: { kind: 'local', path: workingDirectory, realPath: workingDirectory },
            workingDirectory,
            workingDirectoryRealPath: workingDirectory,
            permissionMode: 'ask',
            createdAt: '2026-09-05T00:00:00.000Z'
          }
        }
        return undefined
      },
      assertProjectPathAvailable: (workingDirectory: string) => {
        if (workingDirectory.includes('missing-project')) throw new Error('项目路径不可用')
      },
      listProjects: () => [
        {
          id: 'project-/projects/defaults',
          name: 'Project /projects/defaults',
          location: { kind: 'local', path: '/projects/defaults', realPath: '/projects/defaults' },
          workingDirectory: '/projects/defaults',
          workingDirectoryRealPath: '/projects/defaults',
          permissionMode: 'ask',
          pathAvailable: true,
          createdAt: '2026-09-05T00:00:00.000Z'
        },
        {
          id: 'remote-project-1',
          location: {
            kind: 'ssh',
            hostProfileId: 'host-1',
            remoteRoot: '/cluster/project',
            canonicalRoot: '/canonical/project'
          },
          remoteConnection: {
            phase: remoteProjectPhase,
            message: remoteProjectPhase === 'offline' ? '服务器离线' : undefined
          }
        },
        {
          id: 'remote-collision',
          location: {
            kind: 'ssh',
            hostProfileId: 'host-1',
            remoteRoot: '/projects/research',
            canonicalRoot: '/projects/research'
          },
          workingDirectory: '/projects/research'
        }
      ],
      updateProjectMemory: (id: string, settings: unknown): Record<string, unknown> => {
        options.remoteMemorySettings = projectMemoryTypes.normalizeProjectMemorySettings(settings)
        return { id, memory: options.remoteMemorySettings }
      },
      updateProjectDefaults: (id: string, defaults: Record<string, unknown>) => {
        updatedProjectDefaults.push({ id, defaults })
        return {
          id,
          name: 'Project',
          workingDirectory: '/projects/defaults',
          permissionMode: 'ask',
          pathAvailable: true,
          createdAt: '2026-09-05T00:00:00.000Z',
          ...defaults
        }
      },
      updateProjectPermissionMode: (id: string, permissionMode: string) =>
        id === 'remote-project-1'
          ? {
              id,
              name: 'Remote project',
              location: {
                kind: 'ssh',
                hostProfileId: 'host-1',
                remoteRoot: '/cluster/project',
                canonicalRoot: '/canonical/project'
              },
              workingDirectory: '/cluster/project',
              permissionMode,
              pathAvailable: true,
              createdAt: '2026-09-24T00:00:00.000Z'
            }
          : {
              id,
              name: 'Project',
              workingDirectory: '/projects/defaults',
              permissionMode,
              pathAvailable: true,
              createdAt: '2026-09-05T00:00:00.000Z'
            },
      updateProjectRemoteConnection: (id: string) => ({
        id,
        name: 'Project',
        workingDirectory: '/projects/defaults',
        permissionMode: 'ask',
        pathAvailable: true,
        createdAt: '2026-09-05T00:00:00.000Z'
      }),
      updateProjectRemoteDefaults: (id: string, defaults: Record<string, unknown>) => ({
        id,
        name: 'Project',
        workingDirectory: '/projects/defaults',
        permissionMode: 'ask',
        pathAvailable: true,
        createdAt: '2026-09-05T00:00:00.000Z',
        ...defaults
      }),
      listLocalProjectAllowRoots: () => ['/projects/saved'],
      getProjectByCwd: (
        cwd: string
      ): {
        id: string
        name: string
        permissionMode: string
        workingDirectoryRealPath: string
        defaultModel?: { providerId: string; modelId: string }
        defaultThinkingLevel?: string
      } | null =>
        cwd.startsWith('/projects/')
          ? {
              id: `project-${cwd}`,
              name: `Project ${cwd}`,
              permissionMode: 'ask',
              workingDirectory: cwd,
              workingDirectoryRealPath: cwd,
              ...(cwd.includes('defaults')
                ? {
                    defaultModel: { providerId: 'anthropic', modelId: 'claude-test' },
                    defaultThinkingLevel: 'medium'
                  }
                : cwd.includes('unavailable')
                  ? {
                      defaultModel: { providerId: 'missing', modelId: 'gone' },
                      defaultThinkingLevel: 'high'
                    }
                  : cwd.includes('kimi-retired')
                    ? {
                        defaultModel: { providerId: 'kimi-code', modelId: 'kimi-k2.5' },
                        defaultThinkingLevel: 'high'
                      }
                    : {})
            }
          : null
    },
    './agent/notebook/analysis-notebooks': {
      emptyNotebookRegistry: (message: string) => ({
        projectCwd: null,
        notebooks: [],
        truncated: false,
        initialized: false,
        message
      }),
      initializeProjectAnalysis: (workingDirectory: string) => ({
        notebooksDir: `${workingDirectory}/notebooks`,
        outputsDir: `${workingDirectory}/outputs`
      }),
      listProjectNotebooks: (workingDirectory: string) => ({
        notebooks:
          workingDirectory === '/projects/research'
            ? [
                {
                  path: '/projects/research/notebooks/qc.ipynb',
                  relativePath: 'notebooks/qc.ipynb',
                  name: 'qc.ipynb',
                  directory: 'notebooks',
                  bytes: 1024,
                  modifiedAt: '2026-09-09T00:00:00.000Z'
                }
              ]
            : [],
        truncated: false,
        initialized: true
      })
    },
    './agent/notebook/analysis-notebook-files': {
      openProjectNotebook: (workingDirectory: string, notebookPath: string) => {
        if (options.notebookOpenError) throw options.notebookOpenError
        return {
          path: `${workingDirectory}/${notebookPath}`,
          relativePath: notebookPath,
          name: 'qc.ipynb',
          bytes: 128,
          modifiedAt: '2026-09-09T00:00:00.000Z',
          savedRevision: 'nb-open',
          document: {
            nbformat: 4,
            nbformatMinor: 5,
            metadata: {},
            cells: [],
            extra: {},
            revision: 'nb-open'
          }
        }
      },
      saveProjectNotebook: (
        workingDirectory: string,
        input: { path: string; document: { revision: string } }
      ) => ({
        path: input.path,
        relativePath: input.path.replace(`${workingDirectory}/`, ''),
        name: 'qc.ipynb',
        bytes: 256,
        modifiedAt: '2026-09-09T00:01:00.000Z',
        savedRevision: input.document.revision,
        document: input.document
      }),
      createProjectNotebook: (workingDirectory: string) => ({
        path: `${workingDirectory}/notebooks/Untitled.ipynb`,
        relativePath: 'notebooks/Untitled.ipynb',
        name: 'Untitled.ipynb',
        bytes: 512,
        modifiedAt: '2026-09-09T00:02:00.000Z',
        savedRevision: 'nb-new',
        document: {
          nbformat: 4,
          nbformatMinor: 5,
          metadata: {},
          cells: [],
          extra: {},
          revision: 'nb-new'
        }
      }),
      closeProjectNotebook: (workingDirectory: string, notebookPath: string) => ({
        path: `${workingDirectory}/${notebookPath}`
      }),
      deleteProjectNotebook: (workingDirectory: string, notebookPath: string) => ({
        path: `${workingDirectory}/${notebookPath}`,
        relativePath: notebookPath
      })
    },
    './agent/notebook/analysis-notebook-watch': {
      AnalysisNotebookFileWatcher: class {
        watch(workingDirectory: string, notebookPath: string): unknown {
          return {
            path: `${workingDirectory}/${notebookPath}`,
            relativePath: notebookPath,
            name: 'qc.ipynb',
            bytes: 128,
            modifiedAt: '2026-09-09T00:00:00.000Z',
            savedRevision: 'nb-open',
            document: {
              nbformat: 4,
              nbformatMinor: 5,
              metadata: {},
              cells: [],
              extra: {},
              revision: 'nb-open'
            }
          }
        }
        watchFile(): void {
          return undefined
        }
        noteLocalWrite(): void {
          return undefined
        }
        unwatch(): void {
          return undefined
        }
        unwatchFile(): void {
          return undefined
        }
        unwatchProject(): void {
          return undefined
        }
        dispose(): void {
          return undefined
        }
      }
    },
    './agent/notebook/analysis-kernels': {
      detectAnalysisKernels: () => ({
        jupyterServer: { available: true, command: 'jupyter', version: '2.14.0' },
        kernels: [
          {
            name: 'python3',
            displayName: 'Python 3',
            language: 'python',
            rawLanguage: 'python'
          }
        ],
        preferredKernelName: 'python3',
        hasPythonKernel: true,
        hasRKernel: false,
        messages: ['未检测到 R kernel。']
      })
    },
    './agent/notebook/analysis-jupyter-server': {
      JupyterServerRegistry: TestJupyterServerRegistry
    },
    './agent/notebook/analysis-jupyter-sessions': {
      AnalysisNotebookSessionRegistry: TestAnalysisNotebookSessionRegistry
    },
    './agent/notebook/analysis-jupyter-execution': {
      AnalysisNotebookExecutor: TestAnalysisNotebookExecutor
    },
    './agent/notebook/analysis-notebook-completion': {
      completeNotebookPythonStaticCompletion: (): null => null,
      mergeNotebookCompletionResults: (primary: unknown): unknown => primary
    },
    './agent/notebook/analysis-notebook-formatting': {
      formatNotebookCellSource: (input: {
        projectCwd: string
        source: string
        language?: string
        lineLength?: number
      }): Record<string, unknown> => {
        notebookFormatCalls.push({
          projectCwd: input.projectCwd,
          source: input.source,
          language: input.language,
          lineLength: input.lineLength
        })
        const source = input.source.replace('x=1', 'x = 1')
        return {
          source,
          changed: source !== input.source,
          formatter: 'ruff'
        }
      }
    },
    './agent/notebook/notebook-tool-executor': {
      AnalysisNotebookToolExecutor: class TestAnalysisNotebookToolExecutor {
        execute(request: Record<string, unknown>): Record<string, unknown> {
          return { kind: 'local_notebook_tool', cwd: request.cwd }
        }
        syncDraft(input: {
          cwd: string
          path: string
          document: unknown
          savedRevision?: string
          source?: string
        }): Record<string, unknown> {
          return {
            source: input.source ?? 'renderer',
            projectCwd: input.cwd,
            path: input.path,
            relativePath: input.path,
            document: input.document,
            savedRevision: input.savedRevision ?? 'synced'
          }
        }
      }
    },
    './agent/notebook/notebook-tool-host-router': { NotebookToolHostRouter },
    './agent/notebook/remote-analysis-notebook-backend': {
      createRemoteAnalysisNotebookBackend: () => {
        options.remoteNotebookBackendCreate?.()
        const sessions = new TestAnalysisNotebookSessionRegistry()
        const pathFor = (path: string): string =>
          path.startsWith('/') ? path : `/canonical/project/${path}`
        const status = (
          state = remoteNotebookState
        ): {
          projectCwd: string
          runtimeKind: 'ssh'
          serverLabel: string
          state: string
          hasEndpoint: boolean
          message: string | undefined
        } => ({
          projectCwd: '/canonical/project',
          runtimeKind: 'ssh',
          serverLabel: 'cluster-one',
          state,
          hasEndpoint: state === 'ready',
          message:
            state === 'stopped'
              ? '远程 Jupyter 未连接；重新连接后 kernel 将重启，内存状态会丢失。'
              : undefined
        })
        const workspace = {
          list: async () => {
            remoteNotebookCalls.push({ action: 'list' })
            return {
              notebooks: [
                {
                  path: '/canonical/project/notebooks/remote.ipynb',
                  relativePath: 'notebooks/remote.ipynb',
                  name: 'remote.ipynb',
                  directory: 'notebooks',
                  bytes: 256,
                  modifiedAt: '2026-10-10T00:00:00.000Z'
                }
              ],
              truncated: false,
              initialized: true
            }
          },
          open: async (path: string) => {
            const resolved = pathFor(path)
            remoteNotebookCalls.push({ action: 'open', path: resolved })
            return remoteNotebookFile(resolved)
          },
          create: async (relativePath = 'notebooks/Untitled.ipynb') => {
            const path = pathFor(relativePath)
            remoteNotebookCalls.push({ action: 'create', path })
            return remoteNotebookFile(path)
          },
          save: async (input: { path: string; document: notebookDocument.NotebookDocument }) => {
            const path = pathFor(input.path)
            remoteNotebookCalls.push({ action: 'save', path })
            return { ...remoteNotebookFile(path), document: input.document }
          }
        }
        const tools = {
          execute: async (request: Record<string, unknown>) => {
            remoteNotebookCalls.push({ action: `tool:${String(request.action)}` })
            return { summary: 'remote notebook tool ok', cwd: request.cwd }
          },
          syncDraft: (input: Record<string, unknown>) => ({
            source: input.source ?? 'renderer',
            projectCwd: '/canonical/project',
            path: input.path,
            relativePath: String(input.path).replace('/canonical/project/', ''),
            document: input.document,
            savedRevision: input.savedRevision ?? 'synced'
          })
        }
        return {
          projectCwd: '/canonical/project',
          projectName: 'Remote project',
          workspace,
          sessions,
          tools,
          controller: {
            status: () => status(),
            start: () => {
              remoteNotebookCalls.push({ action: 'start' })
              remoteNotebookState = 'ready'
              return status('preparing_environment')
            },
            stop: async () => {
              remoteNotebookCalls.push({ action: 'stop' })
              remoteNotebookState = 'stopped'
              return status()
            },
            requireReady: () => {
              if (remoteNotebookState !== 'ready') throw new Error('远程 Jupyter 尚未就绪')
            }
          },
          kernels: () => ({
            jupyterServer: { available: true, command: 'jupyter', version: 'remote' },
            kernels: [
              {
                name: 'phi-python',
                displayName: 'Remote Python',
                language: 'python',
                rawLanguage: 'python'
              }
            ],
            preferredKernelName: 'phi-python',
            hasPythonKernel: true,
            hasRKernel: false,
            messages: []
          }),
          initializeProject: async () => ({
            notebooksDir: '/canonical/project/notebooks',
            outputsDir: '/canonical/project/outputs'
          }),
          open: async (path: string) => workspace.open(path),
          save: async (input: { path: string; document: notebookDocument.NotebookDocument }) =>
            workspace.save(input),
          close: async (path: string) => {
            const resolved = pathFor(path)
            remoteNotebookCalls.push({ action: 'close', path: resolved })
            await sessions.closeSession('/canonical/project', resolved)
            return { path: resolved }
          },
          delete: async (path: string) => {
            const resolved = pathFor(path)
            remoteNotebookCalls.push({ action: 'delete', path: resolved })
            return { path: resolved, relativePath: resolved.replace('/canonical/project/', '') }
          },
          dispose: async () => {
            remoteNotebookCalls.push({ action: 'dispose' })
          }
        }
      },
      remoteNotebookFileChange: (projectCwd: string, event: Record<string, unknown>) => ({
        ...event,
        projectCwd
      })
    },
    './agent/engine/omp-bridge': { getOmpBridge: () => fakeOmpBridge },
    './agent/engine/in-process-engine': {
      getPhiEngine: () => phiEngine,
      ownsRemoteRuntimeSession: (id: string) => options.routedRuntime?.(id) ?? false,
      readRpcCompactionPolicy: async (_agentDir: string, overrides: Record<string, unknown>) =>
        options.rpcCompactionPolicyRead?.(overrides) ?? {
          policy: {
            enabled: true,
            thresholdPercent: -1,
            thresholdTokens: -1,
            methodOrder: ['summary'],
            ...overrides
          },
          defaults: { enabled: true, thresholdPercent: -1, thresholdTokens: -1 }
        }
    },
    './agent/remote-session-routing': {
      createAppRemoteSessionManager: (cwd: string, phiSessionId: string, resume: boolean) => ({
        kind: resume ? 'open' : 'persistent',
        cwd,
        ...(resume ? { path: `phi-session:${phiSessionId}` } : {})
      }),
      installAppRemoteSessionRouting: (input: { enabled: boolean }): (() => void) => {
        remoteRoutingOptions.push(input)
        operationLog.push({ type: 'installRemoteRouting', enabled: input.enabled })
        return () => undefined
      }
    },
    './agent/engine/events': engineEvents,
    './agent/engine/rpc/runtime-selection-control': runtimeSelection,
    './agent/session/runtime-recovery-ipc': runtimeRecoveryIpc,
    './agent/session/recovery-summary': recoverySummary,
    './agent/engine/rpc/session-recovery': recoveryFailures,
    './agent/session/runtime-reference': runtimeReference,
    './agent/engine/rpc/facade-session-driver': { facadeBindingHash: () => 'a'.repeat(64) },
    './agent/session/child-run-recovery': {
      readColdChildRuns: (input: { phiSessionId: string }) =>
        options.coldChildRuns?.(input.phiSessionId) ?? []
    },
    './agent/session/runtime-origin-store': {
      registerRuntimeSessionOrigin: () => undefined,
      resolveRuntimeSessionOrigin: (id: string) => options.coldRuntimeOrigin?.(id)
    },
    './web-link-preview': {
      createWebLinkPreviewService: (): ReturnType<typeof createWebLinkPreviewService> =>
        createWebLinkPreviewService({
          fetch: async () => {
            throw new Error('Preview networking is disabled in the main integration fixture')
          }
        })
    },
    './agent/engine/rpc/desktop-websearch-adapter': {
      ...desktopWebSearch,
      createDesktopWebSearchAdapter: options.projectMemoryAdapterCreate
        ? async () => ({ retire: noop, close: async () => undefined })
        : desktopWebSearch.createDesktopWebSearchAdapter
    },
    './agent/engine/rpc/desktop-mcp-adapter': {
      ...desktopMcp,
      createDesktopMcpAdapter: options.projectMemoryAdapterCreate
        ? async () => ({ tools: [], retire: noop, close: async () => undefined })
        : desktopMcp.createDesktopMcpAdapter
    },
    './agent/engine/rpc/remote-library-service': remoteLibrary,
    './agent/notebook/notebook-code-generation': notebookCodeGeneration,
    './agent/notebook/notebook-completion': notebookCompletion,
    './agent/notebook/notebook-output-protocol': {
      registerNotebookOutputScheme: noop,
      installNotebookOutputProtocol: noop
    },
    '../shared/notebookDocument': notebookDocument,
    '../shared/notebookExecutionMetadata': notebookExecutionMetadata,
    '../shared/sessionTitle': sessionTitle,
    './agent/content/skill-host': {
      createSkillHost: (): {
        scriptTools: (params: unknown) => Promise<{ tools: unknown[]; problems: string[] }>
        run: (params: unknown) => Promise<unknown>
        scriptTool: (params: unknown) => Promise<unknown>
        cancel: (params: unknown) => void
        approvalFor: (toolName: string, input: unknown) => undefined
      } => ({
        scriptTools: async () => ({ tools: [], problems: [] }),
        run: async () => {
          throw new Error('skill host is mocked')
        },
        scriptTool: async () => {
          throw new Error('skill host is mocked')
        },
        cancel: () => undefined,
        approvalFor: () => undefined
      })
    },
    './agent/packages/wrapper-tree': {
      // A fresh installation has no domain wrapper tree before a catalog choice.
      getWrapperTreeOwnershipPath: (): string => '/isolated/agent/wrappers/tree.json'
    },
    './agent/content/env-request': {
      ADD_PACKAGES: '添加',
      confirmedEnvironmentRequest: (): boolean => false,
      environmentRequestQuestion: (): string => 'add packages?',
      requestProjectEnvironment: async (): Promise<unknown> => {
        throw new Error('env_request is mocked')
      }
    },
    './agent/content/environment-gate': {
      bindAgentSession: async (): Promise<unknown> => {
        throw new Error('environment binding is mocked')
      }
    },
    './agent/content/environment-builds': {
      createEnvironmentBuilds: (): {
        list: () => unknown[]
        cancel: (envId: string) => void
      } => ({
        list: () => [],
        cancel: () => undefined
      })
    },
    // These callbacks are handed to the existing mocked build/actions layer.
    // Never build or sweep real filesystem environments from this IPC fixture.
    './agent/content/environment-refs': {
      buildEnvironment: async (): Promise<never> => {
        throw new Error('environment building is mocked')
      }
    } satisfies Pick<
      typeof import('../src/main/agent/content/environment-refs'),
      'buildEnvironment'
    >,
    './agent/envs/gc': {
      collectGarbage: () => ({ removed: [], orphans: [], skipped: [], logsRemoved: 0 })
    } satisfies Pick<typeof import('../src/main/agent/envs/gc'), 'collectGarbage'>,
    './agent/packages/mcp-version-cleanup': {
      cleanupInactiveMcpVersions: (): string[] => []
    } satisfies Pick<
      typeof import('../src/main/agent/packages/mcp-version-cleanup'),
      'cleanupInactiveMcpVersions'
    >,
    './agent/content/environment-build-prompt': {
      BUILD_NOW: '现在构建',
      confirmedEnvironmentBuild: (): boolean => false,
      environmentBuildQuestion: (): string => 'build?'
    },
    './agent/envs/runtime': {
      getRuntimeRoot: (): string => '/isolated/runtime'
    },
    './agent/tool-approval': {
      requestRuntimeToolApproval: async (request: Record<string, unknown>, signal: AbortSignal) =>
        options.moduleApproval?.(request, signal) ?? 'cancelled',
      bashApprovalDigest: fakeBashApprovalDigest,
      writeApprovalDigest: fakeWriteApprovalDigest,
      editApprovalDigest: fakeEditApprovalDigest,
      cancelToolApprovals: (): unknown[] => [],
      requestToolApproval: async (): Promise<'cancelled'> => 'cancelled',
      resolveToolApproval: (requestId: string, approved: boolean, responder: unknown): boolean => {
        const trusted = responder === Window.getAllWindows()[0]?.webContents
        approvalResolveCalls.push({ requestId, approved, trusted })
        if (!trusted || requestId !== 'approval-live' || resolvedApprovalIds.has(requestId)) {
          return false
        }
        resolvedApprovalIds.add(requestId)
        return true
      },
      createApprovalExtension: (options: Record<string, unknown>): Record<string, unknown> => {
        approvalOptions.push(options)
        return { name: 'approval-extension' }
      }
    },
    './agent/user-interaction': {
      canRequestAgentUserInteraction: (): boolean => true,
      cancelAgentUserInteractions: noop,
      resolveAgentUserInteraction: noop,
      waitForAgentUserInteraction: async (
        request: Record<string, unknown>
      ): Promise<Record<string, unknown>> => ({
        requestId: request.requestId,
        ...agentInteractionResponse
      })
    },
    './agent/plugins/bundled-install': {
      installBundledPlugins: async (): Promise<unknown> => ({
        installed: [],
        upgraded: [],
        skipped: [],
        errors: [],
        warnings: []
      })
    },
    './agent/plugins/loader': {
      listInstalledPlugins: (): unknown[] => installedPhiPlugins,
      loadedPlugins: (): unknown[] => [],
      installPlugin: (): unknown => ({ ok: true, errors: [], warnings: [] }),
      upgradePlugin: async (): Promise<unknown> => ({ ok: true, errors: [], warnings: [] }),
      setPluginEnabled: (): unknown => ({ ok: true, errors: [], warnings: [] }),
      uninstallPlugin: (): unknown => ({ ok: true, errors: [], warnings: [] })
    },
    './agent/plugins/store': {
      readPluginRegistry: (): unknown => ({ version: 1, plugins: {} }),
      writePluginRegistry: noop
    },
    './agent/enablement': {
      getEnablementPath: (): string => '/isolated/state/enabled.json',
      migrateEnablementFromHistory: (): unknown => ({
        migrated: false,
        enabledSkills: [],
        sessionsScanned: 0,
        bytesScanned: 0
      }),
      filterEnabledMainSkills: (skills: unknown[]): unknown[] => skills,
      isCoreSkill: (): boolean => false,
      getEnablementSnapshot: ({ projectDir }: { projectDir?: string } = {}): unknown => ({
        version: 1,
        global: { ...enablementGlobal },
        ...(projectDir ? { projectPath: projectDir } : {}),
        project: projectDir ? { ...(enablementProjects[projectDir] ?? {}) } : {}
      }),
      setEnabled: (
        item: string,
        value: boolean | null,
        { projectDir }: { projectDir?: string } = {}
      ): unknown => {
        const target = projectDir ? (enablementProjects[projectDir] ??= {}) : enablementGlobal
        if (value === null) delete target[item]
        else target[item] = value
        return { version: 1, global: enablementGlobal, projects: enablementProjects }
      }
    },
    './agent/plugins/validate': {
      validatePlugin: (): unknown => ({ ok: false, errors: [], warnings: [] })
    },
    './agent/packages/official-registry': {
      syncOfficialRegistry: async (options: {
        agentDir?: string
        fetch: typeof fetch
      }): Promise<unknown> => {
        await options.fetch('https://example.invalid/catalog/index.json')
        return officialRegistryFixture
      }
    },
    './agent/packages/official-website-registry': {
      syncPreferredOfficialRegistry: async (registryOptions: {
        agentDir?: string
        fetch: typeof fetch
        forceRefresh?: boolean
      }): Promise<unknown> => {
        await registryOptions.fetch('https://phi.omicsagent.cn/api/catalog')
        return {
          ...officialRegistryFixture,
          label: 'Phi 官网',
          packages: options.officialPackageEntries ?? []
        }
      }
    },
    './agent/packages/official-connector-registry': {
      syncOfficialConnectorRegistry: async (options: {
        agentDir?: string
        fetch: typeof fetch
        forceRefresh?: boolean
      }): Promise<unknown> => {
        operationLog.push({
          type: 'connector.api.sync',
          forceRefresh: options.forceRefresh === true
        })
        await options.fetch('https://phi.omicsagent.cn/api/mcp')
        return officialConnectorRegistryFixture
      }
    },
    './agent/packages/content-source': {
      readContentRegistry: async (
        source: string,
        options: { agentDir?: string; fetch: typeof fetch }
      ): Promise<unknown> => {
        contentSourceCalls.push({ phase: 'read', source, agentDir: options.agentDir })
        if (source === 'phi-packages' || source === officialRegistryFixture.dir) {
          await options.fetch('https://example.invalid/catalog/index.json')
          return officialRegistryFixture
        }
        return { ...officialRegistryFixture, id: source, dir: source, trust: 'imported' }
      },
      prepareContentPackageInstall: async (
        registry: { id: string },
        request: { type: string; id: string },
        options: { agentDir?: string; fetch: typeof fetch }
      ): Promise<unknown> => {
        contentSourceCalls.push({
          phase: 'prepare',
          source: registry.id,
          type: request.type,
          id: request.id,
          agentDir: options.agentDir
        })
        if (registry.id === 'phi-packages')
          await options.fetch(
            `https://example.invalid/catalog/${request.type}-${request.id}.tar.gz`
          )
        return registry
      }
    },
    './agent/packages/icon-views': {
      packageRegistryIconView: (registry: unknown): unknown => registry
    },
    './agent/packages/github-source': {
      previewGithubSource: async (): Promise<unknown> => ({
        repo: 'acme/connectors',
        sha: 'a'.repeat(40),
        packages: [],
        skipped: [],
        warnings: []
      }),
      addGithubSource: async (): Promise<unknown> => ({
        id: 'a'.repeat(16),
        repo: 'acme/connectors',
        sha: 'a'.repeat(40),
        registryPath: '/isolated/github/registry',
        addedAt: '2026-10-11T00:00:00.000Z',
        updatedAt: '2026-10-11T00:00:00.000Z'
      }),
      checkGithubSourceUpdate: async (): Promise<unknown> => ({ changed: false }),
      applyGithubSourceUpdate: async (): Promise<unknown> => ({
        id: 'a'.repeat(16),
        repo: 'acme/connectors',
        sha: 'a'.repeat(40),
        registryPath: '/isolated/github/registry',
        addedAt: '2026-10-11T00:00:00.000Z',
        updatedAt: '2026-10-11T00:00:00.000Z'
      }),
      removeGithubSource: async (): Promise<boolean> => true,
      listGithubSources: (): unknown => ({ version: 1, sources: [] })
    },
    './agent/resource-icons': { readResourceIcon: (): null => null },
    './agent/packages/installer': {
      addKnownRegistry: noop,
      removeKnownRegistry: (): boolean => true,
      listKnownRegistries: async (options: {
        loadOfficialRegistry: () => Promise<unknown>
      }): Promise<unknown> => {
        await options.loadOfficialRegistry()
        return { registries: [officialSourceDetailsFixture] }
      },
      loadKnownRegistryIndexes: async (registryOptions: {
        loadOfficialRegistry: () => Promise<unknown>
      }): Promise<unknown> => ({
        registries: [
          await registryOptions.loadOfficialRegistry(),
          ...(options.customPackageRegistries ?? [])
        ],
        errors: []
      }),
      listPackageUpdates: (): unknown[] => [],
      applyPackageUpdate: async (): Promise<unknown[]> => [],
      applyPackageUpdates: async (): Promise<unknown[]> => [],
      previewOfflinePackageImport: (archivePath: string): unknown => ({
        archivePath,
        plan: {
          registry: {
            id: archivePath,
            dir: '/temporary',
            trust: 'imported',
            schemaVersion: 1,
            generatedAt: '1970-01-01T00:00:00.000Z',
            packages: []
          },
          root: { type: 'skill', id: 'offline-skill', version: '1.0.0' },
          packages: [],
          totalSize: 0,
          environments: [],
          agentDir: '/isolated'
        }
      }),
      importOfflinePackage: async (): Promise<unknown[]> => [],
      cleanupStalePackageStaging: (): string[] => [],
      readRegistry: (dir: string): unknown => ({
        id: dir,
        dir,
        trust: 'imported',
        schemaVersion: 1,
        generatedAt: '2026-10-02T00:00:00.000Z',
        packages: []
      }),
      planInstall: (registry: unknown, request: Record<string, unknown>): unknown => ({
        registry,
        root: { type: request.type, id: request.id, version: request.version ?? '1.0.0' },
        packages: [],
        totalSize: 0,
        environments: [],
        agentDir: '/isolated'
      }),
      installPackages: async (
        plan: { registry: { id: string }; root: { type: string; id: string } },
        options: { agentDir?: string }
      ): Promise<unknown[]> => {
        contentSourceCalls.push({
          phase: 'install',
          source: plan.registry.id,
          type: plan.root.type,
          id: plan.root.id,
          agentDir: options.agentDir
        })
        return [{ type: plan.root.type, id: plan.root.id }]
      },
      uninstallPackage: (): unknown[] => [],
      listInstalledPackages: (): unknown[] => []
    },
    './agent/content/skill': {
      validateSkill: (): unknown => ({ ok: true, errors: [], warnings: [] })
    },
    './agent/mcp/custom-stdio': {
      addLocalMcpConnector: async (): Promise<{ tools: string[] }> => ({ tools: [] }),
      listLocalMcpRuntimes: async (): Promise<unknown[]> => [],
      removeLocalMcpConnector: noop,
      validateLocalConnectorRequest: (value: unknown): unknown => value
    },
    './agent/mcp/local-connector-jobs': {
      createLocalConnectorJobs: () => ({
        startLocalConnectorAdd: (request: { name?: string }) => ({
          started: true,
          name: request.name ?? 'local'
        }),
        cancelLocalConnectorAdd: async (): Promise<void> => undefined,
        retryLocalConnectorAdd: (name: string) => ({ started: true, name }),
        listLocalConnectorJobs: (): unknown[] => []
      })
    },
    './agent/packages/github-source': {
      previewGithubSource: async (): Promise<unknown> => ({
        repo: 'acme/connectors',
        sha: 'a'.repeat(40),
        packages: [],
        skipped: [],
        warnings: []
      }),
      addGithubSource: async (): Promise<unknown> => ({
        id: 'a'.repeat(16),
        repo: 'acme/connectors',
        sha: 'a'.repeat(40),
        registryPath: '/isolated/github/registry',
        addedAt: '2026-10-11T00:00:00.000Z',
        updatedAt: '2026-10-11T00:00:00.000Z'
      }),
      checkGithubSourceUpdate: async (): Promise<unknown> => ({ changed: false }),
      applyGithubSourceUpdate: async (): Promise<unknown> => ({
        id: 'a'.repeat(16),
        repo: 'acme/connectors',
        sha: 'a'.repeat(40),
        registryPath: '/isolated/github/registry',
        addedAt: '2026-10-11T00:00:00.000Z',
        updatedAt: '2026-10-11T00:00:00.000Z'
      }),
      removeGithubSource: async (): Promise<boolean> => true,
      listGithubSources: (): unknown => ({ version: 1, sources: [] })
    },
    './agent/mcp/connector-setup': {
      ...connectorSetup,
      ConnectorSetupTracker: class extends connectorSetup.ConnectorSetupTracker {
        constructor(
          ...[publish, now, storage]: ConstructorParameters<
            typeof connectorSetup.ConnectorSetupTracker
          >
        ) {
          const isolatedStorage = storage
            ? { path: path.join(fixtureStateDir, randomUUID(), 'connector-setup.json') }
            : undefined
          super(publish, now, isolatedStorage)
          if (isolatedStorage) {
            operationLog.push({ type: 'connector.setup.storage', path: isolatedStorage.path })
          }
        }
      }
    },
    './agent/mcp/custom-stdio': {
      addLocalMcpConnector: async (): Promise<{ tools: string[] }> => ({ tools: [] }),
      listLocalMcpRuntimes: async (): Promise<unknown[]> => [],
      removeLocalMcpConnector: noop,
      validateLocalConnectorRequest: (value: unknown): unknown => value
    },
    './agent/mcp-connectors': {
      addRemoteMcpConnector: (
        name: string,
        url: string,
        agentDir?: string,
        options?: unknown
      ): void => {
        addedRemoteMcpConnectors.push({ name, url, agentDir, options })
      },
      disableFeaturedApiKeyAutoDiscovery: noop,
      removeRemoteMcpConnector: noop,
      readMcpServerEntry: (): undefined => undefined,
      readCustomRemoteMcpConnector: (name: string): unknown => {
        const connector =
          typeof name === 'string' ? customRemoteConnectors.get(name.trim()) : undefined
        if (!connector) throw new Error('请选择已保存的自定义 HTTP 连接器')
        return connector
      },
      listConnectorCatalog: (): unknown[] => connectorCatalogFixture,
      mcpOAuthAuthorizationOrigin: (id: string, url: string): string | undefined => {
        const allowed: Record<string, { url: string; origin: string }> = {
          notion: { url: 'https://mcp.notion.com/mcp', origin: 'https://mcp.notion.com' },
          composio: {
            url: 'https://connect.composio.dev/mcp',
            origin: 'https://connect.composio.dev'
          },
          cbioportal: {
            url: 'https://mcp.cbioportal.org/db/mcp',
            origin: 'https://mcp.cbioportal.org'
          }
        }
        return allowed[id]?.url === url ? allowed[id].origin : undefined
      },
      installCatalogConnector: async (
        source: string,
        id: string,
        _version: string,
        options: { agentDir?: string; fetch: typeof fetch }
      ): Promise<unknown[]> => {
        contentSourceCalls.push({ phase: 'mcp-install', source, id, agentDir: options.agentDir })
        if (source === officialRegistryFixture.dir)
          await options.fetch(`https://example.invalid/catalog/mcp-${id}.tar.gz`)
        return []
      },
      uninstallCatalogConnector: (): unknown[] => [],
      connectorEnvironmentBuildAction: (): unknown => {
        throw new Error('connector has no environment in this fixture')
      },
      refreshPersistedManagedStdioServers: (): unknown => {
        operationLog.push({ type: 'refreshManagedStdioServers' })
        return { config: {}, refreshed: [], failures: [], written: false }
      },
      setMcpConnectorEnabled: noop,
      setMcpPackageEnabled: (): boolean => true,
      validateName: (name: string): string => name.trim()
    },
    './agent/mcp-key-credentials': {
      API_KEY_CONNECTOR_IDS: ['tavily', 'serpapi', 'firecrawl', 'browser-use'],
      apiKeyConnector: (id: string) => {
        if (!['tavily', 'serpapi', 'firecrawl', 'browser-use'].includes(id)) {
          throw new Error('该连接器不支持 API key')
        }
        const connector = connectorCatalogFixture.find((entry) => entry.id === id)
        assert.ok(connector?.url)
        return {
          ...connector,
          apiKey: {
            header: id === 'browser-use' ? 'x-browser-use-api-key' : 'Authorization',
            obtainUrl: 'https://example.test/key'
          }
        }
      },
      clearFeaturedMcpApiKey: (id: string) => mcpApiKeys.delete(id),
      featuredMcpApiKeyStatus: (id: string) => mcpApiKeys.has(id),
      isFeaturedMcpApiKeyInstalled: (id: string) => id === 'tavily',
      readFeaturedMcpApiKey: (id: string) => mcpApiKeys.get(id),
      setFeaturedMcpApiKey: (id: string, key: string) => mcpApiKeys.set(id, key)
    },
    './agent/mcp-key-validation': {
      McpApiKeyValidationError: class extends Error {},
      validateFeaturedMcpApiKey: async () => {
        mcpApiKeyValidationCalls += 1
        if (mcpApiKeyValidationFailure) throw mcpApiKeyValidationFailure
      }
    },
    './agent/mcp/remote-project-mcp-service': {
      loadRemoteProjectMcpCatalog: async (): Promise<unknown> => ({
        summaries: [
          {
            id: 'ssh://cluster-one/canonical/project/.phi/mcp.json:server-mcp',
            name: 'server-mcp',
            sourcePath: 'ssh://cluster-one/canonical/project/.phi/mcp.json',
            status: 'configured',
            trustState: 'pending',
            available: false,
            diagnostics: ['来自服务器项目，未信任'],
            relativePath: '.phi/mcp.json',
            contentHash: 'c'.repeat(64),
            remoteProjectCwd: '/isolated/remote-project-anchors/remote-project-1',
            confirmationItems: [
              {
                id: 'server-mcp:command',
                serverName: 'server-mcp',
                kind: 'stdio-command',
                value: '/opt/server-mcp'
              }
            ]
          }
        ],
        runtimeServers: []
      }),
      trustRemoteProjectMcp: async (_context: unknown, input: Record<string, unknown>) => {
        remoteMcpMutations.push({ operation: 'trust', input })
      },
      revokeRemoteProjectMcpTrust: async (_context: unknown, input: Record<string, unknown>) => {
        remoteMcpMutations.push({ operation: 'revoke', input })
      }
    },
    './agent/resources': {
      listGlobalSkills: async (): Promise<unknown[]> => [
        {
          id: '/isolated/skills/global/SKILL.md',
          name: 'global',
          description: 'global skill',
          filePath: '/isolated/skills/global/SKILL.md',
          source: 'user',
          scope: 'user',
          sourceCategory: 'user',
          sourceCategoryLabel: 'User',
          enabled: true,
          disabled: false
        }
      ],
      readGlobalSkillContent: async (filePath: string): Promise<unknown> => {
        if (filePath !== '/isolated/skills/global/SKILL.md') {
          throw new Error('远程项目级 Skill 暂不可用')
        }
        return { filePath, content: '# global skill\n' }
      },
      listGlobalMcpServers: async (): Promise<unknown[]> => [
        {
          id: 'global-mcp',
          name: 'global-mcp',
          sourcePath: '/isolated/mcp.json',
          status: 'configured'
        }
      ],
      listSkills: async (cwd: string): Promise<unknown[]> => [
        {
          id: `${cwd}:skill`,
          name: 'skill',
          description: 'skill',
          filePath: `${cwd}/.phi/skills/skill/SKILL.md`,
          source: 'project',
          scope: 'project',
          sourceCategory: 'user',
          sourceCategoryLabel: 'User',
          enabled: true,
          disabled: false
        },
        ...Object.entries(enablementGlobal)
          .filter(([key, enabled]) => key.startsWith('skill:') && enabled)
          .map(([key]) => {
            const name = key.slice('skill:'.length)
            return {
              id: `${cwd}:${name}`,
              name,
              description: name,
              filePath: `${cwd}/.phi/skills/${name}/SKILL.md`,
              source: 'installed-package',
              scope: 'user',
              sourceCategory: 'installed-package',
              sourceCategoryLabel: '已安装',
              enabled: true,
              disabled: false
            }
          })
      ],
      readSkillContent: async (filePath: string): Promise<unknown> => ({
        filePath,
        content: '# skill\n'
      }),
      setSkillDisabled: async (
        _filePath: string,
        disabled: boolean,
        cwd: string
      ): Promise<unknown[]> => [
        {
          id: `${cwd}:skill`,
          name: 'skill',
          description: 'skill',
          filePath: `${cwd}/.phi/skills/skill/SKILL.md`,
          source: 'project',
          scope: 'project',
          sourceCategory: 'user',
          sourceCategoryLabel: 'User',
          disabled
        }
      ],
      deleteSkill: async (): Promise<unknown[]> => [],
      listPromptAgents: async (cwd: string): Promise<unknown[]> => [
        {
          id: `${cwd}:agent`,
          name: 'executor',
          description: 'agent',
          source: 'project',
          trigger: '/prompts:executor'
        }
      ],
      listMcpServers: async (cwd: string): Promise<unknown[]> => [
        {
          id: `${cwd}:mcp`,
          name: 'mcp',
          command: 'server',
          args: ['--serve'],
          envKeys: ['API_KEY'],
          sourcePath: `${cwd}/.phi/mcp.json`,
          status: 'configured'
        }
      ]
    },
    './agent/wrappers/runs': {
      submitWrapperRunPlan: (
        planId: string,
        options: { heavyWorkloadAcknowledged?: boolean }
      ): never => {
        submitPlanCalls.push({
          planId,
          heavyWorkloadAcknowledged: options.heavyWorkloadAcknowledged
        })
        throw new Error('计划不存在: (mocked in main-integration.test.ts)')
      },
      cancelWrapperRunPlan: (): never => {
        throw new Error('计划不存在: (mocked in main-integration.test.ts)')
      },
      cancelWrapperRun: (): never => {
        throw new Error('run 不存在: (mocked in main-integration.test.ts)')
      }
    },
    './agent/wrappers/remote-results': {
      listWrapperResultDirectory: async (request: unknown): Promise<unknown> => request
    },
    './agent/wrappers/remote-result-read': {
      previewWrapperResult: async (request: { path: string }): Promise<unknown> => ({
        path: `ssh://cluster-one/canonical/project/${request.path}`,
        rootPath: 'ssh://cluster-one/canonical/project',
        kind: 'text',
        mimeType: 'text/plain',
        content: 'remote result',
        bytes: 13,
        previewBytes: 13,
        truncated: false
      }),
      readWrapperResultRange: async (
        request: { path: string },
        options: { signal: AbortSignal }
      ): Promise<unknown> => {
        if (request.path === 'stall.bin') {
          return new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(new Error('read aborted')), {
              once: true
            })
          })
        }
        return { path: `ssh://cluster-one/canonical/project/${request.path}`, dataBase64: 'AA==' }
      }
    },
    './agent/wrappers/remote-result-download': {
      validateWrapperResultDownloadRequest,
      downloadWrapperResultToPath: async (
        request: unknown,
        destination: string,
        options: { signal: AbortSignal; onProgress?: (progress: unknown) => void }
      ): Promise<unknown> => {
        downloadCalls.push({ request, destination })
        return downloadImpl(request, destination, options)
      }
    },
    './agent/wrappers/store': {
      readWrapperPlan: () => wrapperPlan,
      listWrapperRuns: (): unknown[] => [],
      readWrapperRun: (): undefined => undefined,
      readWrapperPlanArtifact: (): undefined => undefined
    },
    './agent/wrappers/plans': {
      recordWrapperUploadedInput: (request: Record<string, unknown>) => request,
      retargetWrapperRunPlan: (request: Record<string, unknown>) => {
        retargetRequests.push(request)
        wrapperPlan = { ...wrapperPlan, revision: Number(wrapperPlan?.revision ?? 1) + 1 }
        return wrapperPlan
      }
    },
    './agent/wrappers/reproducibility': {
      buildWrapperReproducibilityBundle: (): never => {
        throw new Error('run 不存在: (mocked in main-integration.test.ts)')
      }
    },
    './agent/wrappers/composition/job-host-handlers': {
      createWrapperJobHostScope,
      wrapperJobHostHandlers: (
        _jobs: unknown,
        hostOptions?: { scopeFor?: unknown }
      ): Record<string, never> => {
        wrapperJobOptions.hostScopeFor = hostOptions?.scopeFor
        return {}
      }
    },
    './agent/wrappers/composition/job-continue': jobContinue,
    // The real delivery logic: this test is what proves index.ts wires it to the session timeline.
    './agent/wrappers/composition/job-notify': { deliverWrapperRunFinished },
    './agent/wrappers/composition/job-manager': {
      WrapperJobManager: class {
        constructor(options: Record<string, unknown>) {
          Object.assign(wrapperJobOptions, options)
        }
        onChange(): () => void {
          return (): void => {}
        }
        onFinish(listener: (run: unknown, status: unknown) => void): () => void {
          wrapperJobFinishListeners.push(listener)
          return (): void => {}
        }
        shutdown(): void {
          // nothing running in the harness
        }
        cancel(): Promise<{ ok: true }> {
          return Promise.resolve({ ok: true })
        }
        adoptRemoteRuns(): Promise<number> {
          return Promise.resolve(0)
        }
        hasBeenReported(runId: string): boolean {
          return reportedWrapperRuns.has(runId)
        }
      }
    },
    './agent/wrappers/composition/run-record': {
      markInterruptedCompositionRuns: (): number => 0
    },
    './agent/wrappers/executor-slurm-reconcile': {
      reconcileRemoteWrapperRuns: (): Promise<void> => Promise.resolve()
    },
    './agent/wrappers/catalog': {
      migrateLegacyCustomWrappers: (): string[] => [],
      listWrapperCatalog: (): unknown[] => [],
      addCustomWrapper: (): never => {
        throw new Error('wrapper.yaml 校验失败: (mocked in main-integration.test.ts)')
      }
    },
    // Scan core agents and explicitly supplied plugin directories, never the developer's home.
    './agent/agents/discovery': {
      discoverPhiAgents: (options: Parameters<typeof discoverPhiAgents>[0]) =>
        discoverPhiAgents({
          ...options,
          homeDir: '/nonexistent-home'
        })
    },
    './agent/plugins/preview': {
      isPluginSkillPreviewPath: (target: string): boolean =>
        target.includes(path.join('packages', 'plugin')) && target.endsWith('preview.png')
    },
    './agent/agents/remote-wrapper-agent': { loadRemoteWrapperAgent },
    './agent/agents/remote-agent-service': {
      loadRemoteAgentCatalog: async () => {
        const wrapper = loadRemoteWrapperAgent(path.join(process.cwd(), 'resources', 'agents'))
        return {
          agents: wrapper ? [wrapper] : [],
          entries: wrapper
            ? [
                {
                  id: wrapper.filePath,
                  name: wrapper.name,
                  description: wrapper.description,
                  source: 'phi-agent',
                  trigger: `调用智能体：${wrapper.name}`,
                  scope: 'local',
                  available: true
                }
              ]
            : [],
          diagnostics: []
        }
      },
      trustRemoteAgent: async (_context: unknown, input: Record<string, unknown>) => {
        remoteAgentMutations.push({ operation: 'trust', input })
      },
      revokeRemoteAgent: async (_context: unknown, input: Record<string, unknown>) => {
        remoteAgentMutations.push({ operation: 'revoke', input })
      }
    },
    './agent/content/remote-project-skill-service': {
      loadRemoteProjectSkillCatalog: async () => ({
        sources: [],
        entries: [],
        diagnostics: [],
        summaries: []
      }),
      readRemoteProjectSkillContent: async (): Promise<never> => {
        throw new Error('服务器项目 Skill fixture 不存在')
      },
      readRemoteProjectSkillResource: async (): Promise<never> => {
        throw new Error('服务器项目 Skill fixture 不存在')
      },
      trustRemoteProjectSkill: async (_context: unknown, input: Record<string, unknown>) => {
        remoteSkillMutations.push({ operation: 'trust', input })
      },
      revokeRemoteProjectSkillTrust: async (_context: unknown, input: Record<string, unknown>) => {
        remoteSkillMutations.push({ operation: 'revoke', input })
      }
    },
    './agent/packages/skill-detail': {
      readSkillPackageDetail: async (): Promise<Record<string, never>> => ({})
    },
    './agent/packages/wrapper-detail': {
      readWrapperPackageDetail: async (): Promise<Record<string, never>> => ({})
    },
    './agent/mcp-server-view': {
      withConnectorMetadata: (servers: unknown[]): unknown[] => servers
    },
    './agent/mcp/local-connector-jobs': {
      createLocalConnectorJobs: () => ({
        startLocalConnectorAdd: (request: { name?: string }) => ({
          started: true,
          name: request.name ?? 'local'
        }),
        cancelLocalConnectorAdd: async (): Promise<void> => undefined,
        retryLocalConnectorAdd: (name: string) => ({ started: true, name }),
        listLocalConnectorJobs: (): unknown[] => []
      })
    },
    './agent/packages/mutation-queue': {
      runPackageMutation: <T>(task: () => Promise<T>): Promise<T> => task()
    },
    './agent/packages/capability-approval': capabilityApproval,
    './agent/packages/capability-host': capabilityHost,
    './agent/packages/capability-service': {
      ...capabilityService,
      createCapabilityService: (deps: capabilityService.CapabilityServiceDependencies) =>
        (options.capabilityServiceCreate ?? capabilityService.createCapabilityService)(deps)
    },
    './agent/packages/external-skills': externalSkills,
    './agent/packages/official-catalog-api': {
      searchOfficialCatalog: async () => ({ matches: [], available: false })
    },
    './agent/packages/wrapper-removal': {
      removeWrapperPackage: (id: string): { kind: 'uninstalled'; id: string } => ({
        kind: 'uninstalled',
        id
      })
    },
    './agent/agents/background-approval': { BackgroundAgentApprovalTracker },
    './agent/agents/leader-prompt': { buildAgentLeaderPrompt },
    './agent/agents/run-continue': agentRunContinue,
    './agent/agents/run-host': { agentRunHostHandlers },
    './agent/wrappers/composition/discovery': {
      listWrapperCompositionCatalogStatus: (): unknown[] => [],
      resetWrapperCompositionCatalogCache: (): void => {}
    },
    './agent/remote-hosts': {
      listRemoteHostProfiles: (): unknown[] => [],
      listAvailableRemoteHostProfiles: (): unknown[] => [
        { id: 'ssh-config:lab-hpc', label: 'lab-hpc', hostAlias: 'lab-hpc', source: 'ssh-config' }
      ],
      getRemoteHostProfile: (id: string) =>
        id === 'host-1'
          ? { id, label: 'Cluster', hostAlias: options.remoteHostBinding?.() ?? 'cluster-one' }
          : id.startsWith('ssh-config:')
            ? {
                id,
                label: id.slice('ssh-config:'.length),
                hostAlias: id.slice('ssh-config:'.length),
                source: 'ssh-config'
              }
            : undefined,
      saveRemoteHostProfile: (input: { id?: string; label: string; hostAlias: string }) => ({
        id: input.id ?? 'test-remote-host',
        ...input
      }),
      remoteConnectionConfigForProfile: (profile: { hostAlias: string }) => ({
        host: profile.hostAlias
      }),
      deleteRemoteHostProfile: (): void => {}
    },
    './agent/remote-environment-store': {
      readHostRemoteEnvironmentPaths: (): Record<string, string> => ({})
    },
    './agent/remote-runtime-root-settings': {
      listRemoteHostsWithRuntimeRoots: (): unknown[] => [
        { id: 'ssh-config:lab-hpc', label: 'lab-hpc', hostAlias: 'lab-hpc', source: 'ssh-config' }
      ],
      remoteHostProfileWithRuntimeRoot: (profile: unknown): unknown => profile,
      saveRemoteEnvironmentSetting: (
        id: string,
        input: { runtimeRoot?: string; toolPaths?: Record<string, string> }
      ) => ({
        id,
        label: 'Cluster',
        hostAlias: 'cluster-one',
        ...(input.runtimeRoot ? { runtimeRoot: input.runtimeRoot } : {}),
        ...(input.toolPaths && Object.keys(input.toolPaths).length
          ? { toolPaths: input.toolPaths }
          : {})
      }),
      saveRemoteMicromambaMirrorSetting: (id: string, downloadMirrorPrefix?: string) => ({
        id,
        label: 'Cluster',
        hostAlias: 'cluster-one',
        ...(downloadMirrorPrefix ? { downloadMirrorPrefix } : {})
      }),
      saveRemoteRuntimeRootSetting: (id: string, runtimeRoot?: string) => ({
        id,
        label: 'Cluster',
        hostAlias: 'cluster-one',
        ...(runtimeRoot ? { runtimeRoot } : {})
      }),
      clearRemoteRuntimeRootSetting: (): void => {},
      clearRemoteEnvironmentSetting: (): void => {},
      clearRemoteMicromambaMirrorSetting: (): void => {},
      updateProjectRemoteConnectionRuntimeAware: (id: string) => ({
        id,
        name: 'Project',
        workingDirectory: '/projects/defaults',
        permissionMode: 'ask',
        pathAvailable: true,
        createdAt: '2026-09-05T00:00:00.000Z'
      })
    },
    './agent/ssh-config-discovery': {
      listOpenSshHosts: async () => [
        {
          alias: 'lab-hpc',
          hostname: 'compute.example.invalid',
          user: 'scientist',
          port: 22022,
          identityFiles: ['/tmp/lab-key']
        }
      ]
    },
    './agent/ssh-config-editor': {
      saveOpenSshHost: async (input: { alias: string }) => input.alias
    },
    './agent/ssh-bootstrap/default-coordinator': {
      createDefaultSshBootstrapCoordinator: () => ({})
    },
    './agent/ssh-bootstrap/ipc': {
      registerSshBootstrapIpc: (): void => {}
    },
    './agent/remote-micromamba-ipc': {
      registerRemoteMicromambaIpc: (main: {
        handle: (channel: string, handler: Handler) => void
      }): void => {
        main.handle('remote:micromamba', async (event, value: unknown) => {
          const sender = (event as { sender: { send: (channel: string, data: unknown) => void } })
            .sender
          const input = value as Record<string, unknown>
          if (!input || typeof input.requestId !== 'string' || !input.requestId) {
            throw new Error('micromamba 安装请求无效')
          }
          sender.send('remote:micromambaProgress', {
            requestId: input.requestId,
            stage: 'install',
            message: '正在安装…'
          })
          return {
            status: 'installed',
            version: '2.9.0-0',
            platform: 'linux-x64',
            durationMs: 25,
            installPath: '/data/runtime/bin/micromamba-2.9.0-0/micromamba',
            warningCodes: ['noexec'],
            message: 'micromamba 已安装并验证。'
          }
        })
      }
    },
    './agent/remote-ripgrep-ipc': {
      registerRemoteRipgrepIpc: (): void => {}
    },
    './agent/remote-micromamba-artifact': {
      remoteMicromambaManifestVersion: () => '2.9.0-0'
    },
    './agent/remote-runtime-root-store': {
      readHostRuntimeRoot: () => undefined
    },
    './agent/remote-runtime-root': {
      resolveRemoteRuntimeRoot: (input: { projectOverride?: string; hostOverride?: string }) => ({
        source: input.projectOverride ? 'project' : input.hostOverride ? 'host' : 'default',
        configured: input.projectOverride ?? input.hostOverride ?? '~/.phi/runtime'
      })
    },
    './agent/remote-runtime/controller': {
      controlRemoteRuntimeWorkspace,
      RemoteRuntimeController: class {
        readonly environments = {
          cancel: (): void => {},
          describeReadyInWorkspace: async () => options.readyEnvironmentRead?.()
        }
        readonly skills = { cancel: (): void => {} }
        owns(): boolean {
          return Boolean(options.remoteScriptRun)
        }
        scriptTools(): Promise<{ tools: unknown[]; problems: string[] }> {
          if (options.remoteResourceScripts) return options.remoteResourceScripts()
          throw new Error('remote runtime is mocked')
        }
        runSkill(): never {
          throw new Error('remote runtime is mocked')
        }
        runScriptTool(
          params: unknown,
          control?: import('../src/main/agent/remote-runtime/controller').RemoteRuntimeDispatchControl
        ): Promise<unknown> {
          if (options.remoteScriptRun) return options.remoteScriptRun(params, control)
          throw new Error('remote runtime is mocked')
        }
        requestEnvironment(): never {
          throw new Error('remote runtime is mocked')
        }
        bindEnvironment(): never {
          throw new Error('remote runtime is mocked')
        }
        approvalFor(): undefined {
          return undefined
        }
      }
    },
    './agent/remote-runtime/base-environment': {
      resolveRemoteBaseEnvironment: async () => ({ packages: [], channels: ['conda-forge'] })
    },
    './agent/remote-runtime/project-runtime-root': {
      resolveProjectRuntimeRoot: () => ({ source: 'default', configured: '~/.phi/runtime' })
    },
    './agent/remote-doctor': {
      remoteDoctor: async (hostProfileId: string, remotePath?: string, options?: unknown) => {
        remoteDoctorCalls.push({ hostProfileId, remotePath, options })
        return {
          hostProfileId,
          checkedAt: '2026-09-24T00:00:00.000Z',
          ok: true,
          checks: [{ id: 'ssh', status: 'ok', message: remotePath ?? 'connected' }]
        }
      }
    },
    './agent/remote-directory-browser': {
      listRemoteProjectDirectories: async (input: { hostProfileId: string; path: string }) => {
        remoteDirectoryCalls.push(input)
        return {
          hostProfileId: input.hostProfileId,
          path: input.path,
          directories: [{ name: 'data', path: `${input.path.replace(/\/$/, '')}/data` }],
          truncated: false
        }
      }
    },
    './agent/remote-nextflow-install': {
      installRemoteNextflow: async () => ({
        path: '/home/scientist/.local/bin/nextflow',
        alreadyInstalled: false
      })
    },
    './agent/cursor-h2-bridge': {
      createCursorH2Bridge: () => ({
        ensure: async () => 'http://127.0.0.1:12345',
        close: async () => undefined
      })
    },
    './agent/remote-project-create': {
      createCheckedRemoteProject: async (input: Record<string, unknown>) => ({
        id: 'remote-project-1',
        name: input.name,
        location: {
          kind: 'ssh',
          hostProfileId: input.hostProfileId,
          remoteRoot: input.remoteRoot,
          canonicalRoot: '/canonical/project'
        },
        workingDirectory: input.remoteRoot,
        permissionMode: input.permissionMode
      })
    },
    './agent/remote-runtime-context': {
      resolveRemoteRuntimePromptContext: () => ({
        rootLabel: '~/.phi/runtime',
        source: 'default',
        micromambaStatus: 'unchecked',
        ripgrepStatus: 'not-installed'
      })
    },
    './agent/engine/rpc/desktop-project-memory-adapter': {
      createDesktopProjectMemoryAdapter: async (adapterOptions: Record<string, unknown>) => {
        if (options.projectMemoryAdapterCreate)
          return options.projectMemoryAdapterCreate(adapterOptions)
        throw new Error('Memory adapter fixture must be explicitly supplied')
      },
      retireDesktopProjectMemoryAdapters: async (id: string): Promise<void> =>
        options.projectMemoryRetire?.(id)
    },
    './agent/remote-project-instructions': {
      loadRemoteProjectInstructions: async (): Promise<unknown[]> =>
        options.remoteInstructionsRead?.() ??
        (options.remoteRpc && !options.remoteRpcResources
          ? []
          : [
              {
                path: 'ssh://cluster-one/cluster/project/AGENTS.md',
                content: 'Remote instructions v1'
              }
            ])
    },
    './agent/remote-project-connection': {
      RemoteProjectConnectionTracker: class {
        async check(sessionId: string, projectId: string): Promise<{ phase: string }> {
          remoteConnectionChecks.push({ sessionId, projectId })
          return remoteConnectionCheck()
        }
        async observe<T>(_projectId: string, operation: () => Promise<T>): Promise<T> {
          return operation()
        }
        noteRemoteRunLost(): void {
          return undefined
        }
      }
    },
    './agent/remote-project-upload': {
      RemoteProjectUploadService: class {
        private jobs = new Map<string, Record<string, unknown>>()
        private listener: ((job: Record<string, unknown>) => void) | undefined
        subscribe(listener: (job: Record<string, unknown>) => void): () => void {
          this.listener = listener
          return () => undefined
        }
        async prepare(_projectId: string, input: { sourcePaths: string[] }): Promise<unknown> {
          const id = `upload-${this.jobs.size + 1}`
          const job = {
            id,
            status: 'queued',
            sourcePaths: input.sourcePaths,
            destinationDirectory: '',
            totalFiles: input.sourcePaths.length,
            totalBytes: input.sourcePaths.length,
            bytesTransferred: 0,
            bytesPerSecond: 0,
            requiresConfirmation: false,
            confirmed: false,
            files: input.sourcePaths.map((path) => ({
              localPath: path,
              relativePath: path.split('/').pop(),
              name: path.split('/').pop(),
              size: 1,
              sha256: 'a'.repeat(64),
              resolution: 'pending'
            })),
            createdAt: 1,
            updatedAt: 1
          }
          this.jobs.set(id, job)
          this.listener?.(job)
          return job
        }
        async start(_projectId: string, jobId: string): Promise<unknown> {
          const current = this.jobs.get(jobId)!
          const files = (current.files as Array<Record<string, unknown>>).map((file) => ({
            ...file,
            destinationPath: `/canonical/project/${String(file.name)}`,
            resolution: 'uploaded'
          }))
          const job = {
            ...current,
            files,
            status: 'completed',
            bytesTransferred: current.totalBytes
          }
          this.jobs.set(jobId, job)
          this.listener?.(job)
          return job
        }
        async wait(_projectId: string, jobId: string): Promise<unknown> {
          return this.jobs.get(jobId)
        }
        async list(): Promise<unknown[]> {
          return [...this.jobs.values()]
        }
        async cancel(jobId: string): Promise<unknown> {
          const job = { ...this.jobs.get(jobId), status: 'cancelled' }
          this.jobs.set(jobId, job)
          return job
        }
        async retry(jobId: string): Promise<unknown> {
          return this.start('', jobId)
        }
        async dispose(): Promise<void> {
          return undefined
        }
      }
    },
    './agent/transfer': {
      remoteTransferHostKey: (host: string) => `host:${host}`
    },
    './agent/wrappers/remote-ssh-session': {
      connectRemoteSshSession: async () => ({ close: async () => undefined })
    },
    './agent/remote-workspace-boundary': {
      remoteBashApprovalScope: (hostAlias: string, cwd: string) =>
        `SSH ${hostAlias} · cwd ${cwd}；Shell 命令可访问项目目录之外，当前路径检查不是命令沙箱。`,
      resolveRemoteWorkspacePath: async (request: Record<string, unknown>) => ({
        ...request,
        path: '/canonical/project/readme.md',
        hostAlias: 'cluster-one'
      }),
      resolveRemoteBashContext: async (request: Record<string, unknown>) => ({
        ...request,
        cwd: '/canonical/project',
        hostAlias: 'cluster-one',
        approvalScope: 'SSH cluster-one · cwd /canonical/project；Shell 命令可访问项目目录之外'
      }),
      resolveRemoteWorkspaceHostBinding: (request: Record<string, unknown>) => ({
        ...request,
        hostAlias: 'cluster-one',
        remoteRoot: '/cluster/project',
        canonicalRoot: '/canonical/project',
        cacheKey: options.remoteNotebookBinding?.() ?? 'remote-project-1',
        config: {
          remoteRoot: '/cluster/project',
          canonicalRoot: '/canonical/project',
          connect: async () => ({})
        }
      }),
      resolveAuthorizedRemoteConnectionConfig: (request: Record<string, unknown>) => ({
        ...request,
        hostAlias: 'cluster-one',
        connection: { hostAlias: 'cluster-one' }
      })
    },
    './agent/workspace-host/remote-registry': {
      remoteWorkspaceHosts: {
        statPaths: async (input: unknown) => {
          assert.ok(typeof input === 'object' && input !== null)
          const record = input as Record<string, unknown>
          assert.deepEqual(
            Object.keys(record).sort(),
            ['paths', 'projectId', 'sessionId'],
            'path probe input must contain only sessionId, projectId and paths'
          )
          assert.equal(typeof record.sessionId, 'string')
          assert.notEqual(record.sessionId, '')
          assert.equal(typeof record.projectId, 'string')
          assert.notEqual(record.projectId, '')
          assert.ok(Array.isArray(record.paths) && record.paths.length <= 64)
          assert.ok(record.paths.every((path) => typeof path === 'string'))
          assert.ok(
            record.paths.every(
              (candidate) =>
                typeof candidate === 'string' &&
                validRemoteAbsolutePath(candidate) &&
                path.posix.normalize(candidate) === candidate &&
                isRemotePathInside('/canonical/project', candidate)
            ),
            'path probe paths must stay inside the canonical project root'
          )
          assertBoundaryIdentity({
            sessionId: record.sessionId,
            projectId: record.projectId
          })
          return record.paths.map((path) => ({
            path,
            kind:
              path === '/canonical/project/readme.md'
                ? 'file'
                : path === '/canonical/project'
                  ? 'directory'
                  : 'missing'
          }))
        },
        releaseSession: async () => undefined,
        releaseAll: async () => undefined
      }
    },
    './agent/remote-runtime/workspace': {
      openRemoteRuntimeWorkspace: async (): Promise<unknown> => {
        if (options.remoteRuntimeWorkspace) return options.remoteRuntimeWorkspace()
        throw new Error('main integration uses the remote notebook backend mock')
      }
    },
    './agent/remote-workspace-read': {
      readRemoteWorkspacePath: async (request: unknown) => {
        assertRemoteWorkspaceFileRequest(request)
        return {
          kind: 'file',
          path: 'ssh://cluster-one/canonical/project/readme.md',
          content: `remote:${request.path}`,
          fileSize: 13,
          contentType: 'text/plain'
        }
      }
    },
    './agent/remote-workspace-file-ui': {
      previewRemoteWorkspaceFile: async (request: unknown) => {
        assertRemoteWorkspaceFileRequest(request)
        return {
          path: 'ssh://cluster-one/canonical/project/readme.md',
          name: 'readme.md',
          displayPath: 'cluster-one/canonical/project/readme.md',
          rootPath: 'ssh://cluster-one/canonical/project',
          rootLabel: 'cluster-one',
          kind: 'text',
          mimeType: 'text/plain',
          bytes: 7,
          previewBytes: 7,
          truncated: false,
          content: `remote:${request.path}`
        }
      },
      listRemoteWorkspaceDirectory: async (request: unknown) => {
        assertRemoteWorkspaceFileRequest(request)
        return {
          path: 'ssh://cluster-one/canonical/project',
          name: 'project',
          displayPath: 'cluster-one/canonical/project',
          rootPath: 'ssh://cluster-one/canonical/project',
          rootLabel: 'cluster-one',
          entries: [
            {
              path: 'ssh://cluster-one/canonical/project/readme.md',
              name: 'readme.md',
              displayPath: 'cluster-one/canonical/project/readme.md',
              kind: 'file'
            }
          ],
          truncated: false,
          requestPath: request.path
        }
      }
    },
    './agent/remote-workspace-search': {
      remoteGlob: async (request: Record<string, unknown>) => ({
        paths: ['ssh://cluster-one/canonical/project/readme.md'],
        content: `glob:${request.path}`,
        truncated: false,
        engine: 'rg',
        gitignoreApplied: true
      }),
      remoteGrep: async (request: Record<string, unknown>) => ({
        matches: [],
        content: `grep:${request.pattern}`,
        fileCount: 0,
        matchCount: 0,
        truncated: false,
        engine: 'rg',
        gitignoreApplied: true
      })
    },
    './agent/remote-workspace-bash': {
      RemoteWorkspaceBashManager: class {
        constructor(
          private readonly options: { beforeRun?: (request: Record<string, unknown>) => void }
        ) {}
        async run(request: Record<string, unknown>): Promise<unknown> {
          this.options.beforeRun?.(request)
          return {
            status: 'completed',
            hostAlias: 'cluster-one',
            cwd: '/canonical/project',
            exitCode: 0,
            stdout: 'remote-ok',
            stderr: '',
            stdoutTruncated: false,
            stderrTruncated: false,
            wallTimeMs: 1
          }
        }
        cancel(): boolean {
          return true
        }
        cancelSession(): void {
          this.cancel()
        }
        cancelAll(): void {
          this.cancel()
        }
      }
    },
    './agent/download/remote-project-download': {
      RemoteProjectDownloadManager: class {
        async run(): Promise<unknown> {
          return {
            path: 'ssh://cluster-one/canonical/project/download.bin',
            displayPath: 'download.bin',
            bytes: 8
          }
        }
        cancel(): void {
          return undefined
        }
      }
    },
    './agent/remote-workspace-write': {
      RemoteWorkspaceWriteManager: class {
        constructor(
          private readonly options: { beforeWrite?: (request: Record<string, unknown>) => void }
        ) {}
        async create(request: Record<string, unknown>): Promise<unknown> {
          this.options.beforeWrite?.(request)
          return {
            status: 'created',
            path: `ssh://cluster-one/canonical/project/${request.path}`,
            bytes: 2
          }
        }
        cancel(): boolean {
          return true
        }
        cancelSession(): void {
          this.cancel()
        }
        cancelAll(): void {
          this.cancel()
        }
      }
    },
    './agent/remote-workspace-edit': {
      RemoteWorkspaceReadBasis: class {
        readonly seen: Array<{
          sessionId: string
          projectId: string
          hostAlias: string
          path: string
          content: string
        }> = []
        record(
          sessionId: string,
          projectId: string,
          hostAlias: string,
          path: string,
          content: string
        ): void {
          this.seen.push({ sessionId, projectId, hostAlias, path, content })
        }
      },
      RemoteWorkspaceMutationManager: class {
        constructor(
          private readonly options: {
            beforeWrite?: (request: Record<string, unknown>) => void
            beforeEdit?: (request: Record<string, unknown>) => void
          }
        ) {}
        async write(request: Record<string, unknown>): Promise<unknown> {
          this.options.beforeWrite?.(request)
          return {
            status: 'created',
            path: `ssh://cluster-one/canonical/project/${request.path}`,
            bytes: 2
          }
        }
        async edit(request: Record<string, unknown>): Promise<unknown> {
          this.options.beforeEdit?.(request)
          return {
            status: 'updated',
            path: `ssh://cluster-one/canonical/project/${request.path}`,
            bytes: 2,
            oldText: request.old_string,
            newText: request.new_string
          }
        }
        cancel(): boolean {
          return true
        }
        cancelSession(): void {
          this.cancel()
        }
        cancelAll(): void {
          this.cancel()
        }
      }
    },
    './agent/remote-project-anchor': {
      remoteProjectAnchorPath: (id: string) => `/isolated/remote-project-anchors/${id}`,
      ensureRemoteProjectAnchor: (id: string) => `/isolated/remote-project-anchors/${id}`,
      isRemoteProjectAnchorPath: (path: string) => path.includes('/remote-project-anchors/')
    },
    './agent/wrappers/remote-connection-resolver': {
      resolveProjectRemoteTarget: (project: { id?: string } | undefined): unknown => {
        if (project?.id) remoteResolverProjectIds.push(project.id)
        if (options.remoteWrapperTarget && project?.id)
          return {
            projectId: project.id,
            hostProfileId: 'host-1',
            connectionId: 'selected-wrapper-connection',
            target: {
              connection: { host: 'cluster-one' },
              workspaceRoot: '/canonical/project',
              hpc: { scheduler: 'local', runtime: 'singularity' }
            }
          }
        return { reason: 'remote execution is mocked out in main-integration.test.ts' }
      }
    },
    './agent/app-logger': {
      LOG_RETENTION_DAYS: 14,
      cleanupOldLogs: () => 0,
      getPhiLogDir: () => '/tmp/phi/logs',
      writeAppLog: (entry: Record<string, unknown>) => {
        appLogs.push(entry)
      }
    },
    './agent/app-settings': {
      configureSystemUiLanguage: (languages: readonly string[]): void => {
        systemLanguage = systemUiLanguage(languages)
      },
      readLastSelectedModel: () => options.lastSelectedModel,
      writeLastSelectedModel: (model: HarnessOptions['lastSelectedModel']) => {
        options.lastSelectedModel = model
      },
      readAppSettings: (): Record<string, unknown> => ({
        uiLanguage: appUiLanguage ?? systemLanguage,
        noProjectTaskFolder: appNoProjectTaskFolder,
        allowExternalFileRead,
        preventSleepDuringRuns: false,
        nextActionSuggestionsEnabled: true,
        fileOpenConversationLayout: 'sidebar'
      }),
      updateAppSettings: (patch: Record<string, unknown>): Record<string, unknown> => {
        if (patch.uiLanguage === 'en' || patch.uiLanguage === 'zh-CN')
          appUiLanguage = patch.uiLanguage
        if (typeof patch.allowExternalFileRead === 'boolean') {
          allowExternalFileRead = patch.allowExternalFileRead
        }
        return {
          uiLanguage: appUiLanguage ?? systemLanguage,
          noProjectTaskFolder: appNoProjectTaskFolder,
          allowExternalFileRead,
          preventSleepDuringRuns: false,
          nextActionSuggestionsEnabled: true,
          fileOpenConversationLayout: 'sidebar'
        }
      }
    },
    './agent/redaction': {
      isSecretMetadataKey,
      redactSensitiveText: (text: string): string =>
        text
          .replace(/\borg-[A-Za-z0-9_-]+(?:<[^>\s]+>)?/g, '[redacted]')
          .replace(/\bak-[A-Za-z0-9_-]{8,}\b/g, '[redacted]')
    },
    './agent/session/session-lifecycle': lifecycle,
    './agent/session/session-runner-registry': { SessionRunnerRegistry: RunnerRegistry },
    './agent/session/session-export': {
      exportPhiSession: async (sessionId: string, destination: string) => {
        exportedSessions.push({ sessionId, destination })
        return {
          path: `${destination}/phi-session-${sessionId}`,
          fileCount: 5,
          bytes: 123,
          runtimeIncluded: true,
          blobCount: 1
        }
      }
    },
    './agent/deliverables/present-files': {
      validatePresentedFiles: (cwd: string, value: unknown) => {
        if (cwd.includes('remote-project-anchors')) throw new Error('local fallback rejected')
        if (!Array.isArray(value)) throw new Error('Invalid delivery files')
        return value
      }
    },
    './agent/deliverables/remote-present-files': {
      validateRemotePresentedFiles: async (identity: unknown, value: unknown) => {
        if (
          JSON.stringify(identity) !==
          JSON.stringify({ sessionId: 'phi-1', projectId: 'remote-project-1' })
        ) {
          throw new Error('Invalid remote delivery identity')
        }
        if (!Array.isArray(value)) throw new Error('Invalid remote delivery files')
        options.onRemotePresentInspect?.()
        await options.remotePresentGate
        return value.map((item) => ({
          ...(item as Record<string, unknown>),
          path: 'ssh://cluster-one/canonical/project/report.pdf',
          displayPath: 'report.pdf',
          bytes: 123
        }))
      }
    },
    './agent/session/workspace-changes': {
      beginWorkspaceChangeCapture: async (): Promise<object | null> =>
        workspaceChangeSummary ? {} : null,
      finishWorkspaceChangeCapture: async (
        _baseline: unknown,
        options?: { onTextDiff?: (name: string, patch: string) => Promise<unknown> }
      ): Promise<WorkspaceChangeSummary | null> => {
        if (!workspaceChangeSummary || !workspaceDiffPatch || !options?.onTextDiff) {
          return workspaceChangeSummary
        }
        const first = workspaceChangeSummary.files[0]
        const diff = await options.onTextDiff(first.displayPath, workspaceDiffPatch)
        return {
          ...workspaceChangeSummary,
          files: [{ ...first, ...(diff ? { diff } : {}) }, ...workspaceChangeSummary.files.slice(1)]
        } as WorkspaceChangeSummary
      }
    },
    './agent/session/workspace-diffs': {
      persistWorkspaceDiff: (sessionId: string, patch: string): unknown => {
        savedWorkspaceDiff = patch
        return { sessionId, id: 'd'.repeat(64), bytes: Buffer.byteLength(patch) }
      },
      readWorkspaceDiff: (ref: { id?: string }): string => {
        if (ref.id !== 'd'.repeat(64) || !savedWorkspaceDiff) throw new Error('Missing diff')
        return savedWorkspaceDiff
      }
    },
    './agent/session/prompt-images': {
      validatePromptImages: (value: unknown): unknown[] => (Array.isArray(value) ? value : []),
      persistPromptImages: (sessionId: string, images: unknown[]): unknown[] =>
        images.map(() => ({ sessionId, id: 'a'.repeat(64), mimeType: 'image/png' })),
      readPromptImage: (): { mimeType: string; data: string } => ({
        mimeType: 'image/png',
        data: 'iVBORw0KGgo='
      })
    },
    './agent/session/session-store': {
      toolResultDetailsForSession: (): undefined => undefined,
      appendSessionEvent: (sessionId: string, event: Record<string, unknown>) => {
        appendedSessionEvents.push({ sessionId, event })
        return { sessionId, eventId: `event-${appendedSessionEvents.length}`, ...event }
      },
      createPhiSession: (input: Record<string, unknown>): { sessionId: string } => {
        const sessionId = `phi-${++phiSessionCounter}`
        createdPhiSessions.push({ sessionId, ...input })
        return { sessionId }
      },
      createRunId: (): string => `run-${phiSessionCounter + 1}`,
      findPhiSessionByRuntimePath: (runtimeSessionPath: string): { sessionId: string } | null => {
        if (runtimeSessionPath === 'with-phi-events') return { sessionId: 'phi-existing' }
        const match = updatedSessionManifests.find(
          (entry) => entry.patch.runtimeSessionPath === runtimeSessionPath
        )
        return match ? { sessionId: match.sessionId } : null
      },
      findPhiSessionById: (sessionId: string): Record<string, unknown> | null => {
        const session = createdPhiSessions.find((entry) => entry.sessionId === sessionId)
        if (!session) return null
        const patches = updatedSessionManifests
          .filter((entry) => entry.sessionId === sessionId)
          .map((entry) => entry.patch)
        return Object.assign(
          {
            sessionId,
            cwd: session.cwd ?? '/workspace',
            permissionMode: session.permissionMode ?? 'auto',
            status: 'idle',
            unreadKind: null,
            messageCount: 0,
            createdAt: '2026-09-05T00:00:00.000Z',
            updatedAt: '2026-09-05T00:00:00.000Z',
            lastActivityAt: '2026-09-05T00:00:00.000Z'
          },
          session,
          ...patches
        )
      },
      listPhiSessions: () =>
        createdPhiSessions.map((session) => {
          const patches = updatedSessionManifests
            .filter((entry) => entry.sessionId === session.sessionId)
            .map((entry) => entry.patch)
          return Object.assign(
            {
              status: 'idle',
              unreadKind: null,
              messageCount: 0,
              createdAt: '2026-09-05T00:00:00.000Z',
              updatedAt: '2026-09-05T00:00:00.000Z',
              lastActivityAt: '2026-09-05T00:00:00.000Z'
            },
            session,
            ...patches
          )
        }),
      readSessionEvents: (sessionId: string) =>
        sessionId === 'phi-existing'
          ? [
              {
                eventId: 'event-user-existing',
                sessionId,
                createdAt: '2026-09-05T00:00:00.000Z',
                type: 'user_message',
                runId: 'run-existing',
                content: 'phi user'
              },
              {
                eventId: 'event-existing',
                sessionId,
                createdAt: '2026-09-05T00:00:00.000Z',
                type: 'tool_call_completed',
                runId: 'run-existing',
                toolCallId: 'tool-existing',
                toolName: 'bash',
                output: 'restored'
              }
            ]
          : appendedSessionEvents
              .filter((entry) => entry.sessionId === sessionId)
              .map((entry, index) => ({
                eventId: `event-${index + 1}`,
                sessionId,
                createdAt: '2026-09-05T00:00:00.000Z',
                ...entry.event
              })),
      persistToolOutput: (
        sessionId: string,
        input: { runId: string; toolCallId: string; output: string; inlineLimit?: number }
      ) => {
        persistedToolOutputs.push({ sessionId, input })
        const truncated = input.output.length > 8
        return {
          outputPreview: truncated ? `${input.output.slice(0, 8)}\n...saved` : input.output,
          ...(truncated ? { outputPath: `/tool-outputs/${input.toolCallId}.txt` } : {}),
          ...(truncated
            ? {
                outputArtifact: {
                  kind: 'tool_output',
                  path: `/tool-outputs/${input.toolCallId}.txt`,
                  bytes: input.output.length
                }
              }
            : {}),
          outputBytes: input.output.length,
          truncated
        }
      },
      recoverInterruptedPhiSessions: noop,
      updateSessionManifest: (
        sessionId: string,
        patch: Record<string, unknown>
      ): Record<string, unknown> => {
        operationLog.push({ type: 'updateSessionManifest', sessionId, patch })
        updatedSessionManifests.push({ sessionId, patch })
        return { sessionId, ...patch }
      }
    },
    './agent/session/permission-mode-control': permissionModeControl,
    './workspace-file-ipc': workspaceFileIpc,
    './agent/local-file-access': localFileAccess,
    '../../resources/icon.png?asset': { default: '/icon.png' }
  }
  const source = readFileSync(new URL('../src/main/index.ts', import.meta.url), 'utf8')
  const compiled = ts
    .transpileModule(source, {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
    })
    .outputText.replaceAll('import.meta.dirname', "'/app/main'")
  const load = (specifier: string): unknown => {
    assert.ok(specifier in modules, `Unexpected external dependency: ${specifier}`)
    return modules[specifier]
  }
  new Function('require', 'exports', 'process', compiled)(
    load,
    {},
    {
      platform: process.platform,
      env: {
        PI_CODING_AGENT_DIR: '/isolated',
        ELECTRON_RENDERER_URL: 'https://phi.internal',
        ...(options.remoteRpc ? { PHI_REMOTE_OMP_RPC: '1' } : {})
      },
      versions: { node: '22.0.0', electron: '39.0.0' }
    }
  )
  await tick()
  return {
    invoke: async (channel, ...args): Promise<unknown> => {
      const handler = handlers.get(channel)
      assert.ok(handler, `Missing IPC handler ${channel}`)
      const sender = Window.getFocusedWindow()?.webContents
      return handler({ sender, senderFrame: sender?.mainFrame }, ...args)
    },
    invokeFromForeign: async (channel, ...args): Promise<unknown> => {
      const handler = handlers.get(channel)
      assert.ok(handler, `Missing IPC handler ${channel}`)
      return handler(
        {
          sender: {
            isDestroyed: (): boolean => false,
            send: noop
          }
        },
        ...args
      )
    },
    setWorkspaceChangeSummary: (summary): void => {
      workspaceChangeSummary = summary
    },
    setWorkspaceDiffPatch: (patch): void => {
      workspaceDiffPatch = patch
    },
    setInstalledPhiPlugins: (plugins: unknown[]): void => {
      installedPhiPlugins = plugins
    },
    savedWorkspaceDiff: (): string | undefined => savedWorkspaceDiff,
    browserViews,
    closeMainWindow: (): void => {
      Window.getAllWindows()[0]?.close()
    },
    activateApp: (): void => {
      app.emit('activate')
    },
    browserWindowCount: (): number => Window.getAllWindows().length,
    tryWindowOpen: (details): { action: string } => {
      assert.ok(windowOpenHandler, 'Missing app-shell window-open handler')
      return windowOpenHandler(details)
    },
    openedExternalUrls,
    approvalResolveCalls,
    beforeQuit: (): number => {
      let prevented = 0
      app.emit('before-quit', {
        preventDefault: () => {
          prevented += 1
        }
      })
      return prevented
    },
    appQuitCount: (): number => appQuitCalls,
    tryFrameNavigation: (input): boolean => {
      let prevented = false
      frameNavigationHandler?.({
        isMainFrame: input.isMainFrame,
        frame: input.frameName ? { name: input.frameName } : null,
        url: input.url,
        preventDefault: () => {
          prevented = true
        }
      })
      return prevented
    },
    sessions,
    exportedSessions,
    deleted,
    events,
    approvalOptions,
    runnerEvents,
    runStartInputs,
    createdPhiSessions,
    remoteConnectionChecks,
    remoteAgentMutations,
    remoteSkillMutations,
    remoteMcpMutations,
    wrapperJobOptions,
    remoteResolverProjectIds,
    remoteDoctorCalls,
    remoteDirectoryCalls,
    setWrapperPlan: (plan) => {
      wrapperPlan = plan
    },
    setRemoteProjectPhase: (phase) => {
      remoteProjectPhase = phase
    },
    retargetRequests,
    submitPlanCalls,
    setRemoteConnectionCheck: (impl) => {
      remoteConnectionCheck = impl
    },
    createdAgentOptions,
    remoteRoutingOptions,
    renamedSessions,
    savedPersonas,
    resourceLoaderOptions,
    contentSourceCalls,
    contentFetchRequests,
    updatedProjectDefaults,
    updatedSessionManifests,
    appendedSessionEvents,
    wrapperJobFinishListeners,
    hostHandlers,
    setAgentInteractionResponse: (response): void => {
      agentInteractionResponse = response
    },
    setBridgeAgentJobs: (jobs): void => {
      bridgeAgentJobs = jobs
    },
    bridgeRequests,
    bridgeStopCount: () => bridgeStops,
    failBridgeRequests: (error: Error | undefined): void => {
      bridgeFailure = error
    },
    failMcpApiKeyValidation: (error: Error | undefined): void => {
      mcpApiKeyValidationFailure = error
    },
    mcpApiKeyValidationCallCount: () => mcpApiKeyValidationCalls,
    setCustomMcpBridgeRequest: (handler): void => {
      customMcpBridgeRequest = handler
    },
    setCustomRemoteConnector: (name, connector): void => {
      if (connector) customRemoteConnectors.set(name, connector)
      else customRemoteConnectors.delete(name)
    },
    addedRemoteMcpConnectors,
    osNotifications,
    reportedWrapperRuns,
    setAppFocused: (focused: boolean): void => {
      appFocused = focused
    },
    persistedToolOutputs,
    revealedPaths,
    openedPaths,
    fileIconRequests,
    execFileCalls,
    previewReadRequests,
    appLogs,
    acknowledgedSessions,
    jupyterServerCalls,
    notebookSessionCalls,
    remoteNotebookCalls,
    notebookExecutionCalls,
    setNotebookExecutionState: (state): void => {
      notebookExecutionState = state
    },
    notebookFormatCalls,
    managedEnvironmentBuildCalls,
    openDialogOptions,
    saveDialogOptions,
    downloadCalls,
    operationLog,
    setOpenDialogResult: (result): void => {
      openDialogResult = result
    },
    setSaveDialogResult: (result): void => {
      saveDialogResult = result
    },
    setDownloadImpl: (impl): void => {
      downloadImpl = impl
    }
  }
}

test('main browser IPC routes the trusted renderer through the current Phi session', async () => {
  const app = await harness()
  const current = (await app.invoke('sessions:create')) as { phiSessionId: string }
  const initial = (await app.invoke('browser:snapshot', {
    sessionId: 'phi-forged'
  })) as { sessionId: string; tabs: unknown[] }
  assert.equal(initial.sessionId, current.phiSessionId)
  assert.deepEqual(initial.tabs, [])
  assert.equal(app.browserViews.length, 0)

  const outcome = (await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'browser-open-1',
    url: 'https://example.test',
    sessionId: 'phi-forged',
    actor: { kind: 'agent', sessionId: 'phi-forged' }
  })) as { ok: boolean; snapshot: { sessionId: string } }

  assert.equal(outcome.ok, true)
  assert.equal(outcome.snapshot.sessionId, current.phiSessionId)
  await assert.rejects(
    app.invokeFromForeign('browser:snapshot'),
    /Browser renderer is not authorized/
  )
})

test('main browser explicit system open is validated and only runs for the trusted renderer', async () => {
  const app = await harness()
  await app.invoke('sessions:create')
  const opened = (await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'explicit-open-page',
    url: 'https://example.test/path'
  })) as {
    ok: boolean
    snapshot: { activeTabId: string; tabs: Array<{ id: string; documentRevision: number }> }
  }
  assert.equal(opened.ok, true)

  const external = (await app.invoke('browser:execute', {
    type: 'openExternal',
    requestId: 'explicit-system-open',
    tabId: opened.snapshot.activeTabId,
    expectedDocumentRevision: opened.snapshot.tabs[0].documentRevision
  })) as { ok: boolean }
  assert.equal(external.ok, true)
  assert.deepEqual(app.openedExternalUrls, ['https://example.test/path'])

  await assert.rejects(
    app.invokeFromForeign('browser:execute', {
      type: 'openExternal',
      requestId: 'forged-system-open',
      tabId: opened.snapshot.activeTabId,
      expectedDocumentRevision: opened.snapshot.tabs[0].documentRevision
    }),
    /Browser renderer is not authorized/
  )
  assert.deepEqual(app.openedExternalUrls, ['https://example.test/path'])
})

test('app-shell window opens route safe pages in-app and modified clicks externally', async () => {
  const app = await harness()
  await app.invoke('sessions:create')

  assert.deepEqual(
    app.tryWindowOpen({ url: 'https://in-app.example/path', disposition: 'default' }),
    { action: 'deny' }
  )
  await tick()
  assert.equal(app.browserViews.length, 1)
  assert.equal(
    app.browserViews[0].webContents.loadedUrls.includes('https://in-app.example/path'),
    true
  )
  assert.deepEqual(app.openedExternalUrls, [])
  assert.equal(
    app.events.some(
      (entry) =>
        entry.channel === 'browser:event' &&
        (entry.data as { event?: { type?: string } }).event?.type === 'panelRequested'
    ),
    true
  )

  assert.deepEqual(
    app.tryWindowOpen({ url: 'https://external.example/path', disposition: 'background-tab' }),
    { action: 'deny' }
  )
  await tick()
  assert.deepEqual(app.openedExternalUrls, ['https://external.example/path'])
  assert.equal(app.browserViews.length, 1)

  assert.deepEqual(
    app.tryWindowOpen({ url: 'https://script-window.example/path', disposition: 'new-window' }),
    { action: 'deny' }
  )
  await tick()
  assert.deepEqual(app.openedExternalUrls, ['https://external.example/path'])
  assert.equal(app.browserViews.length, 2)
  assert.equal(
    app.browserViews[1].webContents.loadedUrls.includes('https://script-window.example/path'),
    true
  )

  for (const url of [
    'javascript:alert(1)',
    'https://user:password@credential.example/',
    'https://phi.internal/private',
    'https://PHI.INTERNAL.:443/private'
  ]) {
    for (const disposition of ['default', 'background-tab']) {
      assert.deepEqual(app.tryWindowOpen({ url, disposition }), {
        action: 'deny'
      })
    }
  }
  assert.deepEqual(
    app.tryWindowOpen({
      url: 'https://post.example/submit',
      disposition: 'default',
      postBody: { data: [{ bytes: 'secret' }] }
    }),
    { action: 'deny' }
  )
  await tick()
  assert.deepEqual(app.openedExternalUrls, ['https://external.example/path'])
  assert.equal(app.browserViews.length, 2)
})

test('app-shell window open reports failure without shell fallback when no Phi session is active', async () => {
  const app = await harness()
  assert.deepEqual(
    app.tryWindowOpen({ url: 'https://fallback.example/path', disposition: 'default' }),
    { action: 'deny' }
  )
  await tick()
  assert.deepEqual(app.openedExternalUrls, [])
  assert.equal(app.browserViews.length, 0)
  assert.deepEqual(app.events.at(-1), {
    channel: 'browser:event',
    data: {
      sessionId: null,
      event: { type: 'appShellOpenFailed', reason: 'browserUnavailable' }
    }
  })
})

test('main browser IPC derives project partitions and applies only validated viewports', async () => {
  const app = await harness()
  await assert.rejects(app.invoke('browser:snapshot'), /Browser session is unavailable/)

  const ordinary = (await app.invoke('sessions:create')) as { phiSessionId: string }
  const ordinaryOpen = (await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'ordinary-open',
    url: 'https://ordinary.example'
  })) as { snapshot: { activeTabId: string } }
  const ordinaryPartition = app.browserViews[0].options.webPreferences.partition
  assert.doesNotMatch(ordinaryPartition, /persist:|workspace|projects\//)
  assert.equal(ordinaryOpen.snapshot.activeTabId.length > 0, true)
  assert.equal(ordinary.phiSessionId.length > 0, true)

  const project = (await app.invoke('projects:newSession', '/projects/browser-project', 'ask')) as {
    phiSessionId: string
    sessionGeneration: number
  }
  const projectOpen = (await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'project-open',
    url: 'https://project.example',
    sessionId: ordinary.phiSessionId,
    owner: { kind: 'ordinary' }
  })) as { snapshot: { sessionId: string; activeTabId: string } }
  assert.equal(projectOpen.snapshot.sessionId, project.phiSessionId)
  const projectView = app.browserViews[1]
  const projectPartition = projectView.options.webPreferences.partition
  assert.notEqual(projectPartition, ordinaryPartition)
  assert.doesNotMatch(projectPartition, /browser-project|projects\/|persist:/)

  await app.invoke('browser:setViewport', {
    sessionId: project.phiSessionId,
    sessionGeneration: project.sessionGeneration,
    tabId: projectOpen.snapshot.activeTabId,
    viewport: { x: 10, y: 20, width: 300, height: 200 }
  })
  assert.deepEqual(projectView.bounds.at(-1), { x: 10, y: 20, width: 300, height: 200 })
  assert.equal(projectView.visibility.at(-1), true)
  const beforeInvalid = projectView.bounds.length
  await assert.rejects(
    app.invoke('browser:setViewport', {
      sessionId: project.phiSessionId,
      sessionGeneration: project.sessionGeneration,
      tabId: projectOpen.snapshot.activeTabId,
      viewport: { x: 0, y: 0, width: Number.NaN, height: 200 }
    }),
    /Invalid browser request/
  )
  assert.equal(projectView.bounds.length, beforeInvalid)

  const browserEvents = app.events.filter((event) => event.channel === 'browser:event')
  assert.equal(browserEvents.length > 0, true)
  assert.equal(
    browserEvents.some(
      (entry) => (entry.data as { sessionId?: string }).sessionId === project.phiSessionId
    ),
    true
  )
})

test('main session switching suspends old native views and requires a fresh session viewport', async () => {
  const app = await harness()
  const sessionA = (await app.invoke('sessions:create')) as {
    path: string
    phiSessionId: string
    sessionGeneration: number
  }
  const openedA = (await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'switch-browser-a',
    url: 'https://a.example'
  })) as { snapshot: { activeTabId: string } }
  await app.invoke('browser:setViewport', {
    sessionId: sessionA.phiSessionId,
    sessionGeneration: sessionA.sessionGeneration,
    tabId: openedA.snapshot.activeTabId,
    viewport: { x: 1, y: 2, width: 300, height: 180 }
  })
  const viewA = app.browserViews[0]
  assert.equal(viewA.visibility.at(-1), true)

  const sessionB = (await app.invoke('sessions:create')) as {
    path: string
    phiSessionId: string
    sessionGeneration: number
  }
  await tick()
  assert.equal(viewA.visibility.at(-1), false)
  const openedB = (await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'switch-browser-b',
    url: 'https://b.example'
  })) as { snapshot: { activeTabId: string } }
  await app.invoke('browser:setViewport', {
    sessionId: sessionB.phiSessionId,
    sessionGeneration: sessionB.sessionGeneration,
    tabId: openedB.snapshot.activeTabId,
    viewport: { x: 3, y: 4, width: 320, height: 200 }
  })
  const viewB = app.browserViews[1]
  assert.equal(viewB.visibility.at(-1), true)

  const restoredA = (await app.invoke('sessions:switch', sessionA.path)) as {
    phiSessionId: string
    sessionGeneration: number
  }
  assert.equal(restoredA.phiSessionId, sessionA.phiSessionId)
  await tick()
  assert.equal(viewB.visibility.at(-1), false)
  assert.equal(viewA.visibility.at(-1), false)
  assert.equal(app.browserViews.length, 2)
  await app.invoke('browser:setViewport', {
    sessionId: sessionA.phiSessionId,
    sessionGeneration: restoredA.sessionGeneration,
    tabId: openedA.snapshot.activeTabId,
    viewport: { x: 5, y: 6, width: 340, height: 220 }
  })
  assert.equal(viewA.visibility.at(-1), true)
  await assert.rejects(
    app.invoke('browser:setViewport', {
      sessionId: sessionB.phiSessionId,
      sessionGeneration: sessionB.sessionGeneration,
      tabId: openedB.snapshot.activeTabId,
      viewport: null
    }),
    /Browser session is unavailable/
  )
  assert.equal(viewA.visibility.at(-1), true)
  assert.equal(app.browserViews.length, 2)
})

test('main browser host handler trusts runtime origin and ignores forged agent identity', async () => {
  const session = new FakeSession('browser-agent.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const current = (await app.invoke('projects:newSession', '/projects/browser-agent', 'ask')) as {
    phiSessionId: string
  }
  const prompt = app.invoke('agent:prompt', 'initialize runtime mapping')
  while (!session.started) await tick()
  const runtimeSessionId = app.sessions[0].runtimeSessionId
  const execute = app.hostHandlers.get('browser.execute')
  const cancel = app.hostHandlers.get('browser.cancel')
  assert.ok(execute)
  assert.ok(cancel)

  const humanCurrent = (await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'human-current-open',
    url: 'https://human-current.example'
  })) as {
    snapshot: { activeTabId: string; tabs: Array<{ id: string; documentRevision: number }> }
  }
  const humanCurrentTab = humanCurrent.snapshot.tabs.find(
    (tab) => tab.id === humanCurrent.snapshot.activeTabId
  )
  assert.ok(humanCurrentTab)
  const currentNavigation = (await execute({
    originSessionId: runtimeSessionId,
    requestId: 'agent-current-navigate',
    toolCallId: 'tool-current-navigate',
    command: {
      type: 'navigate',
      requestId: 'agent-current-navigate',
      tabId: humanCurrentTab.id,
      url: 'https://claimed-current.example',
      expectedDocumentRevision: humanCurrentTab.documentRevision,
      requireActive: true
    }
  })) as { ok: boolean; snapshot: { tabs: Array<{ id: string; url: string }> } }
  assert.equal(currentNavigation.ok, true, JSON.stringify(currentNavigation))
  assert.equal(
    currentNavigation.snapshot.tabs.find((tab) => tab.id === humanCurrentTab.id)?.url,
    'https://claimed-current.example/'
  )

  const humanSnapshot = (await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'human-snapshot-open',
    url: 'https://human-snapshot.example'
  })) as {
    snapshot: { activeTabId: string; tabs: Array<{ id: string; documentRevision: number }> }
  }
  const humanSnapshotTab = humanSnapshot.snapshot.tabs.find(
    (tab) => tab.id === humanSnapshot.snapshot.activeTabId
  )
  assert.ok(humanSnapshotTab)
  const currentSnapshot = (await execute({
    originSessionId: runtimeSessionId,
    requestId: 'agent-current-snapshot',
    toolCallId: 'tool-current-snapshot',
    command: {
      type: 'snapshot',
      requestId: 'agent-current-snapshot',
      tabId: humanSnapshotTab.id,
      expectedDocumentRevision: humanSnapshotTab.documentRevision,
      requireActive: true
    }
  })) as { ok: boolean; screenshot?: { tabId: string } }
  assert.equal(currentSnapshot.ok, true, JSON.stringify(currentSnapshot))
  assert.equal(currentSnapshot.screenshot?.tabId, humanSnapshotTab.id)

  await cancel({
    originSessionId: runtimeSessionId,
    requestId: 'agent-cancelled-1',
    toolCallId: 'tool-call-cancelled'
  })
  const cancelled = (await execute({
    originSessionId: runtimeSessionId,
    requestId: 'agent-cancelled-1',
    toolCallId: 'tool-call-cancelled',
    command: {
      type: 'open',
      requestId: 'agent-cancelled-1',
      url: 'https://cancelled.example'
    }
  })) as { ok: boolean; error?: { code?: string } }
  assert.equal(cancelled.ok, false)
  assert.equal(cancelled.error?.code, 'ACTION_CANCELLED')

  const outcome = (await execute({
    originSessionId: runtimeSessionId,
    requestId: 'agent-open-1',
    runId: 'agent-run-1',
    toolCallId: 'tool-call-1',
    sessionId: 'phi-forged',
    actor: { kind: 'human' },
    command: {
      type: 'open',
      requestId: 'agent-open-1',
      url: 'https://agent.example'
    }
  })) as { snapshot: { sessionId: string; tabs: Array<{ isAgentControlled: boolean }> } }
  assert.equal(outcome.snapshot.sessionId, current.phiSessionId)
  assert.equal(outcome.snapshot.tabs.at(-1)?.isAgentControlled, true)

  await cancel({
    originSessionId: runtimeSessionId,
    requestId: 'agent-open-1',
    toolCallId: 'tool-call-1'
  })
  const replay = (await execute({
    originSessionId: runtimeSessionId,
    requestId: 'agent-open-1',
    toolCallId: 'tool-call-1',
    command: {
      type: 'open',
      requestId: 'agent-open-1',
      url: 'https://agent.example'
    }
  })) as { ok: boolean }
  assert.equal(replay.ok, true)

  await assert.rejects(
    execute({
      originSessionId: 'runtime-unknown',
      requestId: 'unknown-open',
      runId: 'agent-run-1',
      toolCallId: 'tool-call-1',
      command: { type: 'open', requestId: 'unknown-open', url: 'https://unknown.example' }
    }),
    /Active browser run is unavailable/
  )
  session.finish.resolve()
  await prompt
})

test('main run completion and stop dispose their dedicated browser tabs', async () => {
  for (const outcome of ['completed', 'stopped'] as const) {
    const session = new FakeSession(`browser-run-${outcome}.jsonl`)
    session.hold = true
    const app = await harness(async () => session)
    await app.invoke('projects:newSession', `/projects/browser-${outcome}`, 'ask')
    const prompt = app.invoke('agent:prompt', `browser ${outcome}`)
    while (!session.started) await tick()
    const execute = app.hostHandlers.get('browser.execute')
    assert.ok(execute)
    await execute({
      originSessionId: session.runtimeSessionId,
      requestId: `run-open-${outcome}`,
      toolCallId: `run-tool-${outcome}`,
      command: {
        type: 'open',
        requestId: `run-open-${outcome}`,
        url: `https://${outcome}.example`
      }
    })
    const view = app.browserViews[0]
    if (outcome === 'stopped') await app.invoke('agent:stop')
    else session.finish.resolve()
    await prompt
    for (let attempt = 0; attempt < 10 && view.webContents.closeCalls === 0; attempt += 1) {
      await tick()
    }
    assert.equal(view.webContents.closeCalls, 1)
    const snapshot = (await app.invoke('browser:snapshot')) as { tabs: unknown[] }
    assert.deepEqual(snapshot.tabs, [])
  }
})

test('agent module installation always requests bound approval in automatic permission mode', async () => {
  const session = new FakeSession('module-install-auto.jsonl')
  session.hold = true
  const approvals: Record<string, unknown>[] = []
  const app = await harness(async () => session, {
    moduleApproval: async (request, signal) => {
      assert.equal(signal.aborted, false)
      approvals.push(request)
      return 'denied'
    },
    capabilityServiceCreate: (deps) => ({
      ...capabilityService.createCapabilityService(deps),
      install: async (params, context) => {
        const runtimeSessionId = (params as { runtimeSessionId: string }).runtimeSessionId
        const approved = await deps.confirm(
          {
            runtimeSessionId,
            candidateId: 'fixture-candidate',
            root: { type: 'skill', id: 'fixture-analysis', version: '1.2.3' },
            action: 'install',
            reason: '当前样本分析需要这个技能',
            source: 'Phi Packages',
            trust: 'official',
            totalSize: 1024,
            environments: [],
            packages: [
              {
                type: 'skill',
                id: 'fixture-analysis',
                version: '1.2.3',
                title: '分析技能',
                source: 'Phi Packages',
                trust: 'official',
                size: 1024,
                alreadyInstalled: false
              }
            ]
          },
          context
        )
        assert.equal(approved, false)
        return { ok: false, installed: false, status: 'denied', message: 'denied' }
      }
    })
  })
  const current = (await app.invoke('projects:newSession', '/projects/modules-auto', 'auto')) as {
    phiSessionId: string
  }
  const prompt = app.invoke('agent:prompt', '分析当前样本')
  while (!session.started) await tick()
  try {
    const install = app.hostHandlers.get('capabilities.install')
    assert.ok(install)
    const result = await install(
      {
        runtimeSessionId: session.runtimeSessionId,
        toolCallId: 'module-call',
        requestId: 'module-request',
        candidateId: 'fixture-candidate',
        reason: 'needed'
      },
      { originSessionId: session.runtimeSessionId, toolCallId: 'module-call' }
    )
    assert.deepEqual(result, { ok: false, installed: false, status: 'denied', message: 'denied' })
    assert.equal(approvals.length, 1)
    assert.equal(approvals[0].sessionId, current.phiSessionId)
    assert.equal(approvals[0].toolCallId, 'module-call')
    assert.equal(approvals[0].toolName, 'capability_install')
    assert.match(String(approvals[0].summary), /fixture-analysis @ 1.2.3/)
    assert.equal(session.disposed, false)
    assert.equal(session.log.includes('abort'), false)
  } finally {
    session.finish.resolve()
    await prompt
  }
})

test('main approval response validates payload, renderer identity, and one-shot resolution', async () => {
  const app = await harness()
  assert.equal(await app.invokeFromForeign('tool:approval-response', 'approval-live', true), false)
  assert.equal(await app.invoke('tool:approval-response', 'approval-live', 'false'), false)
  assert.equal(await app.invoke('tool:approval-response', '', true), false)
  assert.equal(await app.invoke('tool:approval-response', 'approval-unknown', true), false)
  assert.equal(await app.invoke('tool:approval-response', 'approval-live', true), true)
  assert.equal(await app.invoke('tool:approval-response', 'approval-live', true), false)
  assert.deepEqual(app.approvalResolveCalls, [
    { requestId: 'approval-live', approved: true, trusted: false },
    { requestId: 'approval-unknown', approved: true, trusted: true },
    { requestId: 'approval-live', approved: true, trusted: true },
    { requestId: 'approval-live', approved: true, trusted: true }
  ])
})

test('main browser cleanup restores idle metadata without loading pages after window reopen', async () => {
  const app = await harness()
  const current = (await app.invoke('sessions:create')) as {
    path: string
    phiSessionId: string
  }
  await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'delete-open',
    url: 'https://delete.example'
  })
  const deletedView = app.browserViews[0]
  await app.invoke('sessions:delete', current.path)
  assert.equal(deletedView.webContents.closeCalls, 1)
  assert.deepEqual(app.deleted, [current.path])

  await app.invoke('sessions:create')
  await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'window-open',
    url: 'https://window.example'
  })
  const windowView = app.browserViews.at(-1)
  assert.ok(windowView)
  const viewCountBeforeClose = app.browserViews.length
  app.closeMainWindow()
  await tick()
  assert.equal(windowView.webContents.closeCalls, 1)
  assert.equal(app.browserWindowCount(), 0)

  app.activateApp()
  assert.equal(app.browserWindowCount(), 1)
  const restored = (await app.invoke('browser:snapshot')) as {
    activeTabId: string
    tabs: Array<{ id: string; restorable?: boolean; url: string }>
  }
  assert.equal(restored.tabs.length, 1)
  assert.equal(restored.tabs[0].restorable, true)
  assert.equal(restored.tabs[0].url, 'https://window.example/')
  assert.equal(app.browserViews.length, viewCountBeforeClose)

  await app.invoke('browser:execute', {
    type: 'restore',
    requestId: 'restore-after-reopen',
    tabId: restored.activeTabId
  })
  assert.equal(app.browserViews.length, viewCountBeforeClose + 1)
  assert.equal(
    app.browserViews.at(-1)?.webContents.loadedUrls.includes('https://window.example/'),
    true
  )
})

test('before quit waits for browser cleanup and resumes app quit exactly once', async () => {
  const app = await harness()
  await app.invoke('sessions:create')
  await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'before-quit-open',
    url: 'https://quit.example'
  })
  const view = app.browserViews[0]
  assert.equal(app.beforeQuit(), 1)
  assert.equal(app.appQuitCount(), 0)
  for (let attempt = 0; attempt < 20 && app.appQuitCount() === 0; attempt += 1) {
    await tick()
  }
  assert.equal(view.webContents.closeCalls, 1)
  assert.equal(app.appQuitCount(), 1)
  assert.equal(app.beforeQuit(), 0)
  await tick()
  assert.equal(view.webContents.closeCalls, 1)
  assert.equal(app.appQuitCount(), 1)
})

test('before quit does not wait for a hung runtime abort after browser cleanup', async () => {
  const session = new FakeSession('hung-abort.jsonl')
  session.hold = true
  session.abortGate = new Promise<void>(() => undefined)
  const app = await harness(async () => session)
  await app.invoke('sessions:create')
  const prompt = app.invoke('agent:prompt', 'hold runtime abort')
  while (!session.started) await tick()
  await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'hung-abort-open',
    url: 'https://hung-abort.example'
  })
  const view = app.browserViews[0]
  assert.equal(app.beforeQuit(), 1)
  assert.equal(app.beforeQuit(), 1)
  for (let attempt = 0; attempt < 20 && app.appQuitCount() === 0; attempt += 1) {
    await tick()
  }
  assert.equal(view.webContents.closeCalls, 1)
  assert.equal(app.appQuitCount(), 1)
  session.finish.resolve()
  await prompt
})

test('main browser cleanup failure permanently rejects browser recreation for the process', async () => {
  const app = await harness()
  await app.invoke('sessions:create')
  await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'failed-window-open',
    url: 'https://failed-window.example'
  })
  const failedView = app.browserViews[0]
  failedView.webContents.closeError = new Error('raw window cleanup secret')
  app.closeMainWindow()
  await tick()
  assert.equal(failedView.webContents.closeCalls, 1)
  assert.equal(app.browserWindowCount(), 0)

  app.activateApp()
  assert.equal(app.browserWindowCount(), 1)
  const viewCount = app.browserViews.length
  for (const request of [
    () => app.invoke('browser:snapshot'),
    () =>
      app.invoke('browser:execute', {
        type: 'open',
        requestId: 'must-not-recreate',
        url: 'https://must-not-load.example'
      })
  ]) {
    await assert.rejects(
      request(),
      (error: Error) =>
        error.message === 'Browser request failed' &&
        !error.message.includes('raw window cleanup secret')
    )
  }
  assert.equal(app.browserViews.length, viewCount)
  assert.equal(failedView.webContents.closeCalls, 1)
})

test('main browser session deletion keeps a cleanup tombstone without leaking raw errors', async () => {
  const app = await harness()
  const current = (await app.invoke('sessions:create')) as {
    path: string
    phiSessionId: string
  }
  await app.invoke('browser:execute', {
    type: 'open',
    requestId: 'failed-delete-open',
    url: 'https://cleanup.example'
  })
  app.browserViews[0].webContents.closeError = new Error('raw session cleanup secret')

  await app.invoke('sessions:delete', current.path)
  assert.deepEqual(app.deleted, [current.path])
  await app.invoke('sessions:switch', current.path)
  await assert.rejects(
    app.invoke('browser:snapshot'),
    (error: Error) =>
      error.message === 'Browser request failed' &&
      !error.message.includes('raw session cleanup secret')
  )
})

test(
  'main IPC: stopping during SDK preflight never starts the cancelled model run',
  { timeout: 3000 },
  async () => {
    const gate = deferred<void>()
    const session = new FakeSession('fresh.jsonl')
    session.preflight = gate.promise
    const app = await harness(async () => session)
    const prompt = app.invoke('agent:prompt', 'hello')
    await tick()
    await app.invoke('agent:stop')
    gate.resolve()
    await prompt
    assert.equal(session.started, false)
  }
)

test('main IPC: user prompt stays verbatim while recommendation settings are read separately', async () => {
  const session = new FakeSession('fresh.jsonl')
  const app = await harness(async () => session)

  await app.invoke('agent:prompt', 'hello')

  assert.deepEqual(session.promptTexts, ['hello'])
  assert.equal(app.appendedSessionEvents[0].event.content, 'hello')
  assert.equal(await app.hostHandlers.get('settings.nextActionSuggestionsEnabled')?.({}), true)
  assert.deepEqual(await app.hostHandlers.get('cursorBridge.ensure')?.({}), {
    baseUrl: 'http://127.0.0.1:12345'
  })
})

test('main IPC: app settings exposes general preferences', async () => {
  const app = await harness()

  assert.deepEqual(await app.invoke('settings:get'), {
    uiLanguage: 'en',
    noProjectTaskFolder: '/workspace',
    allowExternalFileRead: false,
    preventSleepDuringRuns: false,
    nextActionSuggestionsEnabled: true,
    fileOpenConversationLayout: 'sidebar'
  })
  const requests = app.bridgeRequests.length
  const updated = (await app.invoke('settings:update', { uiLanguage: 'zh-CN' })) as {
    uiLanguage: string
  }
  assert.equal(updated.uiLanguage, 'zh-CN')
  assert.equal(((await app.invoke('settings:get')) as { uiLanguage: string }).uiLanguage, 'zh-CN')
  assert.equal(
    app.bridgeRequests.length,
    requests,
    'changing display language does not restart or call the agent runtime'
  )
})

test('main IPC: initial language follows the system while saved choices take priority', async () => {
  const chinese = await harness(undefined, { systemLanguages: ['zh-Hans-CN', 'en-US'] })
  assert.equal(
    ((await chinese.invoke('settings:get')) as { uiLanguage: string }).uiLanguage,
    'zh-CN'
  )
  await chinese.invoke('projects:pickDirectory')
  assert.equal(chinese.openDialogOptions.at(-1)?.title, '选择项目文件夹')
  const updated = await chinese.invoke('settings:update', { allowExternalFileRead: true })
  assert.equal((updated as { uiLanguage: string }).uiLanguage, 'zh-CN')

  const savedEnglish = await harness(undefined, { systemLanguages: ['zh-CN'], uiLanguage: 'en' })
  assert.equal(
    ((await savedEnglish.invoke('settings:get')) as { uiLanguage: string }).uiLanguage,
    'en'
  )
  await savedEnglish.invoke('projects:pickDirectory')
  assert.equal(savedEnglish.openDialogOptions.at(-1)?.title, 'Select a project folder')

  const other = await harness(undefined, { systemLanguages: ['fr-FR', 'zh-CN'] })
  assert.equal(((await other.invoke('settings:get')) as { uiLanguage: string }).uiLanguage, 'en')
})

test('main IPC: web search settings are routed to the OMP worker', async () => {
  const app = await harness()
  const patch = {
    orderedEnabledIds: ['searxng', 'exa'],
    searxngEndpoint: 'http://127.0.0.1:8888',
    searxngEngines: 'sogou wechat'
  }

  await app.invoke('settings:webSearch:get')
  await app.invoke('settings:webSearch:update', patch)
  await app.invoke('settings:webSearch:searxngEngines')
  await app.invoke('settings:webSearch:apiKey:set', 'brave', 'test-key')
  await app.invoke('settings:webSearch:apiKey:clear', 'brave')

  assert.deepEqual(app.bridgeRequests.slice(-5), [
    { method: 'settings.webSearch.get', params: { agentDir: '/isolated' } },
    { method: 'settings.webSearch.update', params: { agentDir: '/isolated', patch } },
    { method: 'settings.webSearch.searxngEngines', params: { agentDir: '/isolated' } },
    {
      method: 'settings.webSearch.apiKey.set',
      params: { agentDir: '/isolated', providerId: 'brave', key: 'test-key' }
    },
    {
      method: 'settings.webSearch.apiKey.clear',
      params: { agentDir: '/isolated', providerId: 'brave' }
    }
  ])
})

test('main IPC: project memory is read and cleared by the worker under its session cwd', async () => {
  const app = await harness()

  const local = (await app.invoke('memory:snapshot', 'project-/projects/demo')) as {
    projectId: string
    settings: unknown
  }
  assert.equal(local.projectId, 'project-/projects/demo')
  assert.deepEqual(local.settings, { enabled: false, learn: false })
  await app.invoke('memory:deleteLesson', 'remote-project-1', 2, 'lesson')
  await app.invoke('memory:clear', 'remote-project-1')
  await assert.rejects(app.invoke('memory:snapshot', 'missing'), /项目不存在/)

  // Local projects key memory by their directory; remote ones by their local anchor.
  assert.deepEqual(
    app.bridgeRequests.filter((request) => request.method.startsWith('memory.')),
    [
      { method: 'memory.read', params: { agentDir: '/isolated', cwd: '/projects/demo' } },
      {
        method: 'memory.deleteLesson',
        params: {
          agentDir: '/isolated',
          cwd: '/isolated/remote-project-anchors/remote-project-1',
          index: 2,
          text: 'lesson'
        }
      },
      {
        method: 'memory.read',
        params: { agentDir: '/isolated', cwd: '/isolated/remote-project-anchors/remote-project-1' }
      },
      {
        method: 'memory.clear',
        params: { agentDir: '/isolated', cwd: '/isolated/remote-project-anchors/remote-project-1' }
      },
      {
        method: 'memory.read',
        params: { agentDir: '/isolated', cwd: '/isolated/remote-project-anchors/remote-project-1' }
      }
    ]
  )
})

test('main IPC: reveal path is limited to Phi-owned files', async () => {
  const app = await harness()

  await app.invoke('files:reveal', '/isolated/sessions/session-1/tool-outputs/out.txt')
  await assert.rejects(
    app.invoke('files:reveal', '/tmp/out.txt'),
    /只能显示 Phi 保存的文件或当前项目内的文件/
  )
  await assert.rejects(app.invoke('files:reveal', 'relative.txt'), /只能显示绝对路径/)

  assert.deepEqual(app.revealedPaths, ['/isolated/sessions/session-1/tool-outputs/out.txt'])
})

test('main IPC: reveal path allows files inside the active project cwd', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/current', 'ask')
  await app.invoke('files:reveal', '/projects/current/src/App.tsx')
  await assert.rejects(
    app.invoke('files:reveal', '/projects/other/src/App.tsx'),
    /只能显示 Phi 保存的文件或当前项目内的文件/
  )

  assert.deepEqual(app.revealedPaths, ['/projects/current/src/App.tsx'])
})

test('main IPC: file icons use the same local file boundary as file actions', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/current', 'ask')
  const icon = await app.invoke('files:getIcon', '/projects/current/src/App.tsx')
  const pngIcon = await app.invoke('files:getIcon', '/projects/current/plot.png')

  assert.equal(icon, 'data:image/png;base64,aWNvbg==')
  assert.equal(pngIcon, 'data:image/png;base64,aWNvbg==')
  assert.deepEqual(app.fileIconRequests, [
    process.platform === 'darwin'
      ? '/Applications/Visual Studio Code.app'
      : '/projects/current/src/App.tsx',
    process.platform === 'darwin'
      ? '/System/Applications/Preview.app'
      : '/projects/current/plot.png'
  ])
  if (process.platform === 'darwin') {
    assert.equal(app.execFileCalls.at(0)?.file, '/usr/bin/plutil')
    assert.equal(app.execFileCalls.at(1)?.file, '/usr/bin/mdfind')
    assert.equal(app.execFileCalls.at(2)?.file, '/usr/bin/mdfind')
    assert.equal(app.execFileCalls.length, 3)
  }
  await assert.rejects(
    app.invoke('files:getIcon', '/projects/other/src/App.tsx'),
    /只能读取图标 Phi 保存的文件或当前项目内的文件/
  )
  await assert.rejects(app.invoke('files:getIcon', 'relative.txt'), /只能读取图标绝对路径/)
})

test('main IPC: local path stats only report allowed existing files and directories', async () => {
  const app = await harness()

  const stats = await app.invoke('files:statLocalPaths', '/projects/current', [
    '/projects/current/README.md',
    '/projects/current/src',
    '/projects/current/qc-demo.csv',
    '/projects/current/notebooks/eda.ipynb',
    '/projects/current/adj.P.Val',
    '/projects/other/secret.txt',
    'relative.txt'
  ])

  assert.deepEqual(stats, [
    { path: '/projects/current/README.md', kind: 'file' },
    { path: '/projects/current/src', kind: 'directory' },
    { path: '/projects/current/qc-demo.csv', kind: 'file' },
    { path: '/projects/current/notebooks/eda.ipynb', kind: 'file' },
    { path: '/projects/current/adj.P.Val', kind: 'missing' },
    { path: '/projects/other/secret.txt', kind: 'missing' },
    { path: 'relative.txt', kind: 'missing' }
  ])

  assert.deepEqual(await app.invoke('files:statLocalPaths', '/tmp/external', ['/workspace']), [
    { path: '/workspace', kind: 'missing' }
  ])

  await app.invoke('settings:update', { allowExternalFileRead: true })
  assert.deepEqual(
    await app.invoke('files:statLocalPaths', '/tmp/external', [
      '/projects/other/secret.txt',
      'relative.txt'
    ]),
    [
      { path: '/projects/other/secret.txt', kind: 'file' },
      { path: 'relative.txt', kind: 'missing' }
    ]
  )
})

test('main IPC: input file picker returns selected paths without reading files', async () => {
  const app = await harness()
  app.setOpenDialogResult({
    canceled: false,
    filePaths: ['/projects/current/src/App.tsx', '/tmp/external-data.csv']
  })

  const paths = await app.invoke('files:pickInput')

  assert.deepEqual(paths, ['/projects/current/src/App.tsx', '/tmp/external-data.csv'])
  assert.deepEqual(app.openDialogOptions.at(-1)?.properties, [
    'openFile',
    'openDirectory',
    'multiSelections'
  ])
  assert.equal(app.previewReadRequests.length, 0)
})

test('main IPC: native dialog copy follows saved language without changing selection semantics', async () => {
  const app = await harness()
  for (const [
    language,
    select,
    input,
    plugin,
    skill,
    project,
    executable,
    importTitle,
    importAction,
    filter
  ] of [
    [
      'en',
      'Select',
      'Select input files or folders',
      'Select a Phi Plugin directory',
      'Select a local Skill directory',
      'Select a project folder',
      'Select a tool executable',
      'Import package',
      'Import',
      'Phi package'
    ],
    [
      'zh-CN',
      '选择',
      '选择输入文件或文件夹',
      '选择 Phi 插件目录',
      '选择本地技能目录',
      '选择项目文件夹',
      '选择工具可执行文件',
      '导入软件包',
      '导入',
      'Phi 软件包'
    ],
    [
      'en',
      'Select',
      'Select input files or folders',
      'Select a Phi Plugin directory',
      'Select a local Skill directory',
      'Select a project folder',
      'Select a tool executable',
      'Import package',
      'Import',
      'Phi package'
    ]
  ] as const) {
    await app.invoke('settings:update', { uiLanguage: language })
    app.setOpenDialogResult({ canceled: false, filePaths: ['/作者目录/原始文件名.tar.gz'] })
    assert.deepEqual(await app.invoke('files:pickInput'), ['/作者目录/原始文件名.tar.gz'])
    assert.equal(app.openDialogOptions.at(-1)?.title, input)
    assert.equal(app.openDialogOptions.at(-1)?.buttonLabel, select)
    for (const [channel, title] of [
      ['phiPlugins:pickDirectory', plugin],
      ['packages:pickRegistryDirectory', skill],
      ['projects:pickDirectory', project],
      ['environment:pickBinary', executable]
    ]) {
      assert.equal(await app.invoke(channel), '/作者目录/原始文件名.tar.gz')
      assert.equal(app.openDialogOptions.at(-1)?.title, title)
      assert.equal(app.openDialogOptions.at(-1)?.buttonLabel, select)
    }
    assert.equal(await app.invoke('packages:pickArchive'), '/作者目录/原始文件名.tar.gz')
    assert.equal(app.openDialogOptions.at(-1)?.title, importTitle)
    assert.equal(app.openDialogOptions.at(-1)?.buttonLabel, importAction)
    assert.deepEqual(app.openDialogOptions.at(-1)?.filters, [
      { name: filter, extensions: ['tar.gz'] }
    ])
  }
})

test('main IPC: input file picker returns an empty list when cancelled', async () => {
  const app = await harness()

  assert.deepEqual(await app.invoke('files:pickInput'), [])
})

test('main IPC: local upload selection becomes a background remote-project job before Wrapper binding', async () => {
  const app = await harness()
  app.setOpenDialogResult({ canceled: false, filePaths: ['/tmp/sample.fastq.gz'] })

  assert.deepEqual(await app.invoke('files:pickLocalUpload'), ['/tmp/sample.fastq.gz'])
  const prepared = (await app.invoke('remoteProjectUploads:prepare', 'project-1', {
    sourcePaths: ['/tmp/sample.fastq.gz'],
    destinationDirectory: 'reads'
  })) as { id: string; status: string }
  assert.equal(prepared.status, 'queued')

  const started = (await app.invoke('remoteProjectUploads:start', 'project-1', prepared.id, {
    confirmed: true
  })) as { status: string }
  assert.equal(started.status, 'completed')
  const jobs = (await app.invoke('remoteProjectUploads:list')) as Array<{ id: string }>
  assert.deepEqual(
    jobs.map((job) => job.id),
    [prepared.id]
  )
  assert.equal(
    app.events.some((event) => event.channel === 'remoteProjectUploads:changed'),
    true
  )

  app.setWrapperPlan({
    revision: 1,
    targetSelection: {
      projectId: 'project-1',
      target: 'remote',
      projectLocation: { kind: 'ssh' }
    }
  })
  const recorded = (await app.invoke(
    'wrappers:completeInputUpload',
    prepared.id,
    'plan-1',
    'reads',
    1
  )) as {
    planId: string
    inputId: string
    localPath: string
    remotePath: string
  }
  assert.deepEqual(recorded, {
    planId: 'plan-1',
    inputId: 'reads',
    expectedRevision: 1,
    localPath: '/tmp/sample.fastq.gz',
    remotePath: '/canonical/project/sample.fastq.gz'
  })
})

test('main IPC: file preview is limited to project and Phi-owned files', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/current', 'ask')
  const projectPreview = (await app.invoke('files:preview', '/projects/current/src/App.tsx')) as {
    name: string
    path: string
    displayPath: string
    rootPath: string
    rootLabel: string
    content: string
    bytes: number
    previewBytes: number
    truncated: boolean
    kind: string
    mimeType: string
  }
  const savedOutputPreview = (await app.invoke(
    'files:preview',
    '/isolated/sessions/session-1/tool-outputs/out.txt'
  )) as { content: string }
  const largePreview = (await app.invoke('files:preview', '/projects/current/large.txt')) as {
    content: string
    bytes: number
    previewBytes: number
    truncated: boolean
  }
  const imagePreview = (await app.invoke('files:preview', '/projects/current/plot.png')) as {
    kind: string
    mimeType: string
    dataUrl: string
    content?: string
    bytes: number
    previewBytes: number
    truncated: boolean
  }
  const pdfPreview = (await app.invoke('files:preview', '/projects/current/report.pdf')) as {
    kind: string
    mimeType: string
    dataUrl: string
    content?: string
    bytes: number
    previewBytes: number
    truncated: boolean
  }
  const htmlPreview = (await app.invoke('files:preview', '/projects/current/report.html')) as {
    kind: string
    mimeType: string
    content: string
    previewBytes: number
    truncated: boolean
  }

  assert.equal(projectPreview.name, 'App.tsx')
  assert.equal(projectPreview.path, '/projects/current/src/App.tsx')
  assert.equal(projectPreview.displayPath, 'src/App.tsx')
  assert.equal(projectPreview.rootPath, '/projects/current')
  assert.equal(projectPreview.rootLabel, 'current')
  assert.equal(projectPreview.kind, 'text')
  assert.equal(projectPreview.mimeType, 'text/plain')
  assert.equal(projectPreview.content, 'export const app = true\n')
  assert.equal(projectPreview.bytes, Buffer.byteLength(projectPreview.content))
  assert.equal(projectPreview.previewBytes, Buffer.byteLength(projectPreview.content))
  assert.equal(projectPreview.truncated, false)
  assert.equal(savedOutputPreview.content, 'saved output\n')
  assert.equal(largePreview.truncated, true)
  assert.equal(largePreview.bytes, 320010)
  assert.equal(largePreview.previewBytes, 320000)
  assert.equal(largePreview.content.length, 320000)
  assert.equal(imagePreview.kind, 'image')
  assert.equal(imagePreview.mimeType, 'image/png')
  assert.match(imagePreview.dataUrl, /^data:image\/png;base64,/)
  assert.equal(imagePreview.content, undefined)
  assert.equal(imagePreview.bytes, 8)
  assert.equal(imagePreview.previewBytes, 8)
  assert.equal(imagePreview.truncated, false)
  for (const [name, mimeType] of [
    ['photo.jpg', 'image/jpeg'],
    ['animation.gif', 'image/gif'],
    ['chart.webp', 'image/webp']
  ]) {
    const preview = (await app.invoke('files:preview', `/projects/current/${name}`)) as {
      kind: string
      mimeType: string
      dataUrl: string
      truncated: boolean
    }
    assert.equal(preview.kind, 'image')
    assert.equal(preview.mimeType, mimeType)
    assert.match(preview.dataUrl, new RegExp(`^data:${mimeType};base64,`))
    assert.equal(preview.truncated, false)
  }
  assert.equal(pdfPreview.kind, 'pdf')
  assert.equal(pdfPreview.mimeType, 'application/pdf')
  assert.match(pdfPreview.dataUrl, /^data:application\/pdf;base64,/)
  assert.equal(pdfPreview.content, undefined)
  assert.equal(pdfPreview.bytes, 9)
  assert.equal(pdfPreview.previewBytes, 9)
  assert.equal(pdfPreview.truncated, false)
  assert.equal(htmlPreview.kind, 'html')
  assert.equal(htmlPreview.mimeType, 'text/html')
  assert.match(htmlPreview.content, /<h1>QC report<\/h1>/)
  assert.equal(htmlPreview.previewBytes, Buffer.byteLength(htmlPreview.content))
  assert.equal(htmlPreview.truncated, false)
  assert.deepEqual(
    app.previewReadRequests.find((request) => request.filePath === '/projects/current/large.txt'),
    { filePath: '/projects/current/large.txt', length: 320000 }
  )
  await assert.rejects(
    app.invoke('files:preview', '/projects/other/src/App.tsx'),
    /只能预览 Phi 保存的文件或当前项目内的文件/
  )
  await assert.rejects(
    app.invoke('files:preview', '/projects/current/link-out.txt'),
    /只能预览 Phi 保存的文件或当前项目内的文件/
  )
  await assert.rejects(app.invoke('files:preview', 'relative.txt'), /只能预览绝对路径/)
  await assert.rejects(
    app.invoke('files:preview', '/projects/current/binary.dat'),
    /暂不支持预览二进制文件/
  )
})

test('main IPC: an installed template preview image is displayable outside the project', async () => {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/current', 'ask')
  const previewPath = installedFigurePreviewFixture
  assert.deepEqual(await app.invoke('files:statLocalPaths', '/projects/current', [previewPath]), [
    { path: previewPath, kind: 'file' }
  ])
  const preview = (await app.invoke('files:preview', previewPath)) as {
    kind: string
    path: string
    dataUrl: string
  }
  assert.equal(preview.kind, 'image')
  assert.equal(preview.path, previewPath)
  assert.match(preview.dataUrl, /^data:image\/png;base64,/)
  await assert.rejects(
    app.invoke('files:preview', path.join(path.dirname(previewPath), 'plot.R')),
    /只能预览 Phi 保存的文件或当前项目内的文件/
  )
})

test('main window prevents HTML report frames from navigating away', async () => {
  const app = await harness()
  assert.equal(
    app.tryFrameNavigation({
      isMainFrame: false,
      frameName: htmlReportPreview.HTML_REPORT_FRAME_NAME,
      url: 'https://example.invalid/collect'
    }),
    true
  )
  assert.equal(
    app.tryFrameNavigation({
      isMainFrame: false,
      frameName: htmlReportPreview.HTML_REPORT_FRAME_NAME,
      url: 'about:srcdoc'
    }),
    false
  )
  assert.equal(app.tryFrameNavigation({ isMainFrame: true, url: 'http://localhost:5173/' }), false)
})

test('main IPC: hover file preview is tiered and bounded', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/current', 'ask')
  const textPreview = (await app.invoke('files:hoverPreview', '/projects/current/src/App.tsx')) as {
    kind: string
    content: string
    bytes: number
    previewBytes: number
    truncated: boolean
  }
  const spreadsheetPreview = (await app.invoke(
    'files:hoverPreview',
    '/projects/current/qc-demo.csv'
  )) as {
    kind: string
    mimeType: string
    format: string
    content: string
  }
  const imagePreview = (await app.invoke('files:hoverPreview', '/projects/current/plot.png')) as {
    kind: string
    mimeType: string
    dataUrl: string
    content?: string
    previewBytes: number
    truncated: boolean
  }
  const largeImagePreview = (await app.invoke(
    'files:hoverPreview',
    '/projects/current/large-plot.png'
  )) as {
    kind: string
    reason: string
    dataUrl?: string
    previewBytes: number
    truncated: boolean
  }
  const pdfPreview = (await app.invoke('files:hoverPreview', '/projects/current/report.pdf')) as {
    kind: string
    mimeType: string
    reason: string
    dataUrl?: string
    content?: string
  }
  const binaryPreview = (await app.invoke(
    'files:hoverPreview',
    '/projects/current/binary.dat'
  )) as {
    kind: string
    reason: string
    dataUrl?: string
    content?: string
  }
  const largeTextPreview = (await app.invoke(
    'files:hoverPreview',
    '/projects/current/large.txt'
  )) as {
    kind: string
    content: string
    previewBytes: number
    truncated: boolean
  }

  assert.equal(textPreview.kind, 'text')
  assert.equal(textPreview.content, 'export const app = true\n')
  assert.equal(textPreview.bytes, Buffer.byteLength(textPreview.content))
  assert.equal(textPreview.previewBytes, Buffer.byteLength(textPreview.content))
  assert.equal(textPreview.truncated, false)
  assert.equal(spreadsheetPreview.kind, 'spreadsheet')
  assert.equal(spreadsheetPreview.mimeType, 'text/csv')
  assert.equal(spreadsheetPreview.format, 'csv')
  assert.equal(spreadsheetPreview.content, 'sample_id,value_a\nS001,1.75\n')
  assert.equal(imagePreview.kind, 'image')
  assert.equal(imagePreview.mimeType, 'image/png')
  assert.match(imagePreview.dataUrl, /^data:image\/png;base64,/)
  assert.equal(imagePreview.content, undefined)
  assert.equal(imagePreview.previewBytes, 8)
  assert.equal(imagePreview.truncated, false)
  assert.equal(largeImagePreview.kind, 'metadata')
  assert.equal(largeImagePreview.reason, 'large_file')
  assert.equal(largeImagePreview.dataUrl, undefined)
  assert.equal(largeImagePreview.previewBytes, 512)
  assert.equal(largeImagePreview.truncated, true)
  assert.equal(pdfPreview.kind, 'metadata')
  assert.equal(pdfPreview.mimeType, 'application/pdf')
  assert.equal(pdfPreview.reason, 'pdf')
  assert.equal(pdfPreview.dataUrl, undefined)
  assert.equal(pdfPreview.content, undefined)
  assert.equal(binaryPreview.kind, 'metadata')
  assert.equal(binaryPreview.reason, 'binary')
  assert.equal(binaryPreview.dataUrl, undefined)
  assert.equal(binaryPreview.content, undefined)
  assert.equal(largeTextPreview.kind, 'text')
  assert.equal(largeTextPreview.previewBytes, 32768)
  assert.equal(largeTextPreview.content.length, 32768)
  assert.equal(largeTextPreview.truncated, true)
  assert.deepEqual(
    app.previewReadRequests
      .filter((request) => request.filePath === '/projects/current/large-plot.png')
      .map((request) => request.length),
    [512]
  )
  assert.deepEqual(
    app.previewReadRequests
      .filter((request) => request.filePath === '/projects/current/large.txt')
      .map((request) => request.length),
    [512, 32768]
  )
  const bundledGuidePreview = (await app.invoke(
    'files:hoverPreview',
    bundledCreateWrapperGuideFixture
  )) as { kind: string; content: string }
  assert.equal(bundledGuidePreview.kind, 'text')
  assert.equal(bundledGuidePreview.content, '# Agent-Facing Nextflow Wrappers\n')
  await assert.rejects(
    app.invoke('files:hoverPreview', '/projects/other/secret.txt'),
    /设置.*通用.*允许读取项目外文件/
  )

  await app.invoke('settings:update', { allowExternalFileRead: true })
  const externalPreview = (await app.invoke(
    'files:hoverPreview',
    '/projects/other/secret.txt'
  )) as { kind: string; content: string }
  assert.equal(externalPreview.kind, 'text')
  assert.equal(externalPreview.content, 'secret\n')
  await assert.rejects(
    app.invoke('files:openPath', '/projects/other/secret.txt'),
    /只能打开 Phi 保存的文件或当前项目内的文件/
  )
})

test('main IPC: local file open and directory listing stay inside allowed roots', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/current', 'ask')
  await app.invoke('files:openPath', '/projects/current/src/App.tsx')
  const rootListing = (await app.invoke('files:listDirectory', '/projects/current')) as {
    displayPath: string
    rootPath: string
    entries: Array<{ name: string; path: string; displayPath: string; kind: 'directory' | 'file' }>
    truncated: boolean
  }
  const srcListing = (await app.invoke('files:listDirectory', '/projects/current/src')) as {
    displayPath: string
    entries: Array<{ name: string; displayPath: string; kind: 'directory' | 'file' }>
  }

  assert.deepEqual(app.openedPaths, ['/projects/current/src/App.tsx'])
  assert.equal(rootListing.displayPath, 'current')
  assert.equal(rootListing.rootPath, '/projects/current')
  assert.equal(rootListing.truncated, false)
  assert.deepEqual(
    rootListing.entries.map((entry) => [entry.name, entry.displayPath, entry.kind]),
    [
      ['src', 'src', 'directory'],
      ['large.txt', 'large.txt', 'file'],
      ['README.md', 'README.md', 'file']
    ]
  )
  assert.equal(srcListing.displayPath, 'src')
  assert.deepEqual(srcListing.entries, [
    {
      name: 'App.tsx',
      path: '/projects/current/src/App.tsx',
      displayPath: 'src/App.tsx',
      kind: 'file'
    }
  ])
  await assert.rejects(app.invoke('files:openPath', '/projects/other/secret.txt'), /只能打开/)
  await assert.rejects(
    app.invoke('files:listDirectory', '/projects/other'),
    /只能列出 Phi 保存的文件或当前项目内的文件/
  )

  const savedListing = (await app.invoke('files:listDirectory', '/projects/saved')) as {
    name: string
    displayPath: string
    entries: Array<{ name: string; path: string }>
  }
  assert.equal(savedListing.name, 'saved')
  assert.equal(savedListing.displayPath, 'saved')
  assert.deepEqual(
    savedListing.entries.map((entry) => entry.path),
    ['/projects/saved/README.md']
  )
})

test('remote file panel IPC uses the bound project request and never falls through local file IPC', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const request = {
    sessionId: String(app.createdPhiSessions[0]?.sessionId),
    projectId: 'remote-project-1',
    path: '/canonical/project/readme.md'
  }
  const preview = (await app.invoke('remoteWorkspace:preview', request)) as {
    path: string
    content: string
    rootPath: string
  }
  assert.equal(preview.path, 'ssh://cluster-one/canonical/project/readme.md')
  assert.equal(preview.content, 'remote:/canonical/project/readme.md')
  assert.equal(preview.rootPath, 'ssh://cluster-one/canonical/project')
  const pathStats = await app.invoke('remoteWorkspace:statPaths', {
    sessionId: request.sessionId,
    projectId: request.projectId,
    paths: ['/canonical/project/readme.md', '/canonical/project', '/canonical/project/missing.txt']
  })
  assert.deepEqual(pathStats, [
    { path: '/canonical/project/readme.md', kind: 'file' },
    { path: '/canonical/project', kind: 'directory' },
    { path: '/canonical/project/missing.txt', kind: 'missing' }
  ])
  await assert.rejects(
    app.invoke('remoteWorkspace:statPaths', {
      sessionId: request.sessionId,
      projectId: request.projectId,
      paths: ['/canonical/project/readme.md'],
      i: 0
    }),
    /path probe input must contain only/
  )
  for (const invalidPath of [
    '/canonical/project-sibling/file.txt',
    '/canonical/project/dir/../file.txt',
    `/canonical/project/${'x'.repeat(4097)}`
  ]) {
    await assert.rejects(
      app.invoke('remoteWorkspace:statPaths', {
        sessionId: request.sessionId,
        projectId: request.projectId,
        paths: [invalidPath]
      }),
      /path probe paths must stay inside the canonical project root/
    )
  }
  const listing = (await app.invoke('remoteWorkspace:listDirectory', {
    ...request,
    path: '/canonical/project'
  })) as { requestPath: string; entries: Array<{ path: string }> }
  assert.equal(listing.requestPath, '/canonical/project')
  assert.equal(listing.entries[0]?.path, 'ssh://cluster-one/canonical/project/readme.md')
  const resultRequest = {
    projectId: 'remote-project-1',
    hostProfileId: 'host-1',
    runId: 'wrun_a',
    scope: 'output',
    path: ''
  }
  assert.deepEqual(await app.invoke('wrapperResults:listDirectory', resultRequest), resultRequest)
  const resultPreview = (await app.invoke('wrapperResults:preview', {
    ...resultRequest,
    path: 'report.txt',
    requestId: 'preview_001'
  })) as { path: string; content: string }
  assert.equal(resultPreview.path, 'ssh://cluster-one/canonical/project/report.txt')
  assert.equal(resultPreview.content, 'remote result')
  const resultRange = (await app.invoke('wrapperResults:readRange', {
    ...resultRequest,
    path: 'data.bin',
    requestId: 'range_001',
    offset: 0,
    length: 1
  })) as { dataBase64: string }
  assert.equal(resultRange.dataBase64, 'AA==')
  const pendingRead = app.invoke('wrapperResults:readRange', {
    ...resultRequest,
    path: 'stall.bin',
    requestId: 'range_cancel_001',
    offset: 0,
    length: 1
  })
  assert.equal(await app.invoke('wrapperResults:cancelRead', 'range_cancel_001'), true)
  await assert.rejects(pendingRead, /读取已取消/)
  assert.equal(await app.invoke('wrapperResults:cancelRead', 'range_cancel_001'), false)
  assert.equal(app.previewReadRequests.length, 0)
  await assert.rejects(app.invoke('files:preview', preview.path), /只能预览绝对路径/)
  await assert.rejects(app.invoke('files:listDirectory', listing.entries[0]?.path))
  await assert.rejects(app.invoke('files:reveal', preview.path))
})

test('remote result download requires a save-dialog choice and routes progress and cancellation', async () => {
  const app = await harness()
  const request = {
    projectId: 'remote-project-1',
    hostProfileId: 'host-1',
    runId: 'wrun_a',
    scope: 'output',
    path: 'report.html',
    requestId: 'download_001'
  }
  assert.equal(app.downloadCalls.length, 0)
  await assert.rejects(
    app.invoke('wrapperResults:download', { ...request, destination: '/untrusted/path' }),
    /只能指定已保存的运行/
  )
  assert.equal(app.saveDialogOptions.length, 0)
  assert.deepEqual(await app.invoke('wrapperResults:download', request), { status: 'cancelled' })
  assert.equal(app.downloadCalls.length, 0)
  assert.equal(app.saveDialogOptions.at(-1)?.defaultPath, 'report.html')

  app.setSaveDialogResult({ canceled: false, filePath: '/chosen/report.html' })
  app.setDownloadImpl(async (_request, destination, options) => {
    options.onProgress?.({
      requestId: 'download_001',
      phase: 'downloading',
      bytesDownloaded: 2,
      totalBytes: 3
    })
    return {
      status: 'saved',
      path: destination,
      bytes: 3,
      sha256: 'sha256:abc',
      remoteDigestVerified: true
    }
  })
  const saved = (await app.invoke('wrapperResults:download', request)) as { path: string }
  assert.equal(saved.path, '/chosen/report.html')
  assert.deepEqual(app.downloadCalls[0], { request, destination: '/chosen/report.html' })
  assert.ok(
    app.events.some(
      (event) =>
        event.channel === 'wrapperResults:downloadProgress' &&
        (event.data as { bytesDownloaded?: number }).bytesDownloaded === 2
    )
  )
  assert.equal(await app.invoke('wrapperResults:cancelDownload', 'download_001'), false)

  const pendingRequest = { ...request, requestId: 'download_002' }
  app.setDownloadImpl(async (_request, _destination, options) => {
    options.onProgress?.({
      requestId: 'download_002',
      phase: 'downloading',
      bytesDownloaded: 0,
      totalBytes: 3
    })
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new Error('cancelled by user')), {
        once: true
      })
    })
  })
  const pending = app.invoke('wrapperResults:download', pendingRequest)
  await tick()
  assert.equal(await app.invoke('wrapperResults:cancelDownload', 'download_002'), true)
  await assert.rejects(pending, /下载已取消/)
  assert.equal(await app.invoke('wrapperResults:cancelDownload', 'download_002'), false)
})

test('main IPC: unavailable project paths are blocked before creating a project session', async () => {
  const app = await harness()

  await assert.rejects(
    app.invoke('projects:newSession', '/projects/missing-project', 'ask'),
    /项目路径不可用/
  )
  assert.equal(app.sessions.length, 0)
})

test('main IPC: remote doctor accepts a host profile before any project exists', async () => {
  const app = await harness()
  assert.deepEqual(await app.invoke('remote:doctor', 'host-1', '/cluster/work'), {
    hostProfileId: 'host-1',
    checkedAt: '2026-09-24T00:00:00.000Z',
    ok: true,
    checks: [{ id: 'ssh', status: 'ok', message: '/cluster/work' }]
  })
  await assert.rejects(app.invoke('remote:doctor', '', '/cluster/work'), /档案 ID 无效/)
  await assert.rejects(app.invoke('remote:doctor', 'host-1', 42), /路径无效/)
  assert.equal(app.sessions.length, 0)
})

test('main IPC: saves and clears a host runtime-root override without credentials', async () => {
  const app = await harness()

  assert.deepEqual(await app.invoke('remote:saveRuntimeRoot', 'host-1', '/data/runtime'), {
    id: 'host-1',
    label: 'Cluster',
    hostAlias: 'cluster-one',
    runtimeRoot: '/data/runtime'
  })
  assert.deepEqual(await app.invoke('remote:saveRuntimeRoot', 'host-1', undefined), {
    id: 'host-1',
    label: 'Cluster',
    hostAlias: 'cluster-one'
  })
  await assert.rejects(app.invoke('remote:saveRuntimeRoot', '', '/data/runtime'), /档案 ID 无效/)
  await assert.rejects(app.invoke('remote:saveRuntimeRoot', 'host-1', 42), /根目录无效/)

  assert.deepEqual(
    await app.invoke('remote:saveMicromambaMirror', 'host-1', 'https://mirror.example/'),
    {
      id: 'host-1',
      label: 'Cluster',
      hostAlias: 'cluster-one',
      downloadMirrorPrefix: 'https://mirror.example/'
    }
  )
  await assert.rejects(app.invoke('remote:saveMicromambaMirror', 'host-1', 42), /镜像前缀无效/)
})

test('main IPC: saves a compact remote environment override without accepting unsafe paths', async () => {
  const app = await harness()

  assert.deepEqual(
    await app.invoke('remote:saveEnvironment', 'host-1', {
      runtimeRoot: '/data/runtime',
      toolPaths: {
        nextflow: '/opt/nextflow/bin/nextflow',
        docker: '/usr/local/bin/docker'
      }
    }),
    {
      id: 'host-1',
      label: 'Cluster',
      hostAlias: 'cluster-one',
      runtimeRoot: '/data/runtime',
      toolPaths: {
        nextflow: '/opt/nextflow/bin/nextflow',
        docker: '/usr/local/bin/docker'
      }
    }
  )
  await assert.rejects(app.invoke('remote:saveEnvironment', '', {}), /档案 ID 无效/)
  await assert.rejects(
    app.invoke('remote:saveEnvironment', 'host-1', { toolPaths: { docker: 42 } }),
    /docker 路径无效/
  )
})

test('main IPC: installs remote micromamba only for an explicit validated request', async () => {
  const app = await harness()

  assert.deepEqual(
    await app.invoke('remote:micromamba', {
      requestId: 'micromamba-request-1',
      hostProfileId: 'host-1',
      runtimeRoot: '/data/runtime',
      confirmedWarnings: ['noexec']
    }),
    {
      status: 'installed',
      version: '2.9.0-0',
      platform: 'linux-x64',
      durationMs: 25,
      installPath: '/data/runtime/bin/micromamba-2.9.0-0/micromamba',
      warningCodes: ['noexec'],
      message: 'micromamba 已安装并验证。'
    }
  )
  assert.equal(
    app.events.some(
      (event) =>
        event.channel === 'remote:micromambaProgress' &&
        (event.data as { requestId?: string }).requestId === 'micromamba-request-1'
    ),
    true
  )
  await assert.rejects(
    app.invoke('remote:micromamba', {
      requestId: '',
      hostProfileId: 'host-1',
      runtimeRoot: '/data/runtime'
    }),
    /请求无效/
  )
})

test('main IPC lists remote project directories before a project exists', async () => {
  const app = await harness()
  assert.deepEqual(
    await app.invoke('projects:listRemoteDirectories', {
      hostProfileId: 'host-1',
      path: '/'
    }),
    {
      hostProfileId: 'host-1',
      path: '/',
      directories: [{ name: 'data', path: '/data' }],
      truncated: false
    }
  )
  assert.deepEqual(app.remoteDirectoryCalls, [{ hostProfileId: 'host-1', path: '/' }])
  assert.equal(app.sessions.length, 0)
})

test('main IPC lists OpenSSH configuration entries without creating Phi profiles', async () => {
  const app = await harness()
  assert.deepEqual(await app.invoke('projects:listOpenSshHosts'), [
    {
      alias: 'lab-hpc',
      hostname: 'compute.example.invalid',
      user: 'scientist',
      port: 22022,
      identityFiles: ['/tmp/lab-key']
    }
  ])
  assert.deepEqual(await app.invoke('projects:listRemoteHosts'), [
    { id: 'ssh-config:lab-hpc', label: 'lab-hpc', hostAlias: 'lab-hpc', source: 'ssh-config' }
  ])
})

test('main IPC writes a new SSH host through the config editor and returns its selectable identity', async () => {
  const app = await harness()
  const result = (await app.invoke('projects:saveOpenSshHost', {
    alias: 'new-lab',
    hostname: 'compute.example.invalid',
    user: 'scientist',
    port: 22022
  })) as { id: string; source: string }
  assert.deepEqual(result, {
    id: 'ssh-config:new-lab',
    label: 'new-lab',
    hostAlias: 'new-lab',
    source: 'ssh-config'
  })
  await assert.rejects(app.invoke('projects:saveOpenSshHost', null), /配置无效/)
})

test('main IPC protects the target identity of a host bound to a remote project', async () => {
  const app = await harness()
  await assert.rejects(
    app.invoke('projects:saveRemoteHost', {
      id: 'host-1',
      label: 'Cluster',
      hostAlias: 'other-server',
      user: 'scientist'
    }),
    /已绑定项目/
  )
  const updated = (await app.invoke('projects:saveRemoteHost', {
    id: 'host-1',
    label: 'Cluster',
    hostAlias: 'cluster-one',
    identityFile: '/tmp/new-key'
  })) as { identityFile: string }
  assert.equal(updated.identityFile, '/tmp/new-key')
})

test('main IPC: a remote project is registered without opening a local project session', async () => {
  const app = await harness()
  const project = (await app.invoke('projects:createRemote', {
    name: 'Cluster',
    hostProfileId: 'host-1',
    remoteRoot: '/cluster/project',
    permissionMode: 'ask'
  })) as { id: string; location: { kind: string; remoteRoot: string } }
  assert.equal(project.id, 'remote-project-1')
  assert.deepEqual(project.location, {
    kind: 'ssh',
    hostProfileId: 'host-1',
    remoteRoot: '/cluster/project',
    canonicalRoot: '/canonical/project'
  })
  assert.equal(app.sessions.length, 0)
})

test('main IPC: remote project session is tied to its ID and a private anchor', async () => {
  const app = await harness()
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    path: string
    cwd: string
    displayCwd: string
    projectId: string
    projectLocation: { kind: string; remoteRoot: string }
  }
  assert.equal(current.cwd, '/isolated/remote-project-anchors/remote-project-1')
  assert.equal(current.displayCwd, '/cluster/project')
  assert.equal(current.projectId, 'remote-project-1')
  assert.equal(current.projectLocation.kind, 'ssh')
  assert.equal(app.createdPhiSessions.at(-1)?.projectId, 'remote-project-1')
  assert.equal(app.createdPhiSessions.at(-1)?.cwd, current.cwd)
  assert.deepEqual(await app.invoke('projects:sessionsById', 'remote-project-1'), [])
  await assert.rejects(
    app.invoke('files:reveal', `${current.cwd}/AGENTS.md`),
    /只能显示 Phi 保存的文件或当前项目内的文件/
  )
  assert.deepEqual(
    await app.invoke('files:statLocalPaths', current.cwd, [`${current.cwd}/AGENTS.md`]),
    [{ path: `${current.cwd}/AGENTS.md`, kind: 'missing' }]
  )
  assert.deepEqual(
    ((await app.invoke('skills:list', current.cwd)) as Array<{ name: string }>).map(
      (skill) => skill.name
    ),
    ['global']
  )
  assert.deepEqual(
    ((await app.invoke('skills:list', '/projects/current')) as Array<{ name: string }>).map(
      (skill) => skill.name
    ),
    ['global']
  )
  assert.deepEqual(
    ((await app.invoke('agents:list', current.cwd)) as Array<{ name: string }>).map(
      (agent) => agent.name
    ),
    ['Wrapper']
  )
  const agentTrustRequest = {
    cwd: current.cwd,
    relativePath: '.phi/agents/Reviewer.md',
    contentHash: 'a'.repeat(64)
  }
  await app.invoke('agents:trustRemoteProject', agentTrustRequest)
  await app.invoke('agents:revokeRemoteProjectTrust', agentTrustRequest)
  assert.deepEqual(app.remoteAgentMutations, [
    {
      operation: 'trust',
      input: {
        relativePath: agentTrustRequest.relativePath,
        contentHash: agentTrustRequest.contentHash
      }
    },
    {
      operation: 'revoke',
      input: {
        relativePath: agentTrustRequest.relativePath,
        contentHash: agentTrustRequest.contentHash
      }
    }
  ])
  const skillTrustRequest = {
    cwd: current.cwd,
    relativePath: '.phi/skills/server-demo/SKILL.md',
    contentHash: 'b'.repeat(64)
  }
  await app.invoke('skills:trustRemoteProject', skillTrustRequest)
  await app.invoke('skills:revokeRemoteProjectTrust', skillTrustRequest)
  assert.deepEqual(app.remoteSkillMutations, [
    {
      operation: 'trust',
      input: {
        relativePath: skillTrustRequest.relativePath,
        contentHash: skillTrustRequest.contentHash
      }
    },
    {
      operation: 'revoke',
      input: {
        relativePath: skillTrustRequest.relativePath,
        contentHash: skillTrustRequest.contentHash
      }
    }
  ])
  const mcpTrustRequest = {
    cwd: current.cwd,
    relativePath: '.phi/mcp.json',
    contentHash: 'c'.repeat(64),
    confirmedItemIds: ['server-mcp:command']
  }
  await app.invoke('mcp:trustRemoteProject', mcpTrustRequest)
  await app.invoke('mcp:revokeRemoteProjectTrust', mcpTrustRequest)
  assert.deepEqual(app.remoteMcpMutations, [
    {
      operation: 'trust',
      input: {
        relativePath: mcpTrustRequest.relativePath,
        contentHash: mcpTrustRequest.contentHash,
        confirmedItemIds: mcpTrustRequest.confirmedItemIds
      }
    },
    {
      operation: 'revoke',
      input: {
        relativePath: mcpTrustRequest.relativePath,
        contentHash: mcpTrustRequest.contentHash
      }
    }
  ])
  assert.deepEqual(
    ((await app.invoke('mcp:listServers', current.cwd)) as Array<{ name: string }>).map(
      (server) => server.name
    ),
    ['global-mcp', 'server-mcp']
  )
  assert.deepEqual(
    ((await app.invoke('mcp:listServers', '/projects/current')) as Array<{ name: string }>).map(
      (server) => server.name
    ),
    ['global-mcp', 'server-mcp']
  )
  assert.deepEqual(
    await app.invoke('skills:read', '/isolated/skills/global/SKILL.md', current.cwd),
    { filePath: '/isolated/skills/global/SKILL.md', content: '# global skill\n' }
  )
  await assert.rejects(app.invoke('files:pickInput'), /不会打开本机会话目录/)
  assert.deepEqual(await app.invoke('analysis:initializeProject', current.cwd), {
    notebooksDir: '/canonical/project/notebooks',
    outputsDir: '/canonical/project/outputs'
  })
  assert.deepEqual(await app.invoke('analysis:startJupyter', current.cwd), {
    projectCwd: '/canonical/project',
    runtimeKind: 'ssh',
    serverLabel: 'cluster-one',
    state: 'preparing_environment',
    hasEndpoint: false,
    message: undefined
  })
  assert.deepEqual(app.jupyterServerCalls, [])
  assert.deepEqual(app.notebookSessionCalls, [])
  await assert.rejects(
    app.invoke('skills:read', `${current.cwd}/AGENTS.md`, current.cwd),
    /暂不可用/
  )
  await assert.rejects(
    app.invoke('skills:read', '/projects/current/.phi/skills/local/SKILL.md', '/projects/current'),
    /暂不可用/
  )
  await assert.rejects(app.invoke('wrappers:submitPlan', 'plan-1'), /will not run locally/)
  await app.invoke('sessions:create')
  const restored = (await app.invoke('sessions:switch', current.path)) as {
    projectId: string
    displayCwd: string
    cwd: string
  }
  assert.equal(restored.projectId, 'remote-project-1')
  assert.equal(restored.displayCwd, '/cluster/project')
  assert.equal(restored.cwd, current.cwd)
})

test('main IPC: custom connector setup forwards optional OAuth fields only to private persistence', async () => {
  const app = await harness()
  const options = {
    oauth: { clientId: 'private-client', clientSecret: 'private-secret' },
    expectedOAuth: { clientId: 'previous-client', clientSecret: 'previous-secret' }
  }
  assert.equal(
    await app.invoke('mcp:addRemoteConnector', 'my-connector', 'https://example.test/mcp', options),
    undefined
  )
  assert.equal(
    await app.invoke('mcp:addRemoteConnector', 'no-auth', 'https://public.test/mcp'),
    undefined
  )
  assert.deepEqual(app.addedRemoteMcpConnectors, [
    { name: 'my-connector', url: 'https://example.test/mcp', agentDir: undefined, options },
    { name: 'no-auth', url: 'https://public.test/mcp', agentDir: undefined, options: undefined }
  ])
  assert.equal(JSON.stringify(app.bridgeRequests).includes('private-secret'), false)
  assert.equal(JSON.stringify(app.bridgeRequests).includes('previous-secret'), false)
  assert.equal(JSON.stringify(app.events).includes('private-secret'), false)
})

test('main IPC: custom OAuth locks browser opening to the prepared endpoint and attempt', async () => {
  const app = await harness()
  const connector = {
    name: 'custom',
    url: 'https://example.test/mcp',
    oauth: { clientId: 'client', clientSecret: 'private-secret' }
  }
  app.setCustomRemoteConnector('custom', connector)
  const open = app.hostHandlers.get('mcp.openCustomAuthUrl')
  assert.ok(open)
  let actualAttempt = ''
  app.setCustomMcpBridgeRequest(async (method, params) => {
    const request = params as { name: string; attemptId: string; serverUrl?: string }
    assert.equal(request.name, 'custom')
    if (method === 'mcp.prepareRemoteAuth')
      return {
        serverUrl: connector.url,
        authorizationUrl: 'https://auth.example.test/oauth/authorize'
      }
    if (method === 'mcp.authorizeRemote') {
      actualAttempt = request.attemptId
      assert.equal(request.serverUrl, connector.url)
      await assert.rejects(
        app.invoke('mcp:authorizeRemoteConnector', 'custom'),
        /Authorization is already in progress/
      )
      for (const url of [
        'http://auth.example.test/oauth/authorize',
        'https://user:password@auth.example.test/oauth/authorize',
        'https://other.test/oauth/authorize',
        'https://auth.example.test/another-path'
      ]) {
        await assert.rejects(
          open({ name: 'custom', attemptId: request.attemptId, url }),
          /Invalid|does not match/
        )
      }
      await assert.rejects(
        open({
          name: 'custom',
          attemptId: 'stale-attempt',
          url: 'https://auth.example.test/oauth/authorize'
        }),
        /expired/
      )
      await open({
        name: 'custom',
        attemptId: request.attemptId,
        url: 'https://auth.example.test/oauth/authorize?client_id=client&state=state'
      })
      return undefined
    }
    return undefined
  })
  await app.invoke('mcp:authorizeRemoteConnector', 'custom')
  assert.deepEqual(app.openedExternalUrls.slice(-1), [
    'https://auth.example.test/oauth/authorize?client_id=client&state=state'
  ])
  await assert.rejects(
    open({
      name: 'custom',
      attemptId: actualAttempt,
      url: 'https://auth.example.test/oauth/authorize'
    }),
    /expired/
  )
  assert.equal(JSON.stringify(app.bridgeRequests).includes('private-secret'), false)
  assert.equal(JSON.stringify(app.events).includes('private-secret'), false)
})

test('main IPC: custom OAuth rejects invalid preflight and changed saved configuration', async () => {
  const app = await harness()
  const connector = {
    name: 'custom',
    url: 'https://example.test/mcp',
    oauth: { clientId: 'client', clientSecret: 'private-secret' }
  }
  await assert.rejects(app.invoke('mcp:authorizeRemoteConnector', 'missing'), /已保存/)
  app.setCustomRemoteConnector('custom', connector)
  for (const prepared of [
    { serverUrl: connector.url, authorizationUrl: 'http://auth.example.test/authorize' },
    { serverUrl: connector.url, authorizationUrl: 'https://user:pass@auth.example.test/authorize' },
    {
      serverUrl: 'https://changed.test/mcp',
      authorizationUrl: 'https://auth.example.test/authorize'
    }
  ]) {
    app.setCustomMcpBridgeRequest(async (method) =>
      method === 'mcp.prepareRemoteAuth' ? prepared : undefined
    )
    await assert.rejects(app.invoke('mcp:authorizeRemoteConnector', 'custom'), /Invalid|changed/)
  }
  app.setCustomMcpBridgeRequest(async (method) => {
    if (method === 'mcp.prepareRemoteAuth') {
      app.setCustomRemoteConnector('custom', {
        ...connector,
        oauth: { clientId: 'changed-client' }
      })
      return { serverUrl: connector.url, authorizationUrl: 'https://auth.example.test/authorize' }
    }
    return undefined
  })
  await assert.rejects(app.invoke('mcp:authorizeRemoteConnector', 'custom'), /changed/)
  assert.equal(
    app.bridgeRequests.some((request) => request.method === 'mcp.authorizeRemote'),
    false
  )
})

test('main IPC: cancellation during custom OAuth discovery prevents the later browser flow', async () => {
  const app = await harness()
  const connector = {
    name: 'custom',
    url: 'https://example.test/mcp',
    oauth: { clientId: 'client' }
  }
  app.setCustomRemoteConnector('custom', connector)
  const started = deferred<void>()
  const prepared = deferred<{ serverUrl: string; authorizationUrl: string }>()
  app.setCustomMcpBridgeRequest(async (method) => {
    if (method === 'mcp.prepareRemoteAuth') {
      started.resolve()
      return prepared.promise
    }
    return undefined
  })
  const authorize = app.invoke('mcp:authorizeRemoteConnector', 'custom')
  await started.promise
  await app.invoke('mcp:cancelRemoteAuth', 'custom')
  prepared.resolve({
    serverUrl: connector.url,
    authorizationUrl: 'https://auth.example.test/authorize'
  })
  await assert.rejects(authorize, /Authorization cancelled/)
  assert.equal(
    app.bridgeRequests.some((request) => request.method === 'mcp.authorizeRemote'),
    false
  )
  assert.equal(app.openedExternalUrls.length, 0)
  const first = app.bridgeRequests.find((request) => request.method === 'mcp.prepareRemoteAuth')
  const cancelled = app.bridgeRequests.find((request) => request.method === 'mcp.cancelRemoteAuth')
  assert.deepEqual(cancelled?.params, first?.params)
})

test('main IPC: custom OAuth cancellation and config changes invalidate browser callbacks', async () => {
  const app = await harness()
  const connector = {
    name: 'custom',
    url: 'https://example.test/mcp',
    oauth: { clientId: 'client' }
  }
  app.setCustomRemoteConnector('custom', connector)
  const open = app.hostHandlers.get('mcp.openCustomAuthUrl')
  assert.ok(open)
  const started = deferred<{ name: string; attemptId: string }>()
  const completed = deferred<void>()
  app.setCustomMcpBridgeRequest(async (method, params) => {
    if (method === 'mcp.prepareRemoteAuth')
      return { serverUrl: connector.url, authorizationUrl: 'https://auth.example.test/authorize' }
    if (method === 'mcp.authorizeRemote') {
      started.resolve(params as { name: string; attemptId: string })
      await completed.promise
      throw new Error('授权已取消')
    }
    return undefined
  })
  const authorize = app.invoke('mcp:authorizeRemoteConnector', 'custom')
  const request = await started.promise
  app.setCustomRemoteConnector('custom', { ...connector, oauth: { clientId: 'changed' } })
  await assert.rejects(open({ ...request, url: 'https://auth.example.test/authorize' }), /changed/)
  app.setCustomRemoteConnector('custom', connector)
  await app.invoke('mcp:cancelRemoteAuth', 'custom')
  await assert.rejects(open({ ...request, url: 'https://auth.example.test/authorize' }), /expired/)
  completed.resolve()
  await assert.rejects(authorize, /授权已取消/)
  const cancelled = app.bridgeRequests.find((entry) => entry.method === 'mcp.cancelRemoteAuth')
  assert.deepEqual(cancelled?.params, { name: request.name, attemptId: request.attemptId })
})

test('main IPC: featured MCP tools are read through the Bun worker', async () => {
  const app = await harness()
  assert.deepEqual(await app.invoke('mcp:featuredTools', 'pubmed'), ['search_articles'])
  assert.deepEqual(app.bridgeRequests.at(-1), {
    method: 'mcp.featuredTools',
    params: {
      id: 'pubmed',
      url: 'https://pubmed.mcp.claude.com/mcp',
      auth: 'none'
    }
  })
  await assert.rejects(app.invoke('mcp:featuredTools', null), /Invalid Connector ID/)
  assert.equal(await app.invoke('mcp:featuredAuthStatus', 'notion'), true)
  assert.deepEqual(app.bridgeRequests.at(-1), {
    method: 'mcp.featuredAuthStatus',
    params: { id: 'notion', url: 'https://mcp.notion.com/mcp' }
  })
  assert.equal(await app.invoke('mcp:featuredAuthStatus', 'composio'), true)
  assert.deepEqual(app.bridgeRequests.at(-1), {
    method: 'mcp.featuredAuthStatus',
    params: { id: 'composio', url: 'https://connect.composio.dev/mcp' }
  })
  assert.equal(await app.invoke('mcp:featuredAuthStatus', 'cbioportal'), true)
  assert.deepEqual(app.bridgeRequests.at(-1), {
    method: 'mcp.featuredAuthStatus',
    params: { id: 'cbioportal', url: 'https://mcp.cbioportal.org/db/mcp' }
  })
  await assert.rejects(
    app.invoke('mcp:featuredAuthStatus', 'gmail'),
    /does not support sign-in status checks/
  )
  await app.invoke('mcp:authorizeFeatured', 'notion')
  assert.deepEqual(app.bridgeRequests.at(-1), {
    method: 'mcp.authorizeFeatured',
    params: { id: 'notion', url: 'https://mcp.notion.com/mcp' }
  })
  await app.invoke('mcp:authorizeFeatured', 'composio')
  assert.deepEqual(app.bridgeRequests.at(-1), {
    method: 'mcp.authorizeFeatured',
    params: { id: 'composio', url: 'https://connect.composio.dev/mcp' }
  })
  await app.invoke('mcp:authorizeFeatured', 'cbioportal')
  assert.deepEqual(app.bridgeRequests.at(-1), {
    method: 'mcp.authorizeFeatured',
    params: { id: 'cbioportal', url: 'https://mcp.cbioportal.org/db/mcp' }
  })
  await assert.rejects(
    app.invoke('mcp:authorizeFeatured', 'gmail'),
    /does not support OAuth authorization/
  )
  const openAuthUrl = app.hostHandlers.get('mcp.openAuthUrl')
  assert.ok(openAuthUrl)
  await assert.rejects(openAuthUrl({ id: 'notion', url: 'http://example.com/' }), /does not match/)
  await assert.rejects(openAuthUrl({ id: 'notion', url: 'https://example.com/' }), /does not match/)
  await assert.rejects(
    openAuthUrl({ id: 'notion', url: 'https://user:pass@mcp.notion.com/' }),
    /does not match/
  )
  await assert.rejects(
    openAuthUrl({ id: 'composio', url: 'https://mcp.notion.com/authorize' }),
    /does not match/
  )
  await assert.rejects(
    openAuthUrl({ id: 'cbioportal', url: 'https://accounts.google.com/authorize' }),
    /does not match/
  )
  await openAuthUrl({ id: 'notion', url: 'https://mcp.notion.com/authorize' })
  await openAuthUrl({ id: 'composio', url: 'https://connect.composio.dev/oauth/authorize' })
  await openAuthUrl({ id: 'cbioportal', url: 'https://mcp.cbioportal.org/authorize' })
  assert.deepEqual(app.openedExternalUrls.slice(-3), [
    'https://mcp.notion.com/authorize',
    'https://connect.composio.dev/oauth/authorize',
    'https://mcp.cbioportal.org/authorize'
  ])
})

test('main IPC: API keys stay out of renderer responses and worker sync requests', async () => {
  const app = await harness()
  assert.equal(await app.invoke('mcp:featuredApiKeyStatus', 'tavily'), false)
  await app.invoke('mcp:setFeaturedApiKey', 'tavily', 'private-test-key')
  assert.equal(await app.invoke('mcp:featuredApiKeyStatus', 'tavily'), true)
  assert.deepEqual(app.bridgeRequests.at(-1), {
    method: 'mcp.syncFeaturedApiKeys',
    params: { id: 'tavily' }
  })
  assert.equal(JSON.stringify(app.bridgeRequests).includes('private-test-key'), false)
  assert.equal(
    await app.hostHandlers.get('mcp.featuredApiKey')?.({ id: 'tavily' }),
    'private-test-key'
  )
  await app.invoke('mcp:clearFeaturedApiKey', 'tavily')
  assert.equal(await app.invoke('mcp:featuredApiKeyStatus', 'tavily'), false)
  assert.equal(await app.hostHandlers.get('mcp.featuredApiKey')?.({ id: 'tavily' }), undefined)
  await app.invoke('mcp:setFeaturedApiKey', 'tavily', 'second-test-key')
  await app.invoke('mcp:removeRemoteConnector', 'tavily', 'https://mcp.tavily.com/mcp')
  assert.equal(await app.invoke('mcp:featuredApiKeyStatus', 'tavily'), false)

  await app.invoke('mcp:setFeaturedApiKey', 'serpapi', 'serp-test-key')
  const checksAfterSave = app.mcpApiKeyValidationCallCount()
  assert.equal(await app.invoke('mcp:featuredApiKeyStatus', 'serpapi'), true)
  assert.equal(await app.invoke('mcp:featuredApiKeyStatus', 'serpapi'), true)
  assert.equal(app.mcpApiKeyValidationCallCount(), checksAfterSave)
})

test('main IPC: a saved API key remains saved if live worker refresh fails', async () => {
  const app = await harness()
  app.failBridgeRequests(new Error('worker unavailable'))
  await assert.rejects(
    app.invoke('mcp:setFeaturedApiKey', 'tavily', 'private-test-key'),
    /Local changes were saved.*could not be synchronized/
  )
  assert.equal(await app.invoke('mcp:featuredApiKeyStatus', 'tavily'), true)
  assert.equal(app.bridgeStopCount(), 1)
})

test('main IPC: an API key is not saved before the provider verifies it', async () => {
  const app = await harness()
  app.failMcpApiKeyValidation(new Error('验证失败'))
  await assert.rejects(app.invoke('mcp:setFeaturedApiKey', 'tavily', 'invalid-key'), /验证失败/)
  assert.equal(await app.invoke('mcp:featuredApiKeyStatus', 'tavily'), false)
})

test('main startup refreshes managed stdio MCP entries', async () => {
  const app = await harness()
  assert.ok(app.operationLog.some((entry) => entry.type === 'refreshManagedStdioServers'))
})

test(
  'main IPC: offline remote session restores history without waiting for SSH and retries by IDs',
  { timeout: 3000 },
  async () => {
    const app = await harness()
    const pending = deferred<{ phase: string }>()
    app.setRemoteConnectionCheck(() => pending.promise)
    const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
      path: string
      phiSessionId: string
      projectId: string
    }
    assert.equal(current.projectId, 'remote-project-1')
    assert.deepEqual(app.remoteConnectionChecks, [
      { sessionId: current.phiSessionId, projectId: current.projectId }
    ])

    app.appendedSessionEvents.push({
      sessionId: current.phiSessionId,
      event: { type: 'user_message', content: 'saved while offline', runId: 'old-run' }
    })
    const restored = (await app.invoke('sessions:switch', current.path)) as {
      projectId: string
      messages: Array<{ content?: string }>
    }
    assert.equal(restored.projectId, current.projectId)
    assert.equal(
      restored.messages.some((message) => message.content === 'saved while offline'),
      true
    )
    assert.equal(app.remoteConnectionChecks.length, 2)

    await assert.rejects(
      app.invoke('projects:retryRemoteConnection', {
        sessionId: current.phiSessionId,
        projectId: current.projectId,
        hostAlias: 'untrusted-host'
      }),
      /必须包含会话和项目 ID/
    )
    const retry = app.invoke('projects:retryRemoteConnection', {
      sessionId: current.phiSessionId,
      projectId: current.projectId
    })
    assert.deepEqual(app.remoteConnectionChecks.at(-1), {
      sessionId: current.phiSessionId,
      projectId: current.projectId
    })
    pending.resolve({ phase: 'reachable' })
    assert.deepEqual(await retry, { phase: 'reachable' })
  }
)

test('an older SSH session without a saved remote location cannot start local anchor tools', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  delete app.createdPhiSessions[0].projectLocation
  await assert.rejects(
    app.invoke('agent:prompt', 'read a project file'),
    /远程项目旧会话缺少服务器位置绑定/
  )
  assert.equal(app.sessions.length, 0)
})

test('main IPC allows only a plan snapshotted for the active SSH project to reach submit', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  app.setWrapperPlan({
    revision: 1,
    targetSelection: {
      projectId: 'another-project',
      target: 'remote',
      projectLocation: { kind: 'ssh' }
    }
  })
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, {
      expectedRevision: 1,
      target: 'remote',
      projectId: 'another-project'
    }),
    /only submit Wrapper plans bound to their server/
  )
  app.setWrapperPlan({
    revision: 1,
    targetSelection: {
      projectId: 'remote-project-1',
      target: 'local',
      projectLocation: { kind: 'ssh' }
    }
  })
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, {
      expectedRevision: 1,
      target: 'local',
      projectId: 'remote-project-1'
    }),
    /will not run locally/
  )
  app.setWrapperPlan({
    revision: 2,
    targetSelection: {
      projectId: 'remote-project-1',
      target: 'remote',
      hostProfileId: 'host-1',
      remoteRoot: '/canonical/project',
      projectLocation: { kind: 'ssh' }
    }
  })
  const confirmed = {
    expectedRevision: 2,
    target: 'remote',
    projectId: 'remote-project-1',
    hostProfileId: 'host-1',
    remoteRoot: '/canonical/project'
  }
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, { ...confirmed, expectedRevision: 1 }),
    /execution target has changed/
  )
  app.setRemoteProjectPhase('offline')
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, confirmed),
    /服务器离线/
  )
  app.setRemoteProjectPhase('reachable')
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, confirmed),
    /计划不存在: \(mocked/
  )
  app.setWrapperPlan({
    revision: 3,
    params: { outdir: '/scratch/approved-output' },
    targetSelection: {
      projectId: 'remote-project-1',
      target: 'remote',
      hostProfileId: 'host-1',
      remoteRoot: '/canonical/project',
      projectLocation: { kind: 'ssh' }
    }
  })
  const externalConfirmation = { ...confirmed, expectedRevision: 3 }
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, externalConfirmation),
    /execution target has changed/
  )
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, {
      ...externalConfirmation,
      externalOutputRoot: '/scratch/other'
    }),
    /execution target has changed/
  )
  await assert.rejects(
    app.invoke('wrappers:submitPlan', 'plan-1', undefined, {
      ...externalConfirmation,
      externalOutputRoot: '/scratch/approved-output'
    }),
    /计划不存在: \(mocked/
  )
  assert.deepEqual(app.submitPlanCalls, [
    { planId: 'plan-1', heavyWorkloadAcknowledged: undefined },
    { planId: 'plan-1', heavyWorkloadAcknowledged: undefined }
  ])
})

test('main IPC forwards an explicit local fallback request only with revision and confirmation', async () => {
  const app = await harness()
  await assert.rejects(
    app.invoke('wrappers:retargetPlan', {
      planId: 'plan-1',
      target: 'local',
      expectedRevision: 1,
      host: 'other'
    }),
    /Invalid Wrapper target change request/
  )
  const request = {
    planId: 'plan-1',
    target: 'local',
    expectedRevision: 1,
    confirmedLocalFallback: true
  }
  app.setWrapperPlan({
    revision: 1,
    targetSelection: { projectId: 'local-project', target: 'remote' }
  })
  const updated = (await app.invoke('wrappers:retargetPlan', request)) as { revision: number }
  assert.equal(updated.revision, 2)
  assert.deepEqual(app.retargetRequests, [request])
})

test('main IPC: remote conversation uses its project identity and disables anchor resources', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'hello from the cluster project')
  const options = app.createdAgentOptions.at(-1)
  assert.ok(options)
  assert.deepEqual(options.remoteProject, {
    phiSessionId: app.createdPhiSessions[0]?.sessionId,
    projectId: 'remote-project-1',
    location: {
      kind: 'ssh',
      hostProfileId: 'host-1',
      remoteRoot: '/cluster/project',
      canonicalRoot: '/canonical/project'
    },
    contextFiles: [
      { path: 'ssh://cluster-one/cluster/project/AGENTS.md', content: 'Remote instructions v1' }
    ]
  })
  const remoteAgent = (
    options.phiAgents as Array<{ name: string; tools: string[]; skills: string[] }>
  )[0]
  assert.equal(remoteAgent.name, 'Wrapper')
  assert.deepEqual(remoteAgent.skills, [])
  assert.deepEqual(remoteAgent.tools, [
    'read',
    'glob',
    'grep',
    'bash',
    'write',
    'edit',
    'wrapper_search',
    'wrapper_inspect',
    'wrapper_run',
    'wrapper_status',
    'wrapper_wait',
    'wrapper_cancel'
  ])
  const runtimeSessionId = app.sessions[0]?.runtimeSessionId
  assert.ok(runtimeSessionId)
  const resolveProjectForRun = app.wrapperJobOptions.resolveProjectForRun as
    ((sessionId: string) => { id: string } | undefined) | undefined
  const resolveRemoteTarget = app.wrapperJobOptions.resolveRemoteTarget as
    ((request: { originSessionId: string }) => unknown) | undefined
  assert.equal(resolveProjectForRun?.(runtimeSessionId)?.id, 'remote-project-1')
  resolveRemoteTarget?.({ originSessionId: runtimeSessionId })
  assert.equal(app.remoteResolverProjectIds.at(-1), 'remote-project-1')
  const checkRemoteEnvironment = app.wrapperJobOptions.checkRemoteEnvironment as
    | ((input: {
        project: { id: string; location: { kind: string; hostProfileId: string } }
        resolved: { target: { workspaceRoot: string; hpc: { scheduler: 'local' } } }
        profile: 'singularity'
      }) => Promise<unknown>)
    | undefined
  const boundProject = resolveProjectForRun?.(runtimeSessionId) as {
    id: string
    location: { kind: string; hostProfileId: string }
  }
  await checkRemoteEnvironment?.({
    project: boundProject,
    resolved: { target: { workspaceRoot: '/canonical/project', hpc: { scheduler: 'local' } } },
    profile: 'singularity'
  })
  assert.deepEqual(app.remoteDoctorCalls.at(-1), {
    hostProfileId: 'host-1',
    remotePath: '/canonical/project',
    options: { scope: 'full', scheduler: 'local', controller: 'login', runtime: 'singularity' }
  })
  const loader = app.resourceLoaderOptions.at(-1)
  assert.equal(loader?.noContextFiles, true)
  assert.equal(loader?.cwd, '/isolated')
  assert.equal(loader?.noSkills, undefined)
  assert.equal(loader?.noExtensions, true)
  assert.equal(app.approvalOptions.length, 1)
  const current = (await app.invoke('sessions:current')) as {
    displayCwd: string
    projectId: string
  }
  assert.equal(current.displayCwd, '/cluster/project')
  assert.equal(current.projectId, 'remote-project-1')
})

test('main bridge exposes only ID-bound remote path and Bash context requests', async () => {
  const app = await harness()
  const pathHandler = app.hostHandlers.get('remoteWorkspace.resolvePath')
  const bashHandler = app.hostHandlers.get('remoteWorkspace.resolveBashContext')
  const readHandler = app.hostHandlers.get('remoteWorkspace.read')
  const globHandler = app.hostHandlers.get('remoteWorkspace.glob')
  const grepHandler = app.hostHandlers.get('remoteWorkspace.grep')
  const bashRunHandler = app.hostHandlers.get('remoteWorkspace.bash')
  const bashCancelHandler = app.hostHandlers.get('remoteWorkspace.cancelBash')
  const writeHandler = app.hostHandlers.get('remoteWorkspace.write')
  const writeCancelHandler = app.hostHandlers.get('remoteWorkspace.cancelWrite')
  const editHandler = app.hostHandlers.get('remoteWorkspace.edit')
  const editCancelHandler = app.hostHandlers.get('remoteWorkspace.cancelEdit')
  assert.ok(pathHandler)
  assert.ok(bashHandler)
  assert.ok(readHandler)
  assert.ok(globHandler)
  assert.ok(grepHandler)
  assert.ok(bashRunHandler)
  assert.ok(bashCancelHandler)
  assert.ok(writeHandler)
  assert.ok(writeCancelHandler)
  assert.ok(editHandler)
  assert.ok(editCancelHandler)
  assert.deepEqual(
    await pathHandler({
      sessionId: 'session-a',
      projectId: 'remote-project-1',
      path: 'readme.md',
      mode: 'existing'
    }),
    {
      sessionId: 'session-a',
      projectId: 'remote-project-1',
      path: '/canonical/project/readme.md',
      mode: 'existing',
      hostAlias: 'cluster-one'
    }
  )
  assert.deepEqual(await bashHandler({ sessionId: 'session-a', projectId: 'remote-project-1' }), {
    sessionId: 'session-a',
    projectId: 'remote-project-1',
    cwd: '/canonical/project',
    hostAlias: 'cluster-one',
    approvalScope: 'SSH cluster-one · cwd /canonical/project；Shell 命令可访问项目目录之外'
  })
  assert.deepEqual(
    await readHandler({ sessionId: 'session-a', projectId: 'remote-project-1', path: 'readme.md' }),
    {
      kind: 'file',
      path: 'ssh://cluster-one/canonical/project/readme.md',
      content: 'remote:readme.md',
      fileSize: 13,
      contentType: 'text/plain'
    }
  )
  assert.equal(
    (
      (await globHandler({
        sessionId: 'session-a',
        projectId: 'remote-project-1',
        path: '*.md'
      })) as { content: string }
    ).content,
    'glob:*.md'
  )
  assert.equal(
    (
      (await grepHandler({
        sessionId: 'session-a',
        projectId: 'remote-project-1',
        pattern: 'marker'
      })) as { content: string }
    ).content,
    'grep:marker'
  )
})

test('remote ask-mode Bash needs a one-use approval tied to session, call and command', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const prompt = app.invoke('agent:prompt', 'run a command')
  await tick()
  assert.equal(app.approvalOptions.length, 1)
  const options = app.approvalOptions[0] as {
    getContext: () => { cwd: string; scopeNote: string; sessionId: string }
    onApprovalResolved: (
      request: {
        sessionId: string
        requestId: string
        toolCallId: string
        toolName: string
        command: string
        approvalDigest: string
        cwd: string
      },
      approved: boolean
    ) => void
  }
  const context = options.getContext()
  assert.equal(context.cwd, 'ssh://cluster-one/canonical/project')
  assert.match(context.scopeNote, /Shell 命令可访问项目目录之外/)
  const run = app.hostHandlers.get('remoteWorkspace.bash')
  assert.ok(run)
  const request = {
    sessionId: context.sessionId,
    projectId: 'remote-project-1',
    requestId: 'remote-run-1',
    toolCallId: 'tool-1',
    command: 'printf remote-ok'
  }
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-1',
      toolCallId: 'tool-1',
      toolName: 'bash',
      command: request.command,
      approvalDigest: fakeBashApprovalDigest(request),
      cwd: context.cwd
    },
    true
  )
  assert.equal(((await run(request)) as { stdout: string }).stdout, 'remote-ok')
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-2',
      toolCallId: 'tool-2',
      toolName: 'bash',
      command: 'printf safe',
      approvalDigest: fakeBashApprovalDigest({ command: 'printf safe' }),
      cwd: context.cwd
    },
    true
  )
  await assert.rejects(
    run({ ...request, requestId: 'remote-run-2', toolCallId: 'tool-2', command: 'printf changed' }),
    /尚未获得本次会话的批准/
  )
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-3',
      toolCallId: 'tool-3',
      toolName: 'bash',
      command: request.command,
      approvalDigest: fakeBashApprovalDigest({ command: request.command, env: { TOKEN: 'safe' } }),
      cwd: context.cwd
    },
    true
  )
  await assert.rejects(
    run({
      ...request,
      requestId: 'remote-run-3',
      toolCallId: 'tool-3',
      env: { TOKEN: 'changed' }
    }),
    /尚未获得本次会话的批准/
  )
  await app.invoke('agent:stop')
  await prompt
})

test('remote ask-mode write needs a one-use approval tied to host, path and content', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const prompt = app.invoke('agent:prompt', 'create one file')
  await tick()
  const options = app.approvalOptions[0] as {
    getContext: () => { cwd: string; writeScopeNote: string; sessionId: string }
    onApprovalResolved: (
      request: {
        sessionId: string
        requestId: string
        toolCallId: string
        toolName: string
        approvalDigest: string
        cwd: string
      },
      approved: boolean
    ) => void
  }
  const context = options.getContext()
  assert.equal(context.cwd, 'ssh://cluster-one/canonical/project')
  assert.match(context.writeScopeNote, /新建文件或修改已读取且未变化的文件/)
  const run = app.hostHandlers.get('remoteWorkspace.write')
  assert.ok(run)
  const request = {
    sessionId: context.sessionId,
    projectId: 'remote-project-1',
    requestId: 'write-1',
    toolCallId: 'tool-write-1',
    path: 'new.txt',
    content: 'ok'
  }
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-write-1',
      toolCallId: request.toolCallId,
      toolName: 'write',
      approvalDigest: fakeWriteApprovalDigest(request),
      cwd: context.cwd
    },
    true
  )
  await assert.rejects(run({ ...request, path: 'other.txt' }), /尚未获得本次会话的批准/)
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-write-content',
      toolCallId: request.toolCallId,
      toolName: 'write',
      approvalDigest: fakeWriteApprovalDigest(request),
      cwd: context.cwd
    },
    true
  )
  await assert.rejects(run({ ...request, content: 'changed' }), /尚未获得本次会话的批准/)
  options.onApprovalResolved(
    {
      sessionId: context.sessionId,
      requestId: 'approval-write-2',
      toolCallId: request.toolCallId,
      toolName: 'write',
      approvalDigest: fakeWriteApprovalDigest(request),
      cwd: context.cwd
    },
    true
  )
  assert.equal(((await run(request)) as { status: string }).status, 'created')
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  await app.invoke('agent:stop')
  await prompt
})

test('remote ask-mode edit binds path, replacement and one-use approval', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const prompt = app.invoke('agent:prompt', 'edit one file')
  await tick()
  const options = app.approvalOptions[0] as {
    getContext: () => { cwd: string; writeScopeNote: string; sessionId: string }
    onApprovalResolved: (
      request: {
        sessionId: string
        requestId: string
        toolCallId: string
        toolName: string
        approvalDigest: string
        cwd: string
      },
      approved: boolean
    ) => void
  }
  const context = options.getContext()
  const run = app.hostHandlers.get('remoteWorkspace.edit')
  assert.ok(run)
  const request = {
    sessionId: context.sessionId,
    projectId: 'remote-project-1',
    requestId: 'edit-1',
    toolCallId: 'tool-edit-1',
    path: 'existing.txt',
    old_string: 'before',
    new_string: 'after'
  }
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  const approve = (id: string): void =>
    options.onApprovalResolved(
      {
        sessionId: context.sessionId,
        requestId: id,
        toolCallId: request.toolCallId,
        toolName: 'edit',
        approvalDigest: fakeEditApprovalDigest(request),
        cwd: context.cwd
      },
      true
    )
  approve('approval-edit-1')
  await assert.rejects(run({ ...request, new_string: 'changed' }), /尚未获得本次会话的批准/)
  approve('approval-edit-2')
  assert.equal(((await run(request)) as { status: string }).status, 'updated')
  await assert.rejects(run(request), /尚未获得本次会话的批准/)
  await app.invoke('agent:stop')
  await prompt
})

test('remote background Wrapper approval keeps host, project, timeline and one-use ticket after the parent turn', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'inspect wrapper in the background')
  const options = app.approvalOptions[0] as {
    getContext: (event: { agentRunId?: string }) => {
      sessionId: string
      sessionPath: string
      runId: string
      cwd: string
      projectName: string
      writeScopeNote: string
    }
    onApprovalRequested: (request: Record<string, unknown>) => void
    onApprovalResolved: (request: Record<string, unknown>, approved: boolean) => void
  }
  const context = options.getContext({ agentRunId: 'wrapper-run-1' })
  assert.equal(context.sessionId, app.createdPhiSessions[0]?.sessionId)
  assert.equal(context.runId, 'wrapper-run-1')
  assert.equal(context.cwd, 'ssh://cluster-one/canonical/project')
  assert.equal(context.projectName, 'Remote project')
  assert.doesNotMatch(context.writeScopeNote, /remote-project-anchors/)
  const run = app.hostHandlers.get('remoteWorkspace.write')
  assert.ok(run)
  const input = {
    sessionId: context.sessionId,
    projectId: 'remote-project-1',
    requestId: 'background-write-1',
    toolCallId: 'background-tool-1',
    path: 'note.txt',
    content: 'safe'
  }
  const approval = {
    sessionId: context.sessionId,
    requestId: 'approval-background-1',
    toolCallId: input.toolCallId,
    agentRunId: 'wrapper-run-1',
    toolName: 'write',
    approvalDigest: fakeWriteApprovalDigest(input),
    cwd: context.cwd,
    summary: `${context.writeScopeNote}\nnote.txt`
  }
  options.onApprovalRequested(approval)
  assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'approval_requested')
  assert.equal(app.appendedSessionEvents.at(-1)?.event.runId, 'wrapper-run-1')
  assert.equal(app.updatedSessionManifests.at(-1)?.patch.status, 'needs_approval')
  options.onApprovalResolved(approval, false)
  assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'approval_denied')
  await assert.rejects(run(input), /尚未获得本次会话的批准/)

  const allowed = { ...approval, requestId: 'approval-background-2' }
  options.onApprovalRequested(allowed)
  options.onApprovalResolved(allowed, true)
  assert.equal(((await run(input)) as { status: string }).status, 'created')
  await assert.rejects(run(input), /尚未获得本次会话的批准/)
  assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'approval_approved')
})

test('remote project permission switches apply to existing sessions and host tickets', async () => {
  const app = await harness()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'inspect a file')
  const options = app.approvalOptions[0] as {
    shouldGate: () => boolean
    onApprovalResolved: (request: Record<string, unknown>, approved: boolean) => void
  }
  assert.ok(options)
  assert.equal(options.shouldGate(), true)
  const sessionId = String(app.createdPhiSessions[0]?.sessionId)
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const secondSessionId = String(app.createdPhiSessions[1]?.sessionId)
  const run = app.hostHandlers.get('remoteWorkspace.write')
  assert.ok(run)
  const input = {
    sessionId,
    projectId: 'remote-project-1',
    requestId: 'mode-write-1',
    toolCallId: 'mode-tool-1',
    path: 'new.txt',
    content: 'safe'
  }
  await app.invoke('projects:updatePermissionMode', 'remote-project-1', 'full')
  // An existing ask-mode waiter may be explicitly approved after switching mode.
  // Its one-use ticket must be consumed by this call even though full skips gating.
  options.onApprovalResolved(
    {
      sessionId,
      requestId: 'late-mode-approval',
      toolCallId: input.toolCallId,
      toolName: 'write',
      approvalDigest: fakeWriteApprovalDigest(input),
      cwd: 'ssh://cluster-one/canonical/project'
    },
    true
  )
  assert.equal(options.shouldGate(), false)
  assert.equal(
    app.updatedSessionManifests.some(
      (entry) => entry.sessionId === secondSessionId && entry.patch.permissionMode === 'full'
    ),
    true
  )
  assert.equal(((await run(input)) as { status: string }).status, 'created')
  await app.invoke('projects:updatePermissionMode', 'remote-project-1', 'auto')
  assert.equal(options.shouldGate(), false)
  assert.equal(
    ((await run({ ...input, requestId: 'mode-write-2' })) as { status: string }).status,
    'created'
  )
  await app.invoke('projects:updatePermissionMode', 'remote-project-1', 'ask')
  assert.equal(options.shouldGate(), true)
  await assert.rejects(run({ ...input, requestId: 'mode-write-3' }), /尚未获得本次会话的批准/)
})

test('main IPC exposes local package registry planning and lifecycle channels', async () => {
  const app = await harness()

  app.setOpenDialogResult({ canceled: false, filePaths: ['/registry'] })
  assert.equal(await app.invoke('packages:pickRegistryDirectory'), '/registry')

  const registry = (await app.invoke('packages:registry', '/registry')) as {
    id: string
    schemaVersion: number
  }
  assert.equal(registry.id, '/registry')
  assert.equal(registry.schemaVersion, 1)
  const plan = (await app.invoke(
    'packages:plan',
    '/registry',
    'skill',
    'alpha-skill',
    '1.0.0'
  )) as { root: { type: string; id: string; version: string } }
  assert.deepEqual(plan.root, { type: 'skill', id: 'alpha-skill', version: '1.0.0' })
  assert.deepEqual(await app.invoke('packages:install', '/registry', 'skill', 'alpha-skill'), [
    { type: 'skill', id: 'alpha-skill' }
  ])
  assert.deepEqual(await app.invoke('enablement:get'), {
    version: 1,
    global: { 'skill:alpha-skill': true },
    project: {}
  })
  assert.deepEqual(await app.invoke('packages:listInstalled'), [])
  assert.deepEqual(await app.invoke('packages:uninstall', 'skill', 'alpha-skill'), [])
  assert.deepEqual(await app.invoke('packages:listRegistries'), [officialSourceDetailsFixture])
  assert.deepEqual(await app.invoke('packages:removeRegistry', '0123456789abcdef'), [
    officialSourceDetailsFixture
  ])
  app.setOpenDialogResult({ canceled: false, filePaths: ['/tmp/offline-skill.tar.gz'] })
  assert.equal(await app.invoke('packages:pickArchive'), '/tmp/offline-skill.tar.gz')
  const preview = (await app.invoke('packages:previewImport', '/tmp/offline-skill.tar.gz')) as {
    plan: { root: { id: string } }
  }
  assert.equal(preview.plan.root.id, 'offline-skill')
  assert.deepEqual(await app.invoke('packages:import', '/tmp/offline-skill.tar.gz'), [])
  assert.deepEqual(await app.invoke('packages:listUpdates'), [])
  await assert.rejects(
    app.invoke('packages:applyUpdate', 'skill', 'alpha-skill'),
    /No update available/
  )
  await assert.rejects(
    app.invoke('packages:plan', '', 'wrapper', '', undefined),
    /Invalid package installation plan request/
  )
})

test('main IPC plans official metadata before fetching and routes all four install types through preparation', async () => {
  const app = await harness()
  const beforePlanning = app.contentFetchRequests.filter((url) => url.endsWith('.tar.gz')).length
  for (const type of ['skill', 'plugin', 'wrapper', 'mcp']) {
    const id = `demo-${type}`
    const plan = (await app.invoke('packages:plan', 'phi-packages', type, id, '1.0.0')) as {
      registry: { id: string; dir: string }
    }
    assert.equal(plan.registry.id, 'phi-packages')
    assert.equal(plan.registry.dir, officialRegistryFixture.dir)
    assert.equal(
      app.contentFetchRequests.filter((url) => url.endsWith('.tar.gz')).length,
      beforePlanning
    )
  }
  app.contentSourceCalls.length = 0
  for (const type of ['skill', 'plugin', 'wrapper', 'mcp']) {
    const id = `demo-${type}`
    assert.deepEqual(
      await app.invoke('packages:install', officialRegistryFixture.dir, type, id, '1.0.0'),
      [{ type, id }]
    )
    const calls = app.contentSourceCalls.filter((call) => call.id === id)
    assert.deepEqual(
      calls.map((call) => call.phase),
      ['prepare', 'install']
    )
    assert.ok(
      calls.every((call) => call.source === 'phi-packages' && call.agentDir === '/isolated')
    )
  }
  assert.equal(app.contentFetchRequests.filter((url) => url.endsWith('.tar.gz')).length, 4)
})

test('main dedicated MCP installation passes Chromium fetch and the selected official generation', async () => {
  const app = await harness()
  await app.invoke('mcp:installConnector', 'pubmed', '1.0.0', officialRegistryFixture.dir)
  assert.deepEqual(
    app.contentSourceCalls.filter((call) => call.phase === 'mcp-install'),
    [
      {
        phase: 'mcp-install',
        source: officialRegistryFixture.dir,
        id: 'pubmed',
        agentDir: '/isolated'
      }
    ]
  )
  assert.ok(app.contentFetchRequests.includes('https://example.invalid/catalog/mcp-pubmed.tar.gz'))
  const storagePath = app.operationLog.find(
    (entry) => entry.type === 'connector.setup.storage'
  )?.path
  assert.equal(typeof storagePath, 'string')
  const persisted = JSON.parse(readFileSync(storagePath as string, 'utf8')) as {
    records: Array<{ id: string; phase: string }>
  }
  assert.ok(
    persisted.records.some((record) => record.id === 'pubmed' && record.phase === 'installed')
  )
})

test('main MCP catalog, server metadata and OAuth load only the official connector API', async () => {
  const app = await harness()
  await tick()
  app.contentFetchRequests.length = 0
  app.operationLog.length = 0
  await app.invoke('mcp:listConnectorCatalog')
  assert.deepEqual(app.contentFetchRequests, ['https://phi.omicsagent.cn/api/mcp'])
  assert.equal(
    app.operationLog.find((entry) => entry.type === 'connector.api.sync')?.forceRefresh,
    true
  )
  app.contentFetchRequests.length = 0
  app.operationLog.length = 0
  await app.invoke('mcp:listServers')
  const openAuthUrl = app.hostHandlers.get('mcp.openAuthUrl')!
  await openAuthUrl({ id: 'notion', url: 'https://mcp.notion.com/authorize' })
  assert.deepEqual(app.contentFetchRequests, [
    'https://phi.omicsagent.cn/api/mcp',
    'https://phi.omicsagent.cn/api/mcp'
  ])
  assert(
    app.operationLog
      .filter((entry) => entry.type === 'connector.api.sync')
      .every((entry) => entry.forceRefresh === false)
  )
})

test('main agent registry loading scopes MCP to its API and merges all types without stale official connectors', async () => {
  const packageEntry = (type: RegistryPackageEntry['type'], id: string): RegistryPackageEntry => ({
    type,
    id,
    version: '1.0.0',
    title: id,
    summary: id,
    archive: `${id}.tar.gz`,
    sha256: 'a'.repeat(64),
    size: 100,
    dependsOn: []
  })
  const custom: LocalRegistry = {
    ...officialRegistryFixture,
    schemaVersion: 1,
    id: '/user/github/registry',
    dir: '/user/github/registry',
    trust: 'imported',
    source: { kind: 'github', id: 'custom', repo: 'user/connectors', sha: 'c'.repeat(40) },
    packages: [packageEntry('mcp', 'custom-connector')]
  }
  let dependencies!: capabilityService.CapabilityServiceDependencies
  const app = await harness(undefined, {
    officialPackageEntries: [
      packageEntry('mcp', 'stale-official-connector'),
      packageEntry('skill', 'website-skill')
    ],
    customPackageRegistries: [custom],
    capabilityServiceCreate: (deps) => {
      dependencies = deps
      return capabilityService.createCapabilityService(deps)
    }
  })
  await tick()
  app.contentFetchRequests.length = 0
  const mcp = await dependencies.loadRegistries('mcp')
  assert.deepEqual(app.contentFetchRequests, ['https://phi.omicsagent.cn/api/mcp'])
  assert.equal(mcp.registries[0].dir, officialConnectorRegistryFixture.dir)
  assert(mcp.registries.some((registry) => registry.dir === custom.dir))
  app.contentFetchRequests.length = 0
  const skill = await dependencies.loadRegistries('skill')
  assert.deepEqual(app.contentFetchRequests, ['https://phi.omicsagent.cn/api/catalog'])
  assert(
    skill.registries.some((registry) =>
      registry.packages.some((entry) => entry.id === 'website-skill')
    )
  )
  app.contentFetchRequests.length = 0
  const all = await dependencies.loadRegistries()
  assert.equal(all.registries[0].dir, officialConnectorRegistryFixture.dir)
  assert.deepEqual(
    new Set(app.contentFetchRequests),
    new Set(['https://phi.omicsagent.cn/api/mcp', 'https://phi.omicsagent.cn/api/catalog'])
  )
  assert(
    !all.registries.some((registry) =>
      registry.packages.some((entry) => entry.id === 'stale-official-connector')
    )
  )
  assert(
    all.registries.some((registry) =>
      registry.packages.some((entry) => entry.id === 'website-skill')
    )
  )
  assert(
    all.registries.some(
      (registry) =>
        registry.source?.repo === 'user/connectors' &&
        registry.packages.some((entry) => entry.id === 'custom-connector')
    )
  )
})

test('main IPC forwards the owning plugin identity for private environment builds', async () => {
  const app = await harness()

  assert.deepEqual(
    await app.invoke('managedEnvironments:build', 'plugin:demo', undefined, 'demo-owner'),
    { envId: 'plugin-demo-owner-demo-0123456789ab' }
  )
  assert.deepEqual(app.managedEnvironmentBuildCalls, [
    { ref: 'plugin:demo', projectCwd: undefined, pluginId: 'demo-owner' }
  ])
})

test('main IPC exposes additive plugin details with global skill enablement', async () => {
  const app = await harness()
  app.setInstalledPhiPlugins([
    {
      id: 'detail-plugin',
      version: '1.0.0',
      enabled: true,
      source: 'local',
      installedAt: '2026-10-07T00:00:00.000Z',
      dir: '/plugins/detail-plugin',
      manifest: {
        schemaVersion: 1,
        id: 'detail-plugin',
        type: 'plugin',
        version: '1.0.0',
        title: 'Detail plugin',
        summary: 'Detail summary.',
        toolPrefix: 'detl',
        components: { agents: [], skills: ['skills/detail-skill'] }
      },
      agents: [],
      skills: [
        {
          dir: '/plugins/detail-plugin/skills/detail-skill',
          name: 'detail-skill',
          description: 'Detailed skill description.',
          body: 'Instructions.',
          frontmatter: { name: 'detail-skill', description: 'Detailed skill description.' },
          phi: {
            environment: 'phi:python@1',
            scripts: [
              {
                name: 'inspect',
                description: 'Inspect a fixture.',
                run: ['python', './scripts/inspect.py'],
                args: { type: 'object', properties: {}, additionalProperties: false },
                approval: 'read'
              }
            ]
          },
          environment: { kind: 'phi', name: 'python', major: 1 }
        }
      ],
      environments: {},
      toolPrefix: 'detl',
      components: { agents: [], skills: ['/plugins/detail-plugin/skills/detail-skill'] }
    }
  ])
  await app.invoke('enablement:set', 'skill:detail-skill', false, { type: 'global' })

  const plugins = (await app.invoke('phiPlugins:list')) as Array<Record<string, unknown>>
  assert.match(String((plugins[0]?.icon as { key?: unknown } | undefined)?.key), /^[0-9a-f]{64}$/)
  assert.deepEqual(plugins, [
    {
      id: 'detail-plugin',
      version: '1.0.0',
      title: 'Detail plugin',
      summary: 'Detail summary.',
      enabled: true,
      source: 'local',
      installedAt: '2026-10-07T00:00:00.000Z',
      directory: '/plugins/detail-plugin',
      // An installed plugin without its own icon gets a catalog fallback, checked below.
      icon: plugins[0]?.icon,
      agents: [],
      skills: ['detail-skill'],
      scriptTools: ['detl_inspect'],
      environments: [],
      agentDetails: [],
      skillDetails: [
        {
          name: 'detail-skill',
          description: 'Detailed skill description.',
          enabled: false,
          environmentRef: 'phi:python@1'
        }
      ],
      scriptToolDetails: [
        {
          name: 'detl_inspect',
          description: 'Inspect a fixture.',
          approval: 'read',
          skillName: 'detail-skill'
        }
      ],
      usedEnvironments: [
        {
          ref: 'phi:python@1',
          name: 'phi-python',
          scope: 'builtin',
          skillNames: ['detail-skill'],
          agentNames: []
        }
      ]
    }
  ])
})

test('main IPC validates and stores global and project enablement', async () => {
  const app = await harness()

  assert.deepEqual(await app.invoke('enablement:get'), {
    version: 1,
    global: {},
    project: {}
  })
  assert.deepEqual(await app.invoke('enablement:set', 'skill:scanpy', true, { type: 'global' }), {
    version: 1,
    global: { 'skill:scanpy': true },
    project: {}
  })
  assert.deepEqual(
    await app.invoke('enablement:set', 'skill:scanpy', false, {
      type: 'project',
      projectCwd: '/projects/current'
    }),
    {
      version: 1,
      global: { 'skill:scanpy': true },
      projectPath: '/projects/current',
      project: { 'skill:scanpy': false }
    }
  )
  assert.deepEqual(
    await app.invoke('enablement:set', 'wrapper:module-nf-core-fastqc', true, { type: 'global' }),
    {
      version: 1,
      global: { 'skill:scanpy': true, 'wrapper:module-nf-core-fastqc': true },
      project: {}
    }
  )
  await assert.rejects(
    app.invoke('enablement:set', 'wrapper:FastQC', true, { type: 'global' }),
    /Invalid enablement item ID/
  )
  await assert.rejects(
    app.invoke('enablement:set', 'skill:scanpy', 'yes', { type: 'global' }),
    /Invalid enablement value/
  )
  await assert.rejects(
    app.invoke('enablement:set', 'skill:scanpy', true, { type: 'project' }),
    /项目启用范围无效/
  )
})

test('main IPC records the production loaded-skill shape for migration', async () => {
  const app = await harness()

  await app.invoke('agent:prompt', 'use the available skill')

  const started = app.runStartInputs[0]
  assert.deepEqual(started?.loadedSkills, ['skill'])
})

test('main IPC refreshes loaded-skill history after runtime invalidation', async () => {
  const app = await harness()

  await app.invoke('agent:prompt', 'first run')
  await app.invoke('packages:install', '/registry', 'skill', 'alpha-skill')
  await app.invoke('agent:prompt', 'second run')

  assert.deepEqual(
    app.runStartInputs.map((input) => input.loadedSkills),
    [['skill'], ['alpha-skill', 'skill']]
  )
})

test(
  'main IPC: a late background session creation cannot overwrite the selected conversation',
  { timeout: 3000 },
  async () => {
    const gate = deferred<FakeSession>()
    const app = await harness(async (_cwd, file) =>
      file === 'A' ? gate.promise : new FakeSession(file)
    )
    const first = app.invoke('sessions:switch', 'A')
    await tick()
    const second = app.invoke('sessions:switch', 'B')
    gate.resolve(new FakeSession('A'))
    await Promise.all([first, second])
    assert.equal(((await app.invoke('sessions:current')) as { path: string }).path, 'B')
    assert.equal(app.sessions.find((session) => session.sessionFile === 'A')?.disposed, false)
  }
)

test(
  'main IPC: switching conversations keeps the old prompt running in the background',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.hold = true
      return session
    })
    await app.invoke('sessions:switch', 'A')
    const prompt = app.invoke('agent:prompt', 'hello')
    await tick()
    const old = app.sessions[0]
    await app.invoke('sessions:switch', 'B')
    const before = app.events.filter((event) => event.channel === 'agent:event').length
    old.listeners.forEach((listener) => listener({ type: 'message_update' }))
    assert.equal(app.events.filter((event) => event.channel === 'agent:event').length, before + 1)
    old.finish.resolve()
    assert.deepEqual(await prompt, {
      path: 'phi-session:phi-1',
      phiSessionId: 'phi-1',
      sessionGeneration: 0
    })
    assert.equal(((await app.invoke('sessions:current')) as { path: string }).path, 'B')
    await tick()
    assert.equal(old.disposed, false)
    assert.deepEqual(old.log, ['started', 'saved'])
  }
)

test('main IPC: switching sessions includes stored Phi timeline events', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.messages.push({ role: 'assistant', content: [{ type: 'text', text: 'runtime' }] })
    return session
  })

  const result = (await app.invoke('sessions:switch', 'with-phi-events')) as { messages: unknown[] }

  assert.deepEqual(result.messages, [
    { role: 'assistant', content: [{ type: 'text', text: 'runtime' }] },
    {
      source: 'phi',
      preferPhiTimeline: true,
      eventId: 'event-user-existing',
      sessionId: 'phi-existing',
      createdAt: '2026-09-05T00:00:00.000Z',
      type: 'user_message',
      runId: 'run-existing',
      content: 'phi user'
    },
    {
      source: 'phi',
      preferPhiTimeline: true,
      eventId: 'event-existing',
      sessionId: 'phi-existing',
      createdAt: '2026-09-05T00:00:00.000Z',
      type: 'tool_call_completed',
      runId: 'run-existing',
      toolCallId: 'tool-existing',
      toolName: 'bash',
      output: 'restored'
    }
  ])
})

test(
  'main IPC: current fresh prompt includes the user question before runtime materializes',
  { timeout: 3000 },
  async () => {
    const gate = deferred<FakeSession>()
    const app = await harness(async () => gate.promise)
    const prompt = app.invoke('agent:prompt', 'where is my question')

    try {
      await tick()
      const current = (await app.invoke('sessions:current')) as {
        path: string | null
        phiSessionId?: string
        messages: Array<Record<string, unknown>>
      }

      assert.equal(current.path, 'phi-session:phi-1')
      assert.equal(current.phiSessionId, 'phi-1')
      assert.equal(
        current.messages.some(
          (message) =>
            message.source === 'phi' &&
            message.type === 'user_message' &&
            message.content === 'where is my question'
        ),
        true
      )
    } finally {
      gate.resolve(new FakeSession('fresh.jsonl'))
      await prompt
    }
  }
)

test(
  'main IPC: Phi-only failed prompts can be restored and materialized later',
  { timeout: 3000 },
  async () => {
    let failBeforeRuntime = true
    const app = await harness(async () => {
      if (failBeforeRuntime) throw new Error('余额不足')
      return new FakeSession('fresh.jsonl')
    })

    await assert.rejects(app.invoke('agent:prompt', '这里输入的聊天为什么消失'), /余额不足/)

    assert.equal(app.createdPhiSessions.length, 1)
    assert.equal(
      app.updatedSessionManifests.some((entry) => 'runtimeSessionPath' in entry.patch),
      false
    )

    const restored = (await app.invoke('sessions:switch', 'phi-session:phi-1')) as {
      path: string
      messages: Array<Record<string, unknown>>
    }

    assert.equal(restored.path, 'phi-session:phi-1')
    assert.equal(
      restored.messages.some(
        (message) =>
          message.source === 'phi' &&
          message.type === 'user_message' &&
          message.content === '这里输入的聊天为什么消失'
      ),
      true
    )

    failBeforeRuntime = false
    await app.invoke('sessions:switch', 'other.jsonl')
    await app.invoke('agent:prompt', '继续', restored)

    assert.equal(app.createdPhiSessions.length, 1)
    assert.deepEqual(
      app.updatedSessionManifests.filter((entry) => 'runtimeSessionPath' in entry.patch),
      [{ sessionId: 'phi-1', patch: { runtimeSessionPath: 'fresh.jsonl' } }]
    )
  }
)

test('main IPC: prompt target controls the write destination even after another session is current', async () => {
  const app = await harness()

  await app.invoke('sessions:switch', 'selected.jsonl')
  const selected = (await app.invoke('sessions:current')) as {
    path: string | null
    cwd: string
    sessionGeneration: number
  }
  await app.invoke('sessions:switch', 'other.jsonl')

  await app.invoke('agent:prompt', 'write to selected', selected)

  const selectedSession = app.sessions.find((session) => session.sessionFile === 'selected.jsonl')
  const otherSession = app.sessions.find((session) => session.sessionFile === 'other.jsonl')
  assert.equal(selectedSession?.promptTexts.length, 1)
  assert.match(selectedSession?.promptTexts[0] ?? '', /^write to selected/)
  assert.equal(otherSession?.promptTexts.length, 0)
  assert.equal(app.createdPhiSessions.at(-1)?.runtimeSessionPath, 'selected.jsonl')
  assert.equal(app.appendedSessionEvents.at(-1)?.event.content, 'write to selected')
})

test('main IPC: context usage follows the selected session and preserves unavailable capacity', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    if (file === 'alpha.jsonl') {
      session.contextUsage = {
        tokens: 24000,
        contextWindow: 200000,
        percent: 12,
        deferredMcpTokens: 8000,
        categories: [
          { id: 'systemPrompt', tokens: 1000 },
          { id: 'systemTools', tokens: 2500 },
          { id: 'mcpTools', tokens: 500 },
          { id: 'systemContext', tokens: 2000 },
          { id: 'skills', tokens: 4000 },
          { id: 'conversation', tokens: 14000 }
        ]
      }
    }
    return session
  })

  await app.invoke('sessions:switch', 'alpha.jsonl')
  const alpha = (await app.invoke('sessions:contextUsage')) as {
    sessionPath: string | null
    usage: FakeSession['contextUsage']
  }
  assert.equal(alpha.sessionPath, 'alpha.jsonl')
  assert.deepEqual(alpha.usage, {
    tokens: 24000,
    contextWindow: 200000,
    percent: 12,
    deferredMcpTokens: 8000,
    categories: [
      { id: 'systemPrompt', tokens: 1000 },
      { id: 'systemTools', tokens: 2500 },
      { id: 'mcpTools', tokens: 500 },
      { id: 'systemContext', tokens: 2000 },
      { id: 'skills', tokens: 4000 },
      { id: 'conversation', tokens: 14000 }
    ]
  })

  await app.invoke('sessions:switch', 'beta.jsonl')
  const beta = (await app.invoke('sessions:contextUsage')) as {
    sessionPath: string | null
    usage: FakeSession['contextUsage']
  }
  assert.equal(beta.sessionPath, 'beta.jsonl')
  assert.equal(beta.usage, null)
})

test('main IPC: a Phi-managed conversation reads usage after its first turn', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.contextUsage = { tokens: 12000, contextWindow: 128000, percent: 9.375 }
    return session
  })

  const created = (await app.invoke('sessions:create')) as { path: string }
  await app.invoke('agent:prompt', 'hello')
  const context = (await app.invoke('sessions:contextUsage')) as {
    sessionPath: string | null
    phiSessionId: string | null
    usage: FakeSession['contextUsage']
  }

  assert.equal(context.sessionPath, created.path)
  assert.ok(context.phiSessionId)
  assert.deepEqual(context.usage, { tokens: 12000, contextWindow: 128000, percent: 9.375 })
})

test('main IPC: an empty Phi session has no usage and does not start a runtime', async () => {
  const app = await harness()
  const created = (await app.invoke('sessions:create')) as { path: string }
  const before = app.sessions.length

  const context = (await app.invoke('sessions:contextUsage')) as {
    sessionPath: string | null
    usage: FakeSession['contextUsage']
  }

  assert.equal(context.sessionPath, created.path)
  assert.equal(context.usage, null)
  assert.equal(app.sessions.length, before)
})

test('main IPC: a late usage result cannot be attributed to the next selected session', async () => {
  const gate = deferred<void>()
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    if (file === 'alpha.jsonl') {
      session.contextUsage = { tokens: 24000, contextWindow: 200000, percent: 12 }
      session.contextUsageGate = gate.promise
    }
    return session
  })

  await app.invoke('sessions:switch', 'alpha.jsonl')
  const pending = app.invoke('sessions:contextUsage')
  await tick()
  await app.invoke('sessions:switch', 'beta.jsonl')
  gate.resolve()

  const stale = (await pending) as {
    sessionPath: string | null
    usage: FakeSession['contextUsage']
  }
  assert.equal(stale.sessionPath, 'alpha.jsonl')
  assert.equal(stale.usage, null)
})

function compactionTarget(current: unknown): {
  sessionPath: string | null
  phiSessionId: string | null
  sessionGeneration: number
} {
  const session = current as {
    path: string | null
    phiSessionId?: string
    sessionGeneration: number
  }
  return {
    sessionPath: session.path,
    phiSessionId: session.phiSessionId ?? null,
    sessionGeneration: session.sessionGeneration
  }
}

test('main IPC: automatic compaction settings stay with their session and use SDK defaults', async () => {
  const app = await harness()
  const first = (await app.invoke('sessions:create')) as { path: string }
  const firstTarget = compactionTarget(await app.invoke('sessions:current'))
  const defaults = (await app.invoke('sessions:autoCompactionSettings', firstTarget)) as {
    enabled: boolean
    thresholdPercent: number
    overrides: Record<string, unknown>
  }
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.thresholdPercent, -1)
  assert.deepEqual(defaults.overrides, {})

  const firstSettings = (await app.invoke('sessions:autoCompactionSettings:set', firstTarget, {
    enabled: false,
    thresholdPercent: 70
  })) as { enabled: boolean; thresholdPercent: number; overrides: Record<string, unknown> }
  assert.equal(firstSettings.enabled, false)
  assert.equal(firstSettings.thresholdPercent, 70)
  assert.deepEqual(firstSettings.overrides, { enabled: false, thresholdPercent: 70 })
  await app.invoke('agent:prompt', 'first conversation')
  assert.deepEqual(app.createdAgentOptions[0].autoCompaction, {
    enabled: false,
    thresholdPercent: 70
  })
  assert.deepEqual(app.sessions[0].autoCompactionOverrides, {
    enabled: false,
    thresholdPercent: 70
  })

  await app.invoke('sessions:create')
  const secondTarget = compactionTarget(await app.invoke('sessions:current'))
  const secondDefaults = (await app.invoke('sessions:autoCompactionSettings', secondTarget)) as {
    enabled: boolean
    thresholdPercent: number
  }
  assert.equal(secondDefaults.enabled, true)
  assert.equal(secondDefaults.thresholdPercent, -1)
  await app.invoke('sessions:autoCompactionSettings:set', secondTarget, { thresholdPercent: 90 })
  await app.invoke('agent:prompt', 'second conversation')
  assert.deepEqual(app.sessions[1].autoCompactionOverrides, { thresholdPercent: 90 })
  await app.invoke('sessions:autoCompactionSettings:set', secondTarget, { enabled: false })
  assert.deepEqual(app.sessions[1].autoCompactionOverrides, {
    enabled: false,
    thresholdPercent: 90
  })
  assert.deepEqual(app.sessions[0].autoCompactionOverrides, {
    enabled: false,
    thresholdPercent: 70
  })

  await app.invoke('sessions:switch', first.path)
  const restored = (await app.invoke(
    'sessions:autoCompactionSettings',
    compactionTarget(await app.invoke('sessions:current'))
  )) as {
    enabled: boolean
    thresholdPercent: number
  }
  assert.equal(restored.enabled, false)
  assert.equal(restored.thresholdPercent, 70)
  await app.invoke(
    'sessions:autoCompactionSettings:set',
    compactionTarget(await app.invoke('sessions:current')),
    { enabled: null, thresholdPercent: null }
  )
  const reset = (await app.invoke(
    'sessions:autoCompactionSettings',
    compactionTarget(await app.invoke('sessions:current'))
  )) as {
    enabled: boolean
    thresholdPercent: number
    overrides: Record<string, unknown>
  }
  assert.equal(reset.enabled, true)
  assert.equal(reset.thresholdPercent, -1)
  assert.deepEqual(reset.overrides, {})
  assert.deepEqual(app.sessions[0].autoCompactionOverrides, {})
})

test('main IPC: automatic compaction settings reject invalid presets and stale targets', async () => {
  const app = await harness()
  await app.invoke('sessions:create')
  const target = compactionTarget(await app.invoke('sessions:current'))
  await assert.rejects(
    app.invoke('sessions:autoCompactionSettings:set', target, { thresholdPercent: 55 }),
    /阈值无效/
  )
  await app.invoke('sessions:create')
  await assert.rejects(
    app.invoke('sessions:autoCompactionSettings:set', target, { enabled: false }),
    /会话已切换/
  )
})

test('main IPC: automatic compaction settings cannot change during a run', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })
  await app.invoke('sessions:create')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const prompt = app.invoke('agent:prompt', 'hello')
  await tick()
  await assert.rejects(
    app.invoke('sessions:autoCompactionSettings:set', target, { enabled: false }),
    /运行结束/
  )
  app.sessions[0].finish.resolve()
  await prompt
})

test('main IPC: manual compaction persists a notice without sending a chat message', async () => {
  const app = await harness()
  await app.invoke('sessions:create')
  await app.invoke('agent:prompt', 'hello')
  const target = compactionTarget(await app.invoke('sessions:current'))
  app.sessions[0].contextUsage = { tokens: 5000, contextWindow: 200000, percent: 2.5 }
  const userMessagesBefore = app.appendedSessionEvents.filter(
    (entry) => entry.event.type === 'user_message'
  ).length

  const result = (await app.invoke('sessions:compact', target)) as {
    phiSessionId: string
    tokensBefore: number
    tokensAfter?: number
  }

  assert.equal(result.tokensBefore, 24000)
  assert.equal(result.tokensAfter, 5000)
  assert.equal(app.sessions[0].compactCalls, 1)
  assert.equal(
    app.appendedSessionEvents.filter((entry) => entry.event.type === 'user_message').length,
    userMessagesBefore
  )
  const notice = app.appendedSessionEvents.find((entry) => entry.event.type === 'context_compacted')
  assert.equal(notice?.sessionId, result.phiSessionId)
  assert.deepEqual(withoutTimestamp(notice?.event ?? {}), {
    type: 'context_compacted',
    action: 'manual',
    reason: 'user',
    summary: 'Earlier work was summarized.',
    shortSummary: 'Earlier work',
    tokensBefore: 24000,
    tokensAfter: 5000
  })
  assert.ok(
    app.events.some(
      (event) =>
        event.channel === 'agent:event' &&
        (event.data as { type?: string }).type === 'context_compacted'
    )
  )
})

test('main IPC: manual compaction rejects running and stale conversations', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })
  await app.invoke('sessions:create')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const prompt = app.invoke('agent:prompt', 'hello')
  await tick()
  await assert.rejects(app.invoke('sessions:compact', target), /运行结束/)
  app.sessions[0].finish.resolve()
  await prompt
  await app.invoke('sessions:switch', 'other.jsonl')
  await assert.rejects(app.invoke('sessions:compact', target), /会话已切换/)
  assert.equal(app.sessions[0].compactCalls, 0)
})

test('main IPC: manual compaction leaves an empty conversation untouched', async () => {
  const app = await harness()
  await app.invoke('sessions:create')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const before = app.sessions.length

  await assert.rejects(app.invoke('sessions:compact', target), /暂无可压缩的历史/)
  assert.equal(app.sessions.length, before)
  assert.equal(
    app.appendedSessionEvents.some((entry) => entry.event.type === 'context_compacted'),
    false
  )
})

test('main IPC: manual compaction excludes duplicates and new prompts until it finishes', async () => {
  const gate = deferred<void>()
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.compactGate = gate.promise
    return session
  })
  await app.invoke('sessions:create')
  await app.invoke('agent:prompt', 'hello')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const compacting = app.invoke('sessions:compact', target)
  await tick()

  await assert.rejects(app.invoke('sessions:compact', target), /正在进行/)
  await assert.rejects(app.invoke('agent:prompt', 'second'), /压缩正在进行/)
  gate.resolve()
  await compacting
  assert.equal(app.sessions[0].compactCalls, 1)
  assert.deepEqual(app.sessions[0].promptTexts, ['hello'])
})

test('main IPC: a background result waits until manual compaction ends before waking its conversation', async () => {
  const gate = deferred<void>()
  const { app, session } = await idleConversation()
  session.compactGate = gate.promise
  const target = compactionTarget(await app.invoke('sessions:current'))
  const compacting = app.invoke('sessions:compact', target)
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  await tick()
  assert.equal(session.promptTexts.length, 1)

  gate.resolve()
  await compacting
  await waitUntil(() => session.promptTexts.length === 2)
  assert.match(session.promptTexts[1], AGENT_WOKEN)
})

test('main IPC: a failed manual compaction records the reason and releases its lock', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.compactError = new Error('summary unavailable')
    return session
  })
  await app.invoke('sessions:create')
  await app.invoke('agent:prompt', 'hello')
  const target = compactionTarget(await app.invoke('sessions:current'))

  await assert.rejects(app.invoke('sessions:compact', target), /summary unavailable/)
  const failure = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'context_compaction_failed'
  )
  assert.equal((failure?.event as { errorMessage?: string })?.errorMessage, 'summary unavailable')
  await assert.rejects(app.invoke('sessions:compact', target), /summary unavailable/)
  assert.equal(app.sessions[0].compactCalls, 2)
})

test('main IPC: continuing a restored runtime conversation reuses its Phi session', async () => {
  const app = await harness()

  await app.invoke('sessions:switch', 'with-phi-events')
  await app.invoke('agent:prompt', 'continue existing')

  assert.equal(app.createdPhiSessions.length, 0)
  assert.equal(app.appendedSessionEvents.at(-1)?.sessionId, 'phi-existing')
  assert.equal(app.appendedSessionEvents.at(-1)?.event.content, 'continue existing')
})

test('main IPC: prompt target rejects stale fresh sessions instead of writing to the wrong chat', async () => {
  const app = await harness()

  const fresh = (await app.invoke('sessions:current')) as {
    path: string | null
    cwd: string
    sessionGeneration: number
  }
  await app.invoke('sessions:switch', 'other.jsonl')

  await assert.rejects(app.invoke('agent:prompt', 'must not leak', fresh), /当前会话已切换/)
  assert.equal(app.createdPhiSessions.length, 0)
  assert.equal(app.appendedSessionEvents.length, 0)
})

test(
  'main IPC: materialized runtime path is linked before notifying the renderer',
  { timeout: 3000 },
  async () => {
    const app = await harness()

    await app.invoke('agent:prompt', 'hello')

    const runtimePathPatchIndex = app.operationLog.findIndex((entry) => {
      const patch = entry.patch as { runtimeSessionPath?: unknown } | undefined
      return entry.type === 'updateSessionManifest' && patch?.runtimeSessionPath === 'fresh.jsonl'
    })
    const firstMaterializedNotifyIndex = app.operationLog.findIndex((entry) => {
      const data = entry.data as { path?: unknown } | undefined
      return (
        entry.type === 'webContents.send' &&
        entry.channel === 'sessions:changed' &&
        data?.path === 'phi-session:phi-1'
      )
    })

    assert.notEqual(runtimePathPatchIndex, -1)
    assert.notEqual(firstMaterializedNotifyIndex, -1)
    assert.equal(runtimePathPatchIndex < firstMaterializedNotifyIndex, true)
  }
)

test('main IPC: delayed runtime path materialization is linked to the Phi session', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(undefined)
    session.materializedSessionFile = file
    return session
  })

  const result = (await app.invoke('agent:prompt', 'first delayed message')) as {
    path: string | null
    phiSessionId?: string
  }

  assert.equal(result.path, 'phi-session:phi-1')
  assert.equal(result.phiSessionId, 'phi-1')
  assert.deepEqual(
    app.updatedSessionManifests.filter((entry) => 'runtimeSessionPath' in entry.patch),
    [{ sessionId: 'phi-1', patch: { runtimeSessionPath: 'fresh.jsonl' } }]
  )
})

test('main IPC: continuing a freshly materialized conversation reuses its Phi session', async () => {
  const app = await harness()

  const first = (await app.invoke('agent:prompt', 'first message')) as {
    path: string | null
    cwd?: string
    sessionGeneration: number
  }
  await app.invoke('agent:prompt', 'second message', {
    path: first.path,
    cwd: first.cwd ?? '/workspace',
    sessionGeneration: first.sessionGeneration
  })

  const userEvents = app.appendedSessionEvents.filter(
    (entry) => (entry.event as { type?: string }).type === 'user_message'
  )
  assert.equal(app.createdPhiSessions.length, 1)
  assert.deepEqual(
    userEvents.map((entry) => entry.sessionId),
    ['phi-1', 'phi-1']
  )
  assert.deepEqual(
    userEvents.map((entry) => (entry.event as { content?: string }).content),
    ['first message', 'second message']
  )
})

test('main IPC: retry prompt target can suppress a duplicate user event', async () => {
  const app = await harness()

  const first = (await app.invoke('agent:prompt', 'retry me')) as {
    path: string | null
    phiSessionId?: string
    cwd?: string
    sessionGeneration: number
  }
  const beforeRetryEventCount = app.appendedSessionEvents.length

  await app.invoke('agent:prompt', 'retry me', {
    path: first.path,
    phiSessionId: first.phiSessionId,
    cwd: first.cwd ?? '/workspace',
    sessionGeneration: first.sessionGeneration,
    suppressUserMessageEvent: true,
    retryUserMessageId: 'event-user'
  })

  const retryEvents = app.appendedSessionEvents.slice(beforeRetryEventCount)
  assert.equal(
    retryEvents.some((entry) => (entry.event as { type?: string }).type === 'user_message'),
    false
  )
  assert.deepEqual(
    retryEvents.filter((entry) => (entry.event as { type?: string }).type === 'user_message_retry'),
    [
      {
        sessionId: 'phi-1',
        event: {
          type: 'user_message_retry',
          runId: 'run-2',
          content: 'retry me',
          userMessageId: 'event-user'
        }
      }
    ]
  )
  const session = app.sessions.find((item) => item.sessionFile === 'fresh.jsonl')
  assert.equal(session?.promptTexts.length, 2)
  assert.equal(
    session?.promptTexts.every((text) => text.startsWith('retry me')),
    true
  )
})

test('main IPC: acknowledging a session uses that session cwd without sidebar rebroadcasts', async () => {
  const app = await harness()

  await app.invoke('sessions:switch', 'A')
  await app.invoke('sessions:switch', 'B')
  const changedEventsBeforeAcknowledge = app.events.filter(
    (event) => event.channel === 'sessions:changed'
  ).length
  await app.invoke('sessions:acknowledge', 'A')
  const changedEventsAfterAcknowledge = app.events.filter(
    (event) => event.channel === 'sessions:changed'
  ).length

  assert.deepEqual(app.acknowledgedSessions.at(-1), { file: 'A', cwd: '/projects/A' })
  assert.equal(changedEventsAfterAcknowledge, changedEventsBeforeAcknowledge)
})

test(
  'main IPC: project resources use the active working directory',
  { timeout: 3000 },
  async () => {
    const app = await harness()
    await app.invoke('projects:newSession', '/projects/custom', 'ask')
    assert.match(
      ((await app.invoke('skills:list')) as Array<{ id: string }>)[0].id,
      /^\/projects\/custom/
    )
    assert.match(
      ((await app.invoke('agents:list')) as Array<{ id: string }>)[0].id,
      /^\/projects\/custom/
    )
    assert.match(
      ((await app.invoke('mcp:listServers')) as Array<{ id: string }>)[0].id,
      /^\/projects\/custom/
    )
  }
)

test('main IPC: analysis notebooks use the active project working directory', async () => {
  const app = await harness()

  const ordinary = (await app.invoke('analysis:listNotebooks')) as { message?: string }
  await app.invoke('projects:newSession', '/projects/research', 'ask')
  const registry = (await app.invoke('analysis:listNotebooks')) as {
    projectCwd: string
    projectName: string
    notebooks: Array<{ relativePath: string }>
  }
  const initialized = (await app.invoke('analysis:initializeProject', '/projects/research')) as {
    notebooksDir: string
    outputsDir: string
  }

  assert.equal(ordinary.projectCwd, '/workspace')
  assert.equal(ordinary.message, undefined)
  assert.equal(registry.projectCwd, '/projects/research')
  assert.equal(registry.projectName, 'Project /projects/research')
  assert.deepEqual(
    registry.notebooks.map((notebook) => notebook.relativePath),
    ['notebooks/qc.ipynb']
  )
  assert.deepEqual(initialized, {
    notebooksDir: '/projects/research/notebooks',
    outputsDir: '/projects/research/outputs'
  })
})

test('main IPC: analysis notebook files use the selected project service', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/research', 'ask')
  const opened = (await app.invoke(
    'analysis:openNotebook',
    '/projects/research',
    'notebooks/qc.ipynb'
  )) as { path: string; relativePath: string; savedRevision: string }
  const saved = (await app.invoke('analysis:saveNotebook', '/projects/research', {
    path: '/projects/research/notebooks/qc.ipynb',
    document: { revision: 'nb-edited' },
    expectedRevision: opened.savedRevision
  })) as { relativePath: string; savedRevision: string }
  const created = (await app.invoke('analysis:createNotebook', '/projects/research')) as {
    relativePath: string
  }
  const closed = (await app.invoke(
    'analysis:closeNotebook',
    '/projects/research',
    'notebooks/qc.ipynb'
  )) as { path: string }
  const deleted = (await app.invoke(
    'analysis:deleteNotebook',
    '/projects/research',
    'notebooks/qc.ipynb'
  )) as { path: string; relativePath: string }

  assert.equal(opened.path, '/projects/research/notebooks/qc.ipynb')
  assert.equal(opened.relativePath, 'notebooks/qc.ipynb')
  assert.equal(saved.relativePath, 'notebooks/qc.ipynb')
  assert.equal(saved.savedRevision, 'nb-edited')
  assert.equal(created.relativePath, 'notebooks/Untitled.ipynb')
  assert.equal(closed.path, '/projects/research/notebooks/qc.ipynb')
  assert.equal(deleted.path, '/projects/research/notebooks/qc.ipynb')
  assert.equal(deleted.relativePath, 'notebooks/qc.ipynb')
})

test('main IPC: analysis notebook files also support the ordinary workspace', async () => {
  const app = await harness()

  const created = (await app.invoke('analysis:createNotebook', '/workspace')) as {
    path: string
    relativePath: string
  }
  const opened = (await app.invoke(
    'analysis:openNotebook',
    '/workspace',
    created.relativePath
  )) as {
    path: string
    relativePath: string
  }

  assert.equal(created.path, '/workspace/notebooks/Untitled.ipynb')
  assert.equal(created.relativePath, 'notebooks/Untitled.ipynb')
  assert.equal(opened.path, '/workspace/notebooks/Untitled.ipynb')
  assert.equal(opened.relativePath, 'notebooks/Untitled.ipynb')
})

test('main IPC: analysis kernel diagnostics tolerate a missing project cwd', async () => {
  const app = await harness()

  const diagnostics = (await app.invoke('analysis:listKernels', '/projects/research')) as {
    jupyterServer: { available: boolean; version: string }
    hasPythonKernel: boolean
    hasRKernel: boolean
  }

  assert.equal(diagnostics.jupyterServer.available, true)
  assert.equal(diagnostics.jupyterServer.version, '2.14.0')
  assert.equal(diagnostics.hasPythonKernel, true)
  assert.equal(diagnostics.hasRKernel, false)
  const missingProjectDiagnostics = (await app.invoke(
    'analysis:listKernels',
    '/missing/project'
  )) as {
    jupyterServer: { available: boolean; version: string }
    hasPythonKernel: boolean
    hasRKernel: boolean
  }
  assert.equal(missingProjectDiagnostics.jupyterServer.available, true)
  assert.equal(missingProjectDiagnostics.jupyterServer.version, '2.14.0')
  assert.equal(missingProjectDiagnostics.hasPythonKernel, true)
  await assert.rejects(
    app.invoke('analysis:listKernels', '/canonical/project'),
    /没有探测或回退到本机 Jupyter/
  )
})

test('main IPC: analysis Jupyter server lifecycle uses the selected project', async () => {
  const app = await harness()

  const initial = (await app.invoke('analysis:jupyterStatus', '/projects/research')) as {
    projectCwd: string
    state: string
  }
  const started = (await app.invoke('analysis:startJupyter', '/projects/research')) as {
    state: string
    pid: number
    hasEndpoint: boolean
  }
  const stopped = (await app.invoke('analysis:stopJupyter', '/projects/research')) as {
    state: string
  }

  assert.equal(initial.projectCwd, '/projects/research')
  assert.equal(initial.state, 'stopped')
  assert.equal(started.state, 'starting')
  assert.equal(started.pid, 2026)
  assert.equal(started.hasEndpoint, false)
  assert.equal(stopped.state, 'stopped')
  assert.deepEqual(app.jupyterServerCalls, [
    { action: 'status', cwd: '/projects/research' },
    { action: 'start', cwd: '/projects/research' },
    { action: 'stop', cwd: '/projects/research' }
  ])
  await assert.rejects(app.invoke('analysis:startJupyter', '/missing/project'), /请选择/)
})

test('main IPC: read-only Jupyter status returns an empty state for a missing project cwd', async () => {
  const app = await harness()

  const status = (await app.invoke('analysis:jupyterStatus', '/missing/project')) as {
    projectCwd: string
    state: string
    hasEndpoint: boolean
    message?: string
  }
  const runtime = (await app.invoke('analysis:jupyterRuntimeStatus', '/missing/project')) as {
    server: { projectCwd: string; state: string; hasEndpoint: boolean; message?: string }
    notebooks: { activeSessionCount: number; busySessionCount: number; sessions: unknown[] }
  }

  assert.deepEqual(status, {
    projectCwd: '/missing/project',
    state: 'stopped',
    hasEndpoint: false,
    message: '请选择一个已添加的项目或当前 workspace'
  })
  assert.deepEqual(runtime, {
    server: {
      projectCwd: '/missing/project',
      state: 'stopped',
      hasEndpoint: false,
      message: '请选择一个已添加的项目或当前 workspace'
    },
    notebooks: {
      activeSessionCount: 0,
      busySessionCount: 0,
      sessions: []
    }
  })
})

test('main IPC: analysis Jupyter runtime status combines server and notebook sessions', async () => {
  const app = await harness()

  const status = (await app.invoke('analysis:jupyterRuntimeStatus', '/projects/research')) as {
    server: { projectCwd: string; state: string }
    notebooks: {
      activeSessionCount: number
      busySessionCount: number
      sessions: Array<{ notebookPath: string; kernelDisplayName: string; state: string }>
    }
  }

  assert.equal(status.server.projectCwd, '/projects/research')
  assert.equal(status.server.state, 'stopped')
  assert.equal(status.notebooks.activeSessionCount, 1)
  assert.equal(status.notebooks.busySessionCount, 0)
  assert.equal(
    status.notebooks.sessions[0]?.notebookPath,
    '/projects/research/notebooks/demo.ipynb'
  )
  assert.equal(status.notebooks.sessions[0]?.kernelDisplayName, 'Python 3')
  assert.equal(status.notebooks.sessions[0]?.state, 'idle')
  assert.deepEqual(app.jupyterServerCalls, [{ action: 'status', cwd: '/projects/research' }])
  assert.deepEqual(app.notebookSessionCalls, [{ action: 'summary', cwd: '/projects/research' }])
  const missing = (await app.invoke('analysis:jupyterRuntimeStatus', '/missing/project')) as {
    server: { state: string; message: string }
    notebooks: { activeSessionCount: number; sessions: unknown[] }
  }
  assert.equal(missing.server.state, 'stopped')
  assert.match(missing.server.message, /请选择/)
  assert.equal(missing.notebooks.activeSessionCount, 0)
  assert.deepEqual(missing.notebooks.sessions, [])
})

test('main IPC: analysis notebook kernel session lifecycle uses the selected project', async () => {
  const app = await harness()
  const document = {
    nbformat: 4,
    nbformatMinor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [],
    extra: {},
    revision: 'nb-1'
  }

  const status = (await app.invoke(
    'analysis:notebookSessionStatus',
    '/projects/research',
    'notebooks/demo.ipynb',
    document
  )) as { state: string }
  const ensured = (await app.invoke(
    'analysis:ensureNotebookSession',
    '/projects/research',
    'notebooks/demo.ipynb',
    document
  )) as { state: string; sessionId: string }
  const closed = (await app.invoke(
    'analysis:closeNotebookSession',
    '/projects/research',
    'notebooks/demo.ipynb'
  )) as { state: string }

  assert.equal(status.state, 'disconnected')
  assert.equal(ensured.state, 'idle')
  assert.equal(ensured.sessionId, 'session-1')
  assert.equal(closed.state, 'disconnected')
  assert.deepEqual(app.notebookSessionCalls, [
    {
      action: 'status',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    },
    {
      action: 'ensure',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    },
    { action: 'close', cwd: '/projects/research', path: '/projects/research/notebooks/demo.ipynb' }
  ])
  await assert.rejects(
    app.invoke('analysis:ensureNotebookSession', '/missing/project', 'x.ipynb', document),
    /请选择/
  )
})

test('main IPC: analysis notebook completion asks the live kernel for matches', async () => {
  const app = await harness()
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: 'df.he'
      }
    ]
  })

  const result = (await app.invoke('analysis:completeNotebookCell', '/projects/research', {
    path: 'notebooks/demo.ipynb',
    document,
    cellId: 'cell-1',
    source: 'df.he',
    cursorPosition: 99
  })) as { matches: string[]; cursorEnd: number; status: string }

  assert.equal(result.status, 'ok')
  assert.deepEqual(result.matches, ['df', 'df.head'])
  assert.equal(result.cursorEnd, 5)
  assert.deepEqual(app.notebookExecutionCalls.slice(-1), [
    {
      cellId: '__completion__',
      source: 'df.he',
      kernelId: 'kernel-1',
      cursorPosition: 5
    }
  ])
})

test('main IPC: analysis notebook formatting returns formatter edits', async () => {
  const app = await harness()
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: 'x=1'
      }
    ]
  })

  const result = (await app.invoke('analysis:formatNotebookCell', '/projects/research', {
    path: 'notebooks/demo.ipynb',
    document,
    cellId: 'cell-1',
    source: 'x=1',
    language: 'python',
    lineLength: 100
  })) as { source: string; changed: boolean; formatter: string }

  assert.equal(result.source, 'x = 1')
  assert.equal(result.changed, true)
  assert.equal(result.formatter, 'ruff')
  assert.deepEqual(app.notebookFormatCalls, [
    {
      projectCwd: '/projects/research',
      source: 'x=1',
      language: 'python',
      lineLength: 100
    }
  ])
})

test('main IPC: analysis notebook cell execution updates the returned document', async () => {
  const app = await harness()
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: 'print("ran")'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:executeNotebookCell',
    '/projects/research',
    'notebooks/demo.ipynb',
    document,
    'cell-1'
  )) as {
    document: notebookDocument.NotebookDocument
    sessionStatus: { state: string; message: string }
    executionCount: number
  }

  assert.equal(result.executionCount, 2)
  assert.equal(result.document.cells[0].executionCount, 2)
  assert.equal(result.document.cells[0].outputs[0].text, 'ran\n')
  assert.deepEqual(result.document.cells[0].metadata.phi, {
    executionStartedAt: '2026-09-09T00:00:00.000Z',
    executionCompletedAt: '2026-09-09T00:00:01.000Z',
    executionDurationMs: 1000
  })
  assert.equal(result.sessionStatus.state, 'idle')
  assert.deepEqual(app.notebookExecutionCalls, [
    { cellId: 'cell-1', source: 'print("ran")', kernelId: 'kernel-1' }
  ])
  assert.deepEqual(app.notebookSessionCalls.slice(-3), [
    {
      action: 'ensure',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    },
    {
      action: 'state:busy',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    },
    {
      action: 'state:idle',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    }
  ])
})

test('main IPC: a cell error keeps the notebook kernel session usable', async () => {
  const app = await harness()
  app.setNotebookExecutionState('error')
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'R', language: 'R', name: 'ir' } },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        metadata: {},
        execution_count: null,
        outputs: [],
        source: 'ggplot(data)'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:executeNotebookCell',
    '/projects/research',
    'notebooks/demo.ipynb',
    document,
    'cell-1'
  )) as {
    state: string
    sessionStatus: { state: string; message: string }
  }

  assert.equal(result.state, 'error')
  assert.equal(result.sessionStatus.state, 'idle')
  assert.equal(result.sessionStatus.message, 'Cell 执行出错，kernel 仍可继续使用')
  assert.deepEqual(app.notebookSessionCalls.slice(-2), [
    {
      action: 'state:busy',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    },
    {
      action: 'state:idle',
      cwd: '/projects/research',
      path: '/projects/research/notebooks/demo.ipynb'
    }
  ])
})

test('main IPC: analysis notebook execution can be interrupted', async () => {
  const app = await harness()

  const status = (await app.invoke(
    'analysis:interruptNotebookExecution',
    '/projects/research',
    'notebooks/demo.ipynb'
  )) as { state: string; message: string }

  assert.equal(status.state, 'idle')
  assert.match(status.message, /停止请求/)
  assert.deepEqual(app.notebookSessionCalls.at(-1), {
    action: 'interrupt',
    cwd: '/projects/research',
    path: '/projects/research/notebooks/demo.ipynb'
  })
})

test('main IPC: remote analysis routes files and Jupyter only through the SSH backend', async () => {
  const app = await harness()
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    cwd: string
  }

  const registry = (await app.invoke('analysis:listNotebooks', current.cwd)) as {
    projectCwd: string
    notebooks: Array<{ path: string }>
  }
  const opened = (await app.invoke(
    'analysis:openNotebook',
    current.cwd,
    'notebooks/remote.ipynb'
  )) as {
    path: string
    contentHash: string
    document: notebookDocument.NotebookDocument
  }
  const saved = (await app.invoke('analysis:saveNotebook', current.cwd, {
    path: opened.path,
    document: opened.document,
    expectedRevision: opened.document.revision,
    expectedHash: opened.contentHash
  })) as { path: string }
  const starting = (await app.invoke('analysis:startJupyter', current.cwd)) as {
    state: string
    runtimeKind: string
    serverLabel: string
  }
  const status = (await app.invoke('analysis:jupyterStatus', current.cwd)) as {
    projectCwd: string
    state: string
    runtimeKind: string
    serverLabel: string
  }
  const executed = (await app.invoke(
    'analysis:executeNotebookCell',
    current.cwd,
    opened.path,
    opened.document,
    'cell-1'
  )) as { executionCount: number }
  const interrupted = (await app.invoke(
    'analysis:interruptNotebookExecution',
    current.cwd,
    opened.path
  )) as { state: string }
  const closedSession = (await app.invoke(
    'analysis:closeNotebookSession',
    current.cwd,
    opened.path
  )) as { state: string }
  const closed = (await app.invoke('analysis:closeNotebook', current.cwd, opened.path)) as {
    path: string
  }
  const stopped = (await app.invoke('analysis:stopJupyter', current.cwd)) as { state: string }

  assert.equal(registry.projectCwd, '/canonical/project')
  assert.deepEqual(
    registry.notebooks.map((item) => item.path),
    ['/canonical/project/notebooks/remote.ipynb']
  )
  assert.equal(opened.path, '/canonical/project/notebooks/remote.ipynb')
  assert.equal(saved.path, '/canonical/project/notebooks/remote.ipynb')
  assert.deepEqual(starting, {
    projectCwd: '/canonical/project',
    runtimeKind: 'ssh',
    serverLabel: 'cluster-one',
    state: 'preparing_environment',
    hasEndpoint: false,
    message: undefined
  })
  assert.equal(status.state, 'ready')
  assert.equal(status.runtimeKind, 'ssh')
  assert.equal(status.serverLabel, 'cluster-one')
  assert.equal(executed.executionCount, 2)
  assert.equal(interrupted.state, 'idle')
  assert.equal(closedSession.state, 'disconnected')
  assert.equal(closed.path, '/canonical/project/notebooks/remote.ipynb')
  assert.equal(stopped.state, 'stopped')
  assert.equal(
    app.notebookSessionCalls.filter(
      (call) => call.action === 'closeProject' && call.cwd === '/canonical/project'
    ).length,
    2
  )
  assert.deepEqual(app.jupyterServerCalls, [])
  assert.equal(
    app.remoteNotebookCalls.some((call) => call.path?.includes('remote-project-anchors')),
    false
  )
})

test('main host: remote notebook tools reject unowned runtime identities without local fallback', async () => {
  const app = await harness()
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
    cwd: string
  }
  const execute = app.hostHandlers.get('notebookTool.execute')
  assert.ok(execute)

  await assert.rejects(
    execute({
      action: 'list',
      cwd: current.cwd,
      params: {},
      remoteProject: {
        runtimeSessionId: 'forged-runtime',
        sessionId: current.phiSessionId,
        projectId: 'remote-project-1'
      }
    }),
    /远程 Notebook 后端不可用/
  )
  assert.deepEqual(app.remoteNotebookCalls, [])
  assert.deepEqual(app.jupyterServerCalls, [])
})

test('main host: a local project wins over a colliding saved remote path', async () => {
  const app = await harness()
  const execute = app.hostHandlers.get('notebookTool.execute')
  assert.ok(execute)

  assert.deepEqual(await execute({ action: 'list', cwd: '/projects/research', params: {} }), {
    kind: 'local_notebook_tool',
    cwd: '/projects/research'
  })
  assert.deepEqual(app.remoteNotebookCalls, [])
})

test('main IPC: deleting a remote project disposes its Notebook backend first', async () => {
  const app = await harness()
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    cwd: string
  }
  await app.invoke('analysis:startJupyter', current.cwd)

  await app.invoke('projects:delete', 'remote-project-1')

  assert.deepEqual(
    app.remoteNotebookCalls.filter((call) => call.action === 'dispose'),
    [{ action: 'dispose' }]
  )
})

test('main IPC: deleting the bound remote session disposes its Notebook backend', async () => {
  const app = await harness()
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    path: string
    cwd: string
  }
  await app.invoke('analysis:startJupyter', current.cwd)

  await app.invoke('sessions:delete', current.path)

  assert.deepEqual(
    app.remoteNotebookCalls.filter((call) => call.action === 'dispose'),
    [{ action: 'dispose' }]
  )
})

test('main IPC: Notebook AI jobs expose live model activity, generated source and independent retries', async () => {
  const preparation = deferred<void>()
  const firstResponse = deferred<void>()
  let holdPreparation = false
  let attempts = 0
  const app = await harness(
    async (_cwd, file) => {
      const session = new FakeSession(file)
      session.skipFinalAssistantMessage = true
      if (attempts++ === 0) {
        session.preflight = firstResponse.promise
        session.hold = true
      }
      session.toolEvents = [
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: { type: 'thinking_start', contentIndex: 0 }
        },
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: 'Inspect the ' }
        },
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: {
            type: 'thinking_delta',
            contentIndex: 0,
            delta: 'data dimensions.'
          }
        },
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: {
            type: 'thinking_end',
            contentIndex: 0,
            content: 'Inspect the data dimensions.'
          }
        },
        {
          type: 'tool_execution_start',
          toolCallId: 'notebook-inspection',
          toolName: 'inspect',
          intent: 'Read returned dataset metadata'
        },
        {
          type: 'tool_execution_update',
          toolCallId: 'notebook-inspection',
          partialResult: { content: [{ type: 'text', text: 'Reading metadata' }] }
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'notebook-inspection',
          result: { content: [{ type: 'text', text: 'Metadata inspected' }] }
        },
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: {
            type: 'text_delta',
            contentIndex: 1,
            delta: JSON.stringify({ cells: [{ language: 'python', code: 'df.describe()' }] })
          }
        }
      ]
      return session
    },
    {
      modelRuntimeGet: async () => {
        if (holdPreparation) await preparation.promise
      }
    }
  )
  const document = notebookDocument.parseNotebook({ nbformat: 4, metadata: {}, cells: [] })
  const input = {
    prompt: '总结数据',
    language: 'python',
    requestId: 'same-draft',
    afterCellId: null,
    references: [],
    model: { providerId: 'openai', modelId: 'gpt-test' }
  }
  const listJobs = async (): Promise<NotebookAiGenerationJob[]> =>
    app.invoke('analysis:listNotebookAiGenerationJobs') as Promise<NotebookAiGenerationJob[]>
  holdPreparation = true
  const generating = app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    input
  )
  await tick()
  const [preparing] = await listJobs()
  assert.equal(preparing.phase, 'preparing')
  assert.equal(preparing.state, 'running')
  assert.equal(preparing.model, 'openai/gpt-test')
  assert.equal(preparing.notebookName, 'qc.ipynb')
  assert.equal(preparing.notebookPath, '/projects/research/notebooks/qc.ipynb')
  preparation.resolve()
  await waitUntil(() => app.sessions.length === 1)
  assert.equal((await listJobs())[0].phase, 'waiting')
  firstResponse.resolve()
  await waitUntil(() => app.sessions[0].started)
  const [streaming] = await listJobs()
  assert.equal(streaming.phase, 'generating')
  assert.equal(streaming.sourcePreview, 'df.describe()')
  assert.equal(streaming.cellCount, 1)
  const thinking = streaming.entries?.filter((entry) => entry.kind === 'thinking')
  assert.equal(thinking?.length, 1)
  assert.equal(thinking?.[0].text, 'Inspect the data dimensions.')
  assert.equal(thinking?.[0].status, 'completed')
  assert.equal(
    streaming.entries?.find((entry) => entry.kind === 'action')?.text,
    'Metadata inspected'
  )
  assert.equal(streaming.entries?.find((entry) => entry.kind === 'action')?.status, 'completed')
  assert.match(streaming.entries?.find((entry) => entry.kind === 'text')?.text ?? '', /df.describe/)
  assert.equal(app.sessions[0].disposed, false)

  await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    input
  )
  const [retry, firstAttempt] = await listJobs()
  assert.notEqual(retry.id, firstAttempt.id)
  assert.equal(retry.requestId, firstAttempt.requestId)
  assert.equal(retry.state, 'completed')
  assert.equal(firstAttempt.state, 'running')
  assert.equal(firstAttempt.id, preparing.id)
  app.sessions[0].finish.resolve()
  await generating
  assert.ok(app.sessions.every((session) => session.disposed))
  assert.ok((await listJobs()).every((job) => job.state === 'completed' && job.completedAt))
  assert.equal(app.createdPhiSessions.length, 0)
  assert.equal(app.runStartInputs.length, 0)
  assert.ok(app.createdAgentOptions.every((options) => options.noTools === 'all'))
})

test('main IPC: Notebook AI jobs keep the remote project identity and resolved notebook path', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: JSON.stringify({ cells: [{ language: 'python', code: 'adata.shape' }] })
            }
          ]
        }
      }
    ]
    return session
  })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    cwd: string
  }
  const document = notebookDocument.parseNotebook({ nbformat: 4, metadata: {}, cells: [] })
  await app.invoke(
    'analysis:generateNotebookCode',
    current.cwd,
    'notebooks/remote.ipynb',
    document,
    { prompt: '查看数据维度', requestId: 'remote-notebook-ai' }
  )
  const [job] = (await app.invoke(
    'analysis:listNotebookAiGenerationJobs'
  )) as NotebookAiGenerationJob[]
  assert.equal(job.projectCwd, '/canonical/project')
  assert.equal(job.notebookPath, '/canonical/project/notebooks/remote.ipynb')
  assert.equal(job.notebookName, 'remote.ipynb')
  assert.equal(job.state, 'completed')
  assert.equal(job.sourcePreview, 'adata.shape')
  assert.deepEqual(app.jupyterServerCalls, [])
  assert.equal(app.createdAgentOptions.at(-1)?.noTools, 'all')
  assert.notEqual(app.createdAgentOptions.at(-1)?.cwd, current.cwd)
})

for (const preparationFailure of ['file', 'auth', 'model'] as const) {
  test(`main IPC: Notebook AI jobs retain ${preparationFailure} preparation failures`, async () => {
    const failure = new Error(`${preparationFailure} preparation unavailable`)
    let failAuth = false
    const app = await harness(undefined, {
      ...(preparationFailure === 'file' ? { notebookOpenError: failure } : {}),
      modelRuntimeGet: async () => {
        if (failAuth) throw failure
      }
    })
    failAuth = preparationFailure === 'auth'
    const document = notebookDocument.parseNotebook({ nbformat: 4, metadata: {}, cells: [] })
    await assert.rejects(
      app.invoke(
        'analysis:generateNotebookCode',
        '/projects/research',
        'notebooks/qc.ipynb',
        document,
        {
          prompt: '总结数据',
          requestId: `preparation-${preparationFailure}`,
          ...(preparationFailure === 'model'
            ? { model: { providerId: 'missing', modelId: 'unavailable' } }
            : {})
        }
      ),
      preparationFailure === 'model' ? /模型不可用/ : failure
    )
    const [job] = (await app.invoke(
      'analysis:listNotebookAiGenerationJobs'
    )) as NotebookAiGenerationJob[]
    assert.equal(job.state, 'failed')
    assert.equal(job.phase, 'failed')
    assert.equal(job.requestId, `preparation-${preparationFailure}`)
    assert.ok(job.completedAt)
    assert.match(
      job.error ?? '',
      preparationFailure === 'model' ? /模型不可用/ : /preparation unavailable/
    )
    assert.equal(app.sessions.length, 0)
  })
}

test('main IPC: notebook AI generation uses assistant event text when session history is empty', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                cells: [
                  {
                    cellType: 'code',
                    source: 'def greedy(items):\n    return sorted(items)',
                    language: 'python'
                  }
                ]
              })
            }
          ]
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '写一个贪心算法',
      language: 'python',
      afterCellId: null,
      references: []
    }
  )) as { source: string; language: string; cells: Array<{ cellType: string; source: string }> }

  assert.equal(result.language, 'python')
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'def greedy(items):\n    return sorted(items)',
      language: 'python'
    }
  ])
  assert.equal(result.source, 'def greedy(items):\n    return sorted(items)')
  assert.equal(app.sessions[0].messages.length, 0)
  assert.equal(app.createdAgentOptions[0].noTools, 'all')
  assert.deepEqual(app.sessions[0].promptOptions[0], {
    expandPromptTemplates: false,
    userInitiated: true,
    skipCompactionCheck: true
  })
  assert.doesNotMatch(app.sessions[0].promptTexts[0], /"cellType":"code"/)
  assert.match(app.sessions[0].promptTexts[0], /NotebookCellsCompletion pattern/)
  assert.match(app.sessions[0].promptTexts[0], /Return exactly one JSON object/)
  assert.match(app.sessions[0].promptTexts[0], /Do not include prose outside JSON/)
})

test('main IPC: notebook AI generation enriches @ variables from the live kernel', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cells: [{ language: 'python', code: 'df.describe()' }]
                })
              }
            ]
          }
        ]
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'load',
        cell_type: 'code',
        metadata: {},
        execution_count: 1,
        outputs: [],
        source: 'df = pd.read_json("use_data.json")'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '@df 总结数据',
      language: 'python',
      afterCellId: 'load',
      references: [
        {
          id: 'dataframe:df',
          kind: 'dataframe',
          name: 'df',
          detail: 'df = pd.read_json("use_data.json")',
          cellId: 'load',
          preview: { source: 'df = pd.read_json("use_data.json")' }
        }
      ]
    }
  )) as { cells: Array<{ cellType: string; source: string }> }

  assert.deepEqual(result.cells, [
    { cellType: 'code', source: 'df.describe()', language: 'python' }
  ])
  assert.ok(
    app.notebookExecutionCalls.some(
      (call) =>
        call.cellId === '__introspection__' && call.source === 'df' && call.kernelId === 'kernel-1'
    )
  )
  const prompt = app.sessions[0].promptTexts[0]
  assert.match(prompt, /@dataframe:\/\/df/)
  assert.match(prompt, /pandas\.core\.frame\.DataFrame/)
  assert.match(prompt, /2 rows x 3 columns/)
  assert.match(prompt, /Year \(object\), Income \(float64\)/)
  assert.match(prompt, /\| Year \| Income \|/)
})

test('main IPC: notebook AI generation enriches R @ data frames from the live kernel', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cells: [{ language: 'r', code: 'summary(df)' }]
                })
              }
            ]
          }
        ]
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'R', language: 'R', name: 'ir' } },
    cells: [
      {
        id: 'load',
        cell_type: 'code',
        metadata: {},
        execution_count: 1,
        outputs: [],
        source: 'df <- readr::read_csv("use_data.csv")'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc-r.ipynb',
    document,
    {
      prompt: '@df 总结数据',
      language: 'r',
      afterCellId: 'load',
      references: [
        {
          id: 'dataframe:df',
          kind: 'dataframe',
          name: 'df',
          detail: 'df <- readr::read_csv("use_data.csv")',
          cellId: 'load',
          preview: { source: 'df <- readr::read_csv("use_data.csv")' }
        }
      ]
    }
  )) as { cells: Array<{ cellType: string; source: string }> }

  assert.deepEqual(result.cells, [{ cellType: 'code', source: 'summary(df)', language: 'r' }])
  assert.ok(
    app.notebookExecutionCalls.some(
      (call) =>
        call.cellId === '__introspection__' &&
        call.source === 'df' &&
        call.kernelId === 'kernel-1' &&
        call.language === 'r'
    )
  )
  const prompt = app.sessions[0].promptTexts[0]
  assert.match(prompt, /@dataframe:\/\/df/)
  assert.match(prompt, /data\.frame/)
  assert.match(prompt, /2 rows x 3 columns/)
  assert.match(prompt, /Year \(character\), Income \(numeric\)/)
  assert.match(prompt, /19th 1208\.7/)
})

test('main IPC: notebook AI generation reads batched assistant messages from runtime events', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cells: [
                    {
                      cellType: 'code',
                      source: 'def choose(items):\n    return max(items)',
                      language: 'python'
                    }
                  ]
                })
              }
            ]
          }
        ]
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '写一个贪心算法',
      language: 'python',
      afterCellId: null,
      references: []
    }
  )) as { source: string; language: string; cells: Array<{ cellType: string; source: string }> }

  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'def choose(items):\n    return max(items)',
      language: 'python'
    }
  ])
  assert.equal(result.source, 'def choose(items):\n    return max(items)')
})

test('main IPC: notebook AI generation lets the prompt model override project defaults', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cells: [
                    {
                      cellType: 'code',
                      source: 'answer = 42',
                      language: 'python'
                    }
                  ]
                })
              }
            ]
          }
        ]
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/defaults',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '写一个答案',
      language: 'python',
      model: { providerId: 'openai', modelId: 'gpt-test' },
      afterCellId: null,
      references: []
    }
  )

  assert.deepEqual(app.createdAgentOptions[0].model, {
    provider: 'openai',
    id: 'gpt-test',
    name: 'gpt-test',
    reasoning: true
  })
  assert.equal(app.createdAgentOptions[0].thinkingLevel, 'medium')
})

test('main IPC: notebook AI generation preserves markdown and code cells', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'agent_end',
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cells: [
                    {
                      language: 'markdown',
                      code: '## 贪婪算法\n每一步选择当前看来最优的候选。'
                    },
                    {
                      language: 'python',
                      code: 'def greedy(values):\n    return sorted(values, reverse=True)'
                    }
                  ]
                })
              }
            ]
          }
        ]
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '写一个贪婪算法，并解释思路',
      language: 'python',
      afterCellId: null,
      references: []
    }
  )) as { source: string; language: string; cells: Array<{ cellType: string; source: string }> }

  assert.deepEqual(result.cells, [
    {
      cellType: 'markdown',
      source: '## 贪婪算法\n每一步选择当前看来最优的候选。'
    },
    {
      cellType: 'code',
      source: 'def greedy(values):\n    return sorted(values, reverse=True)',
      language: 'python'
    }
  ])
  assert.equal(
    result.source,
    '## 贪婪算法\n每一步选择当前看来最优的候选。\n\n' +
      'def greedy(values):\n    return sorted(values, reverse=True)'
  )
})

for (const thinking of [
  'with exit code 1 and',
  '```python\nprint("diagnostic only")\n```',
  `\`\`\`python\n${'print("long reasoning draft")\n'.repeat(200)}\`\`\``,
  JSON.stringify({ cells: [{ language: 'python', code: 'print("thinking only")' }] })
]) {
  test(`main IPC: notebook AI generation inserts the final Markdown instead of reasoning ${thinking.slice(0, 30)}`, async () => {
    const source =
      '## 为什么三个数据集的过滤参数不同\n\nQC_PARAMS 不是三套任意阈值，而是由 **矩阵含义** 决定哪些指标能当过滤器。GSE151530 / GSE189903 的 `X` 是 10x 原始 UMI counts；GSE229772 的 `X` 已归一化。'
    const finalText = JSON.stringify({ cells: [{ language: 'markdown', code: source }] })
    const finalMessage = {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking },
        { type: 'text', text: finalText }
      ]
    }
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.skipFinalAssistantMessage = true
      session.messages.push(finalMessage)
      session.toolEvents = [
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_delta', contentIndex: 0, delta: thinking }
        },
        {
          type: 'message_update',
          assistantMessageEvent: { type: 'thinking_end', contentIndex: 0, content: thinking }
        },
        ...[finalText.slice(0, 45), finalText.slice(45)].map((delta) => ({
          type: 'message_update',
          assistantMessageEvent: { type: 'text_delta', contentIndex: 1, delta }
        })),
        { type: 'message_end', message: finalMessage }
      ]
      return session
    })
    const document = notebookDocument.parseNotebook({ nbformat: 4, metadata: {}, cells: [] })
    const result = (await app.invoke(
      'analysis:generateNotebookCode',
      '/projects/research',
      'notebooks/qc.ipynb',
      document,
      {
        prompt: '为什么不同数据集使用不同的过滤参数',
        language: 'markdown',
        requestId: 'qc-markdown'
      }
    )) as { cells: Array<{ cellType: string; source: string }>; source: string }

    assert.deepEqual(result.cells, [{ cellType: 'markdown', source }])
    assert.equal(result.source, source)
    assert.equal(app.sessions.length, 1, 'a valid final Markdown response needs no repair')
    const progress = app.events.filter(
      (event) => event.channel === 'analysis:notebookCodeGenerationProgress'
    ) as Array<{ data: { cells: Array<{ cellType: string; source: string }> } }>
    assert.ok(progress.length > 0)
    assert.ok(progress.every((event) => event.data.cells.every((cell) => cell.source === source)))
    const [job] = (await app.invoke(
      'analysis:listNotebookAiGenerationJobs'
    )) as NotebookAiGenerationJob[]
    assert.equal(job.entries?.find((entry) => entry.kind === 'thinking')?.text, thinking)
    assert.equal(job.sourcePreview, source)
  })
}

test('main IPC: notebook AI generation chooses the full done message over a short streaming partial', async () => {
  let sessionCount = 0
  const app = await harness(async (_cwd, file) => {
    sessionCount += 1
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    if (sessionCount > 1) {
      session.toolEvents = [
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: {
            type: 'text_delta',
            delta: JSON.stringify({
              cells: [
                {
                  language: 'markdown',
                  code: '## 折线图：各国\n\n下面的代码绘制各国收入随年份变化的折线图。'
                },
                {
                  language: 'python',
                  code: [
                    'fig, ax = plt.subplots()',
                    'income_by_country.T.plot(ax=ax)',
                    'ax.set_title("各国收入趋势")',
                    'ax'
                  ].join('\n')
                }
              ]
            })
          }
        }
      ]
      return session
    }
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'partial',
          partial: {
            role: 'assistant',
            content: [{ type: 'text', text: '折线图：各国' }]
          }
        }
      },
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'done',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: [
                  '## 折线图：各国',
                  '',
                  '下面的代码绘制各国收入随年份变化的折线图。',
                  '',
                  '```python',
                  'fig, ax = plt.subplots()',
                  'income_by_country.T.plot(ax=ax)',
                  'ax.set_title("各国收入趋势")',
                  'ax',
                  '```'
                ].join('\n')
              }
            ]
          }
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '画各国收入折线图',
      language: 'python',
      requestId: 'notebook-ai-stream-1',
      afterCellId: null,
      references: []
    }
  )) as { source: string; language: string; cells: Array<{ cellType: string; source: string }> }

  assert.equal(app.sessions.length, 1)
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source:
        'fig, ax = plt.subplots()\n' +
        'income_by_country.T.plot(ax=ax)\n' +
        'ax.set_title("各国收入趋势")\n' +
        'ax',
      language: 'python'
    }
  ])
  assert.match(result.source, /income_by_country\.T\.plot/)
  assert.notStrictEqual(result.source, '折线图：各国')
  const progressEvents = app.events.filter(
    (event) => event.channel === 'analysis:notebookCodeGenerationProgress'
  ) as Array<{
    channel: string
    data: {
      requestId: string
      source: string
      cells: Array<{ cellType: string; source: string }>
    }
  }>
  assert.equal(progressEvents.at(-1)?.data.requestId, 'notebook-ai-stream-1')
  assert.match(progressEvents.at(-1)?.data.source ?? '', /income_by_country\.T\.plot/)
  assert.deepEqual(
    progressEvents.at(-1)?.data.cells.map((cell) => cell.cellType),
    ['code']
  )
})

test('main IPC: notebook AI generation streams staged cells from partial NotebookCellsCompletion JSON', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'text_delta',
          delta: '{"cells":[{"language":"markdown","code":"## Summary"},'
        }
      },
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'text_delta',
          delta: '{"language":"python","code":"result = df.describe()"}]}'
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '总结 df',
      language: 'python',
      requestId: 'notebook-ai-json-stream',
      afterCellId: null,
      references: []
    }
  )) as { cells: Array<{ cellType: string; source: string }> }
  const progressEvents = app.events.filter(
    (event) => event.channel === 'analysis:notebookCodeGenerationProgress'
  ) as Array<{
    data: {
      requestId: string
      cells: Array<{ cellType: string; source: string }>
    }
  }>

  assert.deepEqual(
    progressEvents.map((event) => event.data.cells.map((cell) => cell.cellType)),
    [['markdown'], ['markdown', 'code']]
  )
  assert.equal(progressEvents[0].data.requestId, 'notebook-ai-json-stream')
  assert.deepEqual(
    result.cells.map((cell) => cell.cellType),
    ['markdown', 'code']
  )
})

test('main IPC: notebook AI generation does not insert incomplete streamed JSON snapshots', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'text_delta',
          delta: '{"cells":[{"language":"markdown","code":"##"}'
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  await assert.rejects(
    app.invoke(
      'analysis:generateNotebookCode',
      '/projects/research',
      'notebooks/qc.ipynb',
      document,
      {
        prompt: '写一个快速排序算法',
        language: 'python',
        requestId: 'notebook-ai-incomplete-json',
        afterCellId: null,
        references: []
      }
    ),
    /AI 没有生成可插入内容/
  )

  const progressEvents = app.events.filter(
    (event) => event.channel === 'analysis:notebookCodeGenerationProgress'
  )
  assert.equal(progressEvents.length, 0)
})

test('main IPC: notebook AI generation repairs prose transcripts into NotebookCellsCompletion JSON', async () => {
  let sessionCount = 0
  const app = await harness(async (_cwd, file) => {
    sessionCount += 1
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    if (sessionCount === 1) {
      session.toolEvents = [
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: {
            type: 'text_delta',
            delta: [
              '最安全的是使用 matplotlib 的 tab10 中差异大的颜色。',
              '',
              '我提供一个 markdown 解释 + 修改后的 code cell。',
              '',
              '返回 JSON，包含两个 cells: markdown + python。'
            ].join('\n')
          }
        }
      ]
    } else {
      session.hold = true
      session.toolEvents = [
        {
          type: 'message_update',
          message: { role: 'assistant' },
          assistantMessageEvent: {
            type: 'text_delta',
            delta: JSON.stringify({
              cells: [
                { language: 'markdown', code: '#### 配色更新' },
                {
                  language: 'python',
                  code: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax'
                }
              ]
            })
          }
        }
      ]
    }
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-20',
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'inc_line.plot(color=["#0072B2", "#E69F00"])'
      }
    ]
  })

  const generating = app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '@cell-20 这个图片使用其他配色',
      language: 'python',
      requestId: 'notebook-ai-repair-json',
      afterCellId: 'cell-20',
      references: []
    }
  )
  await waitUntil(() => app.sessions[1]?.started === true)
  const [repairing] = (await app.invoke(
    'analysis:listNotebookAiGenerationJobs'
  )) as NotebookAiGenerationJob[]
  assert.equal(repairing.phase, 'repairing')
  assert.equal(repairing.state, 'running')
  assert.equal(repairing.cellCount, 2)
  assert.doesNotMatch(repairing.sourcePreview ?? '', /我提供一个 markdown 解释/)
  app.sessions[1].finish.resolve()
  const result = (await generating) as {
    cells: Array<{ cellType: string; source: string; language?: string }>
  }
  const jobs = (await app.invoke(
    'analysis:listNotebookAiGenerationJobs'
  )) as NotebookAiGenerationJob[]
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].id, repairing.id)
  assert.equal(jobs[0].state, 'completed')
  assert.ok(app.sessions.every((session) => session.disposed))

  assert.equal(app.sessions.length, 2)
  assert.match(app.sessions[1].promptTexts[0], /Invalid previous model output/)
  assert.match(app.sessions[1].promptTexts[0], /我提供一个 markdown 解释/)
  assert.equal(app.sessions[1].promptOptions[0].synthetic, true)
  assert.deepEqual(result.cells, [
    { cellType: 'markdown', source: '#### 配色更新' },
    {
      cellType: 'code',
      source: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax',
      language: 'python'
    }
  ])
})

test('main IPC: notebook AI generation accepts a clear fenced code answer', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'text_delta',
          delta: [
            '下面是替换后的 Cell 20 代码：',
            '',
            '```python',
            'colors = ["#1b9e77", "#d95f02"]',
            'ax = inc_line.plot(color=colors)',
            'ax',
            '```'
          ].join('\n')
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-20',
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'inc_line.plot(color=["#0072B2", "#E69F00"])'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '@cell-20 这个图片使用其他配色',
      language: 'python',
      requestId: 'notebook-ai-fenced-code',
      afterCellId: 'cell-20',
      references: []
    }
  )) as { cells: Array<{ cellType: string; source: string; language?: string }> }

  assert.equal(app.sessions.length, 1)
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax',
      language: 'python'
    }
  ])
})

test('main IPC: notebook AI generation accepts provider delta object text', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'message_delta',
          delta: {
            content: [
              {
                type: 'output_text',
                text: [
                  '下面是替换后的 Cell 20 代码：',
                  '',
                  '```python',
                  'colors = ["#1b9e77", "#d95f02"]',
                  'ax = inc_line.plot(color=colors)',
                  'ax',
                  '```'
                ].join('\n')
              }
            ]
          }
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-20',
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'inc_line.plot(color=["#0072B2", "#E69F00"])'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '@cell-20 这个图片使用其他配色',
      language: 'python',
      requestId: 'notebook-ai-provider-delta',
      afterCellId: 'cell-20',
      references: []
    }
  )) as { cells: Array<{ cellType: string; source: string; language?: string }> }

  assert.equal(app.sessions.length, 1)
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax',
      language: 'python'
    }
  ])
})

test('main IPC: notebook AI generation accepts raw code answers', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'text_delta',
          delta: ['colors = ["#1b9e77", "#d95f02"]', 'ax = inc_line.plot(color=colors)', 'ax'].join(
            '\n'
          )
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: [
      {
        id: 'cell-20',
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: 'inc_line.plot(color=["#0072B2", "#E69F00"])'
      }
    ]
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '@cell-20 这个图片使用其他配色',
      language: 'python',
      requestId: 'notebook-ai-raw-code',
      afterCellId: 'cell-20',
      references: []
    }
  )) as { cells: Array<{ cellType: string; source: string; language?: string }> }

  assert.equal(app.sessions.length, 1)
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax',
      language: 'python'
    }
  ])
})

test('main IPC: notebook AI generation uses assistant done event before session history', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'done',
          message: {
            role: 'assistant',
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  cells: [
                    {
                      cellType: 'code',
                      source: 'def greedy(items):\n    return sorted(items, reverse=True)',
                      language: 'python'
                    }
                  ]
                })
              }
            ]
          }
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  const result = (await app.invoke(
    'analysis:generateNotebookCode',
    '/projects/research',
    'notebooks/qc.ipynb',
    document,
    {
      prompt: '写一个贪心算法',
      language: 'python',
      afterCellId: null,
      references: []
    }
  )) as { source: string; language: string; cells: Array<{ cellType: string; source: string }> }

  assert.equal(result.language, 'python')
  assert.deepEqual(result.cells, [
    {
      cellType: 'code',
      source: 'def greedy(items):\n    return sorted(items, reverse=True)',
      language: 'python'
    }
  ])
  assert.equal(result.source, 'def greedy(items):\n    return sorted(items, reverse=True)')
  assert.deepEqual(app.sessions[0].messages, [
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] }
  ])
})

test('main IPC: notebook AI generation surfaces assistant event errors', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_update',
        message: { role: 'assistant' },
        assistantMessageEvent: {
          type: 'error',
          error: { errorMessage: 'Provider failed before returning notebook cells' }
        }
      }
    ]
    return session
  })
  const document = notebookDocument.parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    cells: []
  })

  await assert.rejects(
    app.invoke(
      'analysis:generateNotebookCode',
      '/projects/research',
      'notebooks/qc.ipynb',
      document,
      {
        prompt: '写一个贪心算法',
        language: 'python',
        afterCellId: null,
        references: []
      }
    ),
    /Provider failed before returning notebook cells/
  )
  const [job] = (await app.invoke(
    'analysis:listNotebookAiGenerationJobs'
  )) as NotebookAiGenerationJob[]
  assert.equal(job.state, 'failed')
  assert.equal(job.error, 'Provider failed before returning notebook cells')
  assert.ok(job.completedAt)
  assert.equal(app.sessions[0].disposed, true)
})

test('main IPC: project agent sessions receive active notebook and app Jupyter context', async () => {
  const app = await harness()

  await app.invoke('projects:newSession', '/projects/research', 'auto')
  await app.invoke('analysis:openNotebook', '/projects/research', 'notebooks/qc.ipynb')
  await app.invoke('agent:prompt', '运行当前 notebook 的最后一个 cell')

  const resourceOptions = app.resourceLoaderOptions.at(-1)
  const appendSystemPrompt = resourceOptions?.appendSystemPrompt as string[] | undefined
  assert.ok(appendSystemPrompt?.length)
  const notebookPrompt = appendSystemPrompt.join('\n')
  assert.match(notebookPrompt, /<phi_notebook_runtime>/)
  assert.match(notebookPrompt, /Active notebook: notebooks\/qc\.ipynb/)
  assert.match(notebookPrompt, /Phi app-managed Jupyter Server/)
  assert.match(
    notebookPrompt,
    /Do not assume, probe, or instruct the user to restart JupyterLab on localhost:8888/
  )
  assert.match(notebookPrompt, /notebook\.run_cell/)
})

test('main IPC persists and broadcasts a bounded change summary after the run', async () => {
  const app = await harness()
  const summary: WorkspaceChangeSummary = {
    files: [
      {
        path: '/workspace/result.txt',
        displayPath: 'result.txt',
        status: 'modified',
        added: 2,
        deleted: 1
      }
    ],
    totalChanged: 1,
    truncated: false
  }
  app.setWorkspaceChangeSummary(summary)
  await app.invoke('agent:prompt', 'update the result')

  const saved = app.appendedSessionEvents.find(
    (entry) => (entry.event as { type?: string }).type === 'workspace_changes'
  )?.event as Record<string, unknown> | undefined
  assert.equal(saved?.runId, 'run-2')
  assert.deepEqual(saved?.files, summary.files)
  assert.equal(
    app.events.some(
      (entry) =>
        entry.channel === 'agent:event' &&
        (entry.data as { type?: string }).type === 'workspace_changes'
    ),
    true
  )
})

test('main IPC stores a run diff separately and can read it after the run', async () => {
  const app = await harness()
  const patch = '@@ -1 +1 @@\n-before\n+after\n'
  app.setWorkspaceChangeSummary({
    files: [
      {
        path: '/workspace/result.txt',
        displayPath: 'result.txt',
        status: 'modified',
        added: 1,
        deleted: 1
      }
    ],
    totalChanged: 1,
    truncated: false
  })
  app.setWorkspaceDiffPatch(patch)
  await app.invoke('agent:prompt', 'edit result')

  const event = app.appendedSessionEvents.find(
    (entry) => (entry.event as { type?: string }).type === 'workspace_changes'
  )?.event as { files: Array<{ diff?: { sessionId: string; id: string; bytes: number } }> }
  const ref = event.files[0].diff
  assert.ok(ref)
  assert.equal(ref.sessionId, 'phi-1')
  assert.equal(app.savedWorkspaceDiff(), patch)
  assert.equal(await app.invoke('workspaceChanges:readDiff', ref), patch)
  assert.doesNotMatch(JSON.stringify(event), /@@ -1|-before|\+after/)
})

test('main IPC: pasted image is saved as a reference and reaches the vision model', async () => {
  const app = await harness()
  const image = { mimeType: 'image/png', data: 'iVBORw0KGgo=' }
  await app.invoke('models:select', 'openai', 'gpt-vision-test')
  await app.invoke('agent:prompt', '', { images: [image] })

  assert.deepEqual(app.sessions[0].promptOptions[0].images, [{ type: 'image', ...image }])
  const userEvent = app.appendedSessionEvents.find(
    (entry) => (entry.event as { type?: string }).type === 'user_message'
  )?.event as {
    content: string
    images: Array<{ sessionId: string; id: string; mimeType: string }>
  }
  assert.equal(userEvent.content, '')
  assert.deepEqual(userEvent.images, [
    { sessionId: 'phi-1', id: 'a'.repeat(64), mimeType: 'image/png' }
  ])
  assert.deepEqual(await app.invoke('agent:readPromptImage', userEvent.images[0]), image)
})

test(
  'main IPC: prompt text and tool events are persisted with large output previews',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.toolEvents = [
        {
          type: 'tool_execution_start',
          toolCallId: 'tool-1',
          toolName: 'bash',
          args: { command: 'printf long' }
        },
        {
          type: 'tool_execution_end',
          toolCallId: 'tool-1',
          toolName: 'bash',
          result: { output: 'abcdefghijklmnop' },
          isError: false
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'assistant final' }]
          }
        }
      ]
      return session
    })

    await app.invoke('agent:prompt', 'run tool')

    assert.deepEqual(
      app.appendedSessionEvents.map((entry) => ({
        ...entry,
        event: withoutTimestamp(entry.event as Record<string, unknown>)
      })),
      [
        {
          sessionId: 'phi-1',
          event: {
            type: 'user_message',
            runId: 'run-2',
            content: 'run tool'
          }
        },
        {
          sessionId: 'phi-1',
          event: {
            type: 'tool_call_started',
            runId: 'run-2',
            toolCallId: 'tool-1',
            toolName: 'bash',
            args: { command: 'printf long' }
          }
        },
        {
          sessionId: 'phi-1',
          event: {
            type: 'tool_call_completed',
            runId: 'run-2',
            toolCallId: 'tool-1',
            toolName: 'bash',
            isError: false,
            output: 'abcdefgh\n...saved',
            outputBytes: 16,
            outputTruncated: true,
            outputPath: '/tool-outputs/tool-1.txt',
            outputArtifact: {
              kind: 'tool_output',
              path: '/tool-outputs/tool-1.txt',
              bytes: 16
            }
          }
        },
        {
          sessionId: 'phi-1',
          event: {
            type: 'assistant_message_finalized',
            runId: 'run-2',
            content: 'assistant final'
          }
        }
      ]
    )
    assert.deepEqual(app.persistedToolOutputs, [
      {
        sessionId: 'phi-1',
        input: {
          runId: 'run-2',
          toolCallId: 'tool-1',
          output: 'abcdefghijklmnop',
          inlineLimit: 20000
        }
      }
    ])
    const toolEnd = app.events.find(
      (event) =>
        event.channel === 'agent:event' &&
        (event.data as { type?: string; toolCallId?: string }).type === 'tool_execution_end'
    )
    assert.deepEqual((toolEnd?.data as { result?: unknown }).result, {
      output: 'abcdefgh\n...saved',
      outputPath: '/tool-outputs/tool-1.txt',
      outputBytes: 16,
      truncated: true,
      outputArtifact: {
        kind: 'tool_output',
        path: '/tool-outputs/tool-1.txt',
        bytes: 16
      }
    })
  }
)

test('main IPC: browser tool events persist only bounded control metadata', async () => {
  const sensitiveUrl = 'https://example.test/private?token=super-secret#fragment'
  const pngData = 'iVBORw0KGgoAAAANSUhEUg-browser-secret'
  const sensitiveText = 'PRIVATE_FORM_TEXT_SENTINEL\nsecond line'
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'tool_execution_start',
        toolCallId: 'browser-sdk-1',
        toolName: 'browser',
        args: {
          action: 'typeText',
          target: 'current',
          tabId: 'tab-1',
          expectedDocumentRevision: 4,
          x: 987654.125,
          y: 123456.75,
          consequence: 'write',
          text: sensitiveText,
          modifiers: ['sentinel-modifier'],
          url: sensitiveUrl,
          raw: { url: sensitiveUrl }
        }
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'browser-sdk-1',
        toolName: 'browser',
        result: {
          content: [
            { type: 'text', text: 'Captured tab tab-1' },
            { type: 'image', mimeType: 'image/png', data: pngData }
          ],
          details: { kind: 'browser', screenshot: { tabId: 'tab-1', width: 10, height: 20 } }
        },
        isError: false
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'browser-sdk-1',
          content: [
            { type: 'text', text: 'Captured tab tab-1' },
            { type: 'image', mimeType: 'image/png', data: pngData }
          ],
          details: { raw: pngData }
        }
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'browser-provider-1',
              name: 'browser',
              arguments: {
                action: 'keypress',
                target: 'current',
                tabId: 'tab-2',
                expectedDocumentRevision: 9,
                key: 'SENTINEL_DANGEROUS_KEY',
                modifiers: ['sentinel-modifier'],
                deltaY: 7654321,
                url: sensitiveUrl
              }
            }
          ]
        }
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'browser-provider-1',
          content: [
            { type: 'text', text: 'Captured tab tab-2' },
            { type: 'image', mimeType: 'image/png', data: pngData }
          ]
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'browse safely')

  const events = app.appendedSessionEvents.map((entry) => entry.event as Record<string, unknown>)
  const starts = events.filter((event) => event.type === 'tool_call_started')
  assert.deepEqual(
    starts.map((event) => event.args),
    [
      {
        action: 'typeText',
        target: 'current',
        tabId: 'tab-1',
        expectedDocumentRevision: 4
      },
      {
        action: 'keypress',
        target: 'current',
        tabId: 'tab-2',
        expectedDocumentRevision: 9
      }
    ]
  )
  const persisted = JSON.stringify(events)
  assert.doesNotMatch(persisted, /super-secret|fragment|iVBORw0KGgo|PRIVATE_FORM_TEXT_SENTINEL/)
  assert.doesNotMatch(
    JSON.stringify(app.events),
    /super-secret|fragment|iVBORw0KGgo|PRIVATE_FORM_TEXT_SENTINEL/
  )
  assert.doesNotMatch(
    `${persisted}${JSON.stringify(app.events)}`,
    /987654|123456|7654321|SENTINEL_DANGEROUS_KEY|sentinel-modifier/
  )
})

test('main IPC: provider-managed tool results are persisted and sent to the chat', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            {
              type: 'toolCall',
              id: 'provider-call-1',
              name: 'web_fetch',
              arguments: { url: 'https://example.com' }
            },
            { type: 'text', text: 'Here is the result.' }
          ]
        }
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'provider-call-1',
          content: [{ type: 'text', text: 'Fetched page' }],
          isError: false
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'fetch a page')

  const toolEvents = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .filter((event) => event.toolCallId === 'provider-call-1')
  assert.deepEqual(
    toolEvents.map((event) => event.type),
    ['tool_call_started', 'tool_call_completed']
  )
  assert.equal(toolEvents[0].toolName, 'web_fetch')
  assert.match(String(toolEvents[1].output), /Fetched/)
  assert.ok(
    app.events.some(
      (event) =>
        (event.data as { type?: string; toolCallId?: string }).type ===
          'provider_tool_call_completed' &&
        (event.data as { toolCallId?: string }).toolCallId === 'provider-call-1'
    )
  )
})

test('main IPC: hosted fetch is stored between the thinking and text blocks around it', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'before' },
            { type: 'text', text: 'I will search.' },
            {
              type: 'toolCall',
              id: 'hosted-1',
              name: 'web_fetch',
              arguments: { url: 'https://pubmed.ncbi.nlm.nih.gov/?term=MID1IP1' }
            },
            { type: 'thinking', thinking: 'after' },
            { type: 'text', text: 'Here are the papers.' }
          ]
        }
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'hosted-1',
          content: [{ type: 'text', text: 'PubMed results' }]
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'find MID1IP1 papers')
  const events = app.appendedSessionEvents.map((entry) => entry.event as Record<string, unknown>)
  assert.deepEqual(
    events.map((event) => event.type),
    [
      'user_message',
      'assistant_thinking_completed',
      'assistant_message_finalized',
      'tool_call_started',
      'assistant_thinking_completed',
      'assistant_message_finalized',
      'tool_call_completed'
    ]
  )
  assert.equal(events[2].content, 'I will search.')
  assert.equal(events[5].content, 'Here are the papers.')
})

test('main IPC: SDK tool execution is not duplicated by its message history', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'sdk-call-1', name: 'bash', arguments: { command: 'pwd' } }
          ]
        }
      },
      {
        type: 'tool_execution_start',
        toolCallId: 'sdk-call-1',
        toolName: 'bash',
        args: { command: 'pwd' }
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'sdk-call-1',
        toolName: 'bash',
        result: { content: [{ type: 'text', text: '/workspace' }] },
        isError: false
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'sdk-call-1',
          content: [{ type: 'text', text: '/workspace' }]
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'show the directory')
  const events = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .filter((event) => event.toolCallId === 'sdk-call-1')
  assert.deepEqual(
    events.map((event) => event.type),
    ['tool_call_started', 'tool_call_completed']
  )
  assert.equal(
    app.events.some(
      (event) => (event.data as { type?: string }).type === 'provider_tool_call_completed'
    ),
    false
  )
})

test('main IPC: an SDK completion without a start still suppresses a hosted duplicate', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'todo-1', name: 'todo', arguments: { todos: [] } }]
        }
      },
      {
        type: 'tool_execution_end',
        toolCallId: 'todo-1',
        toolName: 'todo',
        result: { content: [{ type: 'text', text: 'updated' }] },
        isError: false
      },
      {
        type: 'message_end',
        message: {
          role: 'toolResult',
          toolCallId: 'todo-1',
          content: [{ type: 'text', text: 'updated' }]
        }
      }
    ]
    return session
  })
  await app.invoke('agent:prompt', 'update todo')
  const completed = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .filter((event) => event.type === 'tool_call_completed' && event.toolCallId === 'todo-1')
  assert.equal(completed.length, 1)
})

async function permissionTarget(
  app: HarnessResult
): Promise<{ sessionPath: string | null; phiSessionId: string | null; sessionGeneration: number }> {
  const current = (await app.invoke('sessions:current')) as {
    path: string | null
    phiSessionId?: string
    sessionGeneration: number
  }
  return {
    sessionPath: current.path,
    phiSessionId: current.phiSessionId ?? null,
    sessionGeneration: current.sessionGeneration
  }
}

async function updatePermissionMode(app: HarnessResult, mode: string): Promise<unknown> {
  return app.invoke('sessions:updatePermissionMode', mode, await permissionTarget(app))
}

test('main IPC: current conversation permission mode affects the next run', async () => {
  const app = await harness()

  const current = (await updatePermissionMode(app, 'ask')) as {
    permissionMode: string
  }
  assert.equal(current.permissionMode, 'ask')

  await app.invoke('agent:prompt', 'needs permission')

  assert.equal(app.approvalOptions.length, 1)
})

test('main IPC: permission mode changes stay scoped to the selected conversation', async () => {
  const app = await harness()

  const first = (await app.invoke('sessions:switch', 'alpha')) as { permissionMode: string }
  assert.equal(first.permissionMode, 'ask')

  const updated = (await updatePermissionMode(app, 'full')) as {
    permissionMode: string
  }
  assert.equal(updated.permissionMode, 'full')

  const second = (await app.invoke('sessions:switch', 'beta')) as { permissionMode: string }
  assert.equal(second.permissionMode, 'ask')

  const restored = (await app.invoke('sessions:switch', 'alpha')) as { permissionMode: string }
  assert.equal(restored.permissionMode, 'full')
})

test('main IPC: full access retains an inactive live approval hook', async () => {
  const app = await harness()

  const current = (await updatePermissionMode(app, 'full')) as {
    permissionMode: string
  }
  assert.equal(current.permissionMode, 'full')

  await app.invoke('agent:prompt', 'full access')

  assert.equal(app.approvalOptions.length, 1)
  assert.equal((app.approvalOptions[0].shouldGate as () => boolean)(), false)
})

test(
  'main IPC: active local run reads ask, auto and full changes without recreation',
  { timeout: 3000 },
  async () => {
    const session = new FakeSession('live-permissions.jsonl')
    session.hold = true
    const app = await harness(async () => session)
    const prompt = app.invoke('agent:prompt', 'keep running')
    await tick()
    assert.equal(app.approvalOptions.length, 1)
    const shouldGate = app.approvalOptions[0].shouldGate as () => boolean
    assert.equal(shouldGate(), false)
    for (const mode of ['ask', 'auto', 'full', 'ask']) {
      await updatePermissionMode(app, mode)
      assert.equal(shouldGate(), mode === 'ask')
      assert.equal(session.disposed, false)
      assert.equal(session.log.includes('abort'), false)
    }
    assert.equal(app.createdAgentOptions.length, 1)
    await app.invoke('agent:stop')
    await prompt
  }
)

test('main IPC: delayed or foreign permission changes cannot mutate a replacement conversation', async () => {
  const app = await harness()
  await app.invoke('sessions:switch', 'alpha')
  const first = await permissionTarget(app)
  await app.invoke('sessions:switch', 'beta')
  const second = await permissionTarget(app)
  const persisted = app.updatedSessionManifests.length
  await assert.rejects(app.invoke('sessions:updatePermissionMode', 'full', first), /会话已切换/)
  await assert.rejects(
    app.invokeFromForeign('sessions:updatePermissionMode', 'full', second),
    /renderer|渲染|窗口|可信/i
  )
  await assert.rejects(
    app.invoke('sessions:updatePermissionMode', 'invalid', second),
    /权限模式无效/
  )
  await assert.rejects(app.invoke('sessions:updatePermissionMode', 'auto'), /缺少会话目标/)
  assert.equal(app.updatedSessionManifests.length, persisted)
  assert.equal(
    ((await app.invoke('sessions:current')) as { permissionMode: string }).permissionMode,
    'ask'
  )
})

test(
  'main IPC: visible conversation permission changes leave background run policy isolated',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.hold = true
      return session
    })
    await app.invoke('sessions:switch', 'alpha')
    const first = app.invoke('agent:prompt', 'alpha keeps running')
    await tick()
    const alphaPolicy = app.approvalOptions[0].shouldGate as () => boolean
    assert.equal(alphaPolicy(), true)
    await app.invoke('sessions:switch', 'beta')
    await updatePermissionMode(app, 'full')
    const second = app.invoke('agent:prompt', 'beta keeps running')
    await tick()
    const betaPolicy = app.approvalOptions[1].shouldGate as () => boolean
    assert.equal(betaPolicy(), false)
    assert.equal(alphaPolicy(), true)
    await updatePermissionMode(app, 'ask')
    assert.equal(betaPolicy(), true)
    assert.equal(alphaPolicy(), true)
    await app.invoke('sessions:switch', 'alpha')
    await updatePermissionMode(app, 'auto')
    assert.equal(alphaPolicy(), false)
    assert.equal(betaPolicy(), true)
    assert.equal(app.sessions.length, 2)
    assert.ok(app.sessions.every((session) => !session.disposed && !session.log.includes('abort')))
    for (const session of app.sessions) session.finish.resolve()
    await Promise.all([first, second])
  }
)

test(
  'main IPC: local project policy changes reach existing live sessions without aborting them',
  { timeout: 3000 },
  async () => {
    const session = new FakeSession('local-project-live.jsonl')
    session.hold = true
    const app = await harness(async () => session)
    await app.invoke('sessions:switch', 'defaults')
    const prompt = app.invoke('agent:prompt', 'keep project running')
    await tick()
    const shouldGate = app.approvalOptions[0].shouldGate as () => boolean
    assert.equal(shouldGate(), true)
    for (const mode of ['auto', 'full', 'ask']) {
      await app.invoke('projects:updatePermissionMode', 'project-/projects/defaults', mode)
      assert.equal(shouldGate(), mode === 'ask')
      assert.equal(session.disposed, false)
      assert.equal(session.log.includes('abort'), false)
    }
    await app.invoke('agent:stop')
    await prompt
  }
)

test(
  'main IPC: assistant thinking deltas are persisted as timeline items',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.toolEvents = [
        { type: 'message_start', message: { role: 'assistant' } },
        {
          type: 'message_update',
          message: { role: 'assistant' },
          createdAt: '2026-09-07T00:00:00.000Z',
          assistantMessageEvent: {
            type: 'thinking_delta',
            contentIndex: 0,
            delta: 'Inspect '
          }
        },
        {
          type: 'message_update',
          message: { role: 'assistant' },
          createdAt: '2026-09-07T00:00:02.000Z',
          assistantMessageEvent: {
            type: 'thinking_delta',
            contentIndex: 0,
            delta: 'before answering.'
          }
        },
        {
          type: 'message_end',
          createdAt: '2026-09-07T00:00:04.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Done.' }]
          }
        }
      ]
      return session
    })

    await app.invoke('agent:prompt', 'hello')

    assert.deepEqual(
      app.appendedSessionEvents.map((entry) => (entry.event as { type: string }).type),
      ['user_message', 'assistant_thinking_completed', 'assistant_message_finalized']
    )
    assert.equal(
      (app.appendedSessionEvents[1].event as { content?: string }).content,
      'Inspect before answering.'
    )
    assert.equal((app.appendedSessionEvents[1].event as { durationMs?: number }).durationMs, 4000)
  }
)

test('main IPC: assistant failures preserve thinking timing in Phi timeline', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      { type: 'message_start', message: { role: 'assistant' } },
      {
        type: 'message_update',
        message: { role: 'assistant' },
        createdAt: '2026-09-07T00:00:00.000Z',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'Check provider '
        }
      },
      {
        type: 'message_update',
        message: { role: 'assistant' },
        createdAt: '2026-09-07T00:00:02.000Z',
        assistantMessageEvent: {
          type: 'thinking_delta',
          contentIndex: 0,
          delta: 'before failing.'
        }
      },
      {
        type: 'message_end',
        createdAt: '2026-09-07T00:00:05.000Z',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: '404 Not found the model kimi-k2.5 or Permission denied'
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  assert.deepEqual(
    app.appendedSessionEvents.map((entry) => (entry.event as { type: string }).type),
    ['user_message', 'assistant_thinking_completed', 'run_failed']
  )
  assert.deepEqual(app.appendedSessionEvents[1].event, {
    type: 'assistant_thinking_completed',
    runId: 'run-2',
    content: 'Check provider before failing.',
    createdAt: '2026-09-07T00:00:05.000Z',
    durationMs: 5000
  })
})

/**
 * The SDK's events carry no time, so the main process stamps the ones it forwards and stores.
 * Tests that compare a whole event check the stamp is a real time and compare the rest.
 */
function withoutTimestamp<T extends Record<string, unknown>>(event: T): Omit<T, 'createdAt'> {
  const { createdAt, ...rest } = event
  if (createdAt !== undefined) {
    assert.ok(Number.isFinite(Date.parse(String(createdAt))), 'the timestamp is a real time')
  }
  return rest
}

test('main IPC: context compaction events are persisted as timeline notices', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'auto_compaction_start',
        reason: 'threshold',
        action: 'remote'
      },
      {
        type: 'auto_compaction_end',
        action: 'remote',
        result: {
          summary: 'Full compaction summary.',
          shortSummary: 'Short compaction summary.',
          firstKeptEntryId: 'compacted-entry',
          tokensBefore: 12345
        },
        tokensAfter: 4200,
        aborted: false,
        willRetry: false
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  const event = app.appendedSessionEvents.find(
    (entry) => (entry.event as { type?: string }).type === 'context_compacted'
  )?.event as Record<string, unknown> | undefined
  assert.deepEqual(withoutTimestamp(event ?? {}), {
    type: 'context_compacted',
    runId: 'run-2',
    action: 'remote',
    reason: 'threshold',
    shortSummary: 'Short compaction summary.',
    summary: 'Full compaction summary.',
    tokensBefore: 12345,
    tokensAfter: 4200
  })
  assert.ok(
    app.events.some(
      (entry) =>
        entry.channel === 'agent:event' &&
        (entry.data as { type?: string; eventId?: string }).type === 'context_compacted' &&
        typeof (entry.data as { eventId?: string }).eventId === 'string'
    )
  )
})

test('main IPC: automatic shake and image rescue have accurate timeline notices', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      { type: 'auto_compaction_start', action: 'shake', reason: 'threshold' },
      {
        type: 'auto_compaction_end',
        action: 'shake',
        aborted: false,
        skipped: false,
        willRetry: false,
        tokensAfter: 12000
      },
      {
        type: 'notice',
        source: 'compaction',
        level: 'info',
        message:
          'Compaction dead-end recovery: dropped 2 attached images so maintenance could make progress.'
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  const shaken = app.appendedSessionEvents.find((entry) => entry.event.type === 'context_shaken')
  assert.deepEqual(withoutTimestamp(shaken?.event ?? {}), {
    type: 'context_shaken',
    runId: 'run-2',
    action: 'shake',
    reason: 'threshold',
    tokensAfter: 12000
  })
  const rescue = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'context_maintenance_notice'
  )
  assert.match(String(rescue?.event.noticeText), /dropped 2 attached images/)
  assert.equal(
    app.appendedSessionEvents.some((entry) => entry.event.type === 'context_compacted'),
    false
  )
})

test('main IPC: maintenance notices remain visible when the SDK emits them after a run', async () => {
  const app = await harness()
  await app.invoke('agent:prompt', 'hello')

  for (const listener of app.sessions[0].listeners) {
    listener({
      type: 'auto_compaction_end',
      action: 'shake',
      aborted: false,
      skipped: false,
      willRetry: false,
      tokensAfter: 9000
    })
    listener({
      type: 'notice',
      source: 'compaction',
      level: 'info',
      message: 'dropped 1 attached image'
    })
  }

  const shaken = app.appendedSessionEvents.find((entry) => entry.event.type === 'context_shaken')
  const rescued = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'context_maintenance_notice'
  )
  assert.equal(shaken?.event.tokensAfter, 9000)
  assert.equal(shaken?.event.runId, undefined)
  assert.match(String(rescued?.event.noticeText), /dropped 1 attached image/)
})

test('main IPC: failed automatic compaction is not reported as success', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      { type: 'auto_compaction_start', action: 'handoff', reason: 'threshold' },
      {
        type: 'auto_compaction_end',
        action: 'handoff',
        aborted: false,
        skipped: false,
        willRetry: false,
        errorMessage: 'provider rejected summary'
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  assert.equal(
    app.appendedSessionEvents.some((entry) => entry.event.type === 'context_compacted'),
    false
  )
  const failure = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'context_compaction_failed'
  )
  assert.equal(failure?.event.errorMessage, 'provider rejected summary')
})

test('main IPC: aborted automatic compaction records its failure reason', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      { type: 'auto_compaction_start', reason: 'threshold', action: 'handoff' },
      {
        type: 'auto_compaction_end',
        action: 'handoff',
        aborted: true,
        willRetry: false
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  const event = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'context_compaction_failed'
  )?.event
  assert.deepEqual(withoutTimestamp(event ?? {}), {
    type: 'context_compaction_failed',
    runId: 'run-2',
    action: 'handoff',
    reason: 'threshold',
    errorMessage: '已取消'
  })
})

test('main IPC: automatic model failures switch within one run and keep automatic selection', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.model = { provider: 'openai', id: 'gpt-test' }
    const prompt = session.prompt.bind(session)
    session.prompt = async (text, options) => {
      const failed = session.model?.id === 'gpt-test'
      session.skipFinalAssistantMessage = failed
      session.toolEvents = failed
        ? [
            {
              type: 'message_end',
              message: {
                role: 'assistant',
                stopReason: 'error',
                errorMessage: '503 provider unavailable'
              }
            }
          ]
        : [
            {
              type: 'message_end',
              message: {
                role: 'assistant',
                stopReason: 'stop',
                content: [{ type: 'text', text: 'Recovered answer' }]
              }
            }
          ]
      await prompt(text, options)
    }
    return session
  })
  await app.invoke('agent:prompt', 'hello')
  assert.equal(app.sessions.length, 1)
  assert.equal(app.sessions[0].promptTexts.length, 2)
  assert.equal(app.sessions[0].model?.id, 'gpt-vision-test')
  assert.equal(await app.invoke('models:selected'), null)
  assert.equal(app.runStartInputs.length, 1)
  const events = app.appendedSessionEvents.map((entry) => entry.event as Record<string, unknown>)
  assert.equal(events.filter((event) => event.type === 'user_message').length, 1)
  assert.equal(events.filter((event) => event.type === 'model_fallback').length, 1)
  assert.equal(
    events.some((event) => event.type === 'run_failed'),
    false
  )
  assert.equal(events.at(-1)?.content, 'Recovered answer')
})

test('main IPC: automatic fallback only tries configured models and preserves the last error', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.model = { provider: 'openai', id: 'gpt-test' }
    const prompt = session.prompt.bind(session)
    session.prompt = async (text, options) => {
      session.promptError = new Error(`503 ${session.model?.id} unavailable`)
      await prompt(text, options)
    }
    return session
  })
  await assert.rejects(app.invoke('agent:prompt', 'hello'), /gpt-vision-test unavailable/)
  assert.equal(app.sessions[0].promptTexts.length, 2)
  assert.equal(app.sessions[0].model?.provider, 'openai')
})

test('main IPC: SDK recovery clears earlier provider failure without switching models', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.model = { provider: 'openai', id: 'gpt-test' }
    session.toolEvents = [
      {
        type: 'message_end',
        message: { role: 'assistant', stopReason: 'error', errorMessage: '429 rate limit' }
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'stop',
          content: [{ type: 'text', text: 'SDK recovered' }]
        }
      },
      { type: 'auto_retry_end', success: true, attempt: 1 }
    ]
    return session
  })
  await app.invoke('agent:prompt', 'hello')
  assert.equal(app.sessions[0].promptTexts.length, 1)
  assert.equal(
    app.appendedSessionEvents.some((entry) =>
      ['run_failed', 'model_fallback'].includes(String((entry.event as { type?: string }).type))
    ),
    false
  )
})

test('main IPC: automatic image prompts choose an image-capable configured model', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.model = { provider: 'openai', id: 'gpt-test', supportsImages: false }
    return session
  })
  await app.invoke('agent:prompt', 'Describe this image', {
    images: [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }]
  })
  assert.equal(app.sessions[0].model?.id, 'gpt-vision-test')
  assert.equal(app.sessions[0].promptOptions[0].images?.length, 1)
})

test('main IPC: automatic region failure aborts backoff and continues with another model', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.model = { provider: 'openai', id: 'gpt-test' }
    const prompt = session.prompt.bind(session)
    const abort = session.abort.bind(session)
    session.abort = async (options?: { preserveApprovals?: boolean }) => {
      assert.equal(options?.preserveApprovals, true)
      await abort()
    }
    session.prompt = async (text, options) => {
      const failed = session.model?.id === 'gpt-test'
      session.hold = failed
      session.skipFinalAssistantMessage = failed
      session.toolEvents = failed
        ? [
            {
              type: 'auto_retry_start',
              attempt: 1,
              maxAttempts: 5,
              delayMs: 30_000,
              errorMessage: 'Provider is not supported in your region'
            }
          ]
        : []
      await prompt(text, options)
    }
    return session
  })
  await app.invoke('agent:prompt', 'hello')
  assert.equal(app.sessions[0].promptTexts.length, 2)
  assert.equal(app.sessions[0].model?.id, 'gpt-vision-test')
  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'run_failed'
    ),
    false
  )
})

test('main IPC: explicit model failures do not activate automatic fallback', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.promptError = new Error('503 model unavailable')
    return session
  })
  await app.invoke('models:select', 'openai', 'gpt-test')
  await assert.rejects(app.invoke('agent:prompt', 'hello'), /503 model unavailable/)
  assert.equal(app.sessions[0].promptTexts.length, 1)
})

test('main IPC: project sessions inherit project model defaults', { timeout: 3000 }, async () => {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/defaults', 'ask')
  await app.invoke('agent:prompt', 'hello')

  assert.deepEqual(app.createdPhiSessions[0].model, {
    providerId: 'anthropic',
    modelId: 'claude-test'
  })
  assert.equal(app.createdPhiSessions[0].thinkingLevel, 'medium')
  assert.deepEqual(app.createdAgentOptions[0].model, {
    provider: 'anthropic',
    id: 'claude-test',
    name: 'claude-test',
    reasoning: true
  })
  assert.equal(app.createdAgentOptions[0].thinkingLevel, 'medium')
})

test(
  'main IPC: unavailable session model fails before SDK session creation',
  {
    timeout: 3000
  },
  async () => {
    const app = await harness()
    await app.invoke('projects:newSession', '/projects/unavailable', 'ask')

    await assert.rejects(app.invoke('agent:prompt', 'hello'), /模型不可用: missing\/gone/)

    assert.deepEqual(app.createdPhiSessions[0].model, {
      providerId: 'missing',
      modelId: 'gone'
    })
    assert.equal(app.createdAgentOptions.length, 0)
  }
)

test('main IPC: prompt failures keep Phi timeline linked to the runtime session', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.promptError = new Error(
      '401 Invalid Authentication\nInvalid Authentication (type=invalid_authentication_error)'
    )
    return session
  })

  await assert.rejects(app.invoke('agent:prompt', 'hello'), /Invalid Authentication/)

  assert.deepEqual(
    app.updatedSessionManifests.filter((entry) => 'runtimeSessionPath' in entry.patch),
    [{ sessionId: 'phi-1', patch: { runtimeSessionPath: 'fresh.jsonl' } }]
  )
})

test('main IPC: assistant error message ends are restored after switching sessions', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage:
            '429 Your account org-930ebedfe4d54cf998034940e3c937c1<ak-fch4ix7rq6wi11c3z111> request reached organization max RPM: 3'
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')
  await app.invoke('sessions:switch', 'other')
  const restored = (await app.invoke('sessions:switch', 'fresh.jsonl')) as { messages: unknown[] }

  assert.match(JSON.stringify(restored.messages), /run_failed/)
  assert.match(JSON.stringify(restored.messages), /request reached organization max RPM/)
  assert.doesNotMatch(JSON.stringify(restored.messages), /org-930/)
  assert.doesNotMatch(JSON.stringify(restored.messages), /ak-fch/)
})

for (const errorMessage of [
  'Cursor stream ended before turnEnded',
  'stream closed before a terminal response event: Cursor stream ended before turnEnded'
]) {
  test(`main IPC: recovered Cursor stream interruption does not fail the run: ${errorMessage}`, async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.toolEvents = [
        {
          type: 'message_end',
          message: { role: 'assistant', api: 'cursor-agent', stopReason: 'error', errorMessage }
        },
        {
          type: 'message_end',
          message: {
            role: 'assistant',
            api: 'cursor-agent',
            stopReason: 'stop',
            content: [{ type: 'text', text: 'Recovered answer.' }]
          }
        }
      ]
      return session
    })

    await app.invoke('agent:prompt', 'hello')

    assert.equal(
      app.appendedSessionEvents.some((entry) => entry.event.type === 'run_failed'),
      false
    )
    assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'assistant_message_finalized')
    assert.equal(app.appendedSessionEvents.at(-1)?.event.content, 'Recovered answer.')
  })
}

for (const outcome of [
  { api: 'cursor-agent', stopReason: 'aborted' },
  { api: 'cursor-agent', stopReason: 'length' },
  { api: 'openai-completions', stopReason: 'stop' }
]) {
  test(`main IPC: an unsuccessful or other-provider answer cannot clear Cursor failure: ${JSON.stringify(outcome)}`, async () => {
    const errorMessage = 'Cursor stream ended before turnEnded'
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.toolEvents = [
        {
          type: 'message_end',
          message: { role: 'assistant', api: 'cursor-agent', stopReason: 'error', errorMessage }
        },
        { type: 'message_end', message: { role: 'assistant', ...outcome, content: [] } }
      ]
      return session
    })

    await app.invoke('agent:prompt', 'hello')

    assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'run_failed')
    assert.equal(app.appendedSessionEvents.at(-1)?.event.errorMessage, errorMessage)
  })
}

test('main IPC: Cursor recovery retains an unrelated failure earlier in the run', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          api: 'cursor-agent',
          stopReason: 'error',
          errorMessage: '401 unauthorized'
        }
      },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          api: 'cursor-agent',
          stopReason: 'error',
          errorMessage: 'Cursor stream ended before turnEnded'
        }
      },
      {
        type: 'message_end',
        message: { role: 'assistant', api: 'cursor-agent', stopReason: 'stop', content: [] }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'run_failed')
  assert.equal(app.appendedSessionEvents.at(-1)?.event.errorMessage, '401 unauthorized')
})

test('main IPC: Cursor recovery cannot clear a permanent provider stop', async () => {
  const errorMessage = 'This model provider is not supported in your region.'
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      { type: 'auto_retry_start', attempt: 1, maxAttempts: 5, delayMs: 30_000, errorMessage },
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          api: 'cursor-agent',
          stopReason: 'error',
          errorMessage: 'Cursor stream ended before turnEnded'
        }
      },
      {
        type: 'message_end',
        message: { role: 'assistant', api: 'cursor-agent', stopReason: 'stop', content: [] }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')

  assert.ok(app.sessions[0].log.includes('abort'))
  assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'run_failed')
  assert.equal(app.appendedSessionEvents.at(-1)?.event.errorMessage, errorMessage)
})

test('main IPC: unsupported provider region stops automatic retry and fails the run', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    session.skipFinalAssistantMessage = true
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage: 'This model provider is not supported in your region.'
        }
      },
      {
        type: 'auto_retry_start',
        attempt: 1,
        maxAttempts: 5,
        delayMs: 30_000,
        errorMessage: 'This model provider is not supported in your region.'
      }
    ]
    const abort = session.abort.bind(session)
    session.abort = async () => {
      for (const listener of session.listeners) {
        listener({
          type: 'message_end',
          message: { role: 'assistant', stopReason: 'error', errorMessage: 'Request was aborted' }
        })
      }
      await abort()
    }
    return session
  })

  const prompt = app.invoke('agent:prompt', '测试连接')
  const settled = await Promise.race([
    prompt.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))
  ])
  if (!settled) app.sessions[0].finish.resolve()
  await prompt

  assert.equal(settled, true, 'a permanent region denial should not wait through retry backoff')
  assert.ok(app.sessions[0].log.includes('abort'))
  assert.equal(app.appendedSessionEvents.at(-1)?.event.type, 'run_failed')
  assert.match(
    String(app.appendedSessionEvents.at(-1)?.event.errorMessage),
    /not supported in your region/
  )
})

test('main IPC: current session restores assistant error message ends after renderer refresh', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'message_end',
        message: {
          role: 'assistant',
          stopReason: 'error',
          errorMessage:
            '404 Not found the model kimi-k2.5 or Permission denied (type=resource_not_found_error)'
        }
      }
    ]
    return session
  })

  await app.invoke('agent:prompt', 'hello')
  const restored = (await app.invoke('sessions:current')) as { messages?: unknown[] }

  assert.ok(Array.isArray(restored.messages))
  assert.match(JSON.stringify(restored.messages), /run_failed/)
  assert.match(JSON.stringify(restored.messages), /kimi-k2\.5/)
  assert.match(JSON.stringify(restored.messages), /resource_not_found_error/)
})

test(
  'main IPC: current session model selection overrides project defaults',
  { timeout: 3000 },
  async () => {
    const app = await harness()
    await app.invoke('projects:newSession', '/projects/defaults', 'ask')
    await app.invoke('models:select', 'openai', 'gpt-session')
    await app.invoke('thinking:select', 'high')
    await app.invoke('agent:prompt', 'hello')

    assert.deepEqual(app.createdPhiSessions[0].model, {
      providerId: 'anthropic',
      modelId: 'claude-test'
    })
    assert.equal(app.createdPhiSessions[0].thinkingLevel, 'medium')
    assert.deepEqual(
      app.updatedSessionManifests.filter((entry) => 'model' in entry.patch),
      [
        {
          sessionId: 'phi-1',
          patch: { model: { providerId: 'openai', modelId: 'gpt-session' } }
        }
      ]
    )
    assert.deepEqual(
      app.updatedSessionManifests.filter((entry) => 'thinkingLevel' in entry.patch),
      [{ sessionId: 'phi-1', patch: { thinkingLevel: 'high' } }]
    )
    assert.deepEqual(app.createdAgentOptions[0].model, {
      provider: 'openai',
      id: 'gpt-session',
      name: 'gpt-session',
      reasoning: true
    })
  }
)

test('main IPC: model list hides retired Kimi Code K2 entries', async () => {
  const app = await harness()
  const models = (await app.invoke('models:list')) as Array<{ providerId: string; modelId: string }>

  assert.equal(
    models.some((model) => model.providerId === 'kimi-code' && model.modelId === 'kimi-k2.5'),
    false
  )
  assert.equal(
    models.some((model) => model.providerId === 'kimi-code' && model.modelId === 'kimi-for-coding'),
    true
  )
})

test('main IPC: saved retired Kimi Code model selection migrates before prompting', async () => {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/kimi-retired', 'ask')
  await app.invoke('agent:prompt', 'hello')

  assert.deepEqual(app.createdPhiSessions[0].model, {
    providerId: 'kimi-code',
    modelId: 'kimi-k2.5'
  })
  assert.deepEqual(app.updatedSessionManifests[0], {
    sessionId: 'phi-1',
    patch: {
      model: {
        providerId: 'kimi-code',
        modelId: 'kimi-for-coding'
      }
    }
  })
  assert.deepEqual(app.createdAgentOptions[0].model, {
    provider: 'kimi-code',
    id: 'kimi-for-coding',
    name: 'kimi-for-coding',
    reasoning: true
  })
  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'model_selection_migrated'
    ),
    true
  )
})

test(
  'main IPC: starting another session in the same project emits one parallel warning',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.hold = true
      return session
    })

    await app.invoke('projects:newSession', '/projects/parallel', 'ask')
    const first = app.invoke('agent:prompt', 'first')
    await tick()

    await app.invoke('projects:newSession', '/projects/parallel', 'ask')
    const second = app.invoke('agent:prompt', 'second')
    await tick()

    const warnings = app.events.filter(
      (event) =>
        event.channel === 'agent:event' &&
        (event.data as { type?: string }).type === 'project_parallel_warning'
    )
    assert.equal(warnings.length, 1)
    assert.deepEqual(warnings[0].data, {
      type: 'project_parallel_warning',
      sessionGeneration: 0,
      sessionPath: 'phi-session:phi-2',
      cwd: '/projects/parallel',
      activeCount: 1
    })

    app.sessions.forEach((session) => session.finish.resolve())
    await Promise.all([first, second])
  }
)

test(
  'main IPC: project defaults update validates model availability',
  {
    timeout: 3000
  },
  async () => {
    const app = await harness()

    const project = await app.invoke('projects:updateDefaults', 'project-1', {
      defaultModel: { providerId: 'openai', modelId: 'gpt-project' },
      defaultThinkingLevel: 'high'
    })
    assert.deepEqual((project as { defaultModel: unknown }).defaultModel, {
      providerId: 'openai',
      modelId: 'gpt-project'
    })
    assert.deepEqual(app.updatedProjectDefaults, [
      {
        id: 'project-1',
        defaults: {
          defaultModel: { providerId: 'openai', modelId: 'gpt-project' },
          defaultThinkingLevel: 'high'
        }
      }
    ])

    await assert.rejects(
      app.invoke('projects:updateDefaults', 'project-1', {
        defaultModel: { providerId: 'missing', modelId: 'gone' }
      }),
      /模型不可用: missing\/gone/
    )
  }
)

test(
  'main IPC: same-tick conversation switches leave the latest selection current',
  { timeout: 3000 },
  async () => {
    const app = await harness()
    const first = app.invoke('sessions:switch', 'A')
    const second = app.invoke('sessions:switch', 'B')
    const [firstResult, secondResult] = await Promise.all([first, second])
    assert.equal((firstResult as { path: string }).path, 'A')
    assert.equal((secondResult as { path: string }).path, 'B')
    assert.equal(((await app.invoke('sessions:current')) as { path: string }).path, 'B')
  }
)

test('main IPC: direct conversation switch returns state without sidebar rebroadcasts', async () => {
  const app = await harness()
  const initialChangedEvents = app.events.filter(
    (event) => event.channel === 'sessions:changed'
  ).length

  const result = (await app.invoke('sessions:switch', 'A')) as { path: string; cwd: string }
  const changedEvents = app.events.filter((event) => event.channel === 'sessions:changed').length

  assert.equal(result.path, 'A')
  assert.equal(result.cwd, '/projects/A')
  assert.equal(changedEvents, initialChangedEvents)
  assert.deepEqual(app.acknowledgedSessions.at(-1), { file: 'A', cwd: '/projects/A' })
})

test(
  'main IPC: a new prompt after stop can run and persist normally',
  { timeout: 3000 },
  async () => {
    const session = new FakeSession('fresh.jsonl')
    session.hold = true
    const app = await harness(async () => session)
    const first = app.invoke('agent:prompt', 'first')
    await tick()
    await app.invoke('agent:stop')
    await first
    session.hold = false
    const next = await app.invoke('agent:prompt', 'next')
    assert.equal((next as { path: string }).path, 'phi-session:phi-1')
  }
)

test('main IPC: a session rejects a second prompt while running', { timeout: 3000 }, async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const first = app.invoke('agent:prompt', 'first')
  await tick()
  await assert.rejects(app.invoke('agent:prompt', 'second'), /会话正在运行/)
  await app.invoke('agent:stop')
  await first
})

test(
  'main IPC: model and thinking selection during a run apply to the next prompt only',
  {
    timeout: 3000
  },
  async () => {
    const session = new FakeSession('fresh.jsonl')
    session.hold = true
    const app = await harness(async () => session)
    const prompt = app.invoke('agent:prompt', 'first')
    await tick()

    await app.invoke('models:select', 'openai', 'gpt-test')
    await app.invoke('thinking:select', 'medium')

    assert.equal(session.model?.id, undefined)
    assert.equal(session.thinkingLevel, 'high')
    assert.deepEqual(await app.invoke('models:selected'), {
      providerId: 'openai',
      modelId: 'gpt-test'
    })
    assert.equal(await app.invoke('thinking:selected'), 'medium')

    await app.invoke('agent:stop')
    await prompt
    session.hold = false
    await app.invoke('agent:prompt', 'second')

    assert.equal(session.model?.id, 'gpt-test')
    assert.equal(session.thinkingLevel, 'medium')
  }
)

test(
  'main IPC: permission mode changes during a run are saved without cancelling it',
  {
    timeout: 3000
  },
  async () => {
    const session = new FakeSession('fresh.jsonl')
    session.hold = true
    const app = await harness(async () => session)
    const prompt = app.invoke('agent:prompt', 'first')
    await tick()

    const current = (await updatePermissionMode(app, 'full')) as {
      permissionMode: string
    }

    assert.equal(current.permissionMode, 'full')
    assert.equal(session.disposed, false)
    assert.equal(session.log.includes('abort'), false)

    await app.invoke('agent:stop')
    await prompt
  }
)

test(
  'main IPC: active prompt limit rejects new runs without queueing',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.hold = true
      return session
    })
    const prompts: Array<Promise<unknown>> = []
    for (const file of ['A', 'B', 'C', 'D']) {
      await app.invoke('sessions:switch', file)
      prompts.push(app.invoke('agent:prompt', file))
      await tick()
    }

    await app.invoke('sessions:switch', 'E')
    await assert.rejects(app.invoke('agent:prompt', 'blocked'), /运行中的会话已达上限/)

    for (const session of app.sessions) {
      session.finish.resolve()
    }
    await Promise.all(prompts)
  }
)

test(
  'main IPC: project approval callbacks are tied to the active Phi session run',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      session.hold = true
      return session
    })
    await app.invoke('projects:newSession', '/projects/research', 'ask')
    const prompt = app.invoke('agent:prompt', 'needs shell')
    await tick()

    assert.equal(app.approvalOptions.length, 1)
    const options = app.approvalOptions[0] as {
      getContext: () => {
        sessionId: string
        sessionPath?: string
        runId: string
        cwd: string
        projectName?: string
      }
      onApprovalRequested: (request: {
        requestId: string
        sessionId: string
        toolName: string
        summary: string
      }) => void
      onApprovalResolved: (
        request: { requestId: string; sessionId: string },
        approved: boolean
      ) => void
      onApprovalCancelled: (request: { requestId: string; sessionId: string }) => void
    }
    const context = options.getContext()
    assert.deepEqual(
      {
        sessionId: context.sessionId,
        sessionPath: context.sessionPath,
        cwd: context.cwd,
        projectName: context.projectName
      },
      {
        sessionId: 'phi-1',
        sessionPath: 'phi-session:phi-1',
        cwd: '/projects/research',
        projectName: 'Project /projects/research'
      }
    )
    assert.match(context.runId, /^run-/)

    options.onApprovalRequested({
      requestId: 'approval-1',
      sessionId: context.sessionId,
      toolName: 'bash',
      summary: 'npm test'
    })
    options.onApprovalResolved({ requestId: 'approval-1', sessionId: context.sessionId }, false)
    options.onApprovalCancelled({ requestId: 'approval-2', sessionId: context.sessionId })

    assert.deepEqual(app.runnerEvents, [
      {
        type: 'approval_requested',
        sessionId: 'phi-1',
        approvalId: 'approval-1',
        metadata: { toolName: 'bash', summary: 'npm test' }
      },
      { type: 'approval_denied', sessionId: 'phi-1', approvalId: 'approval-1' },
      { type: 'approval_cancelled', sessionId: 'phi-1', approvalId: 'approval-2' }
    ])

    app.sessions[0].finish.resolve()
    await prompt
  }
)

test('main IPC: fullscreen state is available only to the trusted main renderer', async () => {
  const app = await harness()

  assert.equal(await app.invoke('window:get-fullscreen'), false)
  await assert.rejects(
    app.invokeFromForeign('window:get-fullscreen'),
    /Window renderer is not authorized/
  )
})

test('main startup creates the standalone splash before the main window', async () => {
  const app = await harness()
  const splashIndex = app.operationLog.findIndex((entry) => entry.type === 'splash.create')
  const mainWindowIndex = app.operationLog.findIndex(
    (entry) => entry.type === 'window.create' && entry.width === 1280
  )

  assert.ok(splashIndex >= 0)
  assert.ok(mainWindowIndex > splashIndex)
  assert.ok(app.operationLog.some((entry) => entry.type === 'splash.dismiss'))
})

test('main IPC: the splash stays up until the themed main window is ready', async () => {
  const app = await harness(undefined, { holdRendererReady: true })
  assert.equal(app.operationLog.find((entry) => entry.type === 'window.create')?.show, false)
  assert.equal(
    app.operationLog.some((entry) => entry.type === 'window.show'),
    false
  )
  await assert.rejects(
    app.invokeFromForeign('window:renderer-ready', '#0D1218'),
    /Window renderer is not authorized/
  )
  await app.invoke('window:renderer-ready', '#0D1218')
  assert.deepEqual(
    app.operationLog.filter((entry) =>
      ['window.background', 'window.show'].includes(String(entry.type))
    ),
    [{ type: 'window.background', background: '#0D1218' }, { type: 'window.show' }]
  )
  await app.invoke('window:renderer-ready', '#FFFFFF')
  assert.equal(app.operationLog.filter((entry) => entry.type === 'window.show').length, 1)
  app.closeMainWindow()
})

test('main IPC: an unfinished environment scan cannot hold up the themed window reveal', async () => {
  let finishScan!: (value: unknown) => void
  const scan = new Promise<unknown>((resolve) => {
    finishScan = resolve
  })
  const app = await harness(undefined, {
    holdRendererReady: true,
    environmentGet: () => scan
  })
  let environmentReturned = false
  const pending = app.invoke('environment:get').then((value) => {
    environmentReturned = true
    return value
  })
  await tick()
  assert.equal(environmentReturned, false)
  await app.invoke('window:renderer-ready', '#0D1218')
  assert.equal(app.operationLog.filter((entry) => entry.type === 'window.show').length, 1)
  assert.equal(await app.invoke('window:get-fullscreen'), false)
  assert.equal(environmentReturned, false)
  const detected = { snapshot: { firstScanCompleted: true }, showSummary: true }
  finishScan(detected)
  assert.deepEqual(await pending, detected)

  await app.invoke('environment:setToolPath', 'nextflow', '/fixture/nextflow')
  assert.ok(
    app.operationLog.some(
      (entry) =>
        entry.type === 'environment.background.setToolPath' && entry.path === '/fixture/nextflow'
    )
  )
  app.beforeQuit()
  await tick()
  assert.ok(app.operationLog.some((entry) => entry.type === 'environment.background.dispose'))
  app.closeMainWindow()
})

test('main IPC: closing the window stops all active prompt runs', { timeout: 3000 }, async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.hold = true
    return session
  })

  await app.invoke('sessions:switch', 'A')
  const first = app.invoke('agent:prompt', 'first')
  await tick()
  await app.invoke('sessions:switch', 'B')
  const second = app.invoke('agent:prompt', 'second')
  await tick()

  await app.invoke('window:close')
  await Promise.all([first, second])

  assert.equal(
    app.runnerEvents.some((event) => event.type === 'stop_all'),
    true
  )
  assert.deepEqual(
    app.sessions.map((session) => session.log.includes('abort')),
    [true, true]
  )
})

test(
  'main IPC: returning to a background conversation reuses its live session',
  { timeout: 3000 },
  async () => {
    let aCreated = 0
    const app = await harness(async (_cwd, file) => {
      const session = new FakeSession(file)
      if (file === 'A') aCreated += 1
      return session
    })
    await app.invoke('sessions:switch', 'A')
    await app.invoke('sessions:switch', 'B')
    assert.equal(aCreated, 1)
    const back = app.invoke('sessions:switch', 'A')
    assert.equal(((await back) as { path: string }).path, 'A')
    assert.equal(aCreated, 1)
  }
)

test(
  'main IPC: switching back to a running project session returns active status',
  { timeout: 3000 },
  async () => {
    const app = await harness(async (cwd, file) => {
      const session = new FakeSession(file)
      if (cwd === '/projects/research') {
        session.hold = true
      }
      return session
    })

    await app.invoke('projects:newSession', '/projects/research', 'ask')
    const prompt = app.invoke('agent:prompt', 'long running')
    await tick()

    const current = (await app.invoke('sessions:current')) as {
      path: string | null
      status: string
      currentRunId?: string
      currentRunStartedAt?: string
    }
    assert.equal(current.path, 'phi-session:phi-1')
    assert.equal(current.status, 'running')
    assert.match(current.currentRunId ?? '', /^run-/)
    assert.equal(current.currentRunStartedAt, '2026-09-05T00:00:00.000Z')

    await app.invoke('sessions:switch', 'other')
    const restored = (await app.invoke('sessions:switch', 'phi-session:phi-1')) as {
      cwd: string
      status: string
      currentRunId?: string
    }
    assert.equal(restored.cwd, '/projects/research')
    assert.equal(restored.status, 'running')
    assert.match(restored.currentRunId ?? '', /^run-/)

    app.sessions[0].finish.resolve()
    await prompt
  }
)

test('main IPC exports only after the user chooses a destination folder', async () => {
  const app = await harness()
  await app.invoke('agent:prompt', 'private prompt')

  await assert.rejects(app.invoke('sessions:export', 'missing'), /会话不存在/)

  assert.equal(await app.invoke('sessions:export', 'phi-1'), null)
  assert.deepEqual(app.exportedSessions, [])

  app.setOpenDialogResult({ canceled: false, filePaths: ['/chosen/export-parent'] })
  const result = (await app.invoke('sessions:export', 'phi-1')) as { path: string }
  assert.equal(result.path, '/chosen/export-parent/phi-session-phi-1')
  assert.deepEqual(app.exportedSessions, [
    { sessionId: 'phi-1', destination: '/chosen/export-parent' }
  ])
  assert.equal(
    app.appLogs.some((entry) => JSON.stringify(entry).includes('private prompt')),
    false
  )
})

test('main IPC rejects export while its conversation is running', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const run = app.invoke('agent:prompt', 'still running')
  await tick()
  await assert.rejects(app.invoke('sessions:export', 'phi-1'), /运行结束/)
  assert.deepEqual(app.exportedSessions, [])
  await app.invoke('agent:stop')
  await run
})

test('main host records final file delivery only for an active conversation', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const prompt = app.invoke('agent:prompt', 'create report')
  await tick()
  const present = app.hostHandlers.get('deliverables.present')
  assert.ok(present)
  const files = [{ path: '/workspace/report.pdf', displayPath: 'report.pdf', bytes: 123 }]
  const result = await present({
    runtimeSessionId: session.runtimeSessionId,
    toolCallId: 'present-1',
    files
  })
  assert.deepEqual(result, { files })
  const saved = app.appendedSessionEvents.find(
    (entry) => (entry.event as { type?: string }).type === 'files_presented'
  )
  assert.ok(saved)
  assert.equal(saved.event.type, 'files_presented')
  assert.match(String(saved.event.runId), /^run-/)
  assert.equal(saved.event.toolCallId, 'present-1')
  assert.deepEqual(saved.event.files, files)
  assert.equal(
    app.events.some(
      (entry) =>
        entry.channel === 'agent:event' &&
        (entry.data as { type?: string }).type === 'files_presented'
    ),
    true
  )
  await assert.rejects(
    async () => present({ runtimeSessionId: 'unknown', toolCallId: 'present-2', files }),
    /No active conversation/
  )
  await app.invoke('agent:stop')
  await prompt
})

test('main host validates remote delivery on the server without local anchor fallback', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const prompt = app.invoke('agent:prompt', 'create remote report')
  await tick()
  const present = app.hostHandlers.get('deliverables.present')
  assert.ok(present)
  const result = await present({
    runtimeSessionId: session.runtimeSessionId,
    toolCallId: 'remote-present-1',
    files: [{ path: 'report.pdf' }]
  })
  assert.deepEqual(result, {
    files: [
      {
        path: 'ssh://cluster-one/canonical/project/report.pdf',
        displayPath: 'report.pdf',
        bytes: 123
      }
    ]
  })
  await app.invoke('agent:stop')
  await prompt
})

test('main host splits presented file batches into events of at most 4', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const prompt = app.invoke('agent:prompt', 'create report')
  await tick()
  const present = app.hostHandlers.get('deliverables.present')
  assert.ok(present)
  const files = Array.from({ length: 5 }, (_, index) => ({
    path: `/workspace/report-${index}.txt`,
    displayPath: `report-${index}.txt`,
    bytes: index + 1
  }))
  const result = await present({
    runtimeSessionId: session.runtimeSessionId,
    toolCallId: 'present-batch',
    files
  })
  assert.deepEqual(result, { files })
  const batches = app.appendedSessionEvents
    .filter((entry) => (entry.event as { toolCallId?: string }).toolCallId === 'present-batch')
    .map((entry) => (entry.event as { files: Array<{ displayPath: string }> }).files)
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [4, 1]
  )
  assert.equal(batches[0]?.[0]?.displayPath, 'report-0.txt')
  assert.equal(batches[0]?.[3]?.displayPath, 'report-3.txt')
  assert.equal(batches[1]?.[0]?.displayPath, 'report-4.txt')
  assert.equal(
    app.events.filter(
      (entry) =>
        entry.channel === 'agent:event' &&
        (entry.data as { type?: string; toolCallId?: string }).type === 'files_presented' &&
        (entry.data as { toolCallId?: string }).toolCallId === 'present-batch'
    ).length,
    2
  )
  await app.invoke('agent:stop')
  await prompt
})

test('main plan review pauses the run and records approval in its conversation', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const current = (await app.invoke('sessions:current')) as Record<string, unknown>
  const prompt = app.invoke('agent:prompt', 'Analyze then write a report', {
    ...current,
    planMode: true
  })
  await tick()
  assert.equal(
    app.bridgeRequests.some((request) => request.method === 'session.plan.enter'),
    true
  )

  app.setAgentInteractionResponse({
    answers: [{ questionIndex: 0, question: 'plan_review', kind: 'option', answer: 'approve' }]
  })
  const review = app.hostHandlers.get('planReview.request')
  assert.ok(review)
  const result = await review({
    runtimeSessionId: session.runtimeSessionId,
    title: 'analysis-plan',
    planContent: '# Analysis plan\n\n1. Inspect data\n2. Write report',
    planFilePath: 'local://analysis-plan.md'
  })
  assert.deepEqual(result, { decision: 'approve' })
  const planEvents = app.appendedSessionEvents
    .filter((entry) => String(entry.event.type).startsWith('plan_review_'))
    .map((entry) => entry.event)
  assert.deepEqual(
    planEvents.map((event) => event.type),
    ['plan_review_submitted', 'plan_review_decided']
  )
  assert.equal(planEvents[1].decision, 'approve')
  assert.equal(planEvents[0].reviewId, planEvents[1].reviewId)
  assert.equal(
    app.runnerEvents.some((event) => event.type === 'input_requested'),
    true
  )
  assert.equal(
    app.events.some(
      (event) =>
        event.channel === 'agent:event' &&
        (event.data as { type?: string }).type === 'plan_review_decided'
    ),
    true
  )
  await assert.rejects(
    async () =>
      review({
        runtimeSessionId: 'unknown',
        title: 'plan',
        planContent: '# Plan',
        planFilePath: 'local://plan.md'
      }),
    /No active conversation/
  )
  await assert.rejects(
    async () =>
      review({
        runtimeSessionId: session.runtimeSessionId,
        title: 'too-large',
        planContent: 'x'.repeat(65 * 1024),
        planFilePath: 'local://too-large.md'
      }),
    /Invalid plan review request/
  )
  await app.invoke('agent:stop')
  await prompt
})

test('main plan review refuses remote project sessions before starting a run', async () => {
  const app = await harness()
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as Record<
    string,
    unknown
  >
  await assert.rejects(
    app.invoke('agent:prompt', 'Analyze this server project', { ...current, planMode: true }),
    /远程项目暂不支持计划评审/
  )
  assert.equal(
    app.bridgeRequests.some((request) => request.method === 'session.plan.enter'),
    false
  )
  assert.equal(
    app.appendedSessionEvents.some((entry) => entry.event.type === 'user_message'),
    false
  )
})

test('main plan review preserves requested revisions in the session timeline', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const prompt = app.invoke('agent:prompt', 'Draft a plan')
  await tick()
  app.setAgentInteractionResponse({
    answers: [{ questionIndex: 0, question: 'plan_review', kind: 'option', answer: 'revise' }],
    globalNote: 'Add a validation step'
  })
  const review = app.hostHandlers.get('planReview.request')
  assert.ok(review)
  assert.deepEqual(
    await review({
      runtimeSessionId: session.runtimeSessionId,
      title: 'analysis-plan',
      planContent: '# Analysis plan',
      planFilePath: 'local://analysis-plan.md'
    }),
    { decision: 'revise', note: 'Add a validation step' }
  )
  const decided = app.appendedSessionEvents.find(
    (entry) => entry.event.type === 'plan_review_decided'
  )
  assert.equal(decided?.event.decision, 'revise')
  assert.equal(decided?.event.note, 'Add a validation step')
  await app.invoke('agent:stop')
  await prompt
})

test('main jobs list maps live Agent runs to their owning Phi conversations', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const prompt = app.invoke('agent:prompt', 'Analyze samples')
  await tick()
  app.setBridgeAgentJobs([
    {
      agentSessionId: session.runtimeSessionId,
      agentRunId: 'agent-run-1',
      agentName: 'Wrapper',
      task: 'Run quality control',
      state: 'running',
      background: true,
      startedAt: Date.now(),
      lastStep: 'wrapper_run',
      report: 'private full report must not reach the job list'
    },
    {
      agentSessionId: 'unknown',
      agentRunId: 'agent-run-2',
      agentName: 'Unknown',
      task: 'Not owned by Phi',
      state: 'running',
      startedAt: Date.now()
    }
  ])
  const jobs = (await app.invoke('jobs:listAgents')) as Array<Record<string, unknown>>
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].agentRunId, 'agent-run-1')
  assert.equal(jobs[0].sessionPath, 'phi-session:phi-1')
  assert.equal(jobs[0].sessionTitle, 'Analyze samples')
  assert.equal(jobs[0].lastStep, 'wrapper_run')
  assert.equal('report' in jobs[0], false)
  await app.invoke('agent:stop')
  await prompt
})

test(
  'main IPC: deleting an idle active conversation removes its history',
  { timeout: 3000 },
  async () => {
    const old = new FakeSession('A')
    const app = await harness(async () => old)
    await app.invoke('sessions:switch', 'A')
    await app.invoke('sessions:delete', 'A')
    assert.deepEqual(app.deleted, ['A'])
  }
)

test(
  'main IPC: stopping immediately also cancels a prompt still queued for creation',
  { timeout: 3000 },
  async () => {
    const app = await harness()
    const prompt = app.invoke('agent:prompt', 'queued')
    await app.invoke('agent:stop')
    await prompt
    assert.equal(
      app.sessions.some((session) => session.started),
      false
    )
  }
)

test('main IPC: a background wrapper run that ends is reported in the conversation that started it', async () => {
  const app = await harness()
  await app.invoke('projects:newSession', '/projects/wrapper-notice', 'ask')
  await app.invoke('agent:prompt', 'run fastqc')
  const runtimeSessionId = (app.sessions[0] as unknown as { runtimeSessionId: string })
    .runtimeSessionId
  assert.equal(app.wrapperJobFinishListeners.length, 1)

  const before = app.events.length
  app.wrapperJobFinishListeners[0](
    {
      runId: 'wrun_1',
      state: 'completed',
      exitCode: 0,
      outDir: '/data/qc',
      originSessionId: runtimeSessionId,
      wrapper: { canonicalId: 'nf-core/modules/fastqc' }
    },
    { elapsedSeconds: 42, missingOutputs: [] }
  )

  const persisted = app.appendedSessionEvents.filter(
    (entry) => (entry.event as { type?: string }).type === 'wrapper_run_finished'
  )
  assert.equal(persisted.length, 1)
  const event = persisted[0].event as { wrapperRunId: string; state: string; outDir: string }
  assert.equal(event.wrapperRunId, 'wrun_1')
  assert.equal(event.state, 'completed')
  assert.equal(event.outDir, '/data/qc')

  const pushed = app.events
    .slice(before)
    .filter((entry) => (entry.data as { type?: string }).type === 'wrapper_run_finished')
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].channel, 'agent:event')
  const payload = pushed[0].data as { phiSessionId?: string; sessionPath?: string; cwd?: string }
  assert.equal(payload.phiSessionId, persisted[0].sessionId)
  assert.match(payload.sessionPath ?? '', new RegExp(String(persisted[0].sessionId)))
  assert.equal(payload.cwd, '/projects/wrapper-notice')

  // The (fake) window is focused, so no system notification on top of the in-chat one.
  assert.deepEqual(app.osNotifications, [])
})

test('main IPC: a run that ends while Phi is in the background raises a system notification', async () => {
  const app = await harness(undefined, { uiLanguage: 'zh-CN' })
  await app.invoke('projects:newSession', '/projects/wrapper-notice', 'ask')
  await app.invoke('agent:prompt', 'hi')
  const runtimeSessionId = (app.sessions[0] as unknown as { runtimeSessionId: string })
    .runtimeSessionId

  app.setAppFocused(false)
  app.wrapperJobFinishListeners[0](
    {
      runId: 'wrun_2',
      state: 'failed',
      exitCode: 1,
      outDir: '/x',
      originSessionId: runtimeSessionId,
      wrapper: { canonicalId: 'a/b/c' }
    },
    { elapsedSeconds: 5 }
  )

  assert.equal(app.osNotifications.length, 1)
  assert.equal(app.osNotifications[0].title, 'Wrapper 运行失败')
  assert.match(app.osNotifications[0].body, /a\/b\/c/)
  assert.match(app.osNotifications[0].body, /wrun_2/)
})

test('main IPC: a run from a session Phi does not know is announced by system notification only', async () => {
  const app = await harness(undefined, { uiLanguage: 'zh-CN' })
  await app.invoke('projects:newSession', '/projects/wrapper-notice', 'ask')
  await app.invoke('agent:prompt', 'hi')

  app.setAppFocused(false)
  app.wrapperJobFinishListeners[0](
    {
      runId: 'wrun_3',
      state: 'completed',
      exitCode: 0,
      outDir: '/x',
      originSessionId: 'runtime-unknown',
      wrapper: { canonicalId: 'a/b/c' }
    },
    { elapsedSeconds: 5 }
  )

  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'wrapper_run_finished'
    ),
    false
  )
  assert.equal(app.osNotifications.length, 1)
  assert.equal(app.osNotifications[0].title, 'Wrapper 运行已完成')
})

// ── automatic continuation after a background wrapper run ─────────────────

const FINISHED_RUN = (
  originSessionId: string,
  overrides: Record<string, unknown> = {}
): unknown => ({
  runId: 'wrun_1',
  state: 'completed',
  exitCode: 0,
  outDir: '/data/qc',
  originSessionId,
  wrapper: { canonicalId: 'nf-core/modules/fastqc' },
  ...overrides
})

async function waitUntil(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function idleConversation(options: HarnessOptions = {}): Promise<{
  app: Awaited<ReturnType<typeof harness>>
  session: FakeSession
}> {
  const app = await harness(undefined, options)
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  await app.invoke('agent:prompt', 'run fastqc on my reads')
  await tick()
  return { app, session: app.sessions[0] as unknown as FakeSession }
}

const WOKEN = /<phi_wrapper_run_finished>/

test('main IPC: a run that ends wakes an idle conversation with a message from Phi', async () => {
  const { app, session } = await idleConversation()
  const userMessagesBefore = app.appendedSessionEvents.filter(
    (e) => (e.event as { type?: string }).type === 'user_message'
  ).length

  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 42 })
  await waitUntil(() => session.promptTexts.length === 2)

  assert.match(session.promptTexts[1], WOKEN)
  assert.match(session.promptTexts[1], /wrun_1/)
  assert.match(session.promptTexts[1], /\/data\/qc/)
  // Not the user's words: no user bubble is recorded for it…
  assert.equal(
    app.appendedSessionEvents.filter((e) => (e.event as { type?: string }).type === 'user_message')
      .length,
    userMessagesBefore
  )
  // …but the run is tracked like any other, and nothing else was opened or switched.
  await waitUntil(() => session.log.filter((entry) => entry === 'saved').length === 2)
  assert.equal(app.sessions.length, 1)
})

test('main IPC: a run that ends while the conversation is busy wakes it once the busy run is over', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work on something')
  await tick()

  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 7 })
  await tick()
  assert.equal(session.promptTexts.length, 1, 'must not interrupt the run in progress')

  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)
  assert.match(session.promptTexts[1], WOKEN)
})

test('main IPC: runs that end while busy are reported together in one wake-up', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 1 })
  app.wrapperJobFinishListeners[0](
    FINISHED_RUN(session.runtimeSessionId, {
      runId: 'wrun_2',
      wrapper: { canonicalId: 'nf-core/modules/fastp' }
    }),
    { elapsedSeconds: 2 }
  )
  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)
  await tick()

  assert.equal(session.promptTexts.length, 2)
  assert.match(session.promptTexts[1], /wrun_1/)
  assert.match(session.promptTexts[1], /wrun_2/)
})

test('main IPC: stopping a run means its pending wake-up is dropped', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 1 })
  await app.invoke('agent:stop')
  await first
  await tick()
  await tick()

  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: a cancelled run, an opted-out run and an unknown conversation do not wake anything', async () => {
  const { app, session } = await idleConversation()
  const fire = (run: unknown): void => app.wrapperJobFinishListeners[0](run, { elapsedSeconds: 1 })

  fire(FINISHED_RUN(session.runtimeSessionId, { state: 'cancelled', exitCode: -1 }))
  fire(FINISHED_RUN(session.runtimeSessionId, { continueWhenDone: false }))
  fire(FINISHED_RUN('runtime-unknown'))
  await tick()
  await tick()

  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: automatic wake-ups are capped, and a real user message starts the count over', async () => {
  const { app, session } = await idleConversation()
  const wake = async (n: number): Promise<void> => {
    app.wrapperJobFinishListeners[0](
      FINISHED_RUN(session.runtimeSessionId, { runId: `wrun_${n}` }),
      { elapsedSeconds: 1 }
    )
    await tick()
    await tick()
  }

  for (let n = 1; n <= MAX_AUTOMATIC_CONTINUATIONS; n += 1) {
    await wake(n)
    await waitUntil(() => session.promptTexts.length === 1 + n)
  }
  await wake(99)
  assert.equal(session.promptTexts.length, 1 + MAX_AUTOMATIC_CONTINUATIONS, 'the cap holds')

  await app.invoke('agent:prompt', 'ok, carry on')
  await tick()
  await wake(100)
  await waitUntil(() => session.promptTexts.length === 2 + MAX_AUTOMATIC_CONTINUATIONS + 1)
  assert.match(session.promptTexts.at(-1) ?? '', /wrun_100/)
})

test('main IPC: a run whose outcome Wrapper already reported inside the same turn does not wake the conversation again', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  const first = app.invoke('agent:prompt', 'run it and wait for the result')
  await tick()

  // The run ends while the turn is still going, and Wrapper's wait hands the outcome to the agent.
  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 3 })
  app.reportedWrapperRuns.add('wrun_1')
  session.finish.resolve()
  await first
  await tick()
  await tick()

  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: only the runs nobody has reported are included in a wake-up', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/wrapper-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 1 })
  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId, { runId: 'wrun_2' }), {
    elapsedSeconds: 1
  })
  app.reportedWrapperRuns.add('wrun_1')
  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)

  assert.doesNotMatch(session.promptTexts[1], /wrun_1/)
  assert.match(session.promptTexts[1], /wrun_2/)
})

// ── automatic continuation after a background agent run ───────────────────

const AGENT_WOKEN = /<phi_agent_run_finished>/

const agentRunFinished = (
  app: Awaited<ReturnType<typeof harness>>,
  runtimeSessionId: string,
  overrides: Record<string, unknown> = {}
): Promise<unknown> => {
  const handler = app.hostHandlers.get('agentRun.finished')
  assert.ok(handler, 'the main process registers agentRun.finished')
  return handler({
    originSessionId: runtimeSessionId,
    run: {
      id: 'run_1',
      agent: 'Wrapper',
      task: 'align the reads',
      state: 'done',
      background: true,
      startedAt: 1_000,
      completedAt: 61_000,
      toolCalls: 4,
      report: 'Aligned. BAMs are in /data/bam.',
      ...overrides
    }
  })
}

test('main IPC: a background agent run that ends is noted in the conversation and wakes it with its report', async () => {
  const { app, session } = await idleConversation()
  const before = app.events.length

  await agentRunFinished(app, session.runtimeSessionId)
  await waitUntil(() => session.promptTexts.length === 2)

  const persisted = app.appendedSessionEvents.filter(
    (entry) => (entry.event as { type?: string }).type === 'agent_run_finished'
  )
  assert.equal(persisted.length, 1)
  assert.equal((persisted[0].event as { agentRunId: string }).agentRunId, 'run_1')
  assert.equal(
    app.events
      .slice(before)
      .filter((entry) => (entry.data as { type?: string }).type === 'agent_run_finished').length,
    1
  )

  assert.match(session.promptTexts[1], AGENT_WOKEN)
  assert.match(session.promptTexts[1], /run_1 · Wrapper · done/)
  assert.match(session.promptTexts[1], /BAMs are in \/data\/bam\./)
  assert.equal(app.sessions.length, 1)
})

test('main IPC: an agent run that ends while the conversation is busy waits for the busy run to finish', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/agent-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work on something')
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  await tick()
  assert.equal(session.promptTexts.length, 1, 'must not interrupt the run in progress')

  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)
  assert.match(session.promptTexts[1], AGENT_WOKEN)
})

test('main IPC: a run the agent already collected with agent_wait does not wake the conversation again', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/agent-continue', 'ask')
  const first = app.invoke('agent:prompt', 'start it and wait for it')
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  await app.hostHandlers.get('agentRun.reported')?.({
    originSessionId: session.runtimeSessionId,
    runId: 'run_1'
  })
  session.finish.resolve()
  await first
  await tick()
  await tick()

  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: a stale receipt for a reused run id does not swallow a later run', async () => {
  const { app, session } = await idleConversation()
  await app.hostHandlers.get('agentRun.reported')?.({
    originSessionId: session.runtimeSessionId,
    runId: 'run_1'
  })
  await agentRunFinished(app, session.runtimeSessionId)
  await waitUntil(() => session.promptTexts.length === 2)
  assert.match(session.promptTexts[1], /run_1/)
})

test('main IPC: only the agent runs nobody collected are in a wake-up', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/agent-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  await agentRunFinished(app, session.runtimeSessionId, { id: 'run_2', report: 'Second report.' })
  await app.hostHandlers.get('agentRun.reported')?.({
    originSessionId: session.runtimeSessionId,
    runId: 'run_1'
  })
  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)

  assert.doesNotMatch(session.promptTexts[1], /run_1/)
  assert.match(session.promptTexts[1], /run_2/)
})

test('main IPC: stopping the busy run drops the pending agent wake-up', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/agent-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  await app.invoke('agent:stop')
  await first
  await tick()
  await tick()

  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: a cancelled agent run is noted but does not wake anything', async () => {
  const { app, session } = await idleConversation()
  await agentRunFinished(app, session.runtimeSessionId, { state: 'cancelled', report: undefined })
  await tick()
  await tick()

  assert.equal(
    app.appendedSessionEvents.filter(
      (entry) => (entry.event as { type?: string }).type === 'agent_run_finished'
    ).length,
    1
  )
  assert.equal(session.promptTexts.length, 1)
})

test('main IPC: agent and wrapper runs share one wake-up cap, and one wake-up can carry both', async () => {
  const session = new FakeSession('fresh.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  await app.invoke('projects:newSession', '/projects/agent-continue', 'ask')
  const first = app.invoke('agent:prompt', 'work')
  await tick()

  await agentRunFinished(app, session.runtimeSessionId)
  app.wrapperJobFinishListeners[0](FINISHED_RUN(session.runtimeSessionId), { elapsedSeconds: 1 })
  session.finish.resolve()
  await first
  await waitUntil(() => session.promptTexts.length === 2)

  assert.match(session.promptTexts[1], AGENT_WOKEN)
  assert.match(session.promptTexts[1], WOKEN)
})

test('main IPC: a run that ends while Phi is in the background raises a system notification too', async () => {
  const { app, session } = await idleConversation({ uiLanguage: 'zh-CN' })
  app.setAppFocused(false)
  await agentRunFinished(app, session.runtimeSessionId)
  assert.equal(app.osNotifications.length, 1)
  assert.equal(app.osNotifications[0].title, 'Wrapper 后台任务已完成')
})

// ── the agent card: run ids, background start, background progress, steer/stop ───

function agentDelegationSession(extraEvents: unknown[]): {
  factory: (cwd: string, file: string) => Promise<FakeSession>
  session: () => FakeSession
} {
  let created: FakeSession | undefined
  return {
    session: () => created as FakeSession,
    factory: async (_cwd, file) => {
      const session = new FakeSession(file)
      session.toolEvents = [
        {
          type: 'tool_execution_start',
          toolCallId: 'call-1',
          toolName: 'Wrapper',
          args: { task: 'align the reads', background: true }
        },
        ...extraEvents
      ]
      created = session
      return session
    }
  }
}

const persistedTypes = (app: Awaited<ReturnType<typeof harness>>): string[] =>
  app.appendedSessionEvents.map((entry) => String((entry.event as { type?: string }).type))

test('main IPC: a foreground agent step tells the card which run and session it belongs to', async () => {
  const delegation = agentDelegationSession([
    {
      type: 'tool_execution_update',
      toolCallId: 'call-1',
      toolName: 'Wrapper',
      partialResult: {
        content: [{ type: 'text', text: 'read /a.nf' }],
        details: {
          kind: 'agent_step',
          agent: 'Wrapper',
          agentRunId: 'run_1',
          step: { id: 's1', toolName: 'read', status: 'running', args: { path: '/a.nf' } }
        }
      }
    }
  ])
  const app = await harness(delegation.factory)
  await app.invoke('agent:prompt', 'go')

  const step = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .find((event) => event.type === 'agent_execution_step')
  assert.ok(step)
  assert.equal(step.agentRunId, 'run_1')
  assert.equal(step.agentSessionId, delegation.session().runtimeSessionId)
})

test('main IPC: starting an agent in the background leaves its card running instead of completing it', async () => {
  const delegation = agentDelegationSession([
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'Wrapper',
      result: {
        content: [
          { type: 'text', text: 'Started the Wrapper agent in the background as run run_1.' }
        ],
        details: { kind: 'agent_started', agent: 'Wrapper', runId: 'run_1' }
      },
      isError: false
    }
  ])
  const app = await harness(delegation.factory)
  await app.invoke('agent:prompt', 'go')

  assert.ok(!persistedTypes(app).includes('agent_execution_completed'))
  const marker = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .find((event) => event.type === 'agent_execution_background')
  assert.ok(marker)
  assert.equal(marker.toolCallId, 'call-1')
  assert.equal(marker.agentName, 'Wrapper')
  assert.equal(marker.agentRunId, 'run_1')
  assert.equal(marker.agentSessionId, delegation.session().runtimeSessionId)
  assert.ok(
    app.events.some(
      (event) => (event.data as { type?: string }).type === 'agent_execution_background'
    ),
    'the window hears about it'
  )
})

test('main IPC: a foreground agent still completes its card as before', async () => {
  const delegation = agentDelegationSession([
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'Wrapper',
      result: {
        content: [{ type: 'text', text: 'All done.' }],
        details: { kind: 'agent_result', agent: 'Wrapper', toolCalls: 2 }
      },
      isError: false
    }
  ])
  const app = await harness(delegation.factory)
  await app.invoke('agent:prompt', 'go')
  assert.ok(persistedTypes(app).includes('agent_execution_completed'))
  assert.ok(!persistedTypes(app).includes('agent_execution_background'))
})

test('main IPC: a background run’s steps and end reach its card after the turn is over', async () => {
  const delegation = agentDelegationSession([
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'Wrapper',
      result: {
        content: [{ type: 'text', text: 'Started.' }],
        details: { kind: 'agent_started', agent: 'Wrapper', runId: 'run_1' }
      },
      isError: false
    }
  ])
  const app = await harness(delegation.factory)
  await app.invoke('projects:newSession', '/projects/agent-card', 'ask')
  await app.invoke('agent:prompt', 'go')
  await tick()
  const runtime = delegation.session().runtimeSessionId

  await app.hostHandlers.get('agentRun.step')?.({
    originSessionId: runtime,
    run: { id: 'run_1', agent: 'Wrapper', toolCallId: 'call-1' },
    step: { id: 's1', toolName: 'wrapper_run', status: 'done', output: 'x'.repeat(50) }
  })
  await agentRunFinished(app, runtime, { toolCallId: 'call-1' })
  await tick()

  const events = app.appendedSessionEvents.map((entry) => entry.event as Record<string, unknown>)
  const step = events.find((event) => event.type === 'agent_execution_step' && event.agentRunId)
  assert.ok(step, 'the background step is on the card')
  assert.equal(step.toolCallId, 'call-1')
  assert.ok(
    app.persistedToolOutputs.some(
      (entry) => (entry.input as { output?: string }).output === 'x'.repeat(50)
    )
  )
  const completed = events.find((event) => event.type === 'agent_execution_completed')
  assert.ok(completed, 'the card is completed when the run ends')
  assert.equal(completed.toolCallId, 'call-1')
  assert.equal(completed.finalReport, 'Aligned. BAMs are in /data/bam.')
})

test('main IPC: the card’s steer and stop reach the run in the agent worker', async () => {
  const app = await harness()
  await app.invoke('agent:steerRun', 'runtime-7', 'run_3', '  use the mouse genome  ')
  await app.invoke('agent:stopRun', 'runtime-7', 'run_3')
  assert.deepEqual(app.bridgeRequests, [
    {
      method: 'agentRun.steer',
      params: { sessionId: 'runtime-7', runId: 'run_3', message: 'use the mouse genome' }
    },
    { method: 'agentRun.stop', params: { sessionId: 'runtime-7', runId: 'run_3' } }
  ])
})

test('main IPC: steering and stopping refuse malformed requests without asking the worker', async () => {
  const app = await harness()
  await assert.rejects(app.invoke('agent:steerRun', '', 'run_1', 'hi'))
  await assert.rejects(app.invoke('agent:steerRun', 'runtime-7', '', 'hi'))
  await assert.rejects(app.invoke('agent:steerRun', 'runtime-7', 'run_1', '   '))
  await assert.rejects(app.invoke('agent:steerRun', 'runtime-7', 'run_1', 'x'.repeat(5000)))
  await assert.rejects(app.invoke('agent:stopRun', 'runtime-7', 42))
  assert.deepEqual(app.bridgeRequests, [])
})

test('main IPC: a steering message is recorded on the card once the agent has accepted it', async () => {
  const { app, session } = await idleConversation()
  const before = app.events.length

  await app.invoke(
    'agent:steerRun',
    session.runtimeSessionId,
    'run_3',
    '  use the mouse genome  ',
    'call-1'
  )

  const recorded = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .filter((event) => event.type === 'agent_execution_steered')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].toolCallId, 'call-1')
  assert.equal(recorded[0].agentRunId, 'run_3')
  assert.equal(recorded[0].text, 'use the mouse genome')

  const pushed = app.events
    .slice(before)
    .filter((entry) => (entry.data as { type?: string }).type === 'agent_execution_steered')
  assert.equal(pushed.length, 1)
  assert.equal(pushed[0].channel, 'agent:event')
  assert.match(String((pushed[0].data as { sessionPath?: string }).sessionPath), /phi-/)
})

test('main IPC: a steering message is redacted before it is stored', async () => {
  const { app, session } = await idleConversation()
  await app.invoke(
    'agent:steerRun',
    session.runtimeSessionId,
    'run_3',
    'use key ak-abcdefgh12345 please',
    'call-1'
  )
  const recorded = app.appendedSessionEvents
    .map((entry) => entry.event as Record<string, unknown>)
    .find((event) => event.type === 'agent_execution_steered')
  assert.ok(recorded)
  assert.doesNotMatch(String(recorded.text), /ak-abcdefgh/)
})

test('main IPC: a steering message the agent did not accept is not recorded', async () => {
  const { app, session } = await idleConversation()
  app.failBridgeRequests(new Error('Run run_3 is no longer running.'))
  await assert.rejects(
    app.invoke('agent:steerRun', session.runtimeSessionId, 'run_3', 'hello', 'call-1'),
    /no longer running/
  )
  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'agent_execution_steered'
    ),
    false
  )
})

test('main IPC: steering still works when there is no conversation or card to record it on', async () => {
  const { app, session } = await idleConversation()
  await app.invoke('agent:steerRun', 'runtime-unknown', 'run_3', 'hello', 'call-1')
  await app.invoke('agent:steerRun', session.runtimeSessionId, 'run_3', 'hello')
  assert.equal(app.bridgeRequests.length, 2)
  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'agent_execution_steered'
    ),
    false
  )
})

// ── timing: the SDK's tool events carry no timestamp ─────────────────────

test('main IPC: a delegated agent’s live events are timed even though the SDK’s events carry no time', async () => {
  const delegation = agentDelegationSession([
    {
      type: 'tool_execution_end',
      toolCallId: 'call-1',
      toolName: 'Wrapper',
      result: {
        content: [{ type: 'text', text: 'All done.' }],
        details: { kind: 'agent_result', agent: 'Wrapper', toolCalls: 2 }
      },
      isError: false
    }
  ])
  const app = await harness(delegation.factory)
  await app.invoke('agent:prompt', 'go')

  const live = (type: string): { createdAt?: string } | undefined =>
    app.events
      .map((entry) => entry.data as { type?: string; createdAt?: string })
      .find((data) => data.type === type)
  const started = live('agent_execution_started')
  const completed = live('agent_execution_completed')
  assert.ok(started && completed)
  assert.ok(Number.isFinite(Date.parse(started.createdAt ?? '')), 'the card knows when it started')
  assert.ok(Number.isFinite(Date.parse(completed.createdAt ?? '')), 'and when it ended')
  assert.ok(
    Date.parse(completed.createdAt as string) >= Date.parse(started.createdAt as string),
    'in order'
  )
})

test('main IPC: an event that already carries a time keeps it', async () => {
  const app = await harness(async (_cwd, file) => {
    const session = new FakeSession(file)
    session.toolEvents = [
      {
        type: 'tool_execution_start',
        toolCallId: 'call-1',
        toolName: 'Wrapper',
        args: { task: 'align' },
        createdAt: '2026-09-20T01:02:03.000Z'
      }
    ]
    return session
  })
  await app.invoke('agent:prompt', 'go')
  const started = app.events
    .map((entry) => entry.data as { type?: string; createdAt?: string })
    .find((data) => data.type === 'agent_execution_started')
  assert.equal(started?.createdAt, '2026-09-20T01:02:03.000Z')
})

test('main IPC: opted-in empty-resource remote project reaches RPC-compatible creation', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'controlled RPC path')
  const created = app.createdAgentOptions.at(-1)!
  assert.equal(created.resourceLoader, undefined)
  assert.equal(created.phiAgents, undefined)
  assert.equal(created.personaMarkdown, '')
  assert.deepEqual((created.remoteProject as { contextFiles: unknown[] }).contextFiles, [])
  assert.deepEqual(app.sessions[0].promptTexts, ['controlled RPC path'])
  assert.ok(
    app.operationLog.some(
      (entry) => entry.type === 'installRemoteRouting' && entry.enabled === true
    )
  )
})

test('main IPC: opted-in remote persona and project instructions use existing trusted readers', async () => {
  const app = await harness(undefined, {
    remoteRpc: true,
    remoteRpcResources: true,
    remoteMemorySettings: { enabled: true, learn: true }
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'use trusted session configuration')
  assert.equal(app.createdAgentOptions.length, 1)
  const created = app.createdAgentOptions[0]
  assert.equal(created.personaMarkdown, 'persona')
  assert.deepEqual((created.remoteProject as { contextFiles: unknown[] }).contextFiles, [
    { path: 'ssh://cluster-one/cluster/project/AGENTS.md', content: 'Remote instructions v1' }
  ])
  assert.deepEqual(created.memory, { enabled: true, learn: true })
  assert.equal(created.resourceLoader, undefined)
})

for (const boundary of ['cancel-before', 'cancel', 'rebind'] as const)
  test(
    boundary === 'cancel-before'
      ? 'main host: Notebook cancellation before backend lookup blocks lookup and dispatch'
      : `main host: Notebook ${boundary} after backend lookup blocks dispatch`,
    async () => {
      let binding = 'selected-Notebook-host'
      let backendLookups = 0
      const session = new FakeSession('notebook-lookup-owner.jsonl')
      session.hold = true
      const app = await harness(async () => session, {
        remoteNotebookBinding: () => binding,
        remoteNotebookBackendCreate: () => {
          backendLookups += 1
        }
      })
      const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
        phiSessionId: string
        cwd: string
      }
      const parent = app.invoke('agent:prompt', 'initialize the trusted runtime origin')
      await waitUntil(() => session.started)
      try {
        const runtimeSessionId = session.runtimeSessionId
        const execute = app.hostHandlers.get('notebookTool.execute')!
        const controller = new AbortController()
        if (boundary === 'cancel-before') controller.abort(new Error('Notebook lookup cancelled'))
        const pending = execute(
          {
            action: 'save',
            cwd: current.cwd,
            params: { path: 'notebooks/analysis.ipynb' },
            remoteProject: {
              runtimeSessionId,
              sessionId: current.phiSessionId,
              projectId: 'remote-project-1'
            }
          },
          { originSessionId: runtimeSessionId, signal: controller.signal }
        )
        assert.equal(backendLookups, boundary === 'cancel-before' ? 0 : 1)
        if (boundary === 'cancel') controller.abort(new Error('Notebook lookup cancelled'))
        else if (boundary === 'rebind') binding = 'replacement-Notebook-host'
        await assert.rejects(
          pending,
          boundary === 'rebind' ? /运行或项目绑定已改变/ : /Notebook lookup cancelled/
        )
        assert.equal(
          app.remoteNotebookCalls.some(
            (call) => call.action === 'tool:save' || call.action === 'save'
          ),
          false
        )
        assert.deepEqual(app.jupyterServerCalls, [])
      } finally {
        session.finish.resolve()
        await parent
      }
    }
  )

test('main host: owned remote worker Notebook context remains compatible without a cancellation signal', async () => {
  const app = await harness()
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
    cwd: string
  }
  await app.invoke('agent:prompt', 'initialize legacy remote worker origin')
  const runtimeSessionId = app.sessions[0].runtimeSessionId
  const execute = app.hostHandlers.get('notebookTool.execute')!
  const result = await execute(
    {
      action: 'list',
      cwd: current.cwd,
      params: {},
      remoteProject: {
        runtimeSessionId,
        sessionId: current.phiSessionId,
        projectId: 'remote-project-1'
      }
    },
    { originSessionId: runtimeSessionId }
  )
  assert.deepEqual(result, { summary: 'remote notebook tool ok', cwd: '/canonical/project' })
  assert.equal(
    app.remoteNotebookCalls.some((call) => call.action === 'tool:list'),
    true
  )
  assert.equal(
    app.remoteNotebookCalls.some((call) => call.path?.includes('remote-project-anchors')),
    false
  )
})

test('main Wrapper scope rejects unknown origins and rebinds, while legacy local remains compatible', async () => {
  let binding = 'selected-host'
  const app = await harness(undefined, {
    remoteNotebookBinding: () => binding,
    remoteWrapperTarget: true
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'initialize selected Wrapper origin')
  const scopeFor = app.wrapperJobOptions.hostScopeFor as (
    context?: HostContext
  ) => ReturnType<typeof createWrapperJobHostScope> | undefined
  assert.throws(() => scopeFor({ signal: new AbortController().signal }), /trusted origin/)
  assert.throws(
    () => scopeFor({ originSessionId: 'unknown-runtime' }),
    /origin session is unavailable/
  )
  const scope = scopeFor({ originSessionId: app.sessions[0].runtimeSessionId })!
  assert.equal(scope.originSessionId, app.sessions[0].runtimeSessionId)
  scope.assertCurrent!()
  binding = 'replacement-host'
  assert.throws(() => scope.assertCurrent!(), /project\/host binding changed/)
  const local = await harness()
  await local.invoke('agent:prompt', 'initialize ordinary local origin')
  const localScope = local.wrapperJobOptions.hostScopeFor as typeof scopeFor
  assert.equal(localScope({ originSessionId: local.sessions[0].runtimeSessionId }), undefined)
})

for (const boundary of ['stop', 'rebind'] as const)
  test(`main remote present ${boundary} during inspection cannot commit a delivery`, async () => {
    const session = new FakeSession('fresh.jsonl')
    session.hold = true
    let release!: () => void,
      entered = false,
      binding = 'selected-host',
      routed = false
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const app = await harness(async () => session, {
      remoteRpc: true,
      remoteNotebookBinding: () => binding,
      remotePresentGate: gate,
      onRemotePresentInspect: () => {
        entered = true
      },
      routedRuntime: () => routed
    })
    await app.invoke('projects:newRemoteSession', 'remote-project-1')
    const active = app.invoke('agent:prompt', 'inspect the remote artifact')
    await waitUntil(() => session.started)
    routed = true
    const present = app.hostHandlers.get('deliverables.present')!
    const request = {
      runtimeSessionId: session.runtimeSessionId,
      toolCallId: 'held-present',
      files: [{ path: 'report.pdf' }]
    }
    await assert.rejects(
      present(request, {
        originSessionId: 'forged',
        toolCallId: 'held-present',
        signal: new AbortController().signal
      }),
      /origin\/call binding differs/
    )
    const controller = new AbortController()
    const pending = present(request, {
      originSessionId: session.runtimeSessionId,
      toolCallId: 'held-present',
      signal: controller.signal
    })
    await waitUntil(() => entered)
    if (boundary === 'stop') controller.abort(new Error('artifact inspection stopped'))
    else binding = 'replacement-host'
    release()
    await assert.rejects(
      pending,
      boundary === 'stop' ? /artifact inspection stopped/ : /binding changed during inspection/
    )
    assert.equal(
      app.appendedSessionEvents.some(
        (entry) => (entry.event as { type?: string }).type === 'files_presented'
      ),
      false
    )
    await app.invoke('agent:stop')
    await active
  })

test('main actual finished callback wakes the RPC-enabled owning Phi conversation exactly once', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  await app.invoke('agent:prompt', 'start a remote background wrapper')
  const session = app.sessions[0]
  const listeners = (
    app as unknown as { wrapperJobFinishListeners: Array<(run: unknown, status: unknown) => void> }
  ).wrapperJobFinishListeners
  assert.equal(listeners.length, 1)
  listeners[0](
    FINISHED_RUN(session.runtimeSessionId, {
      remote: { host: 'cluster-one', runDir: '/canonical/project/wrappers/runs/wrun_1' }
    }),
    { elapsedSeconds: 1 }
  )
  await waitUntil(() => session.promptTexts.length === 2)
  assert.match(session.promptTexts[1], WOKEN)
  assert.equal(app.sessions.length, 1)
  const notices = app.appendedSessionEvents.filter(
    (entry) => (entry.event as { type?: string }).type === 'wrapper_run_finished'
  )
  assert.equal(notices.length, 1)
  assert.equal(notices[0].sessionId, current.phiSessionId)
})

test('RPC selection rejects a running Phi session before maps or manifest writes', async () => {
  const session = new FakeSession('rpc-controls-busy.jsonl')
  session.hold = true
  const app = await harness(async () => session, { remoteRpc: true })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const running = app.invoke('agent:prompt', 'hold the selected remote run')
  await tick()
  const before = JSON.stringify(app.updatedSessionManifests)
  const selected = await app.invoke('models:selected')
  const thinking = await app.invoke('thinking:selected')
  await assert.rejects(app.invoke('models:select', 'openai', 'gpt-vision-test'), /idle Phi session/)
  await assert.rejects(app.invoke('thinking:select', 'medium'), /idle Phi session/)
  assert.equal(JSON.stringify(app.updatedSessionManifests), before)
  assert.deepEqual(await app.invoke('models:selected'), selected)
  assert.equal(await app.invoke('thinking:selected'), thinking)
  await app.invoke('agent:stop')
  await running
})

test('RPC model lookup cannot commit into a newly selected Phi session', async () => {
  const gate = deferred<void>()
  let held = false,
    reached = false
  const app = await harness(undefined, {
    remoteRpc: true,
    modelRuntimeGet: async () => {
      if (held) {
        reached = true
        await gate.promise
      }
    }
  })
  const first = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  await app.invoke('agent:prompt', 'materialize the old selected session')
  held = true
  const selecting = app.invoke('models:select', 'openai', 'gpt-vision-test')
  const rejected = assert.rejects(selecting, /superseded|stale/i)
  await tick()
  assert.equal(reached, true)
  const second = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  assert.notEqual(second.phiSessionId, first.phiSessionId)
  const before = JSON.stringify(app.updatedSessionManifests)
  gate.resolve()
  await rejected
  assert.equal(JSON.stringify(app.updatedSessionManifests), before)
  assert.deepEqual(await app.invoke('models:selected'), {
    providerId: 'openai',
    modelId: 'gpt-test'
  })
})

test('RPC thinking dispatch keeps its original view generation until confirmation', async () => {
  let routed = false
  const app = await harness(undefined, { remoteRpc: true, routedRuntime: () => routed })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'initialize the old runtime identity')
  routed = true
  const session = app.sessions[0]
  const gate = deferred<void>()
  let reached = false
  session.setThinkingLevel = async (
    level: string,
    control?: { assertCurrent(): void }
  ): Promise<void> => {
    reached = true
    await gate.promise
    control?.assertCurrent()
    session.thinkingLevel = level
  }
  const beforeThinking = session.thinkingLevel
  const selecting = app.invoke('thinking:select', 'medium')
  const rejected = assert.rejects(selecting, /superseded|stale/i)
  await tick()
  assert.equal(reached, true)
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const before = JSON.stringify(app.updatedSessionManifests)
  gate.resolve()
  await rejected
  assert.equal(session.thinkingLevel, beforeThinking)
  assert.equal(JSON.stringify(app.updatedSessionManifests), before)
})

test('RPC selection accepts its own confirmed policy and checkpoint before main publishes the selection', async () => {
  let routed = false
  const app = await harness(undefined, { remoteRpc: true, routedRuntime: () => routed })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  await app.invoke('agent:prompt', 'materialize the selected runtime')
  routed = true
  const session = app.sessions[0]
  const reference = {
    ompSessionId: 'stable-omp',
    journalBasename: 'stable.jsonl',
    checkpoint: { leafId: 'before' }
  }
  app.updatedSessionManifests.push({
    sessionId: current.phiSessionId,
    patch: { runtimeRef: reference }
  })
  session.setModel = async (model, control?: { assertCurrent(): void }): Promise<void> => {
    control?.assertCurrent()
    app.updatedSessionManifests.push({
      sessionId: current.phiSessionId,
      patch: {
        model: { providerId: model.provider, modelId: model.id },
        thinkingLevel: 'high',
        runtimeRef: { ...reference, checkpoint: { leafId: 'model-confirmed' } }
      }
    })
    session.model = model
  }
  await app.invoke('models:select', 'openai', 'gpt-test')
  assert.equal(((await app.invoke('models:selected')) as { modelId: string }).modelId, 'gpt-test')
  assert.equal(
    (app.updatedSessionManifests.at(-1)!.patch.runtimeRef as typeof reference).checkpoint.leafId,
    'model-confirmed'
  )
  session.setThinkingLevel = async (level, control?: { assertCurrent(): void }): Promise<void> => {
    control?.assertCurrent()
    app.updatedSessionManifests.push({
      sessionId: current.phiSessionId,
      patch: {
        thinkingLevel: level,
        runtimeRef: { ...reference, checkpoint: { leafId: 'thinking-confirmed' } }
      }
    })
    session.thinkingLevel = level
  }
  await app.invoke('thinking:select', 'medium')
  assert.equal(await app.invoke('thinking:selected'), 'medium')
  assert.equal(
    (app.updatedSessionManifests.at(-1)!.patch.runtimeRef as typeof reference).checkpoint.leafId,
    'thinking-confirmed'
  )
})

test('RPC compaction main: saved automatic policy reaches startup without enabling other unsupported controls', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const target = compactionTarget(await app.invoke('sessions:current'))
  await app.invoke('sessions:autoCompactionSettings:set', target, {
    enabled: false,
    thresholdPercent: 80
  })
  assert.equal(app.sessions.length, 0)
  await app.invoke('agent:prompt', 'materialize saved compaction policy')
  assert.deepEqual(app.createdAgentOptions[0].autoCompaction, {
    enabled: false,
    thresholdPercent: 80
  })
})

test('RPC compaction main: confirmed live policy returns its baseline without postcommit reads', async () => {
  let routed = false
  let reads = 0
  const app = await harness(undefined, {
    remoteRpc: true,
    routedRuntime: () => routed,
    compactionDefaultsRead: async () => {
      reads += 1
      throw new Error('postcommit defaults unavailable')
    }
  })
  const current = await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'materialize')
  routed = true
  const target = compactionTarget(await app.invoke('sessions:current'))
  const baseline = { enabled: true, thresholdPercent: -1, thresholdTokens: 16384 }
  app.sessions[0].setAutoCompactionSettings = async (overrides, control) => {
    control?.assertCurrent()
    return { ...baseline, ...overrides, defaults: baseline }
  }
  const saved = (await app.invoke('sessions:autoCompactionSettings:set', target, {
    enabled: false,
    thresholdPercent: 80
  })) as Record<string, unknown>
  assert.equal(reads, 0)
  assert.equal(saved.enabled, false)
  assert.equal(saved.thresholdPercent, 80)
  assert.deepEqual(saved.defaults, baseline)
  assert.deepEqual(app.updatedSessionManifests.at(-1)?.patch.autoCompaction, {
    enabled: false,
    thresholdPercent: 80
  })
  assert.equal(saved.phiSessionId, (current as { phiSessionId: string }).phiSessionId)
})

test('RPC compaction main: stale cold policy lookup cannot save into its old or next conversation', async () => {
  const gate = deferred<void>()
  let entered = false
  const app = await harness(undefined, {
    remoteRpc: true,
    rpcCompactionPolicyRead: async () => {
      entered = true
      await gate.promise
      return {
        policy: {
          enabled: false,
          thresholdPercent: 80,
          thresholdTokens: -1,
          methodOrder: ['summary']
        },
        defaults: { enabled: true, thresholdPercent: -1, thresholdTokens: -1 }
      }
    }
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const saving = app.invoke('sessions:autoCompactionSettings:set', target, { enabled: false })
  const rejected = assert.rejects(saving, /superseded|stale/i)
  await tick()
  assert.equal(entered, true)
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const before = JSON.stringify(app.updatedSessionManifests)
  gate.resolve()
  await rejected
  assert.equal(JSON.stringify(app.updatedSessionManifests), before)
  assert.equal(app.sessions.length, 0)
})

test('RPC compaction main: a late live acknowledgement cannot save after host rebinding', async () => {
  let routed = false
  let binding = 'cluster-one'
  const gate = deferred<void>()
  let entered = false
  const app = await harness(undefined, {
    remoteRpc: true,
    routedRuntime: () => routed,
    remoteHostBinding: () => binding
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'materialize')
  routed = true
  const target = compactionTarget(await app.invoke('sessions:current'))
  app.sessions[0].setAutoCompactionSettings = async (_overrides, control) => {
    entered = true
    await gate.promise
    control?.assertCurrent()
    const defaults = { enabled: true, thresholdPercent: -1, thresholdTokens: -1 }
    return { ...defaults, enabled: false, defaults }
  }
  const saving = app.invoke('sessions:autoCompactionSettings:set', target, { enabled: false })
  const rejected = assert.rejects(saving, /superseded|stale/i)
  await tick()
  assert.equal(entered, true)
  binding = 'replacement-host'
  const before = JSON.stringify(app.updatedSessionManifests)
  gate.resolve()
  await rejected
  assert.equal(JSON.stringify(app.updatedSessionManifests), before)
})

test('RPC compaction main: stop waits for its selected manual owner and never aborts a peer', async () => {
  const gate = deferred<void>()
  const abortGate = deferred<void>()
  const app = await harness()
  const first = (await app.invoke('sessions:create')) as { path: string }
  await app.invoke('agent:prompt', 'first')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const owner = app.sessions[0]
  let entered = false
  owner.compact = async (control) => {
    entered = true
    await gate.promise
    control?.assertCurrent()
    return { summary: 'summary', shortSummary: 'summary', tokensBefore: 0 }
  }
  owner.abort = async () => {
    owner.log.push('abort')
    await abortGate.promise
    gate.resolve()
  }
  const compacting = app.invoke('sessions:compact', target)
  const rejected = assert.rejects(compacting, /cancel|取消/i)
  await tick()
  assert.equal(entered, true)
  await app.invoke('sessions:create')
  await app.invoke('agent:prompt', 'peer')
  await app.invoke('agent:stop')
  assert.equal(owner.log.includes('abort'), false)
  await app.invoke('sessions:switch', first.path)
  let stopped = false
  const stop = app.invoke('agent:stop').then(() => {
    stopped = true
  })
  await tick()
  assert.equal(stopped, false)
  assert.equal(owner.log.filter((entry) => entry === 'abort').length, 1)
  assert.equal(app.sessions[1].log.includes('abort'), false)
  abortGate.resolve()
  await stop
  await rejected
  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'context_compacted'
    ),
    false
  )
})

test('RPC compaction main: live getters preserve the installed baseline during a prompt', async () => {
  let routed = false
  const app = await harness(undefined, { remoteRpc: true, routedRuntime: () => routed })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'materialize')
  routed = true
  const session = app.sessions[0]
  const defaults = { enabled: true, thresholdPercent: -1, thresholdTokens: 16384 }
  session.getAutoCompactionSettings = async (control) => {
    control?.assertCurrent()
    return { enabled: false, thresholdPercent: 70, thresholdTokens: 16384, defaults }
  }
  session.hold = true
  // Existing next-run model reconciliation requires a saved exact selection for RPC.
  await app.invoke('models:select', 'openai', 'gpt-test')
  const running = app.invoke('agent:prompt', 'hold')
  await tick()
  const target = compactionTarget(await app.invoke('sessions:current'))
  const settings = (await app.invoke('sessions:autoCompactionSettings', target)) as Record<
    string,
    unknown
  >
  assert.equal(settings.enabled, false)
  assert.equal(settings.thresholdPercent, 70)
  assert.deepEqual(settings.defaults, defaults)
  await assert.rejects(
    app.invoke('sessions:autoCompactionSettings:set', target, { enabled: true }),
    /运行结束/
  )
  await assert.rejects(app.invoke('sessions:compact', target), /运行结束/)
  await app.invoke('agent:stop')
  await running
})

test('RPC compaction main: stale manual initialization stops after registry lookup before creating a runtime', async () => {
  const gate = deferred<void>()
  let hold = false
  let reached = false
  const app = await harness(undefined, {
    remoteRpc: true,
    modelRuntimeGet: async () => {
      if (hold) {
        reached = true
        await gate.promise
      }
    }
  })
  const first = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  app.updatedSessionManifests.push({
    sessionId: first.phiSessionId,
    patch: {
      runtimeSessionPath: 'saved-rpc.jsonl',
      runtimeRef: {
        ompSessionId: 'saved-omp',
        journalBasename: 'saved.jsonl',
        checkpoint: { leafId: 'before' }
      }
    }
  })
  const target = compactionTarget(await app.invoke('sessions:current'))
  hold = true
  const compacting = app.invoke('sessions:compact', target)
  const rejected = assert.rejects(compacting, /superseded|stale/i)
  await tick()
  assert.equal(reached, true)
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const before = JSON.stringify(app.updatedSessionManifests)
  gate.resolve()
  await rejected
  assert.equal(app.sessions.length, 0)
  assert.equal(JSON.stringify(app.updatedSessionManifests), before)
})

test('RPC compaction main: an automatic save awaits its original pending runtime before dispatch', async () => {
  const gate = deferred<void>()
  let hold = false
  let reached = false
  const app = await harness(undefined, {
    modelRuntimeGet: async () => {
      if (hold) {
        reached = true
        await gate.promise
      }
    }
  })
  const first = (await app.invoke('sessions:create')) as { phiSessionId: string }
  app.updatedSessionManifests.push({
    sessionId: first.phiSessionId,
    patch: { runtimeSessionPath: 'saved-local.jsonl' }
  })
  const target = compactionTarget(await app.invoke('sessions:current'))
  hold = true
  const reading = app.invoke('sessions:contextUsage')
  await tick()
  assert.equal(reached, true)
  const before = JSON.stringify(app.updatedSessionManifests)
  let saved = false
  const saving = app
    .invoke('sessions:autoCompactionSettings:set', target, { enabled: false })
    .then(() => {
      saved = true
    })
  await tick()
  assert.equal(saved, false)
  assert.equal(JSON.stringify(app.updatedSessionManifests), before)
  gate.resolve()
  await reading
  await saving
  assert.deepEqual(app.sessions[0].autoCompactionOverrides, { enabled: false })
})

test('RPC compaction main: stopped manual initialization cannot dispatch after the lookup resolves', async () => {
  const gate = deferred<void>()
  let hold = false
  const app = await harness(undefined, {
    modelRuntimeGet: async () => {
      if (hold) await gate.promise
    }
  })
  const first = (await app.invoke('sessions:create')) as { phiSessionId: string }
  app.updatedSessionManifests.push({
    sessionId: first.phiSessionId,
    patch: { runtimeSessionPath: 'saved-local.jsonl' }
  })
  const target = compactionTarget(await app.invoke('sessions:current'))
  hold = true
  const compacting = app.invoke('sessions:compact', target)
  const rejected = assert.rejects(compacting, /superseded|stale|取消/i)
  await tick()
  let stopped = false
  const stopping = app.invoke('agent:stop').then(() => {
    stopped = true
  })
  await tick()
  assert.equal(stopped, false)
  gate.resolve()
  await stopping
  await rejected
  assert.equal(app.sessions.length, 0)
  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'context_compacted'
    ),
    false
  )
})

test('RPC compaction main: a failed local defaults read cannot produce a saved false failure', async () => {
  const error = new Error('desktop policy unavailable')
  const app = await harness(undefined, {
    compactionDefaultsRead: async () => {
      throw error
    }
  })
  await app.invoke('sessions:create')
  await app.invoke('agent:prompt', 'materialize')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const before = JSON.stringify(app.updatedSessionManifests)
  await assert.rejects(
    app.invoke('sessions:autoCompactionSettings:set', target, { enabled: false }),
    error
  )
  assert.equal(JSON.stringify(app.updatedSessionManifests), before)
  assert.equal(app.sessions[0].autoCompactionSettingsCalls, 1)
})

test('RPC compaction main: a persisted runtime reference supports manual compaction and usage without a legacy path', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  const first = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  await app.invoke('agent:prompt', 'materialize')
  app.updatedSessionManifests.push({
    sessionId: first.phiSessionId,
    patch: {
      runtimeSessionPath: undefined,
      runtimeRef: {
        ompSessionId: 'saved-omp',
        journalBasename: 'saved.jsonl',
        checkpoint: { leafId: 'before' }
      }
    }
  })
  app.sessions[0].contextUsage = { tokens: 5000, contextWindow: 200000, percent: 2.5 }
  const target = compactionTarget(await app.invoke('sessions:current'))
  const result = (await app.invoke('sessions:compact', target)) as {
    phiSessionId: string
    tokensAfter: number
  }
  assert.equal(result.phiSessionId, first.phiSessionId)
  assert.equal(result.tokensAfter, 5000)
  assert.equal(app.sessions[0].compactCalls, 1)
  const usage = (await app.invoke('sessions:contextUsage')) as {
    usage: FakeSession['contextUsage']
  }
  assert.deepEqual(usage.usage, app.sessions[0].contextUsage)
})

test('RPC compaction main: its own cold resume preserves the initiating view generation', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  const first = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  app.updatedSessionManifests.push({
    sessionId: first.phiSessionId,
    patch: {
      runtimeRef: {
        ompSessionId: 'saved-omp',
        journalBasename: 'saved.jsonl',
        checkpoint: { leafId: 'before' }
      },
      autoCompaction: { enabled: false, thresholdPercent: 90 }
    }
  })
  const target = compactionTarget(await app.invoke('sessions:current'))
  const result = (await app.invoke('sessions:compact', target)) as { phiSessionId: string }
  assert.equal(result.phiSessionId, first.phiSessionId)
  assert.equal(app.sessions.length, 1)
  assert.equal(app.sessions[0].compactCalls, 1)
  assert.deepEqual(app.createdAgentOptions[0].autoCompaction, {
    enabled: false,
    thresholdPercent: 90
  })
  assert.deepEqual(compactionTarget(await app.invoke('sessions:current')), target)
  const notices = app.events.filter(
    (event) =>
      event.channel === 'agent:event' &&
      (event.data as { type?: string }).type === 'context_compacted'
  )
  assert.equal(notices.length, 1)
  assert.equal(
    (notices[0].data as { sessionGeneration: number }).sessionGeneration,
    target.sessionGeneration
  )
})

for (const boundary of ['navigation', 'lifecycle'] as const)
  test(`RPC compaction main: late live policy acknowledgement rejects ${boundary} replacement without saving`, async () => {
    let routed = false
    const gate = deferred<void>()
    let entered = false
    const app = await harness(undefined, { remoteRpc: true, routedRuntime: () => routed })
    await app.invoke('projects:newRemoteSession', 'remote-project-1')
    await app.invoke('agent:prompt', 'materialize')
    routed = true
    const target = compactionTarget(await app.invoke('sessions:current'))
    app.sessions[0].setAutoCompactionSettings = async (_overrides, control) => {
      entered = true
      await gate.promise
      control?.assertCurrent()
      const defaults = { enabled: true, thresholdPercent: -1, thresholdTokens: -1 }
      return { ...defaults, enabled: false, defaults }
    }
    const saving = app.invoke('sessions:autoCompactionSettings:set', target, { enabled: false })
    const rejected = assert.rejects(saving, /superseded|stale/i)
    await tick()
    assert.equal(entered, true)
    if (boundary === 'navigation') await app.invoke('projects:newRemoteSession', 'remote-project-1')
    else await app.invoke('auth:logout', 'openai')
    const before = JSON.stringify(app.updatedSessionManifests)
    gate.resolve()
    await rejected
    assert.equal(JSON.stringify(app.updatedSessionManifests), before)
  })

test('RPC compaction main: accepted manual work continues on its owner after navigation', async () => {
  const gate = deferred<void>()
  const app = await harness()
  const first = (await app.invoke('sessions:create')) as { phiSessionId: string }
  await app.invoke('agent:prompt', 'materialize')
  const target = compactionTarget(await app.invoke('sessions:current'))
  const owner = app.sessions[0]
  owner.compactGate = gate.promise
  const compacting = app.invoke('sessions:compact', target)
  await tick()
  assert.equal(owner.compactCalls, 1)
  const second = (await app.invoke('sessions:create')) as { phiSessionId: string }
  const beforePeer = await app.invoke('sessions:current')
  gate.resolve()
  const outcome = (await compacting) as { phiSessionId: string }
  assert.equal(outcome.phiSessionId, first.phiSessionId)
  assert.deepEqual(await app.invoke('sessions:current'), beforePeer)
  const notices = app.appendedSessionEvents.filter(
    (entry) => (entry.event as { type?: string }).type === 'context_compacted'
  )
  assert.equal(notices.length, 1)
  assert.equal(notices[0].sessionId, first.phiSessionId)
  assert.notEqual(notices[0].sessionId, second.phiSessionId)
  assert.equal(
    app.appendedSessionEvents.some(
      (entry) => (entry.event as { type?: string }).type === 'context_compaction_failed'
    ),
    false
  )
  assert.equal(owner.log.includes('abort'), false)
  assert.equal(owner.log.includes('dispose'), false)
})

test('RPC compaction main: an adopted RPC reference never falls back to legacy when routing is disabled', async () => {
  const app = await harness()
  const first = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  app.updatedSessionManifests.push({
    sessionId: first.phiSessionId,
    patch: {
      runtimeRef: {
        ompSessionId: 'saved-omp',
        journalBasename: 'saved.jsonl',
        checkpoint: { leafId: 'before' }
      }
    }
  })
  const target = compactionTarget(await app.invoke('sessions:current'))
  await assert.rejects(app.invoke('sessions:compact', target), /远程 RPC.*显式恢复/)
  assert.equal(app.sessions.length, 0)
  assert.equal(app.createdAgentOptions.length, 0)
})

test('RPC compaction main: a cancelled async bootstrap disposes only its own result before dispatch', async () => {
  const gate = deferred<void>()
  let entered = false
  const app = await harness(async (_cwd, file) => {
    entered = true
    await gate.promise
    return new FakeSession(file)
  })
  const first = (await app.invoke('sessions:create')) as { phiSessionId: string }
  app.updatedSessionManifests.push({
    sessionId: first.phiSessionId,
    patch: { runtimeSessionPath: 'saved-local.jsonl' }
  })
  const target = compactionTarget(await app.invoke('sessions:current'))
  const compacting = app.invoke('sessions:compact', target)
  const rejected = assert.rejects(compacting, /superseded|stale|取消/i)
  await tick()
  assert.equal(entered, true)
  const stopping = app.invoke('agent:stop')
  gate.resolve()
  await stopping
  await rejected
  assert.equal(app.sessions.length, 1)
  assert.equal(app.sessions[0].compactCalls, 0)
  assert.deepEqual(app.sessions[0].log, ['abort', 'dispose'])
})

test('RPC compaction main: stop preserves an abort error after awaiting the same manual terminal event', async () => {
  const gate = deferred<void>()
  const abortError = new Error('abort acknowledgement failed')
  const app = await harness()
  await app.invoke('sessions:create')
  await app.invoke('agent:prompt', 'materialize')
  const target = compactionTarget(await app.invoke('sessions:current'))
  app.sessions[0].compactGate = gate.promise
  app.sessions[0].abort = async () => {
    throw abortError
  }
  const compacting = app.invoke('sessions:compact', target)
  const compactRejected = assert.rejects(compacting, /取消/)
  await tick()
  let returned = false
  const stopping = app.invoke('agent:stop').finally(() => {
    returned = true
  })
  const stopRejected = assert.rejects(stopping, (error) => error === abortError)
  await tick()
  assert.equal(returned, false)
  gate.resolve()
  await stopRejected
  await compactRejected
})

test('RPC compaction main: stale bootstrap still disposes its owned result when abort cleanup fails', async () => {
  const gate = deferred<void>()
  const cleanupError = new Error('owned abort acknowledgement failed')
  let entered = false
  const app = await harness(async (_cwd, file) => {
    entered = true
    await gate.promise
    const session = new FakeSession(file)
    session.abort = async () => {
      session.log.push('abort')
      throw cleanupError
    }
    return session
  })
  const first = (await app.invoke('sessions:create')) as { phiSessionId: string }
  app.updatedSessionManifests.push({
    sessionId: first.phiSessionId,
    patch: { runtimeSessionPath: 'saved-local.jsonl' }
  })
  const target = compactionTarget(await app.invoke('sessions:current'))
  const compacting = app.invoke('sessions:compact', target)
  const rejected = assert.rejects(
    compacting,
    (error) =>
      error !== cleanupError &&
      error instanceof Error &&
      /superseded|stale|取消/i.test(error.message)
  )
  await tick()
  assert.equal(entered, true)
  const stopping = app.invoke('agent:stop')
  gate.resolve()
  await stopping
  await rejected
  assert.equal(app.sessions.length, 1)
  assert.equal(app.sessions[0].compactCalls, 0)
  assert.deepEqual(app.sessions[0].log, ['abort', 'dispose'])
})

for (const boundary of ['lifecycle', 'host', 'journal'] as const)
  test(`RPC compaction main: accepted manual work still rejects its own ${boundary} replacement`, async () => {
    const gate = deferred<void>()
    let host = 'cluster-one'
    const app = await harness(undefined, { remoteRpc: true, remoteHostBinding: () => host })
    const first = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
      phiSessionId: string
    }
    await app.invoke('agent:prompt', 'materialize')
    const reference = {
      ompSessionId: 'saved-omp',
      journalBasename: 'saved.jsonl',
      checkpoint: { leafId: 'before' }
    }
    app.updatedSessionManifests.push({
      sessionId: first.phiSessionId,
      patch: { runtimeRef: reference }
    })
    const target = compactionTarget(await app.invoke('sessions:current'))
    const owner = app.sessions[0]
    owner.compactGate = gate.promise
    const compacting = app.invoke('sessions:compact', target)
    const rejected = assert.rejects(compacting, /superseded|stale/i)
    await tick()
    assert.equal(owner.compactCalls, 1)
    if (boundary === 'lifecycle') await app.invoke('auth:logout', 'openai')
    const second = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
      phiSessionId: string
    }
    if (boundary === 'host') host = 'replacement-host'
    if (boundary === 'journal')
      app.updatedSessionManifests.push({
        sessionId: first.phiSessionId,
        patch: { runtimeRef: { ...reference, journalBasename: 'replacement.jsonl' } }
      })
    const beforePeer = await app.invoke('sessions:current')
    gate.resolve()
    await rejected
    assert.deepEqual(await app.invoke('sessions:current'), beforePeer)
    const failures = app.appendedSessionEvents.filter(
      (entry) => (entry.event as { type?: string }).type === 'context_compaction_failed'
    )
    assert.equal(failures.length, 1)
    assert.equal(failures[0].sessionId, first.phiSessionId)
    assert.notEqual(failures[0].sessionId, second.phiSessionId)
    assert.equal(
      app.appendedSessionEvents.some(
        (entry) => (entry.event as { type?: string }).type === 'context_compacted'
      ),
      false
    )
  })

test('T13 main configuration: selected prompt provider reuses trusted sources and owns its local persona path', async () => {
  const app = await harness(undefined, { remoteRpc: true, remoteRpcResources: true })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
    cwd: string
  }
  const provider = app.remoteRoutingOptions[0].loadPromptContext as (
    identity: Record<string, string>,
    signal: AbortSignal
  ) => Promise<Record<string, unknown>>
  const snapshot = await provider(
    {
      runtimeSessionId: 'owner',
      sessionId: current.phiSessionId,
      projectId: 'remote-project-1',
      cwd: '/canonical/project',
      resourceCwd: current.cwd
    },
    new AbortController().signal
  )
  assert.equal(snapshot.personaMarkdown, 'persona')
  assert.equal(snapshot.personaPath, '/isolated/AGENTS.md')
  assert.deepEqual(snapshot.contextFiles, [
    { path: 'ssh://cluster-one/cluster/project/AGENTS.md', content: 'Remote instructions v1' }
  ])
  assert.deepEqual(snapshot.runtime, {
    rootLabel: '~/.phi/runtime',
    source: 'default',
    micromambaStatus: 'unchecked',
    ripgrepStatus: 'not-installed'
  })
})

for (const boundary of ['stop', 'rebind'] as const)
  test(`T13 main configuration: prompt source ${boundary} during read rejects without runtime creation`, async () => {
    const gate = deferred<void>()
    let binding = 'original'
    let entered = false
    const app = await harness(undefined, {
      remoteRpc: true,
      remoteNotebookBinding: () => binding,
      remoteInstructionsRead: async () => {
        entered = true
        await gate.promise
        return []
      }
    })
    const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
      phiSessionId: string
      cwd: string
    }
    const provider = app.remoteRoutingOptions[0].loadPromptContext as (
      identity: Record<string, string>,
      signal: AbortSignal
    ) => Promise<Record<string, unknown>>
    const controller = new AbortController()
    const loading = provider(
      {
        runtimeSessionId: 'owner',
        sessionId: current.phiSessionId,
        projectId: 'remote-project-1',
        cwd: '/canonical/project',
        resourceCwd: current.cwd
      },
      controller.signal
    )
    const rejected = assert.rejects(loading, /abort|绑定已改变/i)
    await tick()
    assert.equal(entered, true)
    if (boundary === 'stop') controller.abort()
    else binding = 'replacement'
    gate.resolve()
    await rejected
    assert.equal(app.createdAgentOptions.length, 0)
  })

test('T13 main configuration: RPC initialization rejects a host rebind after trusted instruction lookup', async () => {
  const gate = deferred<void>()
  let entered = false
  let binding = 'original'
  const app = await harness(undefined, {
    remoteRpc: true,
    remoteNotebookBinding: () => binding,
    remoteInstructionsRead: async () => {
      entered = true
      await gate.promise
      return []
    }
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const running = app.invoke('agent:prompt', 'initialize')
  await tick()
  assert.equal(entered, true)
  binding = 'replacement'
  gate.resolve()
  assert.equal(await running, null)
  assert.equal(app.createdAgentOptions.length, 0)
})

test('T13 main rename: idle live RPC uses one confirmed SDK rename and can target a background owner', async () => {
  let routed = false
  const app = await harness(undefined, { remoteRpc: true, routedRuntime: () => routed })
  const owner = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    path: string
  }
  await app.invoke('agent:prompt', 'materialize owner')
  routed = true
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const peer = await app.invoke('sessions:current')
  await app.invoke('sessions:rename', owner.path, '  Confirmed title  ')
  assert.deepEqual(app.sessions[0].sessionNameCalls, ['Confirmed title'])
  assert.deepEqual(app.renamedSessions, [])
  assert.deepEqual(await app.invoke('sessions:current'), peer)
})

test('T13 main rename: cold future names do not start RPC and adopted offline references require resume', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    path: string
    phiSessionId: string
  }
  await app.invoke('sessions:rename', current.path, 'Future title')
  assert.deepEqual(app.renamedSessions, [{ path: current.path, name: 'Future title' }])
  assert.equal(app.sessions.length, 0)
  app.updatedSessionManifests.push({
    sessionId: current.phiSessionId,
    patch: {
      runtimeRef: {
        ompSessionId: 'saved-omp',
        journalBasename: 'saved.jsonl',
        checkpoint: { leafId: 'before' }
      }
    }
  })
  await assert.rejects(
    app.invoke('sessions:rename', current.path, 'Unsafe offline title'),
    /显式恢复/
  )
  assert.equal(app.renamedSessions.length, 1)
  assert.equal(app.sessions.length, 0)
})

for (const boundary of ['rebind', 'lifecycle'] as const)
  test(`T13 main rename: late confirmation rejects original ${boundary} replacement before saving`, async () => {
    let routed = false
    let host = 'original'
    const gate = deferred<void>()
    let entered = false
    const app = await harness(undefined, {
      remoteRpc: true,
      routedRuntime: () => routed,
      remoteHostBinding: () => host
    })
    const owner = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
      path: string
    }
    await app.invoke('agent:prompt', 'materialize')
    routed = true
    app.sessions[0].sessionManager.setSessionName = async (name, _source, control) => {
      void _source
      entered = true
      await gate.promise
      control?.assertCurrent()
      app.sessions[0].sessionNameCalls.push(name)
      return true
    }
    const renaming = app.invoke('sessions:rename', owner.path, 'Late title')
    const rejected = assert.rejects(renaming, /superseded|stale/i)
    await tick()
    assert.equal(entered, true)
    if (boundary === 'rebind') host = 'replacement'
    else await app.invoke('auth:logout', 'openai')
    gate.resolve()
    await rejected
    assert.deepEqual(app.sessions[0].sessionNameCalls, [])
    assert.deepEqual(app.renamedSessions, [])
  })

test('T13 main rename: busy RPC refuses writes while local Phi names preserve existing behavior', async () => {
  const session = new FakeSession('held.jsonl')
  session.hold = true
  const app = await harness(async () => session, { remoteRpc: true })
  const owner = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    path: string
  }
  const running = app.invoke('agent:prompt', 'hold')
  await tick()
  await assert.rejects(app.invoke('sessions:rename', owner.path, 'Busy title'), /运行结束/)
  assert.deepEqual(app.renamedSessions, [])
  await app.invoke('agent:stop')
  await running
  const local = await harness(async () => {
    const session = new FakeSession('local.jsonl')
    session.hold = true
    return session
  })
  const current = (await local.invoke('sessions:create')) as { path: string }
  const localRun = local.invoke('agent:prompt', 'local hold')
  await tick()
  await local.invoke('sessions:rename', current.path, 'Local title')
  assert.deepEqual(local.renamedSessions, [{ path: current.path, name: 'Local title' }])
  await local.invoke('agent:stop')
  await localRun
})

test('AI session titles: the first successful reply names its original conversation in the background', async () => {
  const gate = deferred<string>()
  const requests: sessionTitleGeneration.SessionTitleRequest[] = []
  const app = await harness(undefined, {
    titleRequest: async (input) => {
      requests.push(input)
      return gate.promise
    }
  })
  const owner = (await app.invoke('sessions:create')) as { path: string; phiSessionId: string }
  await app.invoke('agent:prompt', '帮我合并三个单细胞数据集，然后检查质控参数')
  await tick()
  assert.equal(requests.length, 1)
  assert.equal(requests[0].sessionPath, owner.path)
  assert.deepEqual(app.renamedSessions, [])
  const peer = (await app.invoke('sessions:create')) as { path: string }
  gate.resolve('单细胞合并与质控')
  await tick()
  assert.deepEqual(app.renamedSessions, [{ path: owner.path, name: '单细胞合并与质控' }])
  assert.ok(
    app.updatedSessionManifests.some(
      (entry) => entry.sessionId === owner.phiSessionId && entry.patch.titleSource === 'auto'
    )
  )
  assert.equal(((await app.invoke('sessions:current')) as { path: string }).path, peer.path)
  assert.equal(app.sessions.length, 1, 'title requests do not create visible chat sessions')
})

test('AI session titles: a manual rename cancels and wins over a delayed automatic title', async () => {
  const gate = deferred<string>()
  let signal: AbortSignal | undefined
  const app = await harness(undefined, {
    titleRequest: async (input) => {
      signal = input.signal
      return gate.promise
    }
  })
  const owner = (await app.invoke('sessions:create')) as { path: string; phiSessionId: string }
  await app.invoke('agent:prompt', '整理项目里的分析代码')
  await tick()
  await app.invoke('sessions:rename', owner.path, '我自己的项目标题')
  assert.equal(signal?.aborted, true)
  gate.resolve('迟到的自动标题')
  await tick()
  assert.deepEqual(app.renamedSessions, [{ path: owner.path, name: '我自己的项目标题' }])
  assert.ok(
    app.updatedSessionManifests.some(
      (entry) => entry.sessionId === owner.phiSessionId && entry.patch.titleSource === 'user'
    )
  )
  await app.invoke('agent:prompt', '继续检查')
  await tick()
  assert.equal(app.renamedSessions.length, 1)
})

test('AI session titles: deleting a conversation cancels pending title work', async () => {
  const gate = deferred<string>()
  let signal: AbortSignal | undefined
  const app = await harness(undefined, {
    titleRequest: async (input) => {
      signal = input.signal
      return gate.promise
    }
  })
  const owner = (await app.invoke('sessions:create')) as { path: string }
  await app.invoke('agent:prompt', '分析项目中的错误')
  await tick()
  await app.invoke('sessions:delete', owner.path)
  assert.equal(signal?.aborted, true)
  gate.resolve('已删除对话的标题')
  await tick()
  assert.deepEqual(app.renamedSessions, [])
})

test('AI session titles: a failed request leaves the fallback and retries on a later successful turn', async () => {
  let attempts = 0
  const app = await harness(undefined, {
    titleRequest: async () => {
      if (++attempts === 1) throw new Error('provider unavailable')
      return '项目分析修复'
    }
  })
  const owner = (await app.invoke('sessions:create')) as { path: string }
  await app.invoke('agent:prompt', '修复项目分析流程中的异常')
  await tick()
  assert.deepEqual(app.renamedSessions, [])
  await app.invoke('agent:prompt', '继续定位原因')
  await tick()
  assert.deepEqual(app.renamedSessions, [{ path: owner.path, name: '项目分析修复' }])
  await app.invoke('agent:prompt', '查看最终结果')
  await tick()
  assert.equal(attempts, 2, 'successful AI titles are generated once')
})

test('AI session titles: manual generation suggests an editable title without saving it', async () => {
  const requests: sessionTitleGeneration.SessionTitleRequest[] = []
  const app = await harness(undefined, {
    titleRequest: async (input) => {
      requests.push(input)
      return '单细胞质控分析'
    }
  })
  const owner = (await app.invoke('sessions:create')) as { path: string }
  await app.invoke('sessions:rename', owner.path, '已有的手动标题')
  await app.invoke('agent:prompt', '检查单细胞质控参数\n\n引用文件：\n- `/private/data.h5ad`')
  await tick()
  assert.equal(requests.length, 0, 'manual titles are protected from automatic requests')
  assert.equal(await app.invoke('sessions:generateTitle', owner.path), '单细胞质控分析')
  assert.equal(requests.length, 1)
  assert.match(requests[0].prompt, /检查单细胞质控参数/)
  assert.doesNotMatch(requests[0].prompt, /private\/data/)
  assert.deepEqual(app.renamedSessions, [{ path: owner.path, name: '已有的手动标题' }])
  await assert.rejects(app.invokeFromForeign('sessions:generateTitle', owner.path), /authorized/)
  await assert.rejects(app.invoke('sessions:generateTitle', {}), /路径无效/)
  await assert.rejects(app.invoke('sessions:generateTitle', 'phi-session:missing'), /打开/)
})

test('AI session titles: a busy conversation refuses manual generation', async () => {
  const session = new FakeSession('title-busy.jsonl')
  session.hold = true
  const app = await harness(async () => session)
  const owner = (await app.invoke('sessions:create')) as { path: string }
  const running = app.invoke('agent:prompt', '正在处理的项目任务')
  await tick()
  await assert.rejects(app.invoke('sessions:generateTitle', owner.path), /运行结束/)
  await app.invoke('agent:stop')
  await running
})

test('AI session titles: runtime generation uses the selected model and disposable tool-free memory', async () => {
  const app = await harness(
    async (_cwd, file) => {
      const session = new FakeSession(file)
      if (file === 'in-memory') {
        session.skipFinalAssistantMessage = true
        session.messages.push({
          role: 'assistant',
          content: [{ type: 'text', text: '“单细胞质控分析”' }]
        })
      }
      return session
    },
    { useTitleRuntime: true }
  )
  const owner = (await app.invoke('sessions:create')) as { path: string }
  await app.invoke('models:select', 'openai', 'gpt-test')
  await app.invoke('agent:prompt', '分析单细胞数据并检查质控参数')
  await tick()
  const options = app.createdAgentOptions.find((entry) => entry.noTools === 'all')
  assert.ok(options)
  assert.equal((options.model as { provider: string }).provider, 'openai')
  assert.equal((options.model as { id: string }).id, 'gpt-test')
  assert.equal(options.thinkingLevel, 'minimal')
  const titleSession = app.sessions.find((entry) => entry.sessionFile === 'in-memory')
  assert.ok(titleSession?.disposed)
  assert.match(titleSession.promptTexts[0], /分析单细胞数据/)
  assert.deepEqual(app.renamedSessions, [{ path: owner.path, name: '单细胞质控分析' }])
  assert.equal(
    app.appendedSessionEvents.filter((entry) => entry.event.type === 'user_message').length,
    1
  )
})

test('AI session titles: greetings defer naming until the user gives a concrete topic', async () => {
  const requests: sessionTitleGeneration.SessionTitleRequest[] = []
  const app = await harness(undefined, {
    titleRequest: async (input) => {
      requests.push(input)
      return '单细胞数据质控'
    }
  })
  const owner = (await app.invoke('sessions:create')) as { path: string }
  app.createdPhiSessions[0].title = '你好！'
  await app.invoke('agent:prompt', '你好！')
  await tick()
  assert.equal(requests.length, 0)
  await app.invoke('agent:prompt', '检查单细胞数据的质控流程')
  await tick()
  assert.equal(requests.length, 1)
  assert.match(requests[0].prompt, /检查单细胞数据/)
  assert.deepEqual(app.renamedSessions, [{ path: owner.path, name: '单细胞数据质控' }])
})

for (const scenario of [
  'thinking-only',
  'error-final',
  'error-stream',
  'body-after-thinking'
] as const)
  test(`AI session titles: runtime collection accepts only successful assistant body (${scenario})`, async () => {
    const app = await harness(
      async (_cwd, file) => {
        const session = new FakeSession(file)
        if (file !== 'in-memory') return session
        session.skipFinalAssistantMessage = true
        if (scenario === 'error-final') {
          session.messages.push({
            role: 'assistant',
            stopReason: 'error',
            errorMessage: 'Quota exceeded',
            content: [{ type: 'text', text: 'Quota exceeded for this model' }]
          })
        } else {
          session.toolEvents = [
            {
              type: 'message_update',
              assistantMessageEvent: {
                type: 'thinking_delta',
                delta: 'The conversation concerns single-cell QC'
              }
            }
          ]
          if (scenario === 'body-after-thinking' || scenario === 'error-stream') {
            session.toolEvents.push({
              type: 'message_update',
              assistantMessageEvent: {
                type: 'text_delta',
                delta: 'Single Cell Quality Control'
              }
            })
          }
          if (scenario === 'error-stream') {
            session.toolEvents.push({
              type: 'message_end',
              message: {
                role: 'assistant',
                stopReason: 'error',
                errorMessage: '429 quota exceeded',
                content: []
              }
            })
          }
        }
        return session
      },
      { useTitleRuntime: true }
    )
    const owner = (await app.invoke('sessions:create')) as { path: string }
    await app.invoke('models:select', 'openai', 'gpt-test')
    await app.invoke('agent:prompt', '检查单细胞数据质控流程')
    await tick()
    if (scenario === 'body-after-thinking') {
      assert.deepEqual(app.renamedSessions, [
        { path: owner.path, name: 'Single Cell Quality Control' }
      ])
    } else {
      assert.deepEqual(app.renamedSessions, [])
      await assert.rejects(app.invoke('sessions:generateTitle', owner.path), /暂时无法/)
    }
  })

test('AI session titles: old inactive automatic-model conversations can use the configured SDK default', async () => {
  const app = await harness(
    async (_cwd, file) => {
      const session = new FakeSession(file)
      session.skipFinalAssistantMessage = true
      session.messages.push({
        role: 'assistant',
        content: [{ type: 'text', text: '单细胞质量控制' }]
      })
      return session
    },
    { useTitleRuntime: true }
  )
  const owner = (await app.invoke('sessions:create')) as { path: string; phiSessionId: string }
  app.createdPhiSessions[0].model = null
  app.appendedSessionEvents.push({
    sessionId: owner.phiSessionId,
    event: {
      type: 'user_message',
      content: '之前讨论过的单细胞数据质量控制流程'
    }
  })
  assert.equal(await app.invoke('sessions:generateTitle', owner.path), '单细胞质量控制')
  assert.deepEqual(app.renamedSessions, [])
  const options = app.createdAgentOptions.find((entry) => entry.noTools === 'all')
  assert.ok(options)
  assert.equal(options.model, undefined)
  assert.ok(app.sessions[0].disposed)
})

test('AI session titles: a new prompt prevents a late title write and naming retries after it finishes', async () => {
  const gate = deferred<string>()
  const session = new FakeSession('title-new-turn.jsonl')
  let requests = 0
  const app = await harness(async () => session, {
    titleRequest: async () => {
      requests++
      return requests === 1 ? gate.promise : '项目分析整理'
    }
  })
  const owner = (await app.invoke('sessions:create')) as { path: string }
  await app.invoke('agent:prompt', '整理项目分析代码')
  await tick()
  session.hold = true
  const running = app.invoke('agent:prompt', '再检查输入文件')
  await tick()
  gate.resolve('运行期间不应写入')
  await tick()
  assert.deepEqual(app.renamedSessions, [])
  session.finish.resolve()
  await running
  await tick()
  assert.equal(requests, 2)
  assert.deepEqual(app.renamedSessions, [{ path: owner.path, name: '项目分析整理' }])
})

test('AI session titles: a remote host rebind discards the old generation result', async () => {
  let routed = false
  let host = 'original'
  const gate = deferred<string>()
  const app = await harness(undefined, {
    remoteRpc: true,
    routedRuntime: () => routed,
    remoteHostBinding: () => host,
    titleRequest: async () => gate.promise
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', '检查远程项目中的数据')
  await tick()
  routed = true
  host = 'replacement'
  gate.resolve('过期的远程标题')
  await tick()
  assert.deepEqual(app.sessions[0].sessionNameCalls, [])
  assert.deepEqual(app.renamedSessions, [])
})

test('AI session titles: an attached RPC conversation uses confirmed rename rather than local history writes', async () => {
  let routed = false
  const gate = deferred<string>()
  const app = await harness(undefined, {
    remoteRpc: true,
    routedRuntime: () => routed,
    titleRequest: async () => gate.promise
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', '检查远程项目里的分析流程')
  await tick()
  routed = true
  gate.resolve('远程项目分析')
  await tick()
  assert.deepEqual(app.sessions[0].sessionNameCalls, ['远程项目分析'])
  assert.deepEqual(app.renamedSessions, [])
  assert.ok(app.updatedSessionManifests.some((entry) => entry.patch.titleSource === 'auto'))
})

test('T13 main memory: adapter receives only the selected project policy and local anchor, then joins resource cleanup', async () => {
  const calls: string[] = []
  let supplied: Record<string, unknown> | undefined
  const memory = {
    memoryBlock: 'trusted memory',
    tools: [],
    retire: () => {
      calls.push('retire')
    },
    close: async () => {
      calls.push('close')
    }
  }
  const app = await harness(undefined, {
    remoteRpc: true,
    remoteMemorySettings: { enabled: true, learn: true },
    remoteResourceScripts: async () => ({ tools: [], problems: [] }),
    projectMemoryAdapterCreate: async (options) => {
      supplied = options
      return memory
    }
  })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
    cwd: string
  }
  const loader = app.remoteRoutingOptions[0].loadDesktopTools as (
    identity: Record<string, string>,
    signal: AbortSignal
  ) => Promise<{ tools: Record<string, unknown>; memory?: unknown; close(): Promise<void> }>
  const resources = await loader(
    {
      runtimeSessionId: 'owner',
      sessionId: current.phiSessionId,
      projectId: 'remote-project-1',
      cwd: '/canonical/project',
      resourceCwd: current.cwd
    },
    new AbortController().signal
  )
  assert.equal(resources.memory, memory)
  assert.equal(supplied?.agentDir, '/isolated')
  assert.equal(supplied?.resourceCwd, current.cwd)
  assert.deepEqual(supplied?.settings, { enabled: true, learn: true })
  const beforeDispatch = supplied?.beforeDispatch as () => void
  beforeDispatch()
  await app.invoke('projects:updateMemory', 'remote-project-1', { enabled: false, learn: false })
  assert.throws(beforeDispatch, /记忆策略已改变/)
  assert.doesNotThrow(resources.tools.assertBinding as () => void)
  await resources.close()
  assert.deepEqual(calls, ['retire', 'close'])
})

for (const channel of ['memory:clear', 'memory:deleteLesson'] as const)
  test(`T13 main memory: ${channel} waits only for its project adapters before modifying worker memory`, async () => {
    const gate = deferred<void>()
    const retired: string[] = []
    const app = await harness(undefined, {
      projectMemoryRetire: async (id) => {
        retired.push(id)
        await gate.promise
      }
    })
    const before = app.bridgeRequests.length
    const mutation =
      channel === 'memory:clear'
        ? app.invoke(channel, 'remote-project-1')
        : app.invoke(channel, 'remote-project-1', 0, 'lesson')
    await tick()
    assert.deepEqual(retired, ['remote-project-1'])
    assert.equal(app.bridgeRequests.length, before)
    gate.resolve()
    await mutation
    assert.equal(
      app.bridgeRequests[before].method,
      channel === 'memory:clear' ? 'memory.clear' : 'memory.deleteLesson'
    )
    assert.deepEqual(
      (app.bridgeRequests[before].params as { cwd: string }).cwd,
      '/isolated/remote-project-anchors/remote-project-1'
    )
  })

test('T13 main memory: failed retirement prevents publication of a changed policy', async () => {
  const app = await harness(undefined, {
    remoteMemorySettings: { enabled: true, learn: true },
    projectMemoryRetire: async () => {
      throw new Error('owned memory close failed')
    }
  })
  await assert.rejects(
    app.invoke('projects:updateMemory', 'remote-project-1', { enabled: false, learn: false }),
    /owned memory close failed/
  )
  const snapshot = (await app.invoke('memory:snapshot', 'remote-project-1')) as {
    settings: { enabled: boolean; learn: boolean }
  }
  assert.deepEqual(snapshot.settings, { enabled: true, learn: true })
})

test('T13 main memory: only changed policies drain owned writers before publication', async () => {
  const gate = deferred<void>()
  const retired: string[] = []
  const app = await harness(undefined, {
    remoteMemorySettings: { enabled: true, learn: true },
    projectMemoryRetire: async (id) => {
      retired.push(id)
      await gate.promise
    }
  })
  await app.invoke('projects:updateMemory', 'remote-project-1', { enabled: true, learn: true })
  assert.deepEqual(retired, [])
  const saving = app.invoke('projects:updateMemory', 'remote-project-1', {
    enabled: false,
    learn: false
  })
  await tick()
  assert.deepEqual(retired, ['remote-project-1'])
  const before = (await app.invoke('memory:snapshot', 'remote-project-1')) as {
    settings: { enabled: boolean; learn: boolean }
  }
  assert.deepEqual(before.settings, { enabled: true, learn: true })
  gate.resolve()
  await saving
  const after = (await app.invoke('memory:snapshot', 'remote-project-1')) as {
    settings: { enabled: boolean; learn: boolean }
  }
  assert.deepEqual(after.settings, { enabled: false, learn: false })
})

test('T13 main memory: a pending policy update rejects a concurrent same-policy acknowledgement', async () => {
  const gate = deferred<void>()
  const app = await harness(undefined, {
    remoteMemorySettings: { enabled: true, learn: true },
    projectMemoryRetire: async () => {
      await gate.promise
    }
  })
  const saving = app.invoke('projects:updateMemory', 'remote-project-1', {
    enabled: false,
    learn: false
  })
  await tick()
  await assert.rejects(
    app.invoke('projects:updateMemory', 'remote-project-1', { enabled: true, learn: true }),
    /正在更新/
  )
  gate.resolve()
  await saving
  const snapshot = (await app.invoke('memory:snapshot', 'remote-project-1')) as {
    settings: { enabled: boolean; learn: boolean }
  }
  assert.deepEqual(snapshot.settings, { enabled: false, learn: false })
})

test('T13 main memory: a host rebind during retirement blocks a stale policy publication', async () => {
  const gate = deferred<void>()
  let host = 'original'
  const app = await harness(undefined, {
    remoteMemorySettings: { enabled: true, learn: true },
    remoteHostBinding: () => host,
    projectMemoryRetire: async () => {
      await gate.promise
    }
  })
  const saving = app.invoke('projects:updateMemory', 'remote-project-1', {
    enabled: false,
    learn: false
  })
  const rejected = assert.rejects(saving, /superseded|stale/i)
  await tick()
  host = 'replacement'
  gate.resolve()
  await rejected
  const snapshot = (await app.invoke('memory:snapshot', 'remote-project-1')) as {
    settings: { enabled: boolean; learn: boolean }
  }
  assert.deepEqual(snapshot.settings, { enabled: true, learn: true })
})

test('T13 main configuration: navigation during trusted initialization leaves the original prompt owner running', async () => {
  const gate = deferred<void>()
  let entered = false
  const app = await harness(undefined, {
    remoteRpc: true,
    remoteInstructionsRead: async () => {
      entered = true
      await gate.promise
      return []
    }
  })
  const first = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  const running = app.invoke('agent:prompt', 'initialize original owner')
  await tick()
  assert.equal(entered, true)
  const second = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  const peer = await app.invoke('sessions:current')
  gate.resolve()
  await running
  assert.equal(app.sessions.length, 1)
  assert.deepEqual(app.sessions[0].promptTexts, ['initialize original owner'])
  assert.equal(
    (app.createdAgentOptions[0].remoteProject as { phiSessionId: string }).phiSessionId,
    first.phiSessionId
  )
  assert.notEqual(first.phiSessionId, second.phiSessionId)
  assert.deepEqual(await app.invoke('sessions:current'), peer)
})

for (const channel of ['persona:setMarkdown', 'persona:completeOnboarding'] as const)
  test(`T13 main persona: ${channel} refuses a busy selected RPC session before saving or generating`, async () => {
    const owner = new FakeSession('held.jsonl')
    owner.hold = true
    const app = await harness(async () => owner, { remoteRpc: true })
    await app.invoke('projects:newRemoteSession', 'remote-project-1')
    const running = app.invoke('agent:prompt', 'hold original')
    await tick()
    const createdBefore = app.createdAgentOptions.length
    await assert.rejects(app.invoke(channel, 'New persona'), /运行结束/)
    assert.deepEqual(app.savedPersonas, [])
    assert.equal(app.createdAgentOptions.length, createdBefore)
    assert.equal(owner.log.includes('abort'), false)
    await app.invoke('agent:stop')
    await running
  })

test('T13 main persona: a late onboarding lookup cannot save or invalidate the new RPC view', async () => {
  const gate = deferred<void>()
  let held = false
  let entered = false
  const app = await harness(undefined, {
    remoteRpc: true,
    modelRuntimeGet: async () => {
      if (held) {
        entered = true
        await gate.promise
      }
    }
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  held = true
  const generating = app.invoke('persona:completeOnboarding', 'a helpful scientist')
  const rejected = assert.rejects(generating, /superseded|stale/i)
  await tick()
  assert.equal(entered, true)
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const peer = await app.invoke('sessions:current')
  gate.resolve()
  await rejected
  assert.deepEqual(app.savedPersonas, [])
  assert.equal(app.createdAgentOptions.length, 0)
  assert.deepEqual(await app.invoke('sessions:current'), peer)
})

test('T13 main persona: saving in an idle RPC view preserves an accepted background prompt persona', async () => {
  const owner = new FakeSession('held.jsonl')
  owner.hold = true
  const app = await harness(async () => owner, { remoteRpc: true })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const running = app.invoke('agent:prompt', 'background original persona')
  await tick()
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  assert.equal(await app.invoke('persona:setMarkdown', 'New idle persona'), 'New idle persona')
  assert.deepEqual(app.savedPersonas, ['New idle persona'])
  assert.equal(app.createdAgentOptions[0].personaMarkdown, '')
  assert.equal(owner.log.includes('abort'), false)
  owner.finish.resolve()
  await running
})

test('T13 main memory: ingestion diagnostics contain fixed identity fields only', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  const diagnose = app.remoteRoutingOptions[0].onMemoryError as (identity: {
    sessionId: string
    projectId: string
  }) => void
  diagnose({ sessionId: 'original-session', projectId: 'original-project' })
  const entry = app.appLogs.find((log) => log.event === 'project_memory_ingestion_failed')
  assert.equal(entry?.sessionId, 'original-session')
  assert.deepEqual(entry?.metadata, { projectId: 'original-project', reason: 'ingestion_failed' })
})

test('T13 main persona: manual compaction blocks both persona writers without cancelling the owned operation', async () => {
  const gate = deferred<void>()
  const app = await harness(undefined, { remoteRpc: true })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  await app.invoke('agent:prompt', 'materialize original')
  app.updatedSessionManifests.push({
    sessionId: current.phiSessionId,
    patch: {
      runtimeRef: {
        ompSessionId: 'saved-omp',
        journalBasename: 'saved.jsonl',
        checkpoint: { leafId: 'before' }
      }
    }
  })
  const target = compactionTarget(await app.invoke('sessions:current'))
  app.sessions[0].compactGate = gate.promise
  const compacting = app.invoke('sessions:compact', target)
  await tick()
  assert.equal(app.sessions[0].compactCalls, 1)
  const before = app.createdAgentOptions.length
  await assert.rejects(app.invoke('persona:setMarkdown', 'New persona'), /运行结束/)
  await assert.rejects(app.invoke('persona:completeOnboarding', 'New persona'), /运行结束/)
  assert.deepEqual(app.savedPersonas, [])
  assert.equal(app.createdAgentOptions.length, before)
  assert.equal(app.sessions[0].log.includes('abort'), false)
  gate.resolve()
  await compacting
})

test('T13 main persona: idle onboarding uses a disposable tool-less session before saving its confirmed text', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  assert.equal(await app.invoke('persona:completeOnboarding', 'a helpful scientist'), 'done')
  assert.deepEqual(app.savedPersonas, ['done'])
  assert.equal(app.createdAgentOptions.length, 1)
  assert.equal(app.createdAgentOptions[0].noTools, 'all')
  assert.equal(app.sessions[0].disposed, true)
})

function runtimeRecoveryTarget(
  current: unknown
): import('../src/shared/runtimeRecoveryTypes').RuntimeRecoveryTarget {
  const value = current as {
    phiSessionId: string
    projectId: string
    path: string
    sessionGeneration: number
  }
  return {
    sessionId: value.phiSessionId,
    projectId: value.projectId,
    sessionPath: value.path,
    sessionGeneration: value.sessionGeneration
  }
}
function savedRemoteReference(phiSessionId: string): runtimeReference.RemoteOmpRuntimeRef {
  const scope = {
    hostProfileId: 'host-1',
    bindingHash: 'a'.repeat(64),
    projectId: 'remote-project-1',
    projectRoot: '/canonical/project',
    runtimeRoot: '/remote/runtime'
  }
  return {
    ...scope,
    kind: 'remote-omp',
    version: 1,
    durableSessionKey: runtimeReference.remoteOmpDurableSessionKey(scope, phiSessionId),
    ompSessionId: 'saved-omp',
    journalBasename: 'saved.jsonl',
    ompVersion: '18.10.3'
  }
}

test('T15 main recovery: a cold RPC state and summary preview perform no initialization or policy writes', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  app.updatedSessionManifests.push({
    sessionId: current.phiSessionId,
    patch: {
      runtimeRef: savedRemoteReference(current.phiSessionId),
      model: { providerId: 'openai', modelId: 'gpt-test' }
    }
  })
  app.appendedSessionEvents.push({
    sessionId: current.phiSessionId,
    event: { type: 'user_message', content: 'Preserve the original research question.' }
  })
  const before = JSON.stringify(app.updatedSessionManifests)
  const state = (await app.invoke(
    'sessions:runtimeRecovery',
    runtimeRecoveryTarget(await app.invoke('sessions:current'))
  )) as import('../src/shared/runtimeRecoveryTypes').RuntimeRecoveryState
  assert.equal(state.phase, 'recovery-required')
  assert.equal(state.canResume, true)
  assert.match(state.summary!.content, /original research question/)
  assert.equal(app.createdAgentOptions.length, 0)
  assert.equal(JSON.stringify(app.updatedSessionManifests), before)
})

test('T15 main recovery: explicit summary continuation preserves old history and seeds a distinct unconnected RPC Phi', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  const reference = savedRemoteReference(current.phiSessionId)
  app.updatedSessionManifests.push({
    sessionId: current.phiSessionId,
    patch: { runtimeRef: reference }
  })
  app.appendedSessionEvents.push({
    sessionId: current.phiSessionId,
    event: { type: 'user_message', content: 'Safe local research context.' }
  })
  const target = runtimeRecoveryTarget(await app.invoke('sessions:current'))
  const state = (await app.invoke(
    'sessions:runtimeRecovery',
    target
  )) as import('../src/shared/runtimeRecoveryTypes').RuntimeRecoveryState
  await assert.rejects(
    app.invoke('sessions:continueRuntimeSummary', target, 'b'.repeat(64)),
    /来源历史已更新/
  )
  assert.equal(app.createdPhiSessions.length, 1)
  const result = (await app.invoke(
    'sessions:continueRuntimeSummary',
    target,
    state.summary!.provenance.sha256
  )) as import('../src/shared/runtimeRecoveryTypes').RuntimeSummaryContinuation
  assert.notEqual(result.phiSessionId, target.sessionId)
  assert.equal(result.connected, false)
  assert.equal(app.createdAgentOptions.length, 0)
  const seed = app.appendedSessionEvents.find(
    (entry) =>
      entry.sessionId === result.phiSessionId &&
      (entry.event as { type?: string }).type === 'runtime_recovery_summary'
  )
  assert.equal((seed!.event as { content: string }).content, state.summary!.content)
  const provider = app.remoteRoutingOptions[0].loadPromptContext as (
    identity: Record<string, string>,
    signal: AbortSignal
  ) => Promise<Record<string, unknown>>
  const selected = await provider(
    {
      runtimeSessionId: 'new-owner',
      sessionId: result.phiSessionId,
      projectId: result.projectId,
      cwd: '/canonical/project',
      resourceCwd: '/isolated/remote-project-anchors/remote-project-1'
    },
    new AbortController().signal
  )
  assert.equal(selected.recoverySummary, state.summary!.content)
  assert.deepEqual(
    app.updatedSessionManifests.filter((entry) => entry.sessionId === current.phiSessionId).at(-1)!
      .patch.runtimeRef,
    reference
  )
  assert.equal(
    app.appendedSessionEvents.filter(
      (entry) => (entry.event as { type?: string }).type === 'user_message'
    ).length,
    1
  )
})

test('T15 main recovery: disabled routing cannot create a summary Phi that would silently lose its seed on legacy execution', async () => {
  const app = await harness()
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  app.updatedSessionManifests.push({
    sessionId: current.phiSessionId,
    patch: { runtimeRef: savedRemoteReference(current.phiSessionId) }
  })
  const target = runtimeRecoveryTarget(await app.invoke('sessions:current'))
  const state = (await app.invoke(
    'sessions:runtimeRecovery',
    target
  )) as import('../src/shared/runtimeRecoveryTypes').RuntimeRecoveryState
  assert.equal(state.canResume, false)
  assert.equal(state.canContinueFromSummary, false)
  await assert.rejects(
    app.invoke('sessions:continueRuntimeSummary', target, state.summary!.provenance.sha256),
    /不能创建摘要会话/
  )
  assert.equal(app.createdPhiSessions.length, 1)
  assert.equal(app.createdAgentOptions.length, 0)
})

test('T15 main recovery: retired model aliases require an explicit replacement before any history or policy effects', async () => {
  const app = await harness(undefined, {
    remoteRpc: true,
    onCreateSession: async () => {
      throw new recoveryFailures.RemoteRecoveryError('FILE_INVALID', 'fixture refuses the journal')
    }
  })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  app.updatedSessionManifests.push({
    sessionId: current.phiSessionId,
    patch: {
      runtimeRef: savedRemoteReference(current.phiSessionId),
      model: { providerId: 'kimi-code', modelId: 'kimi-k2.5' }
    }
  })
  const target = runtimeRecoveryTarget(await app.invoke('sessions:current'))
  const beforeManifest = JSON.stringify(app.updatedSessionManifests)
  const beforeEvents = JSON.stringify(app.appendedSessionEvents)
  const state = (await app.invoke(
    'sessions:runtimeRecovery',
    target
  )) as import('../src/shared/runtimeRecoveryTypes').RuntimeRecoveryState
  assert.equal(state.issue, 'model-unavailable')
  await assert.rejects(
    app.invoke('sessions:resumeRuntime', target),
    (error) => (error as { code?: string }).code === 'MODEL_UNAVAILABLE'
  )
  assert.equal(app.createdAgentOptions.length, 0)
  assert.equal(JSON.stringify(app.updatedSessionManifests), beforeManifest)
  assert.equal(JSON.stringify(app.appendedSessionEvents), beforeEvents)
  await assert.rejects(
    app.invoke('sessions:resumeRuntime', target, {
      providerId: 'kimi-code',
      modelId: 'kimi-for-coding'
    }),
    /fixture refuses/
  )
  assert.equal(app.createdAgentOptions.length, 1)
  assert.deepEqual(app.createdAgentOptions[0].remoteRecovery, {
    replacementModel: { providerId: 'kimi-code', modelId: 'kimi-for-coding' }
  })
  assert.equal((app.createdAgentOptions[0].model as { id: string }).id, 'kimi-for-coding')
  assert.equal(JSON.stringify(app.updatedSessionManifests), beforeManifest)
  assert.equal(JSON.stringify(app.appendedSessionEvents), beforeEvents)
})

test('T15 main recovery: stopping a pending explicit attach cancels its own preparation and sends no prompt', async () => {
  let entered = false
  const app = await harness(undefined, {
    remoteRpc: true,
    onCreateSession: async (_options, control) => {
      entered = true
      assert.ok(control?.signal)
      await new Promise<void>((_resolve, reject) => {
        control.signal!.addEventListener('abort', () => reject(control.signal!.reason), {
          once: true
        })
      })
    }
  })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  app.updatedSessionManifests.push({
    sessionId: current.phiSessionId,
    patch: {
      runtimeRef: savedRemoteReference(current.phiSessionId),
      model: { providerId: 'openai', modelId: 'gpt-test' }
    }
  })
  const target = runtimeRecoveryTarget(await app.invoke('sessions:current'))
  const restoring = app.invoke('sessions:resumeRuntime', target)
  const rejected = assert.rejects(restoring, /取消/)
  await waitUntil(() => entered)
  await app.invoke('agent:stop')
  await rejected
  assert.equal(app.sessions.length, 0)
  assert.equal(app.appendedSessionEvents.length, 0)
})

test('T14 main controls: a confirmed background expert blocks persona and model policy edits without stopping its parent scope', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'materialize parent')
  app.sessions[0].hasActiveAgentRuns = () => true
  const before = JSON.stringify(app.updatedSessionManifests)
  await assert.rejects(app.invoke('persona:setMarkdown', 'New persona'), /专家任务/)
  await assert.rejects(app.invoke('models:select', 'openai', 'gpt-test'), /专家任务/)
  assert.deepEqual(app.savedPersonas, [])
  assert.equal(JSON.stringify(app.updatedSessionManifests), before)
  assert.equal(app.sessions[0].log.includes('abort'), false)
})

test('T14 main resources: selected experts receive real enabled skill content and missing names do not load local fallback files', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
    cwd: string
  }
  const load = app.remoteRoutingOptions[0].loadAgentResources as (
    identity: Record<string, string>,
    definitions: readonly { skills: string[] }[],
    signal: AbortSignal
  ) => Promise<{ skills: readonly { name: string; description: string; markdown: string }[] }>
  const identity = {
    runtimeSessionId: 'parent',
    sessionId: current.phiSessionId,
    projectId: 'remote-project-1',
    cwd: '/canonical/project',
    resourceCwd: current.cwd
  }
  const resources = await load(identity, [{ skills: ['global'] }], new AbortController().signal)
  assert.deepEqual(resources.skills, [
    { name: 'global', description: 'global skill', markdown: '# global skill\n' }
  ])
  await assert.rejects(
    load(identity, [{ skills: ['not-selected'] }], new AbortController().signal),
    /专家技能不可用/
  )
})

test('T14 main resources: a background child gets verified service ownership and late terminal ownership cannot dispatch', async () => {
  let routed = false
  let active = true
  let calls = 0
  let checked = 0
  const gate = deferred<void>()
  const app = await harness(undefined, {
    remoteRpc: true,
    routedRuntime: () => routed,
    childResourceOwner: (_runtime, child) => {
      checked += 1
      assert.equal(child, 'owned-child')
      if (!active) throw new Error('child ownership expired')
      return { toolOwner: 'Checker', allowedSkills: ['global'] }
    },
    remoteScriptRun: async (_params, control) => {
      calls += 1
      assert.deepEqual(control?.resourceOwner, { toolOwner: 'Checker', allowedSkills: ['global'] })
      control?.beforeDispatch()
      await gate.promise
      control?.beforeDispatch()
      return { ok: true }
    }
  })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  await app.invoke('agent:prompt', 'materialize parent and end its prompt')
  routed = true
  const runtimeId = app.sessions[0].runtimeSessionId
  const execute = app.hostHandlers.get('skills.scriptTool')!
  const pending = execute(
    {
      runtimeSessionId: runtimeId,
      remoteSessionId: current.phiSessionId,
      projectId: 'remote-project-1',
      requestId: 'request',
      tool: 'global_command',
      args: {},
      toolOwner: 'main',
      allowedSkills: ['not-selected']
    },
    { originSessionId: runtimeId, agentRunId: 'owned-child', signal: new AbortController().signal }
  )
  const rejected = assert.rejects(pending, /child ownership expired/)
  await tick()
  assert.equal(calls, 1)
  active = false
  gate.resolve()
  await rejected
  assert.ok(checked >= 3)
})

test('T15 main recovery: an accepted explicit attach stays with its original owner after navigation and publishes only confirmed model metadata', async () => {
  const gate = deferred<void>()
  let entered = false
  let sessionId = ''
  const app = await harness(undefined, {
    remoteRpc: true,
    routedRuntime: () => true,
    runtimeSessionReady: () => true,
    onCreateSession: async (options, control) => {
      entered = true
      await gate.promise
      control?.assertCurrent()
      const model = options.model as { provider: string; id: string }
      app.updatedSessionManifests.push({
        sessionId,
        patch: {
          model: { providerId: model.provider, modelId: model.id },
          thinkingLevel: 'high',
          runtimeRef: {
            ...reference,
            checkpoint: { leafId: 'confirmed', verifiedAt: '2026-10-15T00:00:00.000Z' }
          }
        }
      })
    }
  })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
    path: string
  }
  sessionId = current.phiSessionId
  const reference = savedRemoteReference(sessionId)
  app.updatedSessionManifests.push({
    sessionId,
    patch: { runtimeRef: reference, model: { providerId: 'openai', modelId: 'gpt-test' } }
  })
  const restoring = app.invoke(
    'sessions:resumeRuntime',
    runtimeRecoveryTarget(await app.invoke('sessions:current')),
    { providerId: 'openai', modelId: 'gpt-vision-test' }
  )
  await waitUntil(() => entered)
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const peer = await app.invoke('sessions:current')
  gate.resolve()
  const restored =
    (await restoring) as import('../src/shared/runtimeRecoveryTypes').RuntimeRecoveryState
  assert.equal(restored.phase, 'connected')
  assert.equal(restored.target.sessionId, sessionId)
  assert.deepEqual(await app.invoke('sessions:current'), peer)
  assert.deepEqual(app.sessions[0].promptTexts, [])
  assert.equal(app.appendedSessionEvents.length, 0)
  await app.invoke('sessions:switch', current.path)
  assert.deepEqual(await app.invoke('models:selected'), {
    providerId: 'openai',
    modelId: 'gpt-vision-test'
  })
  const state = (await app.invoke(
    'sessions:runtimeRecovery',
    runtimeRecoveryTarget(await app.invoke('sessions:current'))
  )) as import('../src/shared/runtimeRecoveryTypes').RuntimeRecoveryState
  assert.equal(state.phase, 'connected')
  assert.equal(state.canResume, false)
})

test('T15 main jobs: restart metadata is readonly, live IDs win, and listing failure never invents interrupted tasks', async () => {
  let reads = 0
  const app = await harness(undefined, {
    remoteRpc: true,
    coldRuntimeOrigin: (id) =>
      id === 'live-runtime' ? { phiSessionId: 'phi-1', cwd: '/fixture/remote' } : undefined,
    coldChildRuns: (phiSessionId) => {
      reads += 1
      return ['old-child', 'live-child'].map((id) => ({
        id,
        phiSessionId,
        agent: 'Researcher',
        background: true,
        status: 'interrupted',
        startedAt: Date.parse('2026-10-01T00:00:00Z'),
        canControl: false,
        historyAvailable: false,
        nativeId: 'private-native',
        childSessionFile: '/private/server/child.jsonl'
      }))
    }
  })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  app.updatedSessionManifests.push({
    sessionId: current.phiSessionId,
    patch: { runtimeRef: savedRemoteReference(current.phiSessionId) }
  })
  app.setBridgeAgentJobs([
    {
      agentSessionId: 'live-runtime',
      agentRunId: 'live-child',
      agentName: 'Researcher',
      task: 'Confirmed live task',
      state: 'running',
      background: true,
      startedAt: Date.now()
    }
  ])
  const jobs = (await app.invoke('jobs:listAgents')) as Array<Record<string, unknown>>
  assert.equal(jobs.length, 2)
  assert.equal(jobs.filter((job) => job.agentRunId === 'live-child').length, 1)
  const cold = jobs.find((job) => job.agentRunId === 'old-child')!
  assert.equal(cold.agentSessionId, '')
  assert.equal(cold.state, 'interrupted')
  assert.equal(cold.canControl, false)
  assert.equal(cold.historyAvailable, false)
  assert.equal(cold.sessionPath, `phi-session:${current.phiSessionId}`)
  assert.equal(cold.task, '')
  assert.equal('nativeId' in cold, false)
  assert.equal('childSessionFile' in cold, false)
  const before = reads
  app.failBridgeRequests(new Error('live listing unavailable'))
  await assert.rejects(app.invoke('jobs:listAgents'), /live listing unavailable/)
  assert.equal(reads, before)
  assert.equal(app.createdAgentOptions.length, 0)
})

test('T14 main approvals: a finished parent child uses one durable event and only its original conversation attention', async () => {
  const app = await harness(undefined, { remoteRpc: true })
  const original = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  await app.invoke('agent:prompt', 'launch an expert')
  const peer = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  const observer = app.remoteRoutingOptions[0].onChildApprovalEvent as (
    event: Record<string, unknown>,
    parent: unknown
  ) => void
  assert.ok(observer)
  const request = {
    requestId: 'approval-child-1',
    sessionId: original.phiSessionId,
    runId: 'child-1',
    agentRunId: 'child-1',
    toolCallId: 'child-tool',
    toolName: 'write',
    summary: 'write approved result',
    cwd: '/canonical/project'
  }
  const event = {
    type: 'approval_requested',
    sessionId: original.phiSessionId,
    runId: 'child-1',
    approvalId: request.requestId,
    toolCallId: request.toolCallId,
    request
  }
  app.appendedSessionEvents.push({
    sessionId: original.phiSessionId,
    event: { ...event, agentRunId: 'child-1', parentRunId: 'old-parent' }
  })
  const before = app.appendedSessionEvents.length
  observer(event, { sessionId: original.phiSessionId, runId: 'old-parent' })
  observer(event, { sessionId: original.phiSessionId, runId: 'old-parent' })
  assert.equal(app.appendedSessionEvents.length, before)
  assert.equal(
    app.updatedSessionManifests.filter((entry) => entry.sessionId === original.phiSessionId).at(-1)
      ?.patch.status,
    'needs_approval'
  )
  assert.equal(
    app.updatedSessionManifests.some(
      (entry) => entry.sessionId === peer.phiSessionId && entry.patch.status === 'needs_approval'
    ),
    false
  )
  const outcomeBefore = app.updatedSessionManifests
    .filter((entry) => entry.sessionId === original.phiSessionId && 'lastRunOutcome' in entry.patch)
    .at(-1)?.patch.lastRunOutcome
  app.appendedSessionEvents.push({
    sessionId: original.phiSessionId,
    event: { ...event, type: 'approval_denied', agentRunId: 'child-1', parentRunId: 'old-parent' }
  })
  observer(
    { ...event, type: 'approval_denied' },
    { sessionId: original.phiSessionId, runId: 'old-parent' }
  )
  assert.equal(
    app.updatedSessionManifests.filter((entry) => entry.sessionId === original.phiSessionId).at(-1)
      ?.patch.status,
    'failed'
  )
  assert.equal(
    app.updatedSessionManifests
      .filter(
        (entry) => entry.sessionId === original.phiSessionId && 'lastRunOutcome' in entry.patch
      )
      .at(-1)?.patch.lastRunOutcome,
    outcomeBefore
  )
  assert.equal(app.appendedSessionEvents.length, before + 1)
  assert.equal(
    ((await app.invoke('sessions:current')) as { phiSessionId: string }).phiSessionId,
    peer.phiSessionId
  )
})

test('T15 main controls: a known cold remote runtime cannot forward stop or steer to the legacy worker', async () => {
  const app = await harness(undefined, {
    remoteRpc: true,
    coldRuntimeOrigin: (id) =>
      id === 'cold-runtime' ? { phiSessionId: 'phi-1', cwd: '/fixture/remote' } : undefined
  })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  app.updatedSessionManifests.push({
    sessionId: current.phiSessionId,
    patch: { runtimeRef: savedRemoteReference(current.phiSessionId) }
  })
  const before = app.bridgeRequests.length
  await assert.rejects(
    app.invoke('agent:stopRun', 'cold-runtime', 'same-child-id'),
    /没有可控制的连接/
  )
  await assert.rejects(
    app.invoke('agent:steerRun', 'cold-runtime', 'same-child-id', 'continue'),
    /没有可控制的连接/
  )
  assert.equal(app.bridgeRequests.length, before)
  await app.invoke('agent:stopRun', 'unknown-local-runtime', 'local-child')
  assert.equal(app.bridgeRequests.at(-1)?.method, 'agentRun.stop')
})

test('T14 main environments: selected experts use a readonly ready descriptor and close workspace on missing or rebound environments', async () => {
  let host = 'cluster-one',
    closed = 0,
    reads = 0
  let result: unknown = undefined
  let rebound = false
  const app = await harness(undefined, {
    remoteRpc: true,
    remoteNotebookBinding: () => host,
    remoteRuntimeWorkspace: async () => {
      const host = { capabilities: () => ({}), fs: {}, exec: {} }
      return {
        projectHost: host,
        runtimeHost: host,
        close: async () => {
          closed += 1
        }
      }
    },
    readyEnvironmentRead: async () => {
      reads += 1
      if (rebound) host = 'replacement'
      return result
    }
  })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
    cwd: string
  }
  const resolve = app.remoteRoutingOptions[0].resolveAgentEnvironment as (
    identity: Record<string, string>,
    agent: { environment: string; pluginId: string },
    signal: AbortSignal
  ) => Promise<Record<string, unknown>>
  const identity = {
    runtimeSessionId: 'parent',
    sessionId: current.phiSessionId,
    projectId: 'remote-project-1',
    cwd: '/canonical/project',
    resourceCwd: current.cwd
  }
  const agent = { environment: 'r-analysis', pluginId: 'trusted-plugin' }
  await assert.rejects(resolve(identity, agent, new AbortController().signal), /尚未就绪/)
  assert.equal(closed, 1)
  result = {
    ref: agent.environment,
    environmentId: 'content-env',
    lockSha256: 'b'.repeat(64),
    status: 'ready',
    execution: {
      runtimeRoot: '/runtime',
      micromambaPath: '/runtime/bin/micromamba',
      prefixPath: '/runtime/envs/content-env',
      markerPath: '/runtime/envs/content-env/.phi-ready',
      markerSha256: 'c'.repeat(64)
    }
  }
  const descriptor = await resolve(identity, agent, new AbortController().signal)
  assert.equal(descriptor.environmentId, 'content-env')
  assert.equal(descriptor.pluginId, agent.pluginId)
  assert.deepEqual(descriptor.binding, {
    serverId: 'host-1',
    serverIdentitySha256: 'a'.repeat(64),
    projectId: 'remote-project-1',
    projectRoot: '/canonical/project'
  })
  assert.deepEqual(descriptor.execution, (result as Record<string, unknown>).execution)
  assert.equal(closed, 2)
  rebound = true
  await assert.rejects(resolve(identity, agent, new AbortController().signal), /绑定已改变/)
  assert.equal(closed, 3)
  assert.equal(reads, 3)
  assert.equal(app.createdAgentOptions.length, 0)
  assert.equal(app.approvalOptions.length, 0)
})

test('T14 main browser: a verified background child keeps its own browser actor after its parent finishes', async () => {
  let routed = false
  let live = true,
    checked = 0
  const app = await harness(undefined, {
    remoteRpc: true,
    routedRuntime: () => routed,
    childResourceOwner: (_runtime, child) => {
      checked += 1
      if (!live || child !== 'browser-child') throw new Error('child browser ownership ended')
      return { toolOwner: 'Researcher', allowedSkills: [] }
    }
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await app.invoke('agent:prompt', 'start background browser research')
  routed = true
  const execute = app.hostHandlers.get('browser.execute')!
  const runtimeId = app.sessions[0].runtimeSessionId
  const context = {
    originSessionId: runtimeId,
    agentRunId: 'browser-child',
    signal: new AbortController().signal
  }
  const request = {
    originSessionId: runtimeId,
    requestId: 'child-open',
    toolCallId: 'child-browser-call',
    command: { type: 'open', requestId: 'child-open', url: 'https://child.example.test' }
  }
  const result = (await execute(request, context)) as {
    ok: boolean
    snapshot: { tabs: Array<{ id: string; documentRevision: number }> }
  }
  assert.equal(result.ok, true)
  assert.equal(app.browserViews.length, 1)
  assert.ok(checked >= 3)
  await assert.rejects(
    execute(
      {
        ...request,
        requestId: 'child-type',
        command: {
          type: 'typeText',
          requestId: 'child-type',
          tabId: result.snapshot.tabs[0].id,
          expectedDocumentRevision: result.snapshot.tabs[0].documentRevision,
          requireActive: true,
          text: 'private text',
          consequence: 'write'
        }
      },
      context
    ),
    /text input is unavailable/
  )
  live = false
  await assert.rejects(
    async () =>
      execute(
        {
          ...request,
          requestId: 'late-open',
          command: { ...request.command, requestId: 'late-open' }
        },
        context
      ),
    /ownership ended/
  )
  const cancel = app.hostHandlers.get('browser.cancel')!
  await cancel(
    { originSessionId: runtimeId, requestId: request.requestId, toolCallId: request.toolCallId },
    context
  )
  assert.equal(app.browserViews.length, 1)
  assert.equal(app.createdAgentOptions.length, 1)
})

test('T15 main recovery: closing the window cancels accepted background preparation without dispatching a prompt', async () => {
  let entered = false,
    cancelled = false
  const app = await harness(undefined, {
    remoteRpc: true,
    onCreateSession: async (_options, control) => {
      entered = true
      await new Promise<void>((_resolve, reject) => {
        const abort = (): void => {
          cancelled = true
          reject(new Error('owned recovery cancelled'))
        }
        control?.signal?.addEventListener('abort', abort, { once: true })
        if (control?.signal?.aborted) abort()
      })
    }
  })
  const current = (await app.invoke('projects:newRemoteSession', 'remote-project-1')) as {
    phiSessionId: string
  }
  app.updatedSessionManifests.push({
    sessionId: current.phiSessionId,
    patch: {
      runtimeRef: savedRemoteReference(current.phiSessionId),
      model: { providerId: 'openai', modelId: 'gpt-test' }
    }
  })
  const restoring = app.invoke(
    'sessions:resumeRuntime',
    runtimeRecoveryTarget(await app.invoke('sessions:current'))
  )
  const rejected = assert.rejects(restoring, /cancelled/)
  await waitUntil(() => entered)
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  app.closeMainWindow()
  await rejected
  assert.equal(cancelled, true)
  assert.equal(app.sessions.length, 0)
  assert.equal(app.appendedSessionEvents.length, 0)
})

test('main model preference: new local and remote chats inherit the latest manual choice across restart', async () => {
  const preferences: HarnessOptions = {}
  const app = await harness(undefined, preferences)
  await app.invoke('projects:newSession', '/projects/defaults', 'ask')
  const first = app.createdPhiSessions[0]
  assert.deepEqual(first.model, { providerId: 'anthropic', modelId: 'claude-test' })
  await app.invoke('models:select', 'openai', 'gpt-test')
  const expected = { providerId: 'openai', modelId: 'gpt-test' }
  assert.deepEqual(preferences.lastSelectedModel, expected)
  await app.invoke('sessions:create')
  assert.deepEqual(app.createdPhiSessions.at(-1)?.model, expected)
  await app.invoke('projects:newSession', '/projects/defaults', 'ask')
  assert.deepEqual(app.createdPhiSessions.at(-1)?.model, expected)
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  assert.deepEqual(app.createdPhiSessions.at(-1)?.model, expected)
  await app.invoke('models:select', 'openai', 'gpt-vision-test')
  await app.invoke('sessions:switch', `phi-session:${first.sessionId}`)
  assert.deepEqual(await app.invoke('models:selected'), expected)
  assert.deepEqual(preferences.lastSelectedModel, {
    providerId: 'openai',
    modelId: 'gpt-vision-test'
  })
  const restarted = await harness(undefined, preferences)
  await restarted.invoke('sessions:create')
  assert.deepEqual(restarted.createdPhiSessions.at(-1)?.model, preferences.lastSelectedModel)
})

test('main model preference: explicit automatic overrides project defaults and stays automatic after a run', async () => {
  const preferences: HarnessOptions = {}
  const app = await harness(undefined, preferences)
  await app.invoke('projects:newSession', '/projects/defaults', 'ask')
  await app.invoke('models:select', null, null)
  assert.equal(await app.invoke('models:selected'), null)
  assert.equal(preferences.lastSelectedModel, null)
  await app.invoke('agent:prompt', 'use automatic selection')
  assert.equal(await app.invoke('models:selected'), null)
  await app.invoke('projects:newSession', '/projects/defaults', 'ask')
  assert.equal(app.createdPhiSessions.at(-1)?.model, null)
  const restarted = await harness(undefined, preferences)
  await restarted.invoke('projects:newRemoteSession', 'remote-project-1')
  assert.equal(restarted.createdPhiSessions.at(-1)?.model, null)
  assert.equal(await restarted.invoke('models:selected'), null)
})

test('main model preference: rejected choices do not replace the remembered model', async () => {
  const preferences: HarnessOptions = {
    lastSelectedModel: { providerId: 'openai', modelId: 'gpt-test' }
  }
  const session = new FakeSession('model-choice.jsonl')
  const app = await harness(async () => session, preferences)
  await app.invoke('sessions:create')
  await app.invoke('agent:prompt', 'materialize session')
  session.setModel = async () => {
    throw new Error('Model change rejected')
  }
  await assert.rejects(
    app.invoke('models:select', 'openai', 'gpt-vision-test'),
    /Model change rejected/
  )
  await assert.rejects(app.invoke('models:select', 'missing', 'gone'), /未知模型/)
  assert.deepEqual(preferences.lastSelectedModel, { providerId: 'openai', modelId: 'gpt-test' })
  assert.deepEqual(await app.invoke('models:selected'), preferences.lastSelectedModel)
})

test('main model preference: unavailable saved model is retained without silently selecting another model', async () => {
  const unavailable = { providerId: 'missing', modelId: 'gone' }
  const app = await harness(undefined, { lastSelectedModel: unavailable })
  await app.invoke('projects:newSession', '/projects/defaults', 'ask')
  assert.deepEqual(app.createdPhiSessions.at(-1)?.model, unavailable)
  assert.deepEqual(await app.invoke('models:selected'), unavailable)
  await assert.rejects(
    app.invoke('agent:prompt', 'keep the unavailable choice visible'),
    /模型不可用/
  )
})

for (const latest of ['fixed', 'automatic'] as const) {
  test(`main model preference: delayed fixed selection cannot overwrite a newer ${latest} choice`, async () => {
    const preferences: HarnessOptions = {
      lastSelectedModel: { providerId: 'openai', modelId: 'gpt-test' }
    }
    const session = new FakeSession('ordered-model-choice.jsonl')
    const app = await harness(async () => session, preferences)
    const current = (await app.invoke('sessions:create')) as { phiSessionId: string }
    await app.invoke('agent:prompt', 'materialize selection target')
    const gate = deferred<void>()
    let entered = false
    session.setModel = async (model) => {
      if (model.id === 'gpt-vision-test') {
        entered = true
        await gate.promise
      }
      session.model = model
    }
    const earlier = app.invoke('models:select', 'openai', 'gpt-vision-test')
    await waitUntil(() => entered)
    const newer =
      latest === 'automatic'
        ? app.invoke('models:select', null, null)
        : app.invoke('models:select', 'openai', 'gpt-session')
    await tick()
    gate.resolve()
    await Promise.all([earlier, newer])
    const expected =
      latest === 'automatic' ? null : { providerId: 'openai', modelId: 'gpt-session' }
    assert.deepEqual(await app.invoke('models:selected'), expected)
    assert.deepEqual(preferences.lastSelectedModel, expected)
    assert.deepEqual(
      app.updatedSessionManifests
        .filter((entry) => entry.sessionId === current.phiSessionId && 'model' in entry.patch)
        .at(-1)?.patch.model,
      expected
    )
    if (latest === 'fixed') assert.equal(session.model?.id, 'gpt-session')
    await app.invoke('sessions:create')
    assert.deepEqual(app.createdPhiSessions.at(-1)?.model, expected)
  })
}

test('main model preference: rejected earlier switch does not block a newer model selection', async () => {
  const preferences: HarnessOptions = {
    lastSelectedModel: { providerId: 'openai', modelId: 'gpt-test' }
  }
  const session = new FakeSession('rejected-model-choice.jsonl')
  const app = await harness(async () => session, preferences)
  await app.invoke('sessions:create')
  await app.invoke('agent:prompt', 'materialize selection target')
  const gate = deferred<void>()
  let entered = false
  session.setModel = async (model) => {
    if (model.id === 'gpt-vision-test') {
      entered = true
      await gate.promise
      throw new Error('Earlier switch failed')
    }
    session.model = model
  }
  const earlier = app.invoke('models:select', 'openai', 'gpt-vision-test')
  const rejected = assert.rejects(earlier, /Earlier switch failed/)
  await waitUntil(() => entered)
  const newer = app.invoke('models:select', 'openai', 'gpt-session')
  gate.resolve()
  await Promise.all([rejected, newer])
  assert.equal(session.model?.id, 'gpt-session')
  assert.deepEqual(preferences.lastSelectedModel, { providerId: 'openai', modelId: 'gpt-session' })
})

test('main model preference: an older switch finishing after another conversation preserves the newer global choice', async () => {
  const preferences: HarnessOptions = {
    lastSelectedModel: { providerId: 'openai', modelId: 'gpt-test' }
  }
  const session = new FakeSession('first-model-choice.jsonl')
  const app = await harness(async () => session, preferences)
  const first = (await app.invoke('sessions:create')) as { path: string }
  await app.invoke('agent:prompt', 'materialize first target')
  const gate = deferred<void>()
  let entered = false
  session.setModel = async (model) => {
    entered = true
    await gate.promise
    session.model = model
  }
  const earlier = app.invoke('models:select', 'openai', 'gpt-vision-test')
  await waitUntil(() => entered)
  await app.invoke('sessions:create')
  await app.invoke('models:select', 'openai', 'gpt-session')
  await app.invoke('sessions:switch', first.path)
  gate.resolve()
  await earlier
  assert.deepEqual(await app.invoke('models:selected'), {
    providerId: 'openai',
    modelId: 'gpt-vision-test'
  })
  assert.deepEqual(preferences.lastSelectedModel, { providerId: 'openai', modelId: 'gpt-session' })
  await app.invoke('sessions:create')
  assert.deepEqual(app.createdPhiSessions.at(-1)?.model, preferences.lastSelectedModel)
})

test('main model preference: RPC automatic selection rejects before changing a fresh remote conversation', async () => {
  const preferences: HarnessOptions = {
    remoteRpc: true,
    lastSelectedModel: { providerId: 'openai', modelId: 'gpt-test' }
  }
  const app = await harness(undefined, preferences)
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  const before = JSON.stringify(app.updatedSessionManifests)
  await assert.rejects(
    app.invoke('models:select', null, null),
    /远程 RPC 对话暂不支持自动模型，请选择具体模型/
  )
  assert.equal(JSON.stringify(app.updatedSessionManifests), before)
  assert.deepEqual(await app.invoke('models:selected'), preferences.lastSelectedModel)
  assert.deepEqual(preferences.lastSelectedModel, { providerId: 'openai', modelId: 'gpt-test' })
})

for (const remoteRpc of [false, true]) {
  test(`main model preference: global automatic ${remoteRpc ? 'keeps RPC project defaults' : 'remains automatic for legacy remote sessions'}`, async () => {
    const defaultModel = { providerId: 'openai', modelId: 'gpt-test' }
    const preferences: HarnessOptions = {
      remoteRpc,
      lastSelectedModel: null,
      remoteDefaultModel: defaultModel
    }
    const app = await harness(undefined, preferences)
    await app.invoke('projects:newRemoteSession', 'remote-project-1')
    const expected = remoteRpc ? defaultModel : null
    assert.deepEqual(app.createdPhiSessions.at(-1)?.model, expected)
    assert.deepEqual(await app.invoke('models:selected'), expected)
    assert.equal(preferences.lastSelectedModel, null)
    if (remoteRpc) {
      await app.invoke(
        'agent:prompt',
        'initialize remote conversation with the supported project model'
      )
      assert.equal(
        app.createdAgentOptions[0].model && (app.createdAgentOptions[0].model as { id: string }).id,
        defaultModel.modelId
      )
      assert.equal(preferences.lastSelectedModel, null)
    }
  })
}

test('main model preference: RPC conversation without a concrete model reports an actionable preflight error', async () => {
  const app = await harness(undefined, {
    remoteRpc: true,
    lastSelectedModel: null,
    remoteDefaultModel: null
  })
  await app.invoke('projects:newRemoteSession', 'remote-project-1')
  await assert.rejects(
    app.invoke('agent:prompt', 'initialize a remote conversation without a supported model'),
    /远程 RPC 对话暂不支持自动模型，请选择具体模型/
  )
  assert.equal(app.createdAgentOptions.length, 0)
})
