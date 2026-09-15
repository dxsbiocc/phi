import './agent-env'
import {
  closeSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import {
  app,
  shell,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme
} from 'electron'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createAgentSession } from './agent/session/session-manager'
import { getAuthManager } from './agent/auth-manager'
import {
  fallbackMarkdownFromDescription,
  getPersonaMarkdown,
  isOnboarded,
  setPersonaMarkdown,
  skipOnboarding
} from './agent/persona-manager'
import {
  WORKSPACE_DIR,
  acknowledgeSession,
  createSessionManager,
  deleteSession,
  isPhiOnlySessionPath,
  listSessions,
  phiOnlySessionPath,
  phiSessionIdFromPath,
  renameSession
} from './agent/session/sessions'
import {
  createProject,
  deleteProject,
  assertProjectPathAvailable,
  getProjectByCwd,
  listProjects,
  updateProjectPermissionMode,
  updateProjectDefaults,
  updateProjectRemoteConnection,
  updateProjectRemoteDefaults,
  type PermissionMode,
  type ModelSelection,
  type ProjectRemoteConnection
} from './agent/projects'
import {
  deleteRemoteConnectionPassphrase,
  isRemoteCredentialStorageAvailable,
  storeRemoteConnectionPassphrase
} from './agent/wrappers/remote-credential-store'
import {
  cancelToolApprovals,
  createApprovalExtension,
  resolveToolApproval
} from './agent/tool-approval'
import {
  createInMemoryRuntimeSessionManager,
  createRuntimeResourceLoader,
  openRuntimeSessionManager,
  type ModelRuntime,
  type RuntimeModel,
  type RuntimeResourceLoader
} from './agent/runtime/runtime-adapter'
import { installPlugin, listPlugins, removePlugin } from './agent/plugins'
import { listMcpServers, listPromptAgents, listSkills } from './agent/resources'
import {
  addCustomWrapper,
  ensureBundledWrappersInstalled,
  listWrapperCatalog
} from './agent/wrappers/catalog'
import { reconcileRemoteWrapperRuns } from './agent/wrappers/executor-slurm-reconcile'
import { buildWrapperReproducibilityBundle } from './agent/wrappers/reproducibility'
import { cancelWrapperRun, cancelWrapperRunPlan, submitWrapperRunPlan } from './agent/wrappers/runs'
import {
  listWrapperRuns,
  readWrapperPlan,
  readWrapperPlanArtifact,
  readWrapperRun
} from './agent/wrappers/store'
import { formatDiagnostics, type DiagnosticsSnapshot } from './agent/diagnostics'
import { LOG_RETENTION_DAYS, cleanupOldLogs, getPhiLogDir, writeAppLog } from './agent/app-logger'
import { redactSensitiveText } from './agent/redaction'
import {
  emptyNotebookRegistry,
  initializeProjectAnalysis,
  listProjectNotebooks
} from './agent/notebook/analysis-notebooks'
import {
  closeProjectNotebook,
  createProjectNotebook,
  deleteProjectNotebook,
  openProjectNotebook,
  saveProjectNotebook,
  type SaveProjectNotebookInput
} from './agent/notebook/analysis-notebook-files'
import { AnalysisNotebookFileWatcher } from './agent/notebook/analysis-notebook-watch'
import { detectAnalysisKernels } from './agent/notebook/analysis-kernels'
import { JupyterServerRegistry } from './agent/notebook/analysis-jupyter-server'
import {
  AnalysisNotebookExecutor,
  type JupyterKernelCompletionResult,
  type NotebookVariableIntrospection
} from './agent/notebook/analysis-jupyter-execution'
import {
  completeNotebookPythonStaticCompletion,
  mergeNotebookCompletionResults
} from './agent/notebook/analysis-notebook-completion'
import { formatNotebookCellSource } from './agent/notebook/analysis-notebook-formatting'
import { AnalysisNotebookSessionRegistry } from './agent/notebook/analysis-jupyter-sessions'
import {
  buildNotebookCodeGenerationRepairPrompt,
  buildNotebookCodeGenerationPrompt,
  generatedNotebookCellsSource,
  notebookCellPromptContext,
  notebookGenerationEmptyResultMessage,
  parseFinalGeneratedNotebookCompletion,
  parseGeneratedNotebookCompletionSnapshot
} from './agent/notebook/notebook-code-generation'
import { AnalysisNotebookToolExecutor } from './agent/notebook/notebook-tool-executor'
import { getOmpBridge } from './agent/omp/omp-bridge'
import {
  isStaleSessionError,
  StaleSessionError,
  SessionLifecycle,
  type SessionLifecycleRecord,
  type SessionSnapshot
} from './agent/session/session-lifecycle'
import { SessionRunnerRegistry } from './agent/session/session-runner-registry'
import {
  appendSessionEvent,
  createPhiSession,
  createRunId,
  findPhiSessionById,
  findPhiSessionByRuntimePath,
  persistToolOutput,
  readSessionEvents,
  recoverInterruptedPhiSessions,
  updateSessionManifest,
  type LastRunOutcome,
  type PhiSessionManifest,
  type SessionStatus,
  type StoredSessionEvent,
  type UnreadKind,
  listPhiSessions
} from './agent/session/session-store'
import {
  updateNotebookCell,
  type JsonObject,
  type NotebookDocument
} from '../shared/notebookDocument'
import { messageContentTitleText } from '../shared/sessionTitle'
import icon from '../../resources/icon.png?asset'

const APP_NAME = 'Phi'
const APP_ID = 'com.electron.app'
const DEFAULT_WINDOW_WIDTH = 1280
const DEFAULT_WINDOW_HEIGHT = 820
const MIN_WINDOW_WIDTH = 860
const MIN_WINDOW_HEIGHT = 560
const appIcon = nativeImage.createFromPath(icon)
// Set by agent-env.ts before this module's own top-level code runs.
const AGENT_DIR = process.env.PI_CODING_AGENT_DIR as string

app.setName(APP_NAME)

function applyDockIcon(): void {
  if (process.platform === 'darwin' && !appIcon.isEmpty()) {
    app.dock?.setIcon(appIcon)
  }
}

let mainWindow: BrowserWindow | null = null
let mainWindowCleanupStarted = false

type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const THINKING_LEVEL_ORDER: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const TOOL_OUTPUT_INLINE_LIMIT = 20000
const FILE_PREVIEW_BYTES_LIMIT = 320000
const FILE_MEDIA_PREVIEW_BYTES_LIMIT = 10 * 1024 * 1024
const FILE_HOVER_TEXT_BYTES_LIMIT = 32 * 1024
const FILE_HOVER_IMAGE_BYTES_LIMIT = 2 * 1024 * 1024
const FILE_HOVER_SNIFF_BYTES_LIMIT = 512
const LOCAL_PATH_STAT_LIMIT = 128
const DIRECTORY_ENTRY_LIMIT = 400
const KIMI_CODE_REPLACEMENT_MODEL_IDS = [
  'kimi-for-coding',
  'k3',
  'k3-256k',
  'kimi-for-coding-highspeed'
] as const

// Mirrors the runtime model metadata: a level is
// unsupported if the model's thinkingLevelMap explicitly maps it to null, and
// 'xhigh'/'max' additionally require an explicit (non-undefined) mapping —
// most models don't opt into those two tiers at all.
function getSupportedThinkingLevels(model: {
  reasoning: boolean
  thinkingLevelMap?: Partial<Record<string, string | null>>
}): ThinkingLevel[] {
  if (!model.reasoning) return []
  return THINKING_LEVEL_ORDER.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level]
    if (mapped === null) return false
    if (level === 'xhigh' || level === 'max') return mapped !== undefined
    return true
  })
}

function isRetiredKimiCodeModel(providerId: string, modelId: string): boolean {
  return providerId === 'kimi-code' && /^kimi-k2(?:$|[.-])/.test(modelId)
}

function isSelectableRuntimeModel(model: { provider: string; id: string }): boolean {
  return !isRetiredKimiCodeModel(model.provider, model.id)
}

function selectableRuntimeModels(runtime: ModelRuntime): RuntimeModel[] {
  return runtime.getModels().filter(isSelectableRuntimeModel)
}

function resolveRuntimeModelSelection(
  runtime: ModelRuntime,
  selection: ModelSelection
): { model: RuntimeModel; selection: ModelSelection; migratedFrom?: ModelSelection } | null {
  const exact = runtime.getModel(selection.providerId, selection.modelId)
  if (exact && isSelectableRuntimeModel(exact)) {
    return { model: exact, selection }
  }

  if (!isRetiredKimiCodeModel(selection.providerId, selection.modelId)) {
    return null
  }

  for (const modelId of KIMI_CODE_REPLACEMENT_MODEL_IDS) {
    const replacement = runtime.getModel(selection.providerId, modelId)
    if (replacement && isSelectableRuntimeModel(replacement)) {
      return {
        model: replacement,
        selection: { providerId: replacement.provider, modelId: replacement.id },
        migratedFrom: selection
      }
    }
  }

  return null
}

function modelSelectionLabel(selection: ModelSelection): string {
  return `${selection.providerId}/${selection.modelId}`
}

type AgentSessionResult = Awaited<ReturnType<typeof createAgentSession>>
type AgentSessionInstance = AgentSessionResult['session']
type AgentSessionRecord = SessionLifecycleRecord<AgentSessionResult>
type CurrentSessionPayload = {
  path: string | null
  phiSessionId?: string
  cwd: string
  sessionGeneration: number
  permissionMode: PermissionMode
  status: SessionStatus
  unreadKind: UnreadKind | null
  lastRunOutcome?: LastRunOutcome
  currentRunId?: string
  currentRunStartedAt?: string
  lastActivityAt?: string
}

type PromptTargetInput = {
  path: string | null
  phiSessionId?: string
  cwd: string
  sessionGeneration?: number
}

interface PromptRun {
  sessionKey: string
  phiSessionId: string
  runId: string
  cwd: string
  projectId?: string
  generation: number
  sessionGeneration: number
  cancelled: boolean
  recordedFailureMessage?: string
  thinkingBlocks: Map<number, string>
  thinkingBlockStartedAtMs: Map<number, number>
  compactionReasons: Map<string, string>
  sessionPath?: string | null
  session?: AgentSessionInstance
  done?: Promise<{ path: string | null; phiSessionId?: string; sessionGeneration: number } | null>
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
  references?: AnalysisNotebookContextReference[]
}

type AnalysisNotebookContextReference = {
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

const sessionLifecycles = new Map<string, SessionLifecycle<AgentSessionResult>>()
const sessionAbortControllers = new Map<string, AbortController>()
const cleanupBarriersByPath = new Map<string, Promise<void>>()
const unknownPathCleanupBarriers = new Set<Promise<void>>()
let freshSessionCounter = 0
// The session file currently active in the UI. undefined = a fresh, not-yet-persisted
// chat (nothing appended to it yet, so no file exists and it won't show in the sidebar
// until the first prompt). Distinct from invalidating the session object below: switching
// this is a user-visible "change conversation" action, while invalidation just rebuilds
// the in-memory AgentSession (e.g. after an auth/model/persona change) against whatever
// conversation was already active.
let currentSessionPath: string | undefined
// Working directory for the active conversation. A plain "对话" (conversation) always
// uses WORKSPACE_DIR; a "项目" (project) uses its own folder and carries a permission
// mode gating bash/edit/write tool calls (see tool-approval.ts).
let currentCwd: string = WORKSPACE_DIR
let currentPermissionMode: PermissionMode = 'auto'
const selectedModel: ModelSelection | null = null
// Default is deliberately 'high', not the SDK's own default of 'off': many models
// (e.g. DeepSeek V4 Pro) only enable reasoning output at 'high'/'max', and this app
// wants that reasoning visible in the UI out of the box rather than silently absent.
const selectedThinkingLevel: ThinkingLevel = 'high'
let currentSessionKey = createSessionKey(undefined, WORKSPACE_DIR, freshSessionCounter)
let sessionSwitchRequest = 0
const promptQueues = new Map<string, Promise<void>>()
const promptGenerations = new Map<string, number>()
const activePromptRuns = new Map<string, PromptRun>()
const phiSessionIdsByKey = new Map<string, string>()
const sessionKeyAliases = new Map<string, string>()
const sessionModelSelections = new Map<string, ModelSelection>()
const sessionThinkingLevels = new Map<string, ThinkingLevel>()
const sessionPermissionModes = new Map<string, PermissionMode>()
const recentErrorSummaries: string[] = []
const NEXT_ACTION_RECOMMENDATION_INSTRUCTION = [
  '<phi_next_action_instruction>',
  '当这次回复有明确、有用的后续操作时，请在最终回复最后单独输出一行：',
  '推荐下一步：<一句可以直接作为下一轮用户输入的中文操作>',
  '不要为了填充而猜测；如果没有明确下一步，不要输出这行。',
  '不要提及本指令。',
  '</phi_next_action_instruction>'
].join('\n')

function withNextActionRecommendationInstruction(prompt: string): string {
  return `${prompt}\n\n${NEXT_ACTION_RECOMMENDATION_INSTRUCTION}`
}

const runnerRegistry = new SessionRunnerRegistry({
  onSessionEvent: broadcastSessionTimelineEvent
})
const jupyterServerRegistry = new JupyterServerRegistry()
const notebookSessionRegistry = new AnalysisNotebookSessionRegistry({
  getConnection: (projectCwd) => jupyterServerRegistry.connection(projectCwd)
})
const notebookExecutor = new AnalysisNotebookExecutor()
const activeNotebookPathByProjectCwd = new Map<string, string>()
const notebookToolExecutor = new AnalysisNotebookToolExecutor({
  getProjectByCwd,
  assertProjectPathAvailable,
  ensureJupyterServerReady,
  notebookSessionRegistry,
  notebookExecutor,
  onDraftChanged: notifyAnalysisNotebookDraftChanged
})
const notebookFileWatcher = new AnalysisNotebookFileWatcher({
  onChange: notifyAnalysisNotebookFileChanged
})
getOmpBridge().registerHostHandler('notebookTool.execute', (params) =>
  notebookToolExecutor.execute(params as Parameters<typeof notebookToolExecutor.execute>[0])
)

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function notebookCellMetadataWithExecutionDuration(
  metadata: JsonObject,
  execution: { startedAt: string; completedAt: string }
): JsonObject {
  const startedAt = Date.parse(execution.startedAt)
  const completedAt = Date.parse(execution.completedAt)
  const durationMs =
    Number.isFinite(startedAt) && Number.isFinite(completedAt)
      ? Math.max(0, completedAt - startedAt)
      : 0
  const phiMetadata =
    metadata.phi && typeof metadata.phi === 'object' && !Array.isArray(metadata.phi)
      ? (metadata.phi as JsonObject)
      : {}
  return {
    ...metadata,
    phi: {
      ...phiMetadata,
      executionStartedAt: execution.startedAt,
      executionCompletedAt: execution.completedAt,
      executionDurationMs: durationMs
    }
  }
}

async function ensureJupyterServerReady(projectCwd: string): Promise<void> {
  let status = jupyterServerRegistry.status(projectCwd)
  if (status.state !== 'ready' || !status.hasEndpoint) {
    status = jupyterServerRegistry.start(projectCwd)
  }
  for (
    let attempt = 0;
    attempt < 20 && (status.state !== 'ready' || !status.hasEndpoint);
    attempt += 1
  ) {
    if (status.state === 'error' || status.state === 'exited' || status.state === 'stopped') {
      break
    }
    await delay(250)
    status = jupyterServerRegistry.status(projectCwd)
  }
  if (status.state !== 'ready' || !status.hasEndpoint) {
    throw new Error(status.message ?? 'Jupyter Server 尚未就绪')
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  return String(error)
}

function emptyNotebookCompletionResult(
  cursorPosition: number,
  message?: string
): JupyterKernelCompletionResult {
  const position = Number.isFinite(cursorPosition) ? Math.max(0, cursorPosition) : 0
  return {
    matches: [],
    cursorStart: position,
    cursorEnd: position,
    metadata: {},
    status: 'error' as const,
    message
  }
}

function notebookDocumentLanguage(document: NotebookDocument): string {
  const kernelspec = document.metadata.kernelspec
  if (kernelspec && typeof kernelspec === 'object' && !Array.isArray(kernelspec)) {
    const spec = kernelspec as JsonObject
    if (typeof spec.language === 'string') return spec.language
    if (typeof spec.name === 'string') return spec.name
    if (typeof spec.display_name === 'string') return spec.display_name
  }
  return ''
}

function isPythonNotebookDocument(document: NotebookDocument): boolean {
  return notebookDocumentLanguage(document).toLocaleLowerCase().includes('python')
}

function notebookAgentRuntimePrompt(projectCwd: string): string | null {
  const project = getProjectByCwd(projectCwd)
  if (!project) return null

  const status = jupyterServerRegistry.status(project.workingDirectory)
  const activeNotebookPath = activeNotebookPathByProjectCwd.get(project.workingDirectory)
  const registry = listProjectNotebooks(project.workingDirectory, {
    maxDepth: 4,
    maxEntries: 600,
    maxNotebooks: 12
  })
  const notebooks = registry.notebooks
    .map((notebook) => {
      const marker = notebook.path === activeNotebookPath ? ' (active)' : ''
      return `- ${notebook.relativePath}${marker}`
    })
    .join('\n')

  return [
    '<phi_notebook_runtime>',
    'This Phi project can operate .ipynb notebooks through the built-in notebook.* tools.',
    'When the user asks to read, edit, save, or run a notebook, use notebook.list/read/insert_cell/update_cell/delete_cell/run_cell/save instead of shell-editing the .ipynb JSON by default.',
    'Notebook execution must use the Phi app-managed Jupyter Server registered for this project. Do not assume, probe, or instruct the user to restart JupyterLab on localhost:8888.',
    `Project: ${project.name ?? project.workingDirectory}`,
    `Project cwd: ${project.workingDirectory}`,
    activeNotebookPath
      ? `Active notebook: ${relative(project.workingDirectory, activeNotebookPath).split(sep).join('/')}`
      : 'Active notebook: none selected',
    `Jupyter server: ${status.state}${status.hasEndpoint ? `, app-managed port ${status.port ?? 'unknown'}` : ', no endpoint yet; notebook.run_cell may start or attach it'}`,
    registry.notebooks.length > 0
      ? `Project notebooks:\n${notebooks}`
      : 'Project notebooks: none found',
    registry.truncated
      ? 'Project notebooks list is truncated; call notebook.list for the full tool view.'
      : '',
    'If notebook.run_cell returns an error, report that tool error directly and do not invent an external JupyterLab port workaround.',
    '</phi_notebook_runtime>'
  ]
    .filter(Boolean)
    .join('\n')
}

function broadcastSessionTimelineEvent(sessionId: string, event: StoredSessionEvent): void {
  const run = [...activePromptRuns.values()].find((item) => item.phiSessionId === sessionId)
  if (!run) return

  const targetWindow = getActiveWindow()
  sendToWindow(targetWindow, 'agent:event', {
    source: 'phi',
    ...event,
    phiSessionId: run.phiSessionId,
    sessionGeneration: run.sessionGeneration,
    sessionPath: run.sessionPath ?? run.session?.sessionFile ?? null,
    cwd: run.cwd
  })
}

function rememberErrorSummary(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  recentErrorSummaries.unshift(message.slice(0, 500))
  recentErrorSummaries.splice(20)
  writeAppLog({
    level: 'error',
    event: 'error_summary',
    metadata: { message }
  })
}

async function settledValue<T>(fallback: T, load: () => Promise<T> | T): Promise<T> {
  try {
    return await load()
  } catch (error) {
    rememberErrorSummary(error)
    return fallback
  }
}

function extractAssistantText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const record = message as { role?: string; content?: unknown }
  if (record.role !== 'assistant') return ''

  return extractMessageText(record.content)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assistantMessagesFrom(value: unknown): unknown[] {
  if (!value) return []
  if (Array.isArray(value)) {
    return value.flatMap((item) => assistantMessagesFrom(item))
  }
  if (!isRecord(value)) return []
  const messages = Array.isArray(value.messages) ? assistantMessagesFrom(value.messages) : []
  const message = isRecord(value.message) ? assistantMessagesFrom(value.message) : []
  const self = value.role === 'assistant' ? [value] : []
  return [...messages, ...message, ...self]
}

function lastAssistantMessageFrom(value: unknown): unknown {
  return assistantMessagesFrom(value).at(-1)
}

function assistantErrorText(message: unknown, options: { allowContent?: boolean } = {}): string {
  if (!isRecord(message)) return ''
  if (typeof message.errorMessage === 'string') return message.errorMessage
  if (typeof message.message === 'string') return message.message
  if (message.role !== 'assistant') return ''
  if (message.stopReason === 'error' || options.allowContent) return extractAssistantText(message)
  return ''
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) {
    if (!content || typeof content !== 'object') return ''
    const record = content as Record<string, unknown>
    if (
      (record.type === 'text' || record.type === 'output_text' || record.type === 'input_text') &&
      typeof record.text === 'string'
    ) {
      return record.text
    }
    if (record.type === undefined && typeof record.text === 'string') return record.text
    if (record.type === undefined && typeof record.output_text === 'string') {
      return record.output_text
    }
    if (typeof record.content === 'string') return record.content
    return (
      extractMessageText(record.content) ||
      extractMessageText(record.delta) ||
      extractMessageText(record.data) ||
      extractMessageText(record.value) ||
      extractMessageText(record.result) ||
      extractMessageText(record.output) ||
      extractMessageText(record.outputs) ||
      extractMessageText(record.message)
    )
  }

  return content
    .map((part) => {
      if (typeof part === 'string') return part
      if (!part || typeof part !== 'object') return ''
      const item = part as { type?: string; text?: unknown; content?: unknown }
      if (
        (item.type === 'text' || item.type === 'output_text' || item.type === 'input_text') &&
        typeof item.text === 'string'
      ) {
        return item.text
      }
      if (typeof item.text === 'string' && item.type === undefined) return item.text
      return extractMessageText(item.content)
    })
    .join('')
}

function assistantTextFromEventSummary(
  summary: Record<string, unknown>,
  currentText: string
): string {
  const message = summary.message as { role?: string } | undefined
  const assistantMessageEvent = summary.assistantMessageEvent as
    | {
        type?: unknown
        delta?: unknown
        message?: unknown
        partial?: unknown
        error?: unknown
        content?: unknown
      }
    | undefined

  if (
    summary.type === 'message_update' &&
    assistantMessageEvent?.type === 'text_delta' &&
    typeof assistantMessageEvent.delta === 'string'
  ) {
    return `${currentText}${assistantMessageEvent.delta}`
  }
  if (summary.type === 'message_update' && typeof assistantMessageEvent?.type === 'string') {
    const deltaText = extractMessageText(assistantMessageEvent.delta)
    if (deltaText && assistantMessageEvent.type.endsWith('_delta')) {
      return `${currentText}${deltaText}`
    }
  }

  if (summary.type === 'message_update' && assistantMessageEvent?.type === 'done') {
    const text = extractAssistantText(assistantMessageEvent.message).trim()
    return text || currentText
  }

  if (summary.type === 'message_update' && assistantMessageEvent?.partial) {
    const text = extractAssistantText(assistantMessageEvent.partial).trim()
    if (text) return text
  }
  if (summary.type === 'message_update' && assistantMessageEvent) {
    const text = extractMessageText(assistantMessageEvent).trim()
    if (text) return text
  }

  if (summary.type === 'message_end' && message?.role === 'assistant') {
    const text = extractAssistantText(message).trim()
    return text || currentText
  }

  const batchedText = extractAssistantText(lastAssistantMessageFrom(summary.messages)).trim()
  if (batchedText) return batchedText

  const resultText = extractAssistantText(lastAssistantMessageFrom(summary.result)).trim()
  if (resultText) return resultText

  return currentText
}

function assistantErrorMessageFromEventSummary(summary: Record<string, unknown>): string | null {
  const assistantMessageEvent = summary.assistantMessageEvent as
    { type?: unknown; error?: unknown } | undefined
  if (summary.type === 'message_update' && assistantMessageEvent?.type === 'error') {
    const error = assistantMessageEvent.error
    const message = assistantErrorText(error, { allowContent: true })
    return message ? redactSensitiveText(message) : '请求失败'
  }

  const message = summary.message as
    { role?: string; stopReason?: unknown; errorMessage?: unknown } | undefined
  if (
    summary.type === 'message_end' &&
    message?.role === 'assistant' &&
    message.stopReason === 'error'
  ) {
    return typeof message.errorMessage === 'string'
      ? redactSensitiveText(message.errorMessage)
      : '请求失败'
  }

  const batchedMessage = lastAssistantMessageFrom(summary.messages)
  const batchedError = assistantErrorText(batchedMessage)
  if (batchedError) return redactSensitiveText(batchedError)

  const resultMessage = lastAssistantMessageFrom(summary.result)
  const resultError = assistantErrorText(resultMessage)
  if (resultError) return redactSensitiveText(resultError)

  return null
}

function notebookCompletionCandidatesFromEventSummary(summary: Record<string, unknown>): unknown[] {
  const candidates: unknown[] = []
  const assistantMessageEvent = summary.assistantMessageEvent as
    | {
        type?: unknown
        data?: unknown
        value?: unknown
        content?: unknown
        delta?: unknown
        result?: unknown
        output?: unknown
        outputs?: unknown
        message?: unknown
        partial?: unknown
        error?: unknown
      }
    | undefined
  if (summary.type === 'message_update' && assistantMessageEvent) {
    candidates.push(assistantMessageEvent)
    if (assistantMessageEvent.message) candidates.push(assistantMessageEvent.message)
    if (assistantMessageEvent.partial) candidates.push(assistantMessageEvent.partial)
    if (assistantMessageEvent.error) candidates.push(assistantMessageEvent.error)
    if (assistantMessageEvent.data) candidates.push(assistantMessageEvent.data)
    if (assistantMessageEvent.value) candidates.push(assistantMessageEvent.value)
    if (assistantMessageEvent.content) candidates.push(assistantMessageEvent.content)
    if (assistantMessageEvent.delta) candidates.push(assistantMessageEvent.delta)
    if (assistantMessageEvent.result) candidates.push(assistantMessageEvent.result)
    if (assistantMessageEvent.output) candidates.push(assistantMessageEvent.output)
    if (assistantMessageEvent.outputs) candidates.push(assistantMessageEvent.outputs)
  }

  const message = summary.message as { role?: string } | undefined
  if (summary.type === 'message_end' && message?.role === 'assistant') {
    candidates.push(message)
  }

  candidates.push(...assistantMessagesFrom(summary.messages))
  candidates.push(...assistantMessagesFrom(summary.result))

  return candidates
}

type NotebookCompletionSelection = {
  cells: AnalysisNotebookGeneratedCell[]
  text: string
  score: number
}

function notebookCompletionCandidateText(candidate: unknown): string {
  if (typeof candidate === 'string') return candidate.trim()
  return extractAssistantText(candidate).trim() || extractMessageText(candidate).trim()
}

function notebookCompletionCellsScore(cells: AnalysisNotebookGeneratedCell[]): number {
  const sourceLength = generatedNotebookCellsSource(cells).trim().length
  const codeCellCount = cells.filter((cell) => cell.cellType === 'code').length
  return sourceLength + cells.length * 1000 + codeCellCount * 1500
}

function chooseNotebookCompletion(
  candidates: unknown[],
  language: string,
  parseCompletion: (candidate: unknown, defaultLanguage: string) => AnalysisNotebookGeneratedCell[]
): NotebookCompletionSelection | null {
  let best: NotebookCompletionSelection | null = null
  for (const candidate of candidates) {
    const cells = parseCompletion(candidate, language)
    if (cells.length === 0) continue

    const text = notebookCompletionCandidateText(candidate)
    const score = notebookCompletionCellsScore(cells)
    if (!best || score > best.score || (score === best.score && text.length > best.text.length)) {
      best = { cells, text, score }
    }
  }
  return best
}

function extractAssistantThinkingBlocks(message: unknown): string[] {
  if (!message || typeof message !== 'object') return []
  const record = message as { role?: string; content?: unknown }
  if (record.role !== 'assistant' || !Array.isArray(record.content)) return []

  return record.content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const item = part as { type?: string; thinking?: unknown; text?: unknown }
      if (item.type !== 'thinking') return ''
      if (typeof item.thinking === 'string') return item.thinking
      return typeof item.text === 'string' ? item.text : ''
    })
    .filter((text) => text.length > 0)
}

function summaryTimestampMs(summary: Record<string, unknown>): number {
  if (typeof summary.createdAt === 'string') {
    const timestamp = Date.parse(summary.createdAt)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return Date.now()
}

function createdAtFromSummary(
  summary: Record<string, unknown>
): { createdAt: string } | Record<string, never> {
  if (typeof summary.createdAt !== 'string') return {}
  return Number.isFinite(Date.parse(summary.createdAt)) ? { createdAt: summary.createdAt } : {}
}

function textFromToolContentParts(content: unknown[]): string {
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

function extractToolText(value: unknown): string {
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return textFromToolContentParts(value)
  if (value && typeof value === 'object') {
    const record = value as { content?: unknown; output?: unknown; text?: unknown }
    if (Array.isArray(record.content)) {
      const text = textFromToolContentParts(record.content)
      if (text) return text
    }
    if (typeof record.output === 'string') return record.output
    if (typeof record.text === 'string') return record.text
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return value == null ? '' : String(value)
}

function isNotebookToolName(toolName: unknown): boolean {
  return typeof toolName === 'string' && toolName.startsWith('notebook.')
}

function detailsFromToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined
  return (result as { details?: unknown }).details
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value ? value : undefined
}

function numberOrNullField(
  record: Record<string, unknown>,
  key: string
): number | null | undefined {
  const value = record[key]
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = numberOrNullField(record, key)
  return typeof value === 'number' ? value : undefined
}

function notebookCellNumberFrom(
  record: Record<string, unknown>,
  cell: Record<string, unknown> | null
): number | undefined {
  const explicit =
    numberField(record, 'cellNumber') ??
    (cell ? (numberField(cell, 'cellNumber') ?? numberField(cell, 'number')) : undefined)
  if (explicit !== undefined && explicit >= 1) return Math.trunc(explicit)
  const legacyIndex = cell ? numberField(cell, 'index') : undefined
  return legacyIndex !== undefined && legacyIndex >= 0 ? Math.trunc(legacyIndex) + 1 : undefined
}

function notebookToolDetailsFromResult(result: unknown): Record<string, unknown> | undefined {
  const details = detailsFromToolResult(result)
  if (!details || typeof details !== 'object') return undefined
  const record = details as Record<string, unknown>
  const kind = stringField(record, 'kind')
  if (!kind || !kind.startsWith('notebook_')) return undefined

  const cell =
    record.cell && typeof record.cell === 'object' ? (record.cell as Record<string, unknown>) : null
  const execution =
    record.execution && typeof record.execution === 'object'
      ? (record.execution as Record<string, unknown>)
      : null
  const cellNumber = notebookCellNumberFrom(record, cell)

  return {
    kind,
    ...(stringField(record, 'path') ? { path: stringField(record, 'path') } : {}),
    ...(stringField(record, 'relativePath')
      ? { relativePath: stringField(record, 'relativePath') }
      : {}),
    ...((stringField(record, 'cellId') ?? (cell ? stringField(cell, 'id') : undefined))
      ? { cellId: stringField(record, 'cellId') ?? (cell ? stringField(cell, 'id') : undefined) }
      : {}),
    ...(cellNumber !== undefined ? { cellNumber } : {}),
    ...((stringField(record, 'cellType') ??
    (cell ? (stringField(cell, 'cellType') ?? stringField(cell, 'cell_type')) : undefined))
      ? {
          cellType:
            stringField(record, 'cellType') ??
            (cell ? (stringField(cell, 'cellType') ?? stringField(cell, 'cell_type')) : undefined)
        }
      : {}),
    ...(execution && stringField(execution, 'state')
      ? { executionState: stringField(execution, 'state') }
      : {}),
    ...(execution && numberOrNullField(execution, 'executionCount') !== undefined
      ? { executionCount: numberOrNullField(execution, 'executionCount') }
      : {}),
    ...(stringField(record, 'summary') ? { summary: stringField(record, 'summary') } : {})
  }
}

function persistCompletedThinkingBlocks(run: PromptRun, summary: Record<string, unknown>): void {
  const thinkingBlocks =
    run.thinkingBlocks.size > 0
      ? [...run.thinkingBlocks.entries()]
          .sort(([left], [right]) => left - right)
          .map(([contentIndex, content]) => ({ contentIndex, content }))
      : extractAssistantThinkingBlocks(summary.message).map((content, contentIndex) => ({
          contentIndex,
          content
        }))
  const thinkingEndedAtMs = summaryTimestampMs(summary)
  run.thinkingBlocks.clear()
  for (const { contentIndex, content } of thinkingBlocks) {
    if (!content) continue
    const startedAtMs = run.thinkingBlockStartedAtMs.get(contentIndex)
    appendSessionEvent(run.phiSessionId, {
      type: 'assistant_thinking_completed',
      runId: run.runId,
      content,
      ...createdAtFromSummary(summary),
      ...(startedAtMs !== undefined
        ? { durationMs: Math.max(0, thinkingEndedAtMs - startedAtMs) }
        : {})
    })
  }
  run.thinkingBlockStartedAtMs.clear()
}

function persistSessionEvent(
  run: PromptRun,
  summary: Record<string, unknown>
): Record<string, unknown> {
  const withRunId = (event: Record<string, unknown>): Record<string, unknown> =>
    typeof event.runId === 'string' ? event : { ...event, runId: run.runId }

  if (summary.type === 'auto_compaction_start' && typeof summary.action === 'string') {
    if (typeof summary.reason === 'string') {
      run.compactionReasons.set(summary.action, summary.reason)
    }
    return withRunId(summary)
  }

  if (summary.type === 'auto_compaction_end' && typeof summary.action === 'string') {
    const reason = run.compactionReasons.get(summary.action)
    run.compactionReasons.delete(summary.action)
    if (!summary.skipped && !summary.aborted) {
      const result = summary.result as
        { summary?: unknown; shortSummary?: unknown; tokensBefore?: unknown } | undefined
      appendSessionEvent(run.phiSessionId, {
        type: 'context_compacted',
        runId: run.runId,
        action: summary.action,
        ...createdAtFromSummary(summary),
        ...(reason ? { reason } : {}),
        ...(typeof result?.shortSummary === 'string' ? { shortSummary: result.shortSummary } : {}),
        ...(typeof result?.summary === 'string' ? { summary: result.summary } : {}),
        ...(typeof result?.tokensBefore === 'number' ? { tokensBefore: result.tokensBefore } : {})
      })
    } else if (summary.errorMessage) {
      appendSessionEvent(run.phiSessionId, {
        type: 'context_compaction_failed',
        runId: run.runId,
        action: summary.action,
        ...createdAtFromSummary(summary),
        ...(reason ? { reason } : {}),
        errorMessage: summary.errorMessage
      })
    }
    return withRunId(summary)
  }

  if (
    summary.type === 'message_start' &&
    (summary.message as { role?: string } | undefined)?.role === 'assistant'
  ) {
    run.thinkingBlocks.clear()
    run.thinkingBlockStartedAtMs.clear()
    return withRunId(summary)
  }

  if (
    summary.type === 'message_update' &&
    (summary.message as { role?: string } | undefined)?.role === 'assistant'
  ) {
    const assistantMessageEvent = summary.assistantMessageEvent as
      { type?: string; delta?: unknown; contentIndex?: unknown } | undefined
    if (
      assistantMessageEvent?.type === 'thinking_delta' &&
      typeof assistantMessageEvent.delta === 'string'
    ) {
      const contentIndex =
        typeof assistantMessageEvent.contentIndex === 'number'
          ? assistantMessageEvent.contentIndex
          : 0
      if (!run.thinkingBlockStartedAtMs.has(contentIndex)) {
        run.thinkingBlockStartedAtMs.set(contentIndex, summaryTimestampMs(summary))
      }
      run.thinkingBlocks.set(
        contentIndex,
        `${run.thinkingBlocks.get(contentIndex) ?? ''}${assistantMessageEvent.delta}`
      )
    }
    return withRunId(summary)
  }

  if (
    summary.type === 'message_end' &&
    (summary.message as { role?: string } | undefined)?.role === 'assistant'
  ) {
    const assistantMessage = summary.message as { stopReason?: unknown; errorMessage?: unknown }
    if (assistantMessage?.stopReason === 'error') {
      const errorMessage =
        typeof assistantMessage.errorMessage === 'string'
          ? redactSensitiveText(assistantMessage.errorMessage)
          : '请求失败'
      persistCompletedThinkingBlocks(run, summary)
      run.recordedFailureMessage = errorMessage
      return withRunId(summary)
    }

    persistCompletedThinkingBlocks(run, summary)

    const content = extractAssistantText(summary.message)
    if (content) {
      appendSessionEvent(run.phiSessionId, {
        type: 'assistant_message_finalized',
        runId: run.runId,
        content,
        ...createdAtFromSummary(summary)
      })
    }
    return withRunId(summary)
  }

  if (summary.type === 'tool_execution_start' && typeof summary.toolCallId === 'string') {
    appendSessionEvent(run.phiSessionId, {
      type: 'tool_call_started',
      runId: run.runId,
      toolCallId: summary.toolCallId,
      toolName: summary.toolName,
      args: summary.args,
      ...createdAtFromSummary(summary)
    })
    return withRunId(summary)
  }

  if (summary.type !== 'tool_execution_end' || typeof summary.toolCallId !== 'string') {
    return withRunId(summary)
  }

  const output = extractToolText(summary.result)
  const notebookDetails = isNotebookToolName(summary.toolName)
    ? notebookToolDetailsFromResult(summary.result)
    : undefined
  const persisted = persistToolOutput(run.phiSessionId, {
    runId: run.runId,
    toolCallId: summary.toolCallId,
    output,
    inlineLimit: TOOL_OUTPUT_INLINE_LIMIT
  })
  appendSessionEvent(run.phiSessionId, {
    type: 'tool_call_completed',
    runId: run.runId,
    toolCallId: summary.toolCallId,
    toolName: summary.toolName,
    isError: summary.isError,
    ...createdAtFromSummary(summary),
    output: persisted.outputPreview,
    outputBytes: persisted.outputBytes,
    outputTruncated: persisted.truncated,
    ...(notebookDetails ? { details: notebookDetails } : {}),
    ...(persisted.outputPath ? { outputPath: persisted.outputPath } : {}),
    ...(persisted.outputArtifact ? { outputArtifact: persisted.outputArtifact } : {})
  })

  if (!persisted.truncated) return withRunId(summary)
  return withRunId({
    ...summary,
    result: {
      output: persisted.outputPreview,
      outputPath: persisted.outputPath,
      outputBytes: persisted.outputBytes,
      truncated: true,
      outputArtifact: persisted.outputArtifact
    }
  })
}

function readPhiTimelineMessages(
  runtimeSessionPath: string | null | undefined,
  cwd: string,
  phiSessionId?: string
): unknown[] {
  const manifestsById = new Map<string, PhiSessionManifest>()
  if (runtimeSessionPath) {
    for (const manifest of listPhiSessions()) {
      if (manifest.cwd === cwd && manifest.runtimeSessionPath === runtimeSessionPath) {
        manifestsById.set(manifest.sessionId, manifest)
      }
    }
  }
  if (phiSessionId) {
    const manifest = listPhiSessions().find((session) => session.sessionId === phiSessionId)
    if (manifest) {
      manifestsById.set(manifest.sessionId, manifest)
    }
  } else if (runtimeSessionPath && manifestsById.size === 0) {
    const manifest = findPhiSessionByRuntimePath(runtimeSessionPath, cwd)
    if (manifest) {
      manifestsById.set(manifest.sessionId, manifest)
    }
  }
  const manifests = [...manifestsById.values()].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt)
  )
  if (manifests.length === 0) return []
  const events = manifests
    .flatMap((manifest) => readSessionEvents(manifest.sessionId))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
  const hasPhiText = events.some(
    (event) => event.type === 'user_message' || event.type === 'assistant_message_finalized'
  )
  return events.map((event) => ({
    ...event,
    ...(hasPhiText ? { preferPhiTimeline: true } : {}),
    source: 'phi'
  }))
}

function createSessionKey(
  path: string | undefined,
  cwd: string,
  freshId = freshSessionCounter
): string {
  return path ? `path:${path}` : `fresh:${cwd}:${freshId}`
}

function createPhiSessionKey(sessionId: string, cwd: string): string {
  return createSessionKey(phiOnlySessionPath(sessionId), cwd)
}

function resolveSessionKeyAlias(sessionKey: string): string {
  let current = sessionKey
  const seen = new Set<string>()
  while (true) {
    const next = sessionKeyAliases.get(current)
    if (!next || seen.has(current)) return current
    seen.add(current)
    current = next
  }
}

function aliasSessionKey(aliasKey: string, canonicalKey: string): void {
  const resolvedCanonicalKey = resolveSessionKeyAlias(canonicalKey)
  if (aliasKey === resolvedCanonicalKey) return

  sessionKeyAliases.set(aliasKey, resolvedCanonicalKey)
  const lifecycle = sessionLifecycles.get(resolvedCanonicalKey)
  if (lifecycle) {
    sessionLifecycles.set(aliasKey, lifecycle)
  }
}

function aliasMaterializedSessionPath(sessionKey: string, path: string, cwd: string): void {
  aliasSessionKey(createSessionKey(path, cwd), sessionKey)
}

function linkPhiManagedSessionKey(sessionKey: string, cwd: string, phiSessionId: string): string {
  const stablePath = phiOnlySessionPath(phiSessionId)
  const stableKey = createPhiSessionKey(phiSessionId, cwd)
  aliasSessionKey(stableKey, sessionKey)
  setPhiSessionIdForKey(sessionKey, phiSessionId)
  setPhiSessionIdForKey(stableKey, phiSessionId)
  if (sameCanonicalSessionKey(sessionKey, currentSessionKey)) {
    currentSessionPath = stablePath
    currentSessionKey = stableKey
  }
  return stablePath
}

function sameCanonicalSessionKey(left: string, right: string): boolean {
  return resolveSessionKeyAlias(left) === resolveSessionKeyAlias(right)
}

function getActivePromptRun(sessionKey: string): PromptRun | undefined {
  return activePromptRuns.get(resolveSessionKeyAlias(sessionKey))
}

function hasActivePromptRun(sessionKey: string): boolean {
  return activePromptRuns.has(resolveSessionKeyAlias(sessionKey))
}

function setActivePromptRun(sessionKey: string, run: PromptRun): void {
  activePromptRuns.set(resolveSessionKeyAlias(sessionKey), run)
}

function deleteActivePromptRun(sessionKey: string, run: PromptRun): void {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  if (activePromptRuns.get(canonicalKey) === run) {
    activePromptRuns.delete(canonicalKey)
  }
}

function getPhiSessionIdForKey(sessionKey: string): string | undefined {
  return phiSessionIdsByKey.get(resolveSessionKeyAlias(sessionKey))
}

function setPhiSessionIdForKey(sessionKey: string, sessionId: string): void {
  phiSessionIdsByKey.set(resolveSessionKeyAlias(sessionKey), sessionId)
}

function updatePhiRuntimeSessionPath(sessionId: string, path: string): void {
  const manifest = findPhiSessionById(sessionId)
  if (manifest?.runtimeSessionPath === path) return
  updateSessionManifest(sessionId, { runtimeSessionPath: path })
}

function linkMaterializedRuntimeSessionPath(
  sessionKey: string,
  cwd: string,
  sessionFile: string | undefined,
  phiSessionId?: string
): void {
  const path = runtimeSessionPath(sessionFile)
  if (!path) return

  const materializedKey = createSessionKey(path, cwd)
  aliasMaterializedSessionPath(sessionKey, path, cwd)
  if (phiSessionId) {
    setPhiSessionIdForKey(sessionKey, phiSessionId)
    setPhiSessionIdForKey(materializedKey, phiSessionId)
    updatePhiRuntimeSessionPath(phiSessionId, path)
  }
  if (phiSessionId) {
    linkPhiManagedSessionKey(sessionKey, cwd, phiSessionId)
    return
  }
  if (sameCanonicalSessionKey(sessionKey, currentSessionKey)) {
    currentSessionKey = materializedKey
  }
}

function linkPromptRunRuntimeSessionPath(
  sessionKey: string,
  cwd: string,
  promptRun: PromptRun,
  session: AgentSessionInstance
): void {
  const path = runtimeSessionPath(session.sessionFile)
  if (!path) return
  promptRun.sessionPath = phiOnlySessionPath(promptRun.phiSessionId)
  linkMaterializedRuntimeSessionPath(sessionKey, cwd, path, promptRun.phiSessionId)
}

function getCurrentLifecycle(): SessionLifecycle<AgentSessionResult> {
  return getLifecycleForKey(currentSessionKey)
}

function getLifecycleForKey(sessionKey: string): SessionLifecycle<AgentSessionResult> {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  let lifecycle = sessionLifecycles.get(canonicalKey)
  if (!lifecycle) {
    lifecycle = new SessionLifecycle<AgentSessionResult>()
    sessionLifecycles.set(canonicalKey, lifecycle)
  }
  if (canonicalKey !== sessionKey) {
    sessionLifecycles.set(sessionKey, lifecycle)
  }
  return lifecycle
}

function getPromptQueue(sessionKey: string): Promise<void> {
  return promptQueues.get(resolveSessionKeyAlias(sessionKey)) ?? Promise.resolve()
}

function setPromptQueue(sessionKey: string, queue: Promise<void>): void {
  promptQueues.set(resolveSessionKeyAlias(sessionKey), queue)
}

function getPromptGeneration(sessionKey: string): number {
  return promptGenerations.get(resolveSessionKeyAlias(sessionKey)) ?? 0
}

function advancePromptGeneration(sessionKey: string): number {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  const next = getPromptGeneration(canonicalKey) + 1
  promptGenerations.set(canonicalKey, next)
  return next
}

function getSessionControllerKey(snapshot: SessionSnapshot, generation: number): string {
  return `${snapshot.path ?? `fresh:${snapshot.cwd}`}:${generation}`
}

function findPhiManifestForSession(
  sessionKey: string,
  path: string | undefined,
  cwd: string
): PhiSessionManifest | null {
  const phiSessionId =
    getActivePromptRun(sessionKey)?.phiSessionId ?? getPhiSessionIdForKey(sessionKey)
  if (phiSessionId) {
    return listPhiSessions().find((manifest) => manifest.sessionId === phiSessionId) ?? null
  }
  if (!path) return null
  const phiOnlySessionId = phiSessionIdFromPath(path)
  return phiOnlySessionId
    ? findPhiSessionById(phiOnlySessionId)
    : findPhiSessionByRuntimePath(path, cwd)
}

function runtimeSessionPath(path: string | undefined): string | undefined {
  return isPhiOnlySessionPath(path) ? undefined : path
}

function runtimeSessionPathForSnapshot(
  sessionKey: string,
  snapshot: SessionSnapshot
): string | undefined {
  return (
    findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)?.runtimeSessionPath ??
    runtimeSessionPath(snapshot.path)
  )
}

function uiSessionPathForKey(sessionKey: string, fallbackPath: string | undefined): string | null {
  const phiSessionId = getPhiSessionIdForKey(sessionKey)
  return phiSessionId ? phiOnlySessionPath(phiSessionId) : (fallbackPath ?? null)
}

function parsePromptTarget(input: unknown): PromptTargetInput | null {
  if (!input || typeof input !== 'object') return null
  const record = input as Record<string, unknown>
  const path = record.path === null ? null : typeof record.path === 'string' ? record.path : null
  const phiSessionId = typeof record.phiSessionId === 'string' ? record.phiSessionId : undefined
  const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : currentCwd
  return {
    path,
    ...(phiSessionId ? { phiSessionId } : {}),
    cwd,
    ...(typeof record.sessionGeneration === 'number'
      ? { sessionGeneration: record.sessionGeneration }
      : {})
  }
}

async function alignCurrentSessionToPromptTarget(input: unknown): Promise<void> {
  const target = parsePromptTarget(input)
  if (!target) return

  if (target.phiSessionId) {
    const manifest = findPhiSessionById(target.phiSessionId)
    if (!manifest) throw new Error('会话不存在或已被删除')
    const stablePath = phiOnlySessionPath(manifest.sessionId)
    const targetKey = createPhiSessionKey(manifest.sessionId, manifest.cwd)
    linkPhiManagedSessionKey(targetKey, manifest.cwd, manifest.sessionId)
    sessionPermissionModes.set(resolveSessionKeyAlias(targetKey), manifest.permissionMode)
    const generationMatches =
      typeof target.sessionGeneration !== 'number' ||
      target.sessionGeneration === getLifecycleForKey(targetKey).currentGeneration
    if (currentSessionPath === stablePath && currentCwd === manifest.cwd && generationMatches) {
      return
    }
    await disposeAndSwitchSession(stablePath, manifest.cwd, manifest.permissionMode, {
      notify: false
    })
    return
  }

  if (target.path === null) {
    const generationMatches =
      typeof target.sessionGeneration !== 'number' ||
      target.sessionGeneration === getCurrentLifecycle().currentGeneration
    if (currentSessionPath === undefined && currentCwd === target.cwd && generationMatches) return
    throw new Error('当前会话已切换，请重新发送')
  }

  const phiOnlySessionId = phiSessionIdFromPath(target.path)
  if (phiOnlySessionId) {
    const manifest = findPhiSessionById(phiOnlySessionId)
    if (!manifest) throw new Error('会话不存在或已被删除')
    const targetKey = createSessionKey(target.path, manifest.cwd)
    setPhiSessionIdForKey(targetKey, phiOnlySessionId)
    sessionPermissionModes.set(resolveSessionKeyAlias(targetKey), manifest.permissionMode)
    if (currentSessionPath !== target.path || currentCwd !== manifest.cwd) {
      await disposeAndSwitchSession(target.path, manifest.cwd, manifest.permissionMode, {
        notify: false
      })
    }
    return
  }

  if (currentSessionPath === target.path) {
    return
  }

  const cwd = (await openRuntimeSessionManager(target.path)).getCwd()
  const targetKey = createSessionKey(target.path, cwd)
  const permissionMode = resolveSessionPermissionMode(targetKey, { path: target.path, cwd })
  if (currentSessionPath !== target.path || currentCwd !== cwd) {
    await disposeAndSwitchSession(target.path, cwd, permissionMode, { notify: false })
  }
}

function getSessionStatusPayload(
  sessionKey: string,
  path: string | undefined,
  cwd: string
): Pick<
  CurrentSessionPayload,
  | 'status'
  | 'unreadKind'
  | 'lastRunOutcome'
  | 'currentRunId'
  | 'currentRunStartedAt'
  | 'lastActivityAt'
> {
  const promptRun = getActivePromptRun(sessionKey)
  const activeRun = promptRun ? runnerRegistry.getActiveRun(promptRun.phiSessionId) : null
  if (activeRun) {
    return {
      status: activeRun.status,
      unreadKind: activeRun.status === 'needs_approval' ? 'approval' : null,
      currentRunId: activeRun.runId,
      currentRunStartedAt: activeRun.startedAt
    }
  }

  const manifest = findPhiManifestForSession(sessionKey, path, cwd)
  if (manifest) {
    return {
      status: manifest.status,
      unreadKind: manifest.unreadKind,
      lastRunOutcome: manifest.lastRunOutcome,
      currentRunId: manifest.currentRunId,
      currentRunStartedAt: manifest.currentRunStartedAt,
      lastActivityAt: manifest.lastActivityAt
    }
  }

  return { status: 'idle', unreadKind: null }
}

function resolveSessionModelSelection(
  sessionKey: string,
  snapshot: SessionSnapshot
): ModelSelection | null {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  if (sessionModelSelections.has(canonicalKey)) {
    return sessionModelSelections.get(canonicalKey) ?? null
  }
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  return manifest?.model ?? getProjectByCwd(snapshot.cwd)?.defaultModel ?? selectedModel
}

function resolveSessionThinkingLevel(sessionKey: string, snapshot: SessionSnapshot): ThinkingLevel {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  if (sessionThinkingLevels.has(canonicalKey)) {
    return sessionThinkingLevels.get(canonicalKey) ?? selectedThinkingLevel
  }
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  return (
    manifest?.thinkingLevel ??
    getProjectByCwd(snapshot.cwd)?.defaultThinkingLevel ??
    selectedThinkingLevel
  )
}

function resolveSessionPermissionMode(
  sessionKey: string,
  snapshot: Pick<SessionSnapshot, 'path' | 'cwd'>
): PermissionMode {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  if (sessionPermissionModes.has(canonicalKey)) {
    return sessionPermissionModes.get(canonicalKey) ?? 'auto'
  }
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  return manifest?.permissionMode ?? getProjectByCwd(snapshot.cwd)?.permissionMode ?? 'auto'
}

function ensurePhiSessionId(
  sessionKey: string,
  snapshot: SessionSnapshot & { permissionMode: PermissionMode },
  title?: string
): string {
  const existing = getPhiSessionIdForKey(sessionKey)
  if (existing) {
    linkPhiManagedSessionKey(sessionKey, snapshot.cwd, existing)
    return existing
  }
  const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
  if (manifest) {
    linkPhiManagedSessionKey(sessionKey, manifest.cwd, manifest.sessionId)
    return manifest.sessionId
  }

  const project = getProjectByCwd(snapshot.cwd)
  const model = resolveSessionModelSelection(sessionKey, snapshot)
  const sessionTitle = messageContentTitleText(title)
  const session = createPhiSession({
    kind: snapshot.cwd === WORKSPACE_DIR ? 'ordinary' : 'project',
    projectId: project?.id ?? null,
    cwd: snapshot.cwd,
    cwdRealPath: project?.workingDirectoryRealPath ?? snapshot.cwd,
    ...(sessionTitle ? { title: sessionTitle } : {}),
    ...(runtimeSessionPath(snapshot.path) ? { runtimeSessionPath: snapshot.path } : {}),
    permissionMode: snapshot.permissionMode,
    ...(model ? { model } : {}),
    thinkingLevel: resolveSessionThinkingLevel(sessionKey, snapshot)
  })
  linkPhiManagedSessionKey(sessionKey, snapshot.cwd, session.sessionId)
  return session.sessionId
}

function createPhiManagedSession(
  cwd: string,
  permissionMode: PermissionMode,
  title?: string
): { path: string; sessionId: string; permissionMode: PermissionMode } {
  const project = getProjectByCwd(cwd)
  const model = project?.defaultModel ?? selectedModel
  const sessionTitle = messageContentTitleText(title)
  const session = createPhiSession({
    kind: cwd === WORKSPACE_DIR ? 'ordinary' : 'project',
    projectId: project?.id ?? null,
    cwd,
    cwdRealPath: project?.workingDirectoryRealPath ?? cwd,
    ...(sessionTitle ? { title: sessionTitle } : {}),
    permissionMode,
    ...(model ? { model } : {}),
    thinkingLevel: project?.defaultThinkingLevel ?? selectedThinkingLevel
  })
  const path = phiOnlySessionPath(session.sessionId)
  const key = createPhiSessionKey(session.sessionId, cwd)
  linkPhiManagedSessionKey(key, cwd, session.sessionId)
  sessionPermissionModes.set(resolveSessionKeyAlias(key), permissionMode)
  return { path, sessionId: session.sessionId, permissionMode }
}

// Turns a free-text description of the desired assistant into a persona markdown file
// by asking the agent itself to write it, in a throwaway session (noTools + in-memory
// history) so it doesn't touch the user's real chat or leave tool-call side effects.
async function generatePersonaMarkdown(description: string): Promise<string> {
  const runtime = await getAuthManager().getRuntime()
  const model = selectedModel
    ? runtime.getModel(selectedModel.providerId, selectedModel.modelId)
    : undefined
  let eventAssistantText = ''
  const { session } = await createAgentSession(
    {
      modelRuntime: runtime,
      cwd: WORKSPACE_DIR,
      noTools: 'all',
      sessionManager: createInMemoryRuntimeSessionManager(WORKSPACE_DIR),
      ...(model ? { model } : {})
    },
    (summary) => {
      eventAssistantText = assistantTextFromEventSummary(summary, eventAssistantText)
    }
  )

  try {
    await session.prompt(
      [
        '请根据下面用户对助手的描述，生成一份 Markdown 格式的智能体人设配置。',
        '内容应涵盖：性格特征、说话风格/语气、回答偏好（如结构、详略程度等）。',
        '只输出 Markdown 正文本身，不要包含任何解释、前后缀说明或代码块包裹符号。',
        '',
        '用户描述：',
        description
      ].join('\n')
    )

    const lastAssistantMessage = [...session.messages].reverse().find((message) => {
      const record = message as { role?: string }
      return record.role === 'assistant'
    })
    const generated = extractAssistantText(lastAssistantMessage).trim() || eventAssistantText.trim()
    return generated || fallbackMarkdownFromDescription(description)
  } finally {
    await session.dispose()
  }
}

const NOTEBOOK_AI_VARIABLE_REFERENCE_PATTERN =
  /@(?:(?:dataframe|variable):\/\/)?([A-Za-z_][A-Za-z0-9_]*)/g

function notebookAiVariableNamesFromInput(
  prompt: string,
  references: AnalysisNotebookContextReference[] | undefined
): string[] {
  const names = new Set<string>()
  for (const reference of references ?? []) {
    if (reference.kind === 'dataframe' || reference.kind === 'variable') {
      names.add(reference.name)
    }
  }
  for (const match of prompt.matchAll(NOTEBOOK_AI_VARIABLE_REFERENCE_PATTERN)) {
    names.add(match[1])
  }
  return [...names]
}

function kernelShapeLabel(shape: string | undefined): string | undefined {
  if (!shape) return undefined
  const match = shape.match(/^\s*(\d+)\s*x\s*(\d+)\s*$/)
  return match ? `${match[1]} rows x ${match[2]} columns` : shape
}

function mergeKernelIntrospectionReference(
  references: AnalysisNotebookContextReference[],
  summary: NotebookVariableIntrospection
): AnalysisNotebookContextReference[] {
  if (!summary.exists || !summary.name) return references
  const index = references.findIndex(
    (reference) =>
      reference.name === summary.name &&
      (reference.kind === 'dataframe' || reference.kind === 'variable')
  )
  const existing = index >= 0 ? references[index] : null
  const kind: AnalysisNotebookContextReference['kind'] =
    existing?.kind ?? (summary.columns?.length || summary.shape ? 'dataframe' : 'variable')
  const next: AnalysisNotebookContextReference = {
    id: existing?.id ?? `${kind}:${summary.name}`,
    kind,
    name: summary.name,
    detail: summary.datatype ?? existing?.detail ?? 'live kernel',
    cellId: existing?.cellId,
    preview: {
      ...existing?.preview,
      source: existing?.preview?.source ?? 'live kernel',
      shape: kernelShapeLabel(summary.shape) ?? existing?.preview?.shape,
      columns: summary.columns ?? existing?.preview?.columns,
      value: summary.preview ?? existing?.preview?.value
    }
  }
  if (index < 0) return [...references, next]
  return references.map((reference, currentIndex) => (currentIndex === index ? next : reference))
}

async function notebookAiReferencesWithKernelIntrospection(input: {
  projectCwd: string
  notebookPath: string
  prompt: string
  language: string
  references?: AnalysisNotebookContextReference[]
}): Promise<AnalysisNotebookContextReference[] | undefined> {
  const references = [...(input.references ?? [])]
  if (!input.language.toLocaleLowerCase().startsWith('python')) return references
  const variableNames = notebookAiVariableNamesFromInput(input.prompt, references)
  if (variableNames.length === 0) return references
  const target = notebookSessionRegistry.executionTarget(input.projectCwd, input.notebookPath)
  if (!target) return references

  try {
    const summaries = await notebookExecutor.introspectVariables({
      connection: target.connection,
      sessionId: target.sessionId,
      kernelId: target.kernelId,
      variableNames
    })
    return summaries.reduce(mergeKernelIntrospectionReference, references)
  } catch {
    return references
  }
}

async function repairNotebookGenerationCompletion(input: {
  sessionOptions: NonNullable<Parameters<typeof createAgentSession>[0]>
  language: string
  notebookPath: string
  insertionIndex: number
  references?: AnalysisNotebookContextReference[]
  userPrompt: string
  nearbyContext: string
  otherCellContext: string
  invalidOutput: string
}): Promise<NotebookCompletionSelection | null> {
  let assistantText = ''
  let errorMessage = ''
  const candidates: unknown[] = []
  const { session } = await createAgentSession(input.sessionOptions, (summary) => {
    assistantText = assistantTextFromEventSummary(summary, assistantText)
    candidates.push(...notebookCompletionCandidatesFromEventSummary(summary))
    errorMessage = assistantErrorMessageFromEventSummary(summary) ?? errorMessage
  })

  try {
    await session.prompt(
      buildNotebookCodeGenerationRepairPrompt({
        language: input.language,
        notebookPath: input.notebookPath,
        insertionIndex: input.insertionIndex,
        references: input.references,
        userPrompt: input.userPrompt,
        nearbyContext: input.nearbyContext,
        otherCellContext: input.otherCellContext,
        invalidOutput: input.invalidOutput
      }),
      {
        expandPromptTemplates: false,
        synthetic: true,
        skipCompactionCheck: true
      }
    )
    if (errorMessage) {
      throw new Error(errorMessage)
    }

    const lastAssistantMessage = [...session.messages].reverse().find((message) => {
      const record = message as { role?: string }
      return record.role === 'assistant'
    })
    return chooseNotebookCompletion(
      [...candidates, assistantText.trim(), lastAssistantMessage],
      input.language,
      parseFinalGeneratedNotebookCompletion
    )
  } finally {
    await session.dispose()
  }
}

async function generateAnalysisNotebookCode(
  cwd: string,
  notebookPath: string,
  document: NotebookDocument,
  input: AnalysisNotebookCodeGenerationInput,
  onProgress?: (progress: AnalysisNotebookCodeGenerationProgress) => void
): Promise<AnalysisNotebookCodeGenerationResult> {
  const prompt = input.prompt.trim()
  if (!prompt) {
    throw new Error('请输入要生成的代码需求')
  }

  const project = getProjectByCwd(cwd)
  if (!project) {
    throw new Error('请选择一个已添加的项目')
  }
  assertProjectPathAvailable(project.workingDirectory)
  const file = openProjectNotebook(project.workingDirectory, notebookPath)
  const runtime = await getAuthManager().getRuntime()
  const modelSelection = input.model ?? project.defaultModel ?? selectedModel
  const resolvedModel = modelSelection
    ? resolveRuntimeModelSelection(runtime, modelSelection)
    : null
  if (modelSelection && !resolvedModel) {
    throw new Error(`模型不可用: ${modelSelectionLabel(modelSelection)}`)
  }
  const { insertionIndex, nearbyContext, otherCellContext } = notebookCellPromptContext(
    document,
    input.afterCellId
  )
  const language = input.language || 'python'
  const references = await notebookAiReferencesWithKernelIntrospection({
    projectCwd: project.workingDirectory,
    notebookPath: file.path,
    prompt,
    language,
    references: input.references
  })
  const sessionOptions = {
    modelRuntime: runtime,
    cwd: project.workingDirectory,
    noTools: 'all' as const,
    thinkingLevel: project.defaultThinkingLevel ?? selectedThinkingLevel,
    sessionManager: createInMemoryRuntimeSessionManager(project.workingDirectory),
    ...(resolvedModel ? { model: resolvedModel.model } : {})
  }
  let eventAssistantText = ''
  let eventErrorMessage = ''
  const eventCompletionCandidates: unknown[] = []
  let lastProgressSource = ''
  const emitProgress = (): void => {
    if (!input.requestId || !onProgress) return
    const selectedCompletion = chooseNotebookCompletion(
      [...eventCompletionCandidates, eventAssistantText.trim()],
      language,
      parseGeneratedNotebookCompletionSnapshot
    )
    if (!selectedCompletion || selectedCompletion.cells.length === 0) return
    const source = generatedNotebookCellsSource(selectedCompletion.cells)
    if (source === lastProgressSource) return
    lastProgressSource = source
    onProgress({
      requestId: input.requestId,
      path: file.path,
      relativePath: file.relativePath,
      source,
      language,
      cells: selectedCompletion.cells
    })
  }
  const { session } = await createAgentSession(sessionOptions, (summary) => {
    eventAssistantText = assistantTextFromEventSummary(summary, eventAssistantText)
    eventCompletionCandidates.push(...notebookCompletionCandidatesFromEventSummary(summary))
    eventErrorMessage = assistantErrorMessageFromEventSummary(summary) ?? eventErrorMessage
    emitProgress()
  })

  try {
    await session.prompt(
      buildNotebookCodeGenerationPrompt({
        language,
        notebookPath: file.relativePath,
        insertionIndex,
        references,
        userPrompt: prompt,
        nearbyContext,
        otherCellContext
      }),
      {
        expandPromptTemplates: false,
        userInitiated: true,
        skipCompactionCheck: true
      }
    )
    if (eventErrorMessage) {
      throw new Error(eventErrorMessage)
    }

    const lastAssistantMessage = [...session.messages].reverse().find((message) => {
      const record = message as { role?: string }
      return record.role === 'assistant'
    })
    const candidates = [
      ...eventCompletionCandidates,
      eventAssistantText.trim(),
      lastAssistantMessage
    ]
    const selectedCompletion = chooseNotebookCompletion(
      candidates,
      language,
      parseFinalGeneratedNotebookCompletion
    )
    let assistantText = selectedCompletion?.text || eventAssistantText.trim()
    assistantText ||= extractAssistantText(lastAssistantMessage).trim()
    let cells = selectedCompletion?.cells ?? []
    let completionText = assistantText
    if (cells.length === 0) {
      const repairedCompletion = await repairNotebookGenerationCompletion({
        sessionOptions,
        language,
        notebookPath: file.relativePath,
        insertionIndex,
        references,
        userPrompt: prompt,
        nearbyContext,
        otherCellContext,
        invalidOutput: assistantText
      })
      if (repairedCompletion) {
        cells = repairedCompletion.cells
        completionText = repairedCompletion.text
      }
    }
    if (cells.length === 0) {
      const emptyResultDiagnostic =
        completionText ||
        '未收到模型返回文本或 data-notebook-cells-completion 结构化结果。请检查当前模型/供应商配置，或稍后重试。'
      throw new Error(notebookGenerationEmptyResultMessage(emptyResultDiagnostic))
    }
    const source = generatedNotebookCellsSource(cells)
    if (input.requestId && onProgress && source !== lastProgressSource) {
      onProgress({
        requestId: input.requestId,
        path: file.path,
        relativePath: file.relativePath,
        source,
        language,
        cells
      })
    }
    return { source, language, cells }
  } finally {
    await session.dispose()
  }
}

function isUsableWindow(window: BrowserWindow | null): window is BrowserWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed())
}

function isDisposedFrameSendError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return (
    message.includes('Render frame was disposed before WebFrameMain could be accessed') ||
    message.includes('Object has been destroyed')
  )
}

function isExpectedShutdownCleanupError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('OMP worker exited (130)')
}

function sendToWindow(window: BrowserWindow | null, channel: string, ...args: unknown[]): boolean {
  if (!isUsableWindow(window)) return false
  try {
    window.webContents.send(channel, ...args)
    return true
  } catch (error) {
    if (isDisposedFrameSendError(error)) return false
    throw error
  }
}

function sendToAllWindows(channel: string, ...args: unknown[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    sendToWindow(window, channel, ...args)
  }
}

function getActiveWindow(): BrowserWindow | null {
  const focusedWindow = BrowserWindow.getFocusedWindow()
  if (isUsableWindow(focusedWindow)) return focusedWindow
  return BrowserWindow.getAllWindows().find((window) => isUsableWindow(window)) ?? null
}

function notifyToolApprovalsCancelled(): void {
  sendToAllWindows('tool:approval-cancelled')
}

function notifyAnalysisNotebookDraftChanged(change: {
  source: string
  projectCwd: string
  path: string
  relativePath: string
  document: NotebookDocument
  savedRevision: string
  changeKind?: string
  changedCellId?: string
  focusCellId?: string
}): void {
  sendToAllWindows('analysis:notebookDraftChanged', change)
}

function notifyAnalysisNotebookFileChanged(change: unknown): void {
  sendToAllWindows('analysis:notebookFileChanged', change)
}

type LocalPathScope = {
  cwd: string
  cwdRealPath?: string
}

function isPathInsideRoot(root: string, target: string): boolean {
  const relativePath = relative(resolve(root), target)
  return relativePath === '' || (!relativePath.startsWith('..') && !isAbsolute(relativePath))
}

function currentLocalPathScope(): LocalPathScope {
  const project = getProjectByCwd(currentCwd)
  return {
    cwd: currentCwd,
    ...(project?.workingDirectoryRealPath ? { cwdRealPath: project.workingDirectoryRealPath } : {})
  }
}

function isLocalFilePathAllowed(
  target: string,
  scope: LocalPathScope = currentLocalPathScope()
): boolean {
  const agentDir = resolve(AGENT_DIR)
  const roots = [agentDir, scope.cwd, scope.cwdRealPath].filter(
    (root): root is string => typeof root === 'string' && root.length > 0
  )
  return roots.some((root) => isPathInsideRoot(root, target))
}

function getLocalPathScope(target: string): {
  rootPath: string
  rootLabel: string
  displayPath: string
} | null {
  const cwd = resolve(currentCwd)
  const agentDir = resolve(AGENT_DIR)
  const relativeCwdPath = relative(cwd, target)
  if (!relativeCwdPath.startsWith('..') && !isAbsolute(relativeCwdPath)) {
    return {
      rootPath: cwd,
      rootLabel: basename(cwd) || cwd,
      displayPath: relativeCwdPath || basename(target)
    }
  }

  const relativeAgentPath = relative(agentDir, target)
  if (!relativeAgentPath.startsWith('..') && !isAbsolute(relativeAgentPath)) {
    return {
      rootPath: agentDir,
      rootLabel: 'Phi',
      displayPath: join('Phi', relativeAgentPath || basename(target))
    }
  }

  return null
}

function assertLocalFilePathAllowed(
  filePath: string,
  actionLabel: string,
  options: { resolveSymlinks?: boolean } = {}
): string {
  if (!isAbsolute(filePath)) {
    throw new Error(`只能${actionLabel}绝对路径`)
  }
  const target = resolve(filePath)
  if (!isLocalFilePathAllowed(target)) {
    throw new Error(`只能${actionLabel} Phi 保存的文件或当前项目内的文件`)
  }
  const inspectedTarget = options.resolveSymlinks ? realpathSync(target) : target
  if (!isLocalFilePathAllowed(inspectedTarget)) {
    throw new Error(`只能${actionLabel} Phi 保存的文件或当前项目内的文件`)
  }
  return inspectedTarget
}

function assertRevealPathAllowed(filePath: string): string {
  return assertLocalFilePathAllowed(filePath, '显示')
}

type LocalPathStatPayload = {
  path: string
  kind: 'file' | 'directory' | 'missing'
}

function localPathStatScope(cwd: unknown): LocalPathScope | null {
  const rawCwd = typeof cwd === 'string' && cwd.trim() ? cwd : currentCwd
  const requestedCwd = resolve(rawCwd)
  if (requestedCwd === resolve(currentCwd)) return currentLocalPathScope()

  const project = getProjectByCwd(rawCwd)
  if (!project) return null

  try {
    assertProjectPathAvailable(project.workingDirectory)
  } catch {
    return null
  }

  return {
    cwd: project.workingDirectory,
    cwdRealPath: project.workingDirectoryRealPath
  }
}

function missingLocalPathStats(paths: string[]): LocalPathStatPayload[] {
  return paths.map((path) => ({ path, kind: 'missing' as const }))
}

function statLocalPath(filePath: string, scope: LocalPathScope): LocalPathStatPayload {
  const missing = { path: filePath, kind: 'missing' as const }
  if (typeof filePath !== 'string' || !isAbsolute(filePath)) return missing

  const target = resolve(filePath)
  if (!isLocalFilePathAllowed(target, scope)) return missing

  try {
    const realTarget = realpathSync(target)
    if (!isLocalFilePathAllowed(realTarget, scope)) return missing

    const stats = statSync(realTarget)
    if (stats.isDirectory()) return { path: target, kind: 'directory' }
    if (stats.isFile()) return { path: target, kind: 'file' }
  } catch {
    return missing
  }

  return missing
}

function statLocalPaths(cwd: unknown, paths: unknown): LocalPathStatPayload[] {
  if (!Array.isArray(paths)) return []

  const uniquePaths = [...new Set(paths.filter((path): path is string => typeof path === 'string'))]
  const limitedPaths = uniquePaths.slice(0, LOCAL_PATH_STAT_LIMIT)
  const scope = localPathStatScope(cwd)
  if (!scope) return missingLocalPathStats(limitedPaths)

  return limitedPaths.map((path) => statLocalPath(path, scope))
}

function readFilePreviewBytes(target: string, bytesToRead: number): Buffer {
  if (bytesToRead <= 0) return Buffer.alloc(0)

  const fd = openSync(target, 'r')
  try {
    const buffer = Buffer.alloc(bytesToRead)
    const bytesRead = readSync(fd, buffer, 0, bytesToRead, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    closeSync(fd)
  }
}

type FilePreviewBasePayload = {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  bytes: number
  previewBytes: number
  truncated: boolean
}

type FilePreviewPayload = FilePreviewBasePayload &
  (
    | {
        kind: 'text'
        mimeType: 'text/plain'
        content: string
      }
    | {
        kind: 'image'
        mimeType: 'image/png'
        dataUrl: string
      }
    | {
        kind: 'pdf'
        mimeType: 'application/pdf'
        dataUrl: string
      }
  )

type FileHoverPreviewPayload = FilePreviewBasePayload &
  (
    | {
        kind: 'text'
        mimeType: 'text/plain'
        content: string
      }
    | {
        kind: 'spreadsheet'
        mimeType: 'text/csv' | 'text/tab-separated-values'
        format: 'csv' | 'tsv'
        content: string
      }
    | {
        kind: 'image'
        mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
        dataUrl: string
      }
    | {
        kind: 'metadata'
        mimeType: string
        reason: 'binary' | 'large_file' | 'pdf' | 'unsupported_media'
      }
  )

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function mediaPreviewType(
  bytes: Buffer
): { kind: 'image'; mimeType: 'image/png' } | { kind: 'pdf'; mimeType: 'application/pdf' } | null {
  if (
    bytes.length >= PNG_SIGNATURE.length &&
    bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return { kind: 'image', mimeType: 'image/png' }
  }
  if (bytes.subarray(0, 5).toString('ascii') === '%PDF-') {
    return { kind: 'pdf', mimeType: 'application/pdf' }
  }
  return null
}

function filePreviewBasePayload(
  target: string,
  stats: { size: number },
  previewBytes: number,
  truncated: boolean
): FilePreviewBasePayload {
  const scope = getLocalPathScope(target)
  return {
    path: target,
    name: basename(target),
    displayPath: scope?.displayPath ?? basename(target),
    rootPath: scope?.rootPath ?? dirname(target),
    rootLabel: scope?.rootLabel ?? basename(dirname(target)),
    bytes: stats.size,
    previewBytes,
    truncated
  }
}

function spreadsheetHoverPreviewType(
  path: string
):
  | { format: 'csv'; mimeType: 'text/csv' }
  | { format: 'tsv'; mimeType: 'text/tab-separated-values' }
  | null {
  const name = basename(path).toLowerCase()
  if (name.endsWith('.csv')) return { format: 'csv', mimeType: 'text/csv' }
  if (name.endsWith('.tsv') || name.endsWith('.tab')) {
    return { format: 'tsv', mimeType: 'text/tab-separated-values' }
  }
  return null
}

function hoverMediaPreviewType(
  bytes: Buffer
):
  | { kind: 'image'; mimeType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' }
  | { kind: 'pdf'; mimeType: 'application/pdf' }
  | null {
  const fullPreviewType = mediaPreviewType(bytes)
  if (fullPreviewType) return fullPreviewType
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { kind: 'image', mimeType: 'image/jpeg' }
  }
  const signature = bytes.subarray(0, 6).toString('ascii')
  if (signature === 'GIF87a' || signature === 'GIF89a') {
    return { kind: 'image', mimeType: 'image/gif' }
  }
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
    bytes.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { kind: 'image', mimeType: 'image/webp' }
  }
  return null
}

function createFilePreview(filePath: string): FilePreviewPayload {
  const target = assertLocalFilePathAllowed(filePath, '预览', { resolveSymlinks: true })
  const stats = statSync(target)
  if (!stats.isFile()) {
    throw new Error('只能预览文件内容')
  }

  const truncated = stats.size > FILE_PREVIEW_BYTES_LIMIT
  const previewBytes = readFilePreviewBytes(target, Math.min(stats.size, FILE_PREVIEW_BYTES_LIMIT))
  const base = filePreviewBasePayload(target, stats, previewBytes.byteLength, truncated)
  const mediaType = mediaPreviewType(previewBytes)
  if (mediaType) {
    if (stats.size > FILE_MEDIA_PREVIEW_BYTES_LIMIT) {
      throw new Error('文件过大，暂不支持直接预览')
    }
    const mediaBytes =
      previewBytes.byteLength === stats.size
        ? previewBytes
        : readFilePreviewBytes(target, stats.size)
    if (mediaType.kind === 'image') {
      return {
        ...base,
        kind: 'image',
        mimeType: 'image/png',
        dataUrl: `data:${mediaType.mimeType};base64,${mediaBytes.toString('base64')}`,
        previewBytes: mediaBytes.byteLength,
        truncated: false
      }
    }

    return {
      ...base,
      kind: 'pdf',
      mimeType: 'application/pdf',
      dataUrl: `data:${mediaType.mimeType};base64,${mediaBytes.toString('base64')}`,
      previewBytes: mediaBytes.byteLength,
      truncated: false
    }
  }

  if (previewBytes.includes(0)) {
    throw new Error('暂不支持预览二进制文件')
  }

  return {
    ...base,
    kind: 'text',
    mimeType: 'text/plain',
    content: previewBytes.toString('utf8'),
    truncated
  }
}

function createFileHoverPreview(filePath: string): FileHoverPreviewPayload {
  const target = assertLocalFilePathAllowed(filePath, '预览', { resolveSymlinks: true })
  const stats = statSync(target)
  if (!stats.isFile()) {
    throw new Error('只能预览文件内容')
  }

  const sniffBytes = readFilePreviewBytes(
    target,
    Math.min(stats.size, FILE_HOVER_SNIFF_BYTES_LIMIT)
  )
  const base = filePreviewBasePayload(
    target,
    stats,
    sniffBytes.byteLength,
    stats.size > sniffBytes.byteLength
  )
  const mediaType = hoverMediaPreviewType(sniffBytes)

  if (mediaType?.kind === 'image') {
    if (stats.size > FILE_HOVER_IMAGE_BYTES_LIMIT) {
      return {
        ...base,
        kind: 'metadata',
        mimeType: mediaType.mimeType,
        reason: 'large_file',
        truncated: true
      }
    }

    const mediaBytes =
      sniffBytes.byteLength === stats.size ? sniffBytes : readFilePreviewBytes(target, stats.size)
    return {
      ...base,
      kind: 'image',
      mimeType: mediaType.mimeType,
      dataUrl: `data:${mediaType.mimeType};base64,${mediaBytes.toString('base64')}`,
      previewBytes: mediaBytes.byteLength,
      truncated: false
    }
  }

  if (mediaType?.kind === 'pdf') {
    return {
      ...base,
      kind: 'metadata',
      mimeType: 'application/pdf',
      reason: 'pdf',
      truncated: stats.size > sniffBytes.byteLength
    }
  }

  if (sniffBytes.includes(0)) {
    return {
      ...base,
      kind: 'metadata',
      mimeType: 'application/octet-stream',
      reason: 'binary',
      truncated: stats.size > sniffBytes.byteLength
    }
  }

  const previewBytes =
    sniffBytes.byteLength >= Math.min(stats.size, FILE_HOVER_TEXT_BYTES_LIMIT)
      ? sniffBytes
      : readFilePreviewBytes(target, Math.min(stats.size, FILE_HOVER_TEXT_BYTES_LIMIT))
  const truncated = stats.size > previewBytes.byteLength
  const spreadsheetType = spreadsheetHoverPreviewType(target)
  if (spreadsheetType) {
    return {
      ...filePreviewBasePayload(target, stats, previewBytes.byteLength, truncated),
      kind: 'spreadsheet',
      mimeType: spreadsheetType.mimeType,
      format: spreadsheetType.format,
      content: previewBytes.toString('utf8')
    }
  }

  return {
    ...filePreviewBasePayload(target, stats, previewBytes.byteLength, truncated),
    kind: 'text',
    mimeType: 'text/plain',
    content: previewBytes.toString('utf8')
  }
}

function openLocalFilePath(filePath: string): Promise<void> {
  const target = assertLocalFilePathAllowed(filePath, '打开', { resolveSymlinks: true })
  return shell.openPath(target).then((errorMessage) => {
    if (errorMessage) {
      throw new Error(errorMessage)
    }
  })
}

function createDirectoryListing(dirPath: string): {
  path: string
  name: string
  displayPath: string
  rootPath: string
  rootLabel: string
  entries: Array<{
    path: string
    name: string
    displayPath: string
    kind: 'directory' | 'file'
  }>
  truncated: boolean
} {
  const target = assertLocalFilePathAllowed(dirPath, '列出', { resolveSymlinks: true })
  const stats = statSync(target)
  if (!stats.isDirectory()) {
    throw new Error('只能列出文件夹内容')
  }

  const entries = readdirSync(target, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = join(target, entry.name)
    let realEntryPath = entryPath
    try {
      realEntryPath = realpathSync(entryPath)
      if (!isLocalFilePathAllowed(realEntryPath)) return []
      const entryStats = statSync(realEntryPath)
      if (!entryStats.isDirectory() && !entryStats.isFile()) return []
      const scope = getLocalPathScope(entryPath)
      return [
        {
          path: entryPath,
          name: entry.name,
          displayPath: scope?.displayPath ?? entry.name,
          kind: entryStats.isDirectory() ? ('directory' as const) : ('file' as const)
        }
      ]
    } catch {
      return []
    }
  })
  entries.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })

  const scope = getLocalPathScope(target)
  return {
    path: target,
    name: basename(target) || target,
    displayPath: scope?.displayPath ?? basename(target),
    rootPath: scope?.rootPath ?? target,
    rootLabel: scope?.rootLabel ?? basename(target),
    entries: entries.slice(0, DIRECTORY_ENTRY_LIMIT),
    truncated: entries.length > DIRECTORY_ENTRY_LIMIT
  }
}

function cancelPendingToolApprovals(): void {
  cancelToolApprovals()
  notifyToolApprovalsCancelled()
}

async function abortSession(session: AgentSessionInstance): Promise<void> {
  cancelPendingToolApprovals()
  await session.abort()
}

async function abortSessionWithoutCancellingApprovals(
  session: AgentSessionInstance
): Promise<void> {
  await session.abort()
}

async function abortAndDisposeSession(
  session: AgentSessionInstance,
  options: { cancelApprovals: boolean }
): Promise<void> {
  if (options.cancelApprovals) {
    await abortSession(session)
  } else {
    await abortSessionWithoutCancellingApprovals(session)
  }
  await session.dispose()
}

async function cleanupSessionRecord(
  record: AgentSessionRecord | null,
  options: { cancelApprovals: boolean } = { cancelApprovals: false }
): Promise<void> {
  if (!record) return

  const controller = sessionAbortControllers.get(
    getSessionControllerKey(record.snapshot, record.generation)
  )
  controller?.abort()

  const barrier: { promise: Promise<void> | null } = { promise: null }
  barrier.promise = (async (): Promise<void> => {
    let resolvedPath = record.snapshot.path
    try {
      const { session } = await record.promise
      resolvedPath = session.sessionFile ?? resolvedPath
      if (
        resolvedPath &&
        barrier.promise &&
        cleanupBarriersByPath.get(resolvedPath) !== barrier.promise
      ) {
        cleanupBarriersByPath.set(resolvedPath, barrier.promise)
      }
      await abortAndDisposeSession(session, options)
    } catch (error) {
      if (
        !isStaleSessionError(error) &&
        !(mainWindowCleanupStarted && isExpectedShutdownCleanupError(error))
      ) {
        rememberErrorSummary(error)
        console.error('Failed to clean up agent session:', error)
      }
    } finally {
      sessionAbortControllers.delete(getSessionControllerKey(record.snapshot, record.generation))
      if (barrier.promise) {
        unknownPathCleanupBarriers.delete(barrier.promise)
      }
      if (resolvedPath && cleanupBarriersByPath.get(resolvedPath) === barrier.promise) {
        cleanupBarriersByPath.delete(resolvedPath)
      }
    }
  })()

  if (record.snapshot.path) {
    cleanupBarriersByPath.set(record.snapshot.path, barrier.promise)
  } else if (barrier.promise) {
    unknownPathCleanupBarriers.add(barrier.promise)
  }

  await barrier.promise
}

async function waitForSessionCleanup(snapshot: SessionSnapshot): Promise<void> {
  if (snapshot.path) {
    await Promise.all([...unknownPathCleanupBarriers])
    await cleanupBarriersByPath.get(snapshot.path)
    return
  }

  await Promise.all([...unknownPathCleanupBarriers])
}

async function getCurrentResolvedSession(): Promise<AgentSessionResult | null> {
  const lifecycle = getCurrentLifecycle()
  const record = lifecycle.currentRecord
  if (!record) return null

  try {
    const result = await record.promise
    return lifecycle.isCurrent(record) ? result : null
  } catch (error) {
    if (!isStaleSessionError(error)) {
      throw error
    }
    return null
  }
}

async function getCurrentResolvedSessionIfReady(): Promise<AgentSessionResult | null> {
  const lifecycle = getCurrentLifecycle()
  const record = lifecycle.currentRecord
  if (!record) return null

  const pending = Symbol('pending')
  try {
    const result = await Promise.race([record.promise, Promise.resolve(pending)])
    if (result === pending) return null
    return lifecycle.isCurrent(record) ? result : null
  } catch (error) {
    if (!isStaleSessionError(error)) {
      throw error
    }
    return null
  }
}

function getCurrentSessionPayload(): CurrentSessionPayload {
  currentPermissionMode = resolveSessionPermissionMode(currentSessionKey, {
    path: currentSessionPath,
    cwd: currentCwd
  })
  const manifest = findPhiManifestForSession(currentSessionKey, currentSessionPath, currentCwd)
  const phiSessionId = manifest?.sessionId ?? getPhiSessionIdForKey(currentSessionKey)
  const path = phiSessionId ? phiOnlySessionPath(phiSessionId) : (currentSessionPath ?? null)
  return {
    path,
    ...(phiSessionId ? { phiSessionId } : {}),
    cwd: currentCwd,
    sessionGeneration: getCurrentLifecycle().currentGeneration,
    permissionMode: currentPermissionMode,
    ...getSessionStatusPayload(currentSessionKey, currentSessionPath, currentCwd)
  }
}

async function getCurrentSessionPayloadWithMessages(): Promise<
  ReturnType<typeof getCurrentSessionPayload> & {
    messages: unknown[]
  }
> {
  const payload = getCurrentSessionPayload()
  const phiSessionId = payload.phiSessionId ?? getPhiSessionIdForKey(currentSessionKey)
  if (!payload.path && !phiSessionId) {
    return { ...payload, messages: [] }
  }

  const current = payload.path
    ? phiSessionId
      ? await getCurrentResolvedSessionIfReady()
      : await getCurrentResolvedSession()
    : null
  return {
    ...payload,
    messages: [
      ...(current?.session.messages ?? []),
      ...readPhiTimelineMessages(
        current?.session.sessionFile ?? payload.path,
        payload.cwd,
        phiSessionId
      )
    ]
  }
}

function notifySessionChanged(): void {
  const payload = getCurrentSessionPayload()
  sendToAllWindows('sessions:changed', payload)
}

function notifyProjectParallelRun(
  sessionGeneration: number,
  sessionPath: string | undefined,
  cwd: string,
  activeCount: number
): void {
  const window = getActiveWindow()
  sendToWindow(window, 'agent:event', {
    type: 'project_parallel_warning',
    sessionGeneration,
    sessionPath: sessionPath ?? null,
    cwd,
    activeCount
  })
}

function countOtherActiveProjectRuns(projectId: string, sessionKey: string): number {
  return [...activePromptRuns.values()].filter(
    (run) => run.projectId === projectId && run.sessionKey !== sessionKey
  ).length
}

async function createDiagnosticsText(): Promise<string> {
  const currentSnapshot: SessionSnapshot = {
    path: currentSessionPath,
    cwd: currentCwd,
    permissionMode: currentPermissionMode
  }
  const [providers, projects, sessions, skills, mcpServers, plugins, selected, thinking, runtime] =
    await Promise.all([
      settledValue([], () => getAuthManager().getProviderStatuses()),
      settledValue([], () => listProjects()),
      settledValue([], () => listSessions()),
      settledValue([], () => listSkills(currentCwd)),
      settledValue([], () => listMcpServers(currentCwd)),
      settledValue([], () => listPlugins()),
      settledValue(null, () => resolveSessionModelSelection(currentSessionKey, currentSnapshot)),
      settledValue(selectedThinkingLevel, () =>
        resolveSessionThinkingLevel(currentSessionKey, currentSnapshot)
      ),
      settledValue(null, () => getAuthManager().getRuntime())
    ])
  const models = runtime ? runtime.getModels() : []
  const phiSessionId =
    getPhiSessionIdForKey(currentSessionKey) ??
    (currentSessionPath
      ? findPhiSessionByRuntimePath(currentSessionPath, currentCwd)?.sessionId
      : undefined)
  const currentSummary = currentSessionPath
    ? sessions.find((session) => session.path === currentSessionPath)
    : undefined
  const activeRun = phiSessionId ? getActivePromptRun(currentSessionKey) : undefined
  const snapshot: DiagnosticsSnapshot = {
    generatedAt: new Date().toISOString(),
    app: {
      name: APP_NAME,
      version: app.getVersion()
    },
    platform: {
      os: process.platform,
      node: process.versions.node,
      electron: process.versions.electron
    },
    currentSession: {
      path: currentSessionPath ?? null,
      ...(phiSessionId ? { phiSessionId } : {}),
      cwd: currentCwd,
      permissionMode: currentPermissionMode,
      status: currentSummary?.status,
      unreadKind: currentSummary?.unreadKind,
      activeRunId: activeRun?.runId
    },
    model: {
      selected,
      thinkingLevel: thinking,
      availableCount: models.length
    },
    providers,
    projects,
    sessions,
    skills,
    mcpServers,
    plugins,
    activeRunCount: activePromptRuns.size,
    logs: {
      directory: getPhiLogDir(),
      retentionDays: LOG_RETENTION_DAYS
    },
    recentErrors: recentErrorSummaries
  }
  return formatDiagnostics(snapshot)
}

async function invalidateAgentSession(): Promise<void> {
  const lifecycle = getCurrentLifecycle()
  const previous = lifecycle.advance()
  advancePromptGeneration(currentSessionKey)
  const activePromptRun = getActivePromptRun(currentSessionKey)
  if (activePromptRun) {
    activePromptRun.cancelled = true
  }
  cancelPendingToolApprovals()
  notifySessionChanged()
  void cleanupSessionRecord(previous)
}

async function stopActivePrompt(): Promise<void> {
  // Invalidate queued work even before its queue callback sets activePromptRun.
  advancePromptGeneration(currentSessionKey)
  const run = getActivePromptRun(currentSessionKey)
  if (!run) {
    cancelPendingToolApprovals()
    return
  }

  run.cancelled = true
  runnerRegistry.stopRun(run.phiSessionId)
  cancelPendingToolApprovals()
  if (run.session) {
    await abortSession(run.session)
  }
}

async function stopAllPromptRuns(): Promise<void> {
  for (const [sessionKey, run] of activePromptRuns) {
    advancePromptGeneration(sessionKey)
    run.cancelled = true
  }
  runnerRegistry.stopAll()
  cancelPendingToolApprovals()
  await Promise.all(
    [...activePromptRuns.values()].map(async (run) => {
      if (!run.session) return
      await abortSessionWithoutCancellingApprovals(run.session)
    })
  )
}

function cleanupMainWindowRuntime(): void {
  if (mainWindowCleanupStarted) return
  mainWindowCleanupStarted = true
  void stopAllPromptRuns()
  notebookFileWatcher.dispose()
  jupyterServerRegistry.disposeAll()
  void invalidateAgentSession()
}

// A user-visible conversation switch points future getAgentSession() calls at a
// different file/cwd/permission mode. It deliberately does not abort the old
// session: switching conversations is navigation, not stop.
async function disposeAndSwitchSession(
  path: string | undefined,
  cwd: string = WORKSPACE_DIR,
  permissionMode: PermissionMode = 'auto',
  options: { notify?: boolean } = {}
): Promise<{
  path: string | null
  cwd: string
  sessionGeneration: number
  permissionMode: PermissionMode
}> {
  if (!path) {
    freshSessionCounter += 1
  }
  currentSessionPath = path
  currentCwd = cwd
  currentSessionKey = createSessionKey(path, cwd)
  currentPermissionMode = resolveSessionPermissionMode(currentSessionKey, { path, cwd })
  if (!path) {
    sessionPermissionModes.set(resolveSessionKeyAlias(currentSessionKey), permissionMode)
    currentPermissionMode = permissionMode
  }
  const target = getCurrentSessionPayload()
  if (options.notify !== false) {
    notifySessionChanged()
  }
  return target
}

async function getAgentSession(
  sessionKey: string = currentSessionKey,
  snapshot: SessionSnapshot = {
    path: currentSessionPath,
    cwd: currentCwd,
    permissionMode: currentPermissionMode
  }
): Promise<AgentSessionResult> {
  const lifecycle = getLifecycleForKey(sessionKey)
  const record = lifecycle.getOrCreate(
    snapshot,
    async (creationSnapshot, generation) => {
      if (!lifecycle.isCurrentGeneration(generation)) {
        throw new StaleSessionError()
      }
      await waitForSessionCleanup(creationSnapshot)
      if (!lifecycle.isCurrentGeneration(generation)) {
        throw new StaleSessionError()
      }
      const runtime = await getAuthManager().getRuntime()
      if (!lifecycle.isCurrentGeneration(generation)) {
        throw new StaleSessionError()
      }
      const modelSelection = resolveSessionModelSelection(sessionKey, creationSnapshot)
      const resolvedModel = modelSelection
        ? resolveRuntimeModelSelection(runtime, modelSelection)
        : null
      const model = resolvedModel?.model
      if (modelSelection && !resolvedModel) {
        throw new Error(`模型不可用: ${modelSelectionLabel(modelSelection)}`)
      }
      if (resolvedModel?.migratedFrom) {
        sessionModelSelections.set(resolveSessionKeyAlias(sessionKey), resolvedModel.selection)
        const run = getActivePromptRun(sessionKey)
        const phiSessionId = run?.phiSessionId ?? getPhiSessionIdForKey(sessionKey)
        if (phiSessionId) {
          const stored = appendSessionEvent(phiSessionId, {
            type: 'model_selection_migrated',
            ...(run ? { runId: run.runId } : {}),
            fromProviderId: resolvedModel.migratedFrom.providerId,
            fromModelId: resolvedModel.migratedFrom.modelId,
            toProviderId: resolvedModel.selection.providerId,
            toModelId: resolvedModel.selection.modelId,
            toModelName: resolvedModel.model.name
          })
          updateSessionManifest(phiSessionId, { model: resolvedModel.selection })
          const targetWindow = getActiveWindow()
          const sessionPath = uiSessionPathForKey(sessionKey, creationSnapshot.path)
          sendToWindow(targetWindow, 'agent:event', {
            ...stored,
            phiSessionId,
            sessionGeneration: generation,
            sessionPath,
            cwd: creationSnapshot.cwd
          })
        }
      }
      const thinkingLevel = resolveSessionThinkingLevel(sessionKey, creationSnapshot)
      const sessionAbortController = new AbortController()
      sessionAbortControllers.set(
        getSessionControllerKey(creationSnapshot, generation),
        sessionAbortController
      )

      let resourceLoader: RuntimeResourceLoader | undefined
      const notebookPrompt = notebookAgentRuntimePrompt(creationSnapshot.cwd)
      const extensionFactories =
        creationSnapshot.permissionMode === 'ask'
          ? [
              createApprovalExtension({
                signal: sessionAbortController.signal,
                getContext: () => {
                  const run = getActivePromptRun(sessionKey)
                  if (!run) return null
                  const project = getProjectByCwd(creationSnapshot.cwd)
                  return {
                    sessionId: run.phiSessionId,
                    sessionPath: phiOnlySessionPath(run.phiSessionId),
                    sessionGeneration: run.sessionGeneration,
                    runId: run.runId,
                    cwd: creationSnapshot.cwd,
                    ...(project?.name ? { projectName: project.name } : {})
                  }
                },
                onApprovalRequested: (request) => {
                  if (!request.sessionId) return
                  runnerRegistry.markNeedsApproval(request.sessionId, request.requestId, {
                    toolName: request.toolName,
                    summary: request.summary
                  })
                },
                onApprovalResolved: (request, approved) => {
                  if (!request.sessionId) return
                  if (approved) {
                    runnerRegistry.markApprovalApproved(request.sessionId, request.requestId)
                  } else {
                    runnerRegistry.markApprovalDenied(request.sessionId, request.requestId)
                  }
                },
                onApprovalCancelled: (request) => {
                  if (!request.sessionId) return
                  runnerRegistry.markApprovalCancelled(request.sessionId, request.requestId)
                }
              })
            ]
          : []
      if (notebookPrompt || extensionFactories.length > 0) {
        resourceLoader = createRuntimeResourceLoader({
          cwd: creationSnapshot.cwd,
          agentDir: AGENT_DIR,
          ...(notebookPrompt ? { appendSystemPrompt: [notebookPrompt] } : {}),
          ...(extensionFactories.length > 0 ? { extensionFactories } : {})
        })
        await resourceLoader.reload()
      }
      if (!lifecycle.isCurrentGeneration(generation)) {
        throw new StaleSessionError()
      }

      const result = await createAgentSession({
        modelRuntime: runtime,
        thinkingLevel,
        cwd: creationSnapshot.cwd,
        sessionManager: createSessionManager(
          creationSnapshot.cwd,
          runtimeSessionPathForSnapshot(sessionKey, creationSnapshot)
        ),
        ...(resourceLoader ? { resourceLoader } : {}),
        ...(model ? { model } : {})
      })
      const run = getActivePromptRun(sessionKey)
      if (run) {
        linkPromptRunRuntimeSessionPath(sessionKey, creationSnapshot.cwd, run, result.session)
      } else {
        linkMaterializedRuntimeSessionPath(
          sessionKey,
          creationSnapshot.cwd,
          result.session.sessionFile
        )
      }
      if (
        lifecycle.isCurrentGeneration(generation) &&
        sameCanonicalSessionKey(sessionKey, currentSessionKey)
      ) {
        const nextSessionPath = uiSessionPathForKey(sessionKey, creationSnapshot.path)
        if (currentSessionPath !== nextSessionPath) {
          currentSessionPath = nextSessionPath ?? undefined
          notifySessionChanged()
        }
      }

      result.session.subscribe((summary) => {
        if (!lifecycle.isCurrentGeneration(generation)) return
        const run = getActivePromptRun(sessionKey)
        const persistedSummary = run ? persistSessionEvent(run, summary) : summary
        const targetWindow = getActiveWindow()
        const phiSessionId = run?.phiSessionId ?? getPhiSessionIdForKey(sessionKey)
        sendToWindow(targetWindow, 'agent:event', {
          ...persistedSummary,
          ...(phiSessionId ? { phiSessionId } : {}),
          sessionGeneration: generation,
          sessionPath: phiSessionId
            ? phiOnlySessionPath(phiSessionId)
            : (result.session.sessionFile ?? creationSnapshot.path ?? null),
          cwd: creationSnapshot.cwd
        })
      })

      return result
    },
    async ({ session }) => {
      await abortAndDisposeSession(session, { cancelApprovals: false })
    }
  )

  return record.promise
}

async function applyNextRunConfiguration(
  session: AgentSessionInstance,
  sessionKey: string,
  snapshot: SessionSnapshot
): Promise<void> {
  const runtime = await getAuthManager().getRuntime()
  const modelSelection = resolveSessionModelSelection(sessionKey, snapshot)
  if (modelSelection) {
    const resolvedModel = resolveRuntimeModelSelection(runtime, modelSelection)
    if (!resolvedModel) {
      throw new Error(`模型不可用: ${modelSelectionLabel(modelSelection)}`)
    }
    await session.setModel(resolvedModel.model)
  }
  session.setThinkingLevel(resolveSessionThinkingLevel(sessionKey, snapshot))
}

function createWindow(): void {
  mainWindowCleanupStarted = false

  // Create the browser window.
  const window = new BrowserWindow({
    title: APP_NAME,
    width: DEFAULT_WINDOW_WIDTH,
    height: DEFAULT_WINDOW_HEIGHT,
    minWidth: MIN_WINDOW_WIDTH,
    minHeight: MIN_WINDOW_HEIGHT,
    show: true,
    autoHideMenuBar: true,
    transparent: false,
    // macOS titleBarStyle paints a system sidebar material behind the left pane.
    // Use a frameless window and opt the traffic lights back in so the renderer
    // owns every background pixel.
    ...(process.platform === 'darwin' ? { frame: false } : {}),
    backgroundMaterial: 'none',
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0B262D' : '#FFFFFF',
    icon: appIcon,
    webPreferences: {
      preload: join(import.meta.dirname, '../preload/index.mjs'),
      sandbox: false
    }
  })
  mainWindow = window

  window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#0B262D' : '#FFFFFF')
  window.webContents.setBackgroundThrottling(false)
  if (process.platform === 'darwin') {
    window.setVibrancy(null)
    window.setWindowButtonVisibility(false)
  }

  window.on('ready-to-show', () => {
    window.show()
  })

  window.on('close', () => {
    cleanupMainWindowRuntime()
  })

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null
    }
  })

  window.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    window.loadFile(join(import.meta.dirname, '../renderer/index.html'))
  }
}

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  applyDockIcon()

  const removedLogs = cleanupOldLogs()
  writeAppLog({ event: 'app_started', metadata: { removedOldLogs: removedLogs } })
  recoverInterruptedPhiSessions()
  try {
    ensureBundledWrappersInstalled()
  } catch (error) {
    writeAppLog({
      level: 'error',
      event: 'wrapper_bundled_install_failed',
      metadata: { error: error instanceof Error ? error.message : String(error) }
    })
  }
  // Fire-and-forget: resumes any slurm-controller run left mid-flight by the
  // previous app session (see executor-slurm-reconcile.ts's doc comment).
  // Must never block startup — a network hiccup here shouldn't delay the window.
  void reconcileRemoteWrapperRuns().catch((error: unknown) => {
    writeAppLog({
      level: 'error',
      event: 'wrapper_remote_run_reconcile_failed',
      metadata: { error: error instanceof Error ? error.message : String(error) }
    })
  })
  // Set app user model id for windows
  electronApp.setAppUserModelId(APP_ID)

  // Default open or close DevTools by F12 in development
  // and ignore CommandOrControl + R in production.
  // see https://github.com/alex8088/electron-toolkit/tree/master/packages/utils
  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // IPC test
  ipcMain.on('ping', () => console.log('pong'))
  ipcMain.handle('window:close', () => {
    getActiveWindow()?.close()
  })
  ipcMain.handle('window:minimize', () => {
    getActiveWindow()?.minimize()
  })
  ipcMain.handle('window:toggle-fullscreen', () => {
    const window = getActiveWindow()
    if (!window) return
    window.setFullScreen(!window.isFullScreen())
  })
  ipcMain.handle('files:reveal', async (_, filePath: string) => {
    shell.showItemInFolder(assertRevealPathAllowed(filePath))
  })
  ipcMain.handle('files:openPath', async (_, filePath: string) => {
    await openLocalFilePath(filePath)
  })
  ipcMain.handle('files:pickInput', async () => {
    const window = getActiveWindow()
    const options: Electron.OpenDialogOptions = {
      defaultPath: currentCwd || undefined,
      properties: ['openFile', 'openDirectory', 'multiSelections']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? [] : result.filePaths
  })
  ipcMain.handle('files:preview', async (_, filePath: string) => {
    return createFilePreview(filePath)
  })
  ipcMain.handle('files:hoverPreview', async (_, filePath: string) => {
    return createFileHoverPreview(filePath)
  })
  ipcMain.handle('files:statLocalPaths', async (_, cwd: unknown, paths: unknown) => {
    return statLocalPaths(cwd, paths)
  })
  ipcMain.handle('files:listDirectory', async (_, dirPath: string) => {
    return createDirectoryListing(dirPath)
  })
  ipcMain.handle('diagnostics:copy', async () => {
    const text = await createDiagnosticsText()
    clipboard.writeText(text)
    writeAppLog({ event: 'diagnostics_copied' })
    return text
  })

  ipcMain.handle('agent:prompt', async (_, text: string, targetInput?: unknown) => {
    const normalizedText = text.trim()
    if (!normalizedText) return null
    if (targetInput !== undefined) {
      await alignCurrentSessionToPromptTarget(targetInput)
    }

    const runSessionKey = resolveSessionKeyAlias(currentSessionKey)
    const runGeneration = advancePromptGeneration(runSessionKey)
    const runLifecycle = getLifecycleForKey(runSessionKey)
    const runSessionGeneration = runLifecycle.currentGeneration
    const runSnapshot: SessionSnapshot & { permissionMode: PermissionMode } = {
      path: runtimeSessionPath(currentSessionPath),
      cwd: currentCwd,
      permissionMode: currentPermissionMode
    }
    const project = getProjectByCwd(runSnapshot.cwd)
    const phiSessionId = ensurePhiSessionId(runSessionKey, runSnapshot, normalizedText)
    const stableSessionPath = phiOnlySessionPath(phiSessionId)
    const runId = createRunId()
    if (hasActivePromptRun(runSessionKey)) {
      throw new Error('会话正在运行')
    }
    const otherActiveProjectRuns = project
      ? countOtherActiveProjectRuns(project.id, runSessionKey)
      : 0
    const promptRun: PromptRun = {
      sessionKey: runSessionKey,
      phiSessionId,
      runId,
      cwd: runSnapshot.cwd,
      ...(project ? { projectId: project.id } : {}),
      generation: runGeneration,
      sessionGeneration: runSessionGeneration,
      cancelled: false,
      thinkingBlocks: new Map(),
      thinkingBlockStartedAtMs: new Map(),
      compactionReasons: new Map(),
      sessionPath: stableSessionPath
    }
    setActivePromptRun(runSessionKey, promptRun)
    appendSessionEvent(phiSessionId, {
      type: 'user_message',
      runId,
      content: normalizedText
    })
    if (otherActiveProjectRuns > 0) {
      notifyProjectParallelRun(
        runSessionGeneration,
        stableSessionPath,
        runSnapshot.cwd,
        otherActiveProjectRuns
      )
    }

    // Serialize prompts per session: duplicate/overlapping IPC invokes must
    // never run session.prompt() concurrently within the same conversation.
    const run = getPromptQueue(runSessionKey).then(async () => {
      let promptResult: {
        path: string | null
        phiSessionId?: string
        sessionGeneration: number
      } | null = null
      if (
        promptRun.cancelled ||
        promptRun.generation !== getPromptGeneration(runSessionKey) ||
        !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
      ) {
        return null
      }

      const registryRun = runnerRegistry.startRun({
        sessionId: phiSessionId,
        runId,
        getRecordedFailure: () => promptRun.recordedFailureMessage,
        execute: async ({ signal }) => {
          if (signal.aborted || promptRun.cancelled) return

          let session: AgentSessionInstance
          try {
            const result = await getAgentSession(runSessionKey, runSnapshot)
            session = result.session
          } catch (error) {
            if (
              isStaleSessionError(error) ||
              promptRun.cancelled ||
              signal.aborted ||
              !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
            ) {
              return
            }
            throw error
          }
          promptRun.session = session

          await applyNextRunConfiguration(session, runSessionKey, runSnapshot)

          if (
            signal.aborted ||
            promptRun.cancelled ||
            promptRun.generation !== getPromptGeneration(runSessionKey) ||
            !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
          ) {
            await abortSession(session)
            return
          }

          try {
            await session.prompt(withNextActionRecommendationInstruction(normalizedText), {
              preflightResult: (success) => {
                if (
                  success &&
                  (signal.aborted ||
                    promptRun.cancelled ||
                    promptRun.generation !== getPromptGeneration(runSessionKey) ||
                    !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration))
                ) {
                  void abortSessionWithoutCancellingApprovals(session).catch((error) => {
                    rememberErrorSummary(error)
                    console.error('Failed to abort stale prompt:', error)
                  })
                  throw new StaleSessionError()
                }
              }
            })
          } catch (error) {
            linkPromptRunRuntimeSessionPath(runSessionKey, runSnapshot.cwd, promptRun, session)
            if (
              signal.aborted ||
              promptRun.cancelled ||
              promptRun.generation !== getPromptGeneration(runSessionKey) ||
              !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
            ) {
              return
            }
            throw error
          }
          linkPromptRunRuntimeSessionPath(runSessionKey, runSnapshot.cwd, promptRun, session)

          if (
            signal.aborted ||
            promptRun.cancelled ||
            promptRun.generation !== getPromptGeneration(runSessionKey) ||
            !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
          ) {
            return
          }

          // A brand-new chat's first prompt is when it actually becomes a file on disk —
          // hand the stable Phi path back so the renderer can refresh and highlight it.
          if (sameCanonicalSessionKey(runSessionKey, currentSessionKey)) {
            currentSessionPath = stableSessionPath
          }
          promptRun.sessionPath = stableSessionPath
          promptResult = {
            path: stableSessionPath,
            phiSessionId,
            sessionGeneration: promptRun.sessionGeneration
          }
        }
      })
      await registryRun.done
      return promptRun.cancelled ? null : promptResult
    })
    promptRun.done = run
    setPromptQueue(
      runSessionKey,
      run.then(
        () => {
          deleteActivePromptRun(runSessionKey, promptRun)
          notifySessionChanged()
        },
        () => {
          deleteActivePromptRun(runSessionKey, promptRun)
          notifySessionChanged()
        }
      )
    )
    return run
  })

  ipcMain.handle('agent:stop', async () => {
    await stopActivePrompt()
  })

  ipcMain.handle('auth:status', async () => getAuthManager().getProviderStatuses())
  ipcMain.handle('auth:loginApiKey', async (_, providerId: string, key: string) => {
    const normalizedKey = key.trim()
    const status = await getAuthManager().loginApiKey(providerId, normalizedKey)
    await invalidateAgentSession()
    return status
  })
  ipcMain.handle('auth:loginOAuth', async (_, providerId: string) => {
    const status = await getAuthManager().loginOAuth(providerId)
    await invalidateAgentSession()
    return status
  })
  ipcMain.handle('auth:logout', async (_, providerId: string) => {
    await getAuthManager().logout(providerId)
    await invalidateAgentSession()
  })
  ipcMain.handle('auth:interaction-response', async (_, requestId: string, value: string) => {
    await getAuthManager().resolveInteraction(requestId, value)
  })

  ipcMain.handle('models:list', async () => {
    const runtime = await getAuthManager().getRuntime()
    return selectableRuntimeModels(runtime).map((model) => ({
      providerId: model.provider,
      modelId: model.id,
      name: model.name,
      thinkingLevels: getSupportedThinkingLevels(model)
    }))
  })
  ipcMain.handle('models:select', async (_, providerId: string, modelId: string) => {
    const runtime = await getAuthManager().getRuntime()
    const resolved = resolveRuntimeModelSelection(runtime, { providerId, modelId })
    if (!resolved || resolved.migratedFrom) {
      throw new Error(`未知模型: ${providerId}/${modelId}`)
    }
    const model = resolved.model

    const nextModel = { providerId, modelId }
    sessionModelSelections.set(resolveSessionKeyAlias(currentSessionKey), nextModel)
    const phiSessionId = getPhiSessionIdForKey(currentSessionKey)
    if (phiSessionId) {
      updateSessionManifest(phiSessionId, { model: nextModel })
    }
    if (hasActivePromptRun(currentSessionKey)) {
      return
    }
    const current = await getCurrentResolvedSession()
    if (current) {
      const { session } = current
      await session.setModel(model)
    }
  })
  ipcMain.handle('models:selected', async () => {
    const snapshot: SessionSnapshot = {
      path: currentSessionPath,
      cwd: currentCwd,
      permissionMode: currentPermissionMode
    }
    const resolved = resolveSessionModelSelection(currentSessionKey, snapshot)
    if (resolved) {
      const runtime = await getAuthManager().getRuntime()
      return resolveRuntimeModelSelection(runtime, resolved)?.selection ?? resolved
    }

    const current = await getCurrentResolvedSession()
    if (!current) return null

    const { session } = current
    const model = session.model
    return model ? { providerId: model.provider, modelId: model.id } : null
  })

  ipcMain.handle('thinking:select', async (_, level: ThinkingLevel) => {
    sessionThinkingLevels.set(resolveSessionKeyAlias(currentSessionKey), level)
    const phiSessionId = getPhiSessionIdForKey(currentSessionKey)
    if (phiSessionId) {
      updateSessionManifest(phiSessionId, { thinkingLevel: level })
    }
    if (hasActivePromptRun(currentSessionKey)) {
      return
    }
    const current = await getCurrentResolvedSession()
    if (current) {
      const { session } = current
      session.setThinkingLevel(level)
    }
  })
  ipcMain.handle('thinking:selected', async () => {
    const resolved = sessionThinkingLevels.get(resolveSessionKeyAlias(currentSessionKey))
    if (resolved) return resolved

    const current = await getCurrentResolvedSession()
    if (current) {
      const { session } = current
      return session.thinkingLevel
    }
    return resolveSessionThinkingLevel(currentSessionKey, {
      path: currentSessionPath,
      cwd: currentCwd,
      permissionMode: currentPermissionMode
    })
  })

  ipcMain.handle('sessions:list', async () => listSessions())
  ipcMain.handle('sessions:current', async () => getCurrentSessionPayloadWithMessages())
  ipcMain.handle('sessions:updatePermissionMode', async (_, permissionMode: PermissionMode) => {
    currentPermissionMode = permissionMode
    sessionPermissionModes.set(resolveSessionKeyAlias(currentSessionKey), permissionMode)
    const phiSessionId =
      getPhiSessionIdForKey(currentSessionKey) ??
      (currentSessionPath
        ? findPhiManifestForSession(currentSessionKey, currentSessionPath, currentCwd)?.sessionId
        : undefined)
    if (phiSessionId) {
      updateSessionManifest(phiSessionId, { permissionMode })
    }
    if (!hasActivePromptRun(currentSessionKey)) {
      await invalidateAgentSession()
    }
    notifySessionChanged()
    return getCurrentSessionPayload()
  })
  ipcMain.handle('sessions:create', async () => {
    const session = createPhiManagedSession(WORKSPACE_DIR, 'auto')
    return disposeAndSwitchSession(session.path, WORKSPACE_DIR, session.permissionMode)
  })
  ipcMain.handle('sessions:switch', async (_, path: string) => {
    const request = ++sessionSwitchRequest
    const phiOnlySessionId = phiSessionIdFromPath(path)
    if (phiOnlySessionId) {
      const manifest = findPhiSessionById(phiOnlySessionId)
      if (!manifest) return null
      const targetKey = createSessionKey(path, manifest.cwd)
      setPhiSessionIdForKey(targetKey, phiOnlySessionId)
      sessionPermissionModes.set(resolveSessionKeyAlias(targetKey), manifest.permissionMode)
      const shouldBecomeCurrent = request === sessionSwitchRequest
      const target = shouldBecomeCurrent
        ? await disposeAndSwitchSession(path, manifest.cwd, manifest.permissionMode, {
            notify: false
          })
        : {
            path,
            cwd: manifest.cwd,
            sessionGeneration: getLifecycleForKey(targetKey).currentGeneration,
            permissionMode: manifest.permissionMode
          }
      if (shouldBecomeCurrent) {
        acknowledgeSession(path, manifest.cwd)
      }
      return {
        path,
        phiSessionId: manifest.sessionId,
        cwd: target.cwd,
        sessionGeneration: target.sessionGeneration,
        permissionMode: manifest.permissionMode,
        ...getSessionStatusPayload(targetKey, path, target.cwd),
        messages: readPhiTimelineMessages(null, target.cwd, phiOnlySessionId)
      }
    }

    // The session file already knows its own cwd (a project session was created with
    // that project's folder as cwd) — read it so switching to it also restores the
    // right permission mode, regardless of which sidebar section it was opened from.
    const cwd = (await openRuntimeSessionManager(path)).getCwd()
    const targetKey = createSessionKey(path, cwd)
    const permissionMode = resolveSessionPermissionMode(targetKey, { path, cwd })
    const shouldBecomeCurrent = request === sessionSwitchRequest
    const target = shouldBecomeCurrent
      ? await disposeAndSwitchSession(path, cwd, permissionMode, { notify: false })
      : {
          path,
          cwd,
          sessionGeneration: getLifecycleForKey(createSessionKey(path, cwd)).currentGeneration,
          permissionMode
        }
    const targetLifecycle = getLifecycleForKey(targetKey)
    const targetSnapshot: SessionSnapshot = { path, cwd, permissionMode }
    let session: AgentSessionInstance
    try {
      const result = await getAgentSession(targetKey, targetSnapshot)
      session = result.session
    } catch (error) {
      if (
        isStaleSessionError(error) ||
        !targetLifecycle.isCurrentGeneration(target.sessionGeneration)
      ) {
        return null
      }
      throw error
    }
    if (!targetLifecycle.isCurrentGeneration(target.sessionGeneration)) {
      return null
    }
    if (shouldBecomeCurrent && target.path) {
      acknowledgeSession(target.path, target.cwd)
    }
    const sessionPath = session.sessionFile ?? path
    const phiSessionId = getPhiSessionIdForKey(targetKey)
    return {
      path: phiSessionId ? phiOnlySessionPath(phiSessionId) : sessionPath,
      ...(phiSessionId ? { phiSessionId } : {}),
      cwd: target.cwd,
      sessionGeneration: target.sessionGeneration,
      permissionMode,
      ...getSessionStatusPayload(targetKey, sessionPath, target.cwd),
      messages: [
        ...session.messages,
        ...readPhiTimelineMessages(sessionPath, target.cwd, getPhiSessionIdForKey(targetKey))
      ]
    }
  })
  ipcMain.handle('sessions:acknowledge', async (_, path: string) => {
    const phiOnlySessionId = phiSessionIdFromPath(path)
    const cwd = phiOnlySessionId
      ? (findPhiSessionById(phiOnlySessionId)?.cwd ?? currentCwd)
      : (await openRuntimeSessionManager(path)).getCwd()
    return acknowledgeSession(path, cwd)
  })
  ipcMain.handle('sessions:delete', async (_, path: string) => {
    if (currentSessionPath === path) {
      await disposeAndSwitchSession(undefined)
    }
    const phiSessionId = phiSessionIdFromPath(path)
    const manifest = phiSessionId
      ? findPhiSessionById(phiSessionId)
      : findPhiSessionByRuntimePath(path, currentCwd)
    // Let an aborted run finish persisting before unlinking its history; otherwise
    // the final SDK write can recreate a conversation the user just deleted.
    await waitForSessionCleanup({
      path: manifest?.runtimeSessionPath ?? runtimeSessionPath(path),
      cwd: manifest?.cwd ?? currentCwd,
      permissionMode: currentPermissionMode
    })
    deleteSession(path)
  })
  ipcMain.handle('sessions:rename', async (_, path: string, name: string) => {
    const trimmedName = name.trim()
    if (!trimmedName) return

    if (isPhiOnlySessionPath(path)) {
      await renameSession(path, trimmedName)
      return
    }
    const current = await getCurrentResolvedSession()
    if (currentSessionPath === path && current) {
      const { session } = current
      await session.sessionManager.setSessionName(trimmedName, 'user')
      return
    }
    await renameSession(path, trimmedName)
  })

  ipcMain.handle('projects:list', async () => listProjects())
  ipcMain.handle('projects:pickDirectory', async () => {
    const window = getActiveWindow()
    const options: Electron.OpenDialogOptions = {
      properties: ['openDirectory', 'createDirectory']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle(
    'projects:create',
    async (_, name: string, workingDirectory: string, permissionMode: PermissionMode) =>
      createProject({ name, workingDirectory, permissionMode })
  )
  ipcMain.handle('projects:delete', async (_, id: string) => {
    deleteProject(id)
  })
  ipcMain.handle(
    'projects:updatePermissionMode',
    async (_, id: string, permissionMode: PermissionMode) => {
      const project = updateProjectPermissionMode(id, permissionMode)
      if (project.workingDirectory === currentCwd) {
        currentPermissionMode = project.permissionMode
        await invalidateAgentSession()
      }
      return project
    }
  )
  ipcMain.handle(
    'projects:updateDefaults',
    async (
      _,
      id: string,
      defaults: {
        defaultModel?: ModelSelection | null
        defaultThinkingLevel?: ThinkingLevel | null
      }
    ) => {
      if (defaults.defaultModel) {
        const runtime = await getAuthManager().getRuntime()
        const resolved = resolveRuntimeModelSelection(runtime, defaults.defaultModel)
        if (!resolved || resolved.migratedFrom) {
          throw new Error(
            `模型不可用: ${defaults.defaultModel.providerId}/${defaults.defaultModel.modelId}`
          )
        }
      }
      return updateProjectDefaults(id, defaults)
    }
  )
  ipcMain.handle('projects:pickPrivateKeyFile', async () => {
    const window = getActiveWindow()
    const options: Electron.OpenDialogOptions = {
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile']
    }
    const result = window
      ? await dialog.showOpenDialog(window, options)
      : await dialog.showOpenDialog(options)
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })
  ipcMain.handle('projects:isRemoteCredentialStorageAvailable', async () =>
    isRemoteCredentialStorageAvailable()
  )
  ipcMain.handle(
    'projects:updateRemoteConnection',
    async (
      _,
      id: string,
      connectionId: string,
      patch: ProjectRemoteConnection | null,
      passphrase?: string | null
    ) => {
      const project = updateProjectRemoteConnection(id, connectionId, patch)
      // Keep the credential store in sync with the connection record: removed
      // entirely, or its passphrase explicitly cleared/rotated — see
      // remote-credential-store.ts, which never lets projects.ts's plain
      // projects.json hold the passphrase itself.
      if (patch === null || passphrase === null) {
        deleteRemoteConnectionPassphrase(connectionId)
      } else if (passphrase) {
        storeRemoteConnectionPassphrase(connectionId, passphrase)
      }
      return project
    }
  )
  ipcMain.handle(
    'projects:updateRemoteDefaults',
    async (
      _,
      id: string,
      defaults: {
        defaultRemoteConnectionId?: string | null
        remoteWorkspaceRoot?: string | null
      }
    ) => updateProjectRemoteDefaults(id, defaults)
  )
  ipcMain.handle('projects:sessions', async (_, workingDirectory: string) =>
    listSessions(workingDirectory)
  )
  ipcMain.handle(
    'projects:newSession',
    async (_, workingDirectory: string, permissionMode: PermissionMode) => {
      assertProjectPathAvailable(workingDirectory)
      const session = createPhiManagedSession(workingDirectory, permissionMode)
      return disposeAndSwitchSession(session.path, workingDirectory, session.permissionMode)
    }
  )
  ipcMain.handle('analysis:listNotebooks', async (_, cwd?: string) => {
    const targetCwd = cwd ?? currentCwd
    const project = getProjectByCwd(targetCwd)
    if (!project) {
      return emptyNotebookRegistry('选择一个项目后显示 notebooks')
    }
    assertProjectPathAvailable(project.workingDirectory)
    const registry = listProjectNotebooks(project.workingDirectory)
    return {
      projectCwd: project.workingDirectory,
      projectName: project.name,
      ...registry
    }
  })
  ipcMain.handle('analysis:initializeProject', async (_, cwd: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    return initializeProjectAnalysis(project.workingDirectory)
  })
  ipcMain.handle('analysis:openNotebook', async (_, cwd: string, notebookPath: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    const file = notebookFileWatcher.watch(project.workingDirectory, notebookPath)
    activeNotebookPathByProjectCwd.set(project.workingDirectory, file.path)
    notebookToolExecutor.syncDraft({
      cwd: project.workingDirectory,
      path: file.path,
      document: file.document,
      savedRevision: file.savedRevision,
      source: 'renderer'
    })
    return file
  })
  ipcMain.handle(
    'analysis:saveNotebook',
    async (_, cwd: string, input: SaveProjectNotebookInput) => {
      const project = getProjectByCwd(cwd)
      if (!project) {
        throw new Error('请选择一个已添加的项目')
      }
      assertProjectPathAvailable(project.workingDirectory)
      const file = saveProjectNotebook(project.workingDirectory, input)
      notebookFileWatcher.noteLocalWrite(project.workingDirectory, file)
      activeNotebookPathByProjectCwd.set(project.workingDirectory, file.path)
      notebookToolExecutor.syncDraft({
        cwd: project.workingDirectory,
        path: file.path,
        document: file.document,
        savedRevision: file.savedRevision,
        source: 'renderer'
      })
      return file
    }
  )
  ipcMain.handle(
    'analysis:syncNotebookDraft',
    async (
      _,
      cwd: string,
      notebookPath: string,
      document: NotebookDocument,
      savedRevision?: string
    ) => {
      const project = getProjectByCwd(cwd)
      if (!project) {
        throw new Error('请选择一个已添加的项目')
      }
      assertProjectPathAvailable(project.workingDirectory)
      const file = openProjectNotebook(project.workingDirectory, notebookPath)
      activeNotebookPathByProjectCwd.set(project.workingDirectory, file.path)
      return notebookToolExecutor.syncDraft({
        cwd: project.workingDirectory,
        path: file.path,
        document,
        savedRevision,
        source: 'renderer'
      })
    }
  )
  ipcMain.handle('analysis:createNotebook', async (_, cwd: string, relativePath?: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    const file = createProjectNotebook(project.workingDirectory, relativePath)
    notebookFileWatcher.watchFile(project.workingDirectory, file)
    activeNotebookPathByProjectCwd.set(project.workingDirectory, file.path)
    return file
  })
  ipcMain.handle('analysis:closeNotebook', async (_, cwd: string, notebookPath: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    const file = openProjectNotebook(project.workingDirectory, notebookPath)
    await notebookSessionRegistry.closeSession(project.workingDirectory, file.path)
    if (activeNotebookPathByProjectCwd.get(project.workingDirectory) === file.path) {
      activeNotebookPathByProjectCwd.delete(project.workingDirectory)
    }
    notebookFileWatcher.unwatchFile(project.workingDirectory, file)
    return closeProjectNotebook(project.workingDirectory, notebookPath)
  })
  ipcMain.handle('analysis:deleteNotebook', async (_, cwd: string, notebookPath: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    const file = openProjectNotebook(project.workingDirectory, notebookPath)
    await notebookSessionRegistry.closeSession(project.workingDirectory, file.path)
    if (activeNotebookPathByProjectCwd.get(project.workingDirectory) === file.path) {
      activeNotebookPathByProjectCwd.delete(project.workingDirectory)
    }
    notebookFileWatcher.unwatchFile(project.workingDirectory, file)
    return deleteProjectNotebook(project.workingDirectory, notebookPath)
  })
  ipcMain.handle('analysis:listKernels', async (_, cwd?: string) => {
    if (cwd) {
      const project = getProjectByCwd(cwd)
      if (!project) {
        throw new Error('请选择一个已添加的项目')
      }
      assertProjectPathAvailable(project.workingDirectory)
    }
    return detectAnalysisKernels()
  })
  ipcMain.handle('analysis:jupyterStatus', async (_, cwd: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    return jupyterServerRegistry.status(project.workingDirectory)
  })
  ipcMain.handle('analysis:jupyterRuntimeStatus', async (_, cwd: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    return {
      server: jupyterServerRegistry.status(project.workingDirectory),
      notebooks: notebookSessionRegistry.projectSummary(project.workingDirectory)
    }
  })
  ipcMain.handle('analysis:startJupyter', async (_, cwd: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    return jupyterServerRegistry.start(project.workingDirectory)
  })
  ipcMain.handle('analysis:stopJupyter', async (_, cwd: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    await notebookSessionRegistry.closeProject(project.workingDirectory)
    notebookFileWatcher.unwatchProject(project.workingDirectory)
    return jupyterServerRegistry.stop(project.workingDirectory)
  })
  ipcMain.handle(
    'analysis:notebookSessionStatus',
    async (_, cwd: string, notebookPath: string, document: NotebookDocument) => {
      const project = getProjectByCwd(cwd)
      if (!project) {
        throw new Error('请选择一个已添加的项目')
      }
      assertProjectPathAvailable(project.workingDirectory)
      const file = openProjectNotebook(project.workingDirectory, notebookPath)
      return notebookSessionRegistry.status({
        projectCwd: project.workingDirectory,
        notebookPath: file.path,
        document,
        kernels: detectAnalysisKernels()
      })
    }
  )
  ipcMain.handle(
    'analysis:ensureNotebookSession',
    async (_, cwd: string, notebookPath: string, document: NotebookDocument) => {
      const project = getProjectByCwd(cwd)
      if (!project) {
        throw new Error('请选择一个已添加的项目')
      }
      assertProjectPathAvailable(project.workingDirectory)
      const file = openProjectNotebook(project.workingDirectory, notebookPath)
      return notebookSessionRegistry.ensureSession({
        projectCwd: project.workingDirectory,
        notebookPath: file.path,
        document,
        kernels: detectAnalysisKernels()
      })
    }
  )
  ipcMain.handle('analysis:closeNotebookSession', async (_, cwd: string, notebookPath: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    const file = openProjectNotebook(project.workingDirectory, notebookPath)
    return notebookSessionRegistry.closeSession(project.workingDirectory, file.path)
  })
  ipcMain.handle(
    'analysis:interruptNotebookExecution',
    async (_, cwd: string, notebookPath: string) => {
      const project = getProjectByCwd(cwd)
      if (!project) {
        throw new Error('请选择一个已添加的项目')
      }
      assertProjectPathAvailable(project.workingDirectory)
      const file = openProjectNotebook(project.workingDirectory, notebookPath)
      return notebookSessionRegistry.interruptSession(project.workingDirectory, file.path)
    }
  )
  ipcMain.handle(
    'analysis:completeNotebookCell',
    async (
      _,
      cwd: string,
      input: {
        path: string
        document: NotebookDocument
        cellId: string
        source: string
        cursorPosition: number
      }
    ) => {
      const project = getProjectByCwd(cwd)
      if (!project) {
        throw new Error('请选择一个已添加的项目')
      }
      assertProjectPathAvailable(project.workingDirectory)
      const file = openProjectNotebook(project.workingDirectory, input.path)
      const cell = input.document.cells.find((item) => item.id === input.cellId)
      const cursorPosition = Number.isFinite(input.cursorPosition)
        ? Math.max(0, Math.min(input.cursorPosition, input.source.length))
        : 0
      if (!cell || cell.cellType !== 'code') {
        return emptyNotebookCompletionResult(cursorPosition, 'Notebook cell is not a code cell')
      }

      const staticCompletion = isPythonNotebookDocument(input.document)
        ? completeNotebookPythonStaticCompletion({
            projectCwd: project.workingDirectory,
            source: input.source,
            cursorPosition
          })
        : null
      const target = notebookSessionRegistry.executionTarget(project.workingDirectory, file.path)
      if (!target) {
        return (
          staticCompletion ??
          emptyNotebookCompletionResult(cursorPosition, 'Notebook kernel is not connected')
        )
      }

      try {
        const kernelCompletion = await notebookExecutor.completeCode({
          connection: target.connection,
          sessionId: target.sessionId,
          kernelId: target.kernelId,
          code: input.source,
          cursorPosition
        })
        return mergeNotebookCompletionResults(kernelCompletion, staticCompletion)
      } catch (error) {
        return (
          staticCompletion ?? emptyNotebookCompletionResult(cursorPosition, errorMessage(error))
        )
      }
    }
  )
  ipcMain.handle(
    'analysis:formatNotebookCell',
    async (
      _,
      cwd: string,
      input: {
        path: string
        document: NotebookDocument
        cellId: string
        source: string
        language?: string
        lineLength?: number
      }
    ) => {
      const project = getProjectByCwd(cwd)
      if (!project) {
        throw new Error('请选择一个已添加的项目')
      }
      assertProjectPathAvailable(project.workingDirectory)
      openProjectNotebook(project.workingDirectory, input.path)
      const cell = input.document.cells.find((item) => item.id === input.cellId)
      if (!cell || cell.cellType !== 'code') {
        return {
          source: input.source,
          changed: false,
          formatter: 'none' as const,
          message: 'Notebook cell is not a code cell'
        }
      }

      return formatNotebookCellSource({
        projectCwd: project.workingDirectory,
        source: input.source,
        language: input.language,
        lineLength: input.lineLength
      })
    }
  )
  ipcMain.handle(
    'analysis:generateNotebookCode',
    async (
      event,
      cwd: string,
      notebookPath: string,
      document: NotebookDocument,
      input: AnalysisNotebookCodeGenerationInput
    ) =>
      generateAnalysisNotebookCode(cwd, notebookPath, document, input, (progress) => {
        event.sender.send('analysis:notebookCodeGenerationProgress', progress)
      })
  )
  ipcMain.handle(
    'analysis:executeNotebookCell',
    async (_, cwd: string, notebookPath: string, document: NotebookDocument, cellId: string) => {
      const project = getProjectByCwd(cwd)
      if (!project) {
        throw new Error('请选择一个已添加的项目')
      }
      assertProjectPathAvailable(project.workingDirectory)
      const file = openProjectNotebook(project.workingDirectory, notebookPath)
      const kernels = detectAnalysisKernels()
      let sessionStatus = await notebookSessionRegistry.ensureSession({
        projectCwd: project.workingDirectory,
        notebookPath: file.path,
        document,
        kernels
      })
      let target = notebookSessionRegistry.executionTarget(project.workingDirectory, file.path)
      if (!target) {
        await ensureJupyterServerReady(project.workingDirectory)
        sessionStatus = await notebookSessionRegistry.ensureSession({
          projectCwd: project.workingDirectory,
          notebookPath: file.path,
          document,
          kernels
        })
        target = notebookSessionRegistry.executionTarget(project.workingDirectory, file.path)
      }
      if (!target) {
        throw new Error(sessionStatus.message ?? '请先连接 notebook kernel')
      }

      const cell = document.cells.find((item) => item.id === cellId)
      if (!cell) {
        throw new Error(`Notebook cell not found: ${cellId}`)
      }

      notebookSessionRegistry.updateSessionState(
        project.workingDirectory,
        file.path,
        'busy',
        'Notebook kernel 正在执行'
      )
      try {
        const execution = await notebookExecutor.executeCell({
          connection: target.connection,
          sessionId: target.sessionId,
          kernelId: target.kernelId,
          cell
        })
        const nextDocument = updateNotebookCell(document, cellId, {
          executionCount: execution.executionCount,
          outputs: execution.outputs,
          metadata: notebookCellMetadataWithExecutionDuration(cell.metadata, execution)
        })
        notebookToolExecutor.syncDraft({
          cwd: project.workingDirectory,
          path: file.path,
          document: nextDocument,
          source: 'renderer'
        })
        const nextSessionStatus =
          notebookSessionRegistry.updateSessionState(
            project.workingDirectory,
            file.path,
            execution.state === 'error' ? 'error' : 'idle',
            execution.state === 'error' ? 'Cell 执行出错' : 'Cell 执行完成'
          ) ?? sessionStatus
        return {
          ...execution,
          document: nextDocument,
          sessionStatus: nextSessionStatus
        }
      } catch (error) {
        notebookSessionRegistry.updateSessionState(
          project.workingDirectory,
          file.path,
          'error',
          error instanceof Error ? error.message : String(error)
        )
        throw error
      }
    }
  )

  ipcMain.handle('tool:approval-response', async (_, requestId: string, approved: boolean) => {
    resolveToolApproval(requestId, approved)
  })

  ipcMain.handle('plugins:list', async () => listPlugins())
  ipcMain.handle('plugins:install', async (_, source: string) => {
    try {
      const list = await installPlugin(source)
      writeAppLog({ event: 'plugin_installed', metadata: { source } })
      await invalidateAgentSession()
      return list
    } catch (error) {
      rememberErrorSummary(error)
      writeAppLog({
        level: 'error',
        event: 'plugin_install_failed',
        metadata: { source, error: error instanceof Error ? error.message : String(error) }
      })
      throw error
    }
  })
  ipcMain.handle('plugins:remove', async (_, source: string) => {
    try {
      const list = await removePlugin(source)
      writeAppLog({ event: 'plugin_removed', metadata: { source } })
      await invalidateAgentSession()
      return list
    } catch (error) {
      rememberErrorSummary(error)
      writeAppLog({
        level: 'error',
        event: 'plugin_remove_failed',
        metadata: { source, error: error instanceof Error ? error.message : String(error) }
      })
      throw error
    }
  })
  ipcMain.handle('skills:list', async (_, cwd?: string) => listSkills(cwd ?? currentCwd))
  ipcMain.handle('agents:list', async (_, cwd?: string) => listPromptAgents(cwd ?? currentCwd))
  ipcMain.handle('mcp:listServers', async (_, cwd?: string) => listMcpServers(cwd ?? currentCwd))

  ipcMain.handle('wrappers:getPlan', async (_, planId: string) => readWrapperPlan(planId))
  ipcMain.handle(
    'wrappers:submitPlan',
    async (_, planId: string, heavyWorkloadAcknowledged?: boolean) => {
      try {
        return submitWrapperRunPlan(planId, { heavyWorkloadAcknowledged })
      } catch (error) {
        rememberErrorSummary(error)
        throw error
      }
    }
  )
  ipcMain.handle('wrappers:cancelPlan', async (_, planId: string) => {
    try {
      return cancelWrapperRunPlan(planId)
    } catch (error) {
      rememberErrorSummary(error)
      throw error
    }
  })
  ipcMain.handle('wrappers:listCatalog', async () => listWrapperCatalog())
  ipcMain.handle('wrappers:addCustom', async (_, sourceDir: string) => {
    try {
      const entry = addCustomWrapper(sourceDir)
      writeAppLog({ event: 'wrapper_custom_added', metadata: { sourceDir, id: entry.manifest.id } })
      return entry
    } catch (error) {
      rememberErrorSummary(error)
      writeAppLog({
        level: 'error',
        event: 'wrapper_custom_add_failed',
        metadata: { sourceDir, error: error instanceof Error ? error.message : String(error) }
      })
      throw error
    }
  })
  ipcMain.handle('wrappers:listRuns', async () => listWrapperRuns())
  ipcMain.handle('wrappers:getRun', async (_, runId: string) => readWrapperRun(runId))
  ipcMain.handle('wrappers:cancelRun', async (_, runId: string) => {
    try {
      return cancelWrapperRun(runId)
    } catch (error) {
      rememberErrorSummary(error)
      throw error
    }
  })
  ipcMain.handle('wrappers:getPlanArtifact', async (_, planId: string, fileName: string) =>
    readWrapperPlanArtifact(planId, fileName)
  )
  ipcMain.handle('wrappers:exportReproducibility', async (_, runId: string) => {
    try {
      const bundle = buildWrapperReproducibilityBundle(runId)
      const window = getActiveWindow()
      const options: Electron.SaveDialogOptions = {
        defaultPath: `phi-wrapper-${runId}-reproducibility.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }]
      }
      const result = window
        ? await dialog.showSaveDialog(window, options)
        : await dialog.showSaveDialog(options)
      if (result.canceled || !result.filePath) return null
      writeFileSync(result.filePath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8')
      writeAppLog({ event: 'wrapper_reproducibility_exported', metadata: { runId } })
      return result.filePath
    } catch (error) {
      rememberErrorSummary(error)
      writeAppLog({
        level: 'error',
        event: 'wrapper_reproducibility_export_failed',
        metadata: { runId, error: error instanceof Error ? error.message : String(error) }
      })
      throw error
    }
  })

  ipcMain.handle('persona:getAppName', async () => APP_NAME)
  ipcMain.handle('persona:isOnboarded', async () => isOnboarded())
  ipcMain.handle('persona:getMarkdown', async () => getPersonaMarkdown())
  ipcMain.handle('persona:setMarkdown', async (_, markdown: string) => {
    setPersonaMarkdown(markdown)
    await invalidateAgentSession()
    return getPersonaMarkdown()
  })
  ipcMain.handle('persona:skip', async () => {
    skipOnboarding()
  })
  ipcMain.handle('persona:completeOnboarding', async (_, description: string) => {
    const trimmedDescription = description.trim()
    if (!trimmedDescription) {
      skipOnboarding()
      return ''
    }

    let markdown: string
    try {
      markdown = await generatePersonaMarkdown(trimmedDescription)
    } catch (error) {
      rememberErrorSummary(error)
      console.error('生成人设配置失败，回退为原始描述:', error)
      markdown = fallbackMarkdownFromDescription(trimmedDescription)
    }

    setPersonaMarkdown(markdown)
    await invalidateAgentSession()
    return markdown
  })

  createWindow()

  app.on('activate', function () {
    applyDockIcon()

    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => {
  cleanupMainWindowRuntime()
})

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
