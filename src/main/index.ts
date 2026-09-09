import './agent-env'
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
import { isAbsolute, join, relative, resolve } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { createAgentSession } from './agent/session-manager'
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
  listSessions,
  renameSession
} from './agent/sessions'
import {
  createProject,
  deleteProject,
  assertProjectPathAvailable,
  getProjectByCwd,
  listProjects,
  updateProjectPermissionMode,
  updateProjectDefaults,
  type PermissionMode,
  type ModelSelection
} from './agent/projects'
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
} from './agent/runtime-adapter'
import { installPlugin, listPlugins, removePlugin } from './agent/plugins'
import { listMcpServers, listSkills } from './agent/resources'
import { formatDiagnostics, type DiagnosticsSnapshot } from './agent/diagnostics'
import { LOG_RETENTION_DAYS, cleanupOldLogs, getPhiLogDir, writeAppLog } from './agent/app-logger'
import { redactSensitiveText } from './agent/redaction'
import {
  emptyNotebookRegistry,
  initializeProjectAnalysis,
  listProjectNotebooks
} from './agent/analysis-notebooks'
import {
  closeProjectNotebook,
  createProjectNotebook,
  openProjectNotebook,
  saveProjectNotebook,
  type SaveProjectNotebookInput
} from './agent/analysis-notebook-files'
import { detectAnalysisKernels } from './agent/analysis-kernels'
import { JupyterServerRegistry } from './agent/analysis-jupyter-server'
import { AnalysisNotebookExecutor } from './agent/analysis-jupyter-execution'
import { AnalysisNotebookSessionRegistry } from './agent/analysis-jupyter-sessions'
import {
  isStaleSessionError,
  StaleSessionError,
  SessionLifecycle,
  type SessionLifecycleRecord,
  type SessionSnapshot
} from './agent/session-lifecycle'
import { SessionRunnerRegistry } from './agent/session-runner-registry'
import {
  appendSessionEvent,
  createPhiSession,
  createRunId,
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
} from './agent/session-store'
import { updateNotebookCell, type NotebookDocument } from '../shared/notebookDocument'
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

type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const THINKING_LEVEL_ORDER: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const TOOL_OUTPUT_INLINE_LIMIT = 20000
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
  done?: Promise<{ path: string | null; sessionGeneration: number } | null>
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

const runnerRegistry = new SessionRunnerRegistry({
  onSessionEvent: broadcastSessionTimelineEvent
})
const jupyterServerRegistry = new JupyterServerRegistry()
const notebookSessionRegistry = new AnalysisNotebookSessionRegistry({
  getConnection: (projectCwd) => jupyterServerRegistry.connection(projectCwd)
})
const notebookExecutor = new AnalysisNotebookExecutor()

function broadcastSessionTimelineEvent(sessionId: string, event: StoredSessionEvent): void {
  const run = [...activePromptRuns.values()].find((item) => item.phiSessionId === sessionId)
  if (!run) return

  const targetWindow = getActiveWindow()
  if (!targetWindow || targetWindow.isDestroyed()) return

  targetWindow.webContents.send('agent:event', {
    source: 'phi',
    ...event,
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
  if (record.role !== 'assistant' || !Array.isArray(record.content)) return ''

  return record.content
    .map((part) => {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        return (part as { text?: string }).text ?? ''
      }
      return ''
    })
    .join('')
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

function readPhiTimelineMessages(runtimeSessionPath: string, cwd: string): unknown[] {
  const manifest = findPhiSessionByRuntimePath(runtimeSessionPath, cwd)
  if (!manifest) return []
  const events = readSessionEvents(manifest.sessionId)
  const hasPhiText = events.some(
    (event) => event.type === 'user_message' || event.type === 'assistant_message_finalized'
  )
  return events.map((event) => ({
    source: 'phi',
    ...(hasPhiText ? { preferPhiTimeline: true } : {}),
    ...event
  }))
}

function createSessionKey(
  path: string | undefined,
  cwd: string,
  freshId = freshSessionCounter
): string {
  return path ? `path:${path}` : `fresh:${cwd}:${freshId}`
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
  return path ? findPhiSessionByRuntimePath(path, cwd) : null
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
  const manifest = snapshot.path ? findPhiSessionByRuntimePath(snapshot.path, snapshot.cwd) : null
  return manifest?.model ?? getProjectByCwd(snapshot.cwd)?.defaultModel ?? selectedModel
}

function resolveSessionThinkingLevel(sessionKey: string, snapshot: SessionSnapshot): ThinkingLevel {
  const canonicalKey = resolveSessionKeyAlias(sessionKey)
  if (sessionThinkingLevels.has(canonicalKey)) {
    return sessionThinkingLevels.get(canonicalKey) ?? selectedThinkingLevel
  }
  const manifest = snapshot.path ? findPhiSessionByRuntimePath(snapshot.path, snapshot.cwd) : null
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
  const manifest = snapshot.path ? findPhiSessionByRuntimePath(snapshot.path, snapshot.cwd) : null
  return manifest?.permissionMode ?? getProjectByCwd(snapshot.cwd)?.permissionMode ?? 'auto'
}

function ensurePhiSessionId(
  sessionKey: string,
  snapshot: SessionSnapshot & { permissionMode: PermissionMode },
  title?: string
): string {
  const existing = getPhiSessionIdForKey(sessionKey)
  if (existing) return existing

  const project = getProjectByCwd(snapshot.cwd)
  const model = resolveSessionModelSelection(sessionKey, snapshot)
  const session = createPhiSession({
    kind: snapshot.cwd === WORKSPACE_DIR ? 'ordinary' : 'project',
    projectId: project?.id ?? null,
    cwd: snapshot.cwd,
    cwdRealPath: project?.workingDirectoryRealPath ?? snapshot.cwd,
    ...(title ? { title } : {}),
    permissionMode: snapshot.permissionMode,
    ...(model ? { model } : {}),
    thinkingLevel: resolveSessionThinkingLevel(sessionKey, snapshot)
  })
  setPhiSessionIdForKey(sessionKey, session.sessionId)
  return session.sessionId
}

// Turns a free-text description of the desired assistant into a persona markdown file
// by asking the agent itself to write it, in a throwaway session (noTools + in-memory
// history) so it doesn't touch the user's real chat or leave tool-call side effects.
async function generatePersonaMarkdown(description: string): Promise<string> {
  const runtime = await getAuthManager().getRuntime()
  const model = selectedModel
    ? runtime.getModel(selectedModel.providerId, selectedModel.modelId)
    : undefined
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    cwd: WORKSPACE_DIR,
    noTools: 'all',
    sessionManager: createInMemoryRuntimeSessionManager(WORKSPACE_DIR),
    ...(model ? { model } : {})
  })

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
    const generated = extractAssistantText(lastAssistantMessage).trim()
    return generated || fallbackMarkdownFromDescription(description)
  } finally {
    await session.dispose()
  }
}

function getActiveWindow(): BrowserWindow | null {
  return (
    BrowserWindow.getFocusedWindow() ??
    BrowserWindow.getAllWindows().find((window) => !window.isDestroyed()) ??
    null
  )
}

function notifyToolApprovalsCancelled(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('tool:approval-cancelled')
    }
  }
}

function assertRevealPathAllowed(filePath: string): string {
  if (!isAbsolute(filePath)) {
    throw new Error('只能显示绝对路径')
  }
  const agentDir = resolve(AGENT_DIR)
  const cwd = resolve(currentCwd)
  const target = resolve(filePath)
  const relativeAgentPath = relative(agentDir, target)
  const relativeCwdPath = relative(cwd, target)
  const isInAgentDir = !relativeAgentPath.startsWith('..') && !isAbsolute(relativeAgentPath)
  const isInCurrentCwd = !relativeCwdPath.startsWith('..') && !isAbsolute(relativeCwdPath)
  if (!isInAgentDir && !isInCurrentCwd) {
    throw new Error('只能显示 Phi 保存的文件或当前项目内的文件')
  }
  return target
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
      if (!isStaleSessionError(error)) {
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

function getCurrentSessionPayload(): CurrentSessionPayload {
  currentPermissionMode = resolveSessionPermissionMode(currentSessionKey, {
    path: currentSessionPath,
    cwd: currentCwd
  })
  return {
    path: currentSessionPath ?? null,
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
  if (!payload.path) {
    return { ...payload, messages: [] }
  }

  const current = await getCurrentResolvedSession()
  return {
    ...payload,
    messages: [
      ...(current?.session.messages ?? []),
      ...readPhiTimelineMessages(current?.session.sessionFile ?? payload.path, payload.cwd)
    ]
  }
}

function notifySessionChanged(): void {
  const payload = getCurrentSessionPayload()
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) {
      window.webContents.send('sessions:changed', payload)
    }
  }
}

function notifyProjectParallelRun(
  sessionGeneration: number,
  sessionPath: string | undefined,
  cwd: string,
  activeCount: number
): void {
  const window = getActiveWindow()
  if (!window || window.isDestroyed()) return
  window.webContents.send('agent:event', {
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
      await abortSession(run.session)
    })
  )
}

// A user-visible conversation switch points future getAgentSession() calls at a
// different file/cwd/permission mode. It deliberately does not abort the old
// session: switching conversations is navigation, not stop.
async function disposeAndSwitchSession(
  path: string | undefined,
  cwd: string = WORKSPACE_DIR,
  permissionMode: PermissionMode = 'auto'
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
  notifySessionChanged()
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
          if (targetWindow && !targetWindow.isDestroyed()) {
            targetWindow.webContents.send('agent:event', {
              ...stored,
              sessionGeneration: generation,
              sessionPath: creationSnapshot.path ?? null,
              cwd: creationSnapshot.cwd
            })
          }
        }
      }
      const thinkingLevel = resolveSessionThinkingLevel(sessionKey, creationSnapshot)
      const sessionAbortController = new AbortController()
      sessionAbortControllers.set(
        getSessionControllerKey(creationSnapshot, generation),
        sessionAbortController
      )

      let resourceLoader: RuntimeResourceLoader | undefined
      if (creationSnapshot.permissionMode === 'ask') {
        resourceLoader = createRuntimeResourceLoader({
          cwd: creationSnapshot.cwd,
          agentDir: AGENT_DIR,
          extensionFactories: [
            createApprovalExtension({
              signal: sessionAbortController.signal,
              getContext: () => {
                const run = getActivePromptRun(sessionKey)
                if (!run) return null
                const project = getProjectByCwd(creationSnapshot.cwd)
                return {
                  sessionId: run.phiSessionId,
                  ...(run.session?.sessionFile ? { sessionPath: run.session.sessionFile } : {}),
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
        sessionManager: createSessionManager(creationSnapshot.cwd, creationSnapshot.path),
        ...(resourceLoader ? { resourceLoader } : {}),
        ...(model ? { model } : {})
      })
      if (result.session.sessionFile) {
        const materializedKey = createSessionKey(result.session.sessionFile, creationSnapshot.cwd)
        aliasMaterializedSessionPath(sessionKey, result.session.sessionFile, creationSnapshot.cwd)
        if (currentSessionKey === sessionKey) {
          currentSessionKey = materializedKey
        }
      }
      if (
        lifecycle.isCurrentGeneration(generation) &&
        sameCanonicalSessionKey(sessionKey, currentSessionKey)
      ) {
        const nextSessionPath = result.session.sessionFile ?? creationSnapshot.path
        if (currentSessionPath !== nextSessionPath) {
          currentSessionPath = nextSessionPath
          notifySessionChanged()
        }
      }
      const run = getActivePromptRun(sessionKey)
      if (run && result.session.sessionFile) {
        run.sessionPath = result.session.sessionFile
        updateSessionManifest(run.phiSessionId, {
          runtimeSessionPath: result.session.sessionFile
        })
      }

      result.session.subscribe((summary) => {
        if (!lifecycle.isCurrentGeneration(generation)) return
        const run = getActivePromptRun(sessionKey)
        const persistedSummary = run ? persistSessionEvent(run, summary) : summary
        const targetWindow = getActiveWindow()
        if (targetWindow && !targetWindow.isDestroyed()) {
          targetWindow.webContents.send('agent:event', {
            ...persistedSummary,
            sessionGeneration: generation,
            sessionPath: result.session.sessionFile ?? creationSnapshot.path ?? null,
            cwd: creationSnapshot.cwd
          })
        }
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
    void stopAllPromptRuns()
    jupyterServerRegistry.disposeAll()
    void invalidateAgentSession()
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
  ipcMain.handle('diagnostics:copy', async () => {
    const text = await createDiagnosticsText()
    clipboard.writeText(text)
    writeAppLog({ event: 'diagnostics_copied' })
    return text
  })

  ipcMain.handle('agent:prompt', async (_, text: string) => {
    const normalizedText = text.trim()
    if (!normalizedText) return null

    const runSessionKey = resolveSessionKeyAlias(currentSessionKey)
    const runGeneration = advancePromptGeneration(runSessionKey)
    const runLifecycle = getLifecycleForKey(runSessionKey)
    const runSessionGeneration = runLifecycle.currentGeneration
    const runSnapshot: SessionSnapshot & { permissionMode: PermissionMode } = {
      path: currentSessionPath,
      cwd: currentCwd,
      permissionMode: currentPermissionMode
    }
    const project = getProjectByCwd(runSnapshot.cwd)
    const phiSessionId = ensurePhiSessionId(runSessionKey, runSnapshot, normalizedText)
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
      sessionPath: runSnapshot.path ?? null
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
        runSnapshot.path,
        runSnapshot.cwd,
        otherActiveProjectRuns
      )
    }

    // Serialize prompts per session: duplicate/overlapping IPC invokes must
    // never run session.prompt() concurrently within the same conversation.
    const run = getPromptQueue(runSessionKey).then(async () => {
      let promptResult: { path: string | null; sessionGeneration: number } | null = null
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
            await session.prompt(normalizedText, {
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

          if (
            signal.aborted ||
            promptRun.cancelled ||
            promptRun.generation !== getPromptGeneration(runSessionKey) ||
            !runLifecycle.isCurrentGeneration(promptRun.sessionGeneration)
          ) {
            return
          }

          // A brand-new chat's first prompt is when it actually becomes a file on disk —
          // hand the path back so the renderer can refresh and highlight it in the sidebar.
          if (sameCanonicalSessionKey(runSessionKey, currentSessionKey)) {
            currentSessionPath = session.sessionFile ?? currentSessionPath
          }
          promptRun.sessionPath = session.sessionFile ?? promptRun.sessionPath
          promptResult = {
            path: session.sessionFile ?? null,
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
        ? findPhiSessionByRuntimePath(currentSessionPath, currentCwd)?.sessionId
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
    return disposeAndSwitchSession(undefined)
  })
  ipcMain.handle('sessions:switch', async (_, path: string) => {
    const request = ++sessionSwitchRequest
    // The session file already knows its own cwd (a project session was created with
    // that project's folder as cwd) — read it so switching to it also restores the
    // right permission mode, regardless of which sidebar section it was opened from.
    const cwd = (await openRuntimeSessionManager(path)).getCwd()
    const targetKey = createSessionKey(path, cwd)
    const permissionMode = resolveSessionPermissionMode(targetKey, { path, cwd })
    const shouldBecomeCurrent = request === sessionSwitchRequest
    const target = shouldBecomeCurrent
      ? await disposeAndSwitchSession(path, cwd, permissionMode)
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
    if (target.path) {
      acknowledgeSession(target.path, target.cwd)
      notifySessionChanged()
    }
    const sessionPath = session.sessionFile ?? path
    return {
      path: sessionPath,
      cwd: target.cwd,
      sessionGeneration: target.sessionGeneration,
      permissionMode,
      ...getSessionStatusPayload(targetKey, sessionPath, target.cwd),
      messages: [...session.messages, ...readPhiTimelineMessages(sessionPath, target.cwd)]
    }
  })
  ipcMain.handle('sessions:acknowledge', async (_, path: string) => {
    const cwd = (await openRuntimeSessionManager(path)).getCwd()
    const acknowledged = acknowledgeSession(path, cwd)
    if (acknowledged) {
      notifySessionChanged()
    }
    return acknowledged
  })
  ipcMain.handle('sessions:delete', async (_, path: string) => {
    if (currentSessionPath === path) {
      await disposeAndSwitchSession(undefined)
    }
    // Let an aborted run finish persisting before unlinking its history; otherwise
    // the final SDK write can recreate a conversation the user just deleted.
    await waitForSessionCleanup({ path, cwd: currentCwd, permissionMode: currentPermissionMode })
    deleteSession(path)
  })
  ipcMain.handle('sessions:rename', async (_, path: string, name: string) => {
    const trimmedName = name.trim()
    if (!trimmedName) return

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
  ipcMain.handle('projects:sessions', async (_, workingDirectory: string) =>
    listSessions(workingDirectory)
  )
  ipcMain.handle(
    'projects:newSession',
    async (_, workingDirectory: string, permissionMode: PermissionMode) => {
      assertProjectPathAvailable(workingDirectory)
      return disposeAndSwitchSession(undefined, workingDirectory, permissionMode)
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
    return openProjectNotebook(project.workingDirectory, notebookPath)
  })
  ipcMain.handle(
    'analysis:saveNotebook',
    async (_, cwd: string, input: SaveProjectNotebookInput) => {
      const project = getProjectByCwd(cwd)
      if (!project) {
        throw new Error('请选择一个已添加的项目')
      }
      assertProjectPathAvailable(project.workingDirectory)
      return saveProjectNotebook(project.workingDirectory, input)
    }
  )
  ipcMain.handle('analysis:createNotebook', async (_, cwd: string, relativePath?: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    return createProjectNotebook(project.workingDirectory, relativePath)
  })
  ipcMain.handle('analysis:closeNotebook', async (_, cwd: string, notebookPath: string) => {
    const project = getProjectByCwd(cwd)
    if (!project) {
      throw new Error('请选择一个已添加的项目')
    }
    assertProjectPathAvailable(project.workingDirectory)
    const file = openProjectNotebook(project.workingDirectory, notebookPath)
    await notebookSessionRegistry.closeSession(project.workingDirectory, file.path)
    return closeProjectNotebook(project.workingDirectory, notebookPath)
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
    'analysis:executeNotebookCell',
    async (_, cwd: string, notebookPath: string, document: NotebookDocument, cellId: string) => {
      const project = getProjectByCwd(cwd)
      if (!project) {
        throw new Error('请选择一个已添加的项目')
      }
      assertProjectPathAvailable(project.workingDirectory)
      const file = openProjectNotebook(project.workingDirectory, notebookPath)
      const kernels = detectAnalysisKernels()
      const sessionStatus = await notebookSessionRegistry.ensureSession({
        projectCwd: project.workingDirectory,
        notebookPath: file.path,
        document,
        kernels
      })
      const target = notebookSessionRegistry.executionTarget(project.workingDirectory, file.path)
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
          outputs: execution.outputs
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
  ipcMain.handle('mcp:listServers', async (_, cwd?: string) => listMcpServers(cwd ?? currentCwd))

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
  void stopAllPromptRuns()
  jupyterServerRegistry.disposeAll()
  void invalidateAgentSession()
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
