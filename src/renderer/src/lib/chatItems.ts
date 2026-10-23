import { chatItemFromPhiTimelineEvent } from '../features/chat/lib/chatTimelineNotices'
export { chatItemFromPhiTimelineEvent } from '../features/chat/lib/chatTimelineNotices'
import type { ChatItem, NotebookToolSummary, RunLifecycleItem, ToolCallItem } from '../types'
import { workspaceChangesItemFromPhiTimelineEvent } from '../features/chat/lib/workspaceChanges'
import { presentedFilesItemFromPhiTimelineEvent } from '../features/chat/lib/presentedFiles'
import {
  uiBlocksItemFromToolEvent,
  unavailableUiBlocksItemFromToolEvent
} from '../features/chat/lib/uiBlocks'
import { applyPlanReviewDecision, planReviewItemFromEvent } from '../features/chat/lib/planReview'
import type { TodoPhaseSnapshot, TodoSnapshot, TodoTaskSnapshot } from './todoTypes'
import {
  agentExecutionFromTimelineEvent,
  agentExecutionIndex,
  applyAgentBackgroundTimelineEvent,
  applyAgentCompletedTimelineEvent,
  applyAgentSteeredTimelineEvent,
  applyAgentStepTimelineEvent
} from './agentExecutionRestore'
import { messagesForUserRetryTarget } from './chatRetry'
import {
  appendRecoveredRuntimeToolsAfterThinking,
  appendRecoveredRuntimeToolsBeforeAnswer,
  appendRecoveredRuntimeToolsBeforeThinking,
  recoverMissingRuntimeTools,
  type RuntimeToolRecovery
} from '../features/chat/lib/runtimeToolRecovery'
import { storedPromptImages } from '../features/chat/lib/storedPromptImages'
import { visibleRuntimeUserText } from '../features/chat/lib/runtimePromptText'
import { applyApprovalTimelineEvent } from '../features/chat/lib/approvalTimeline'

const WRAPPER_TOOL_PREFIX = 'wrapper_'
const NOTEBOOK_TOOL_PREFIX = 'notebook_'
const LEGACY_NOTEBOOK_TOOL_PREFIX = 'notebook.'
const TODO_TOOL_NAME = 'todo'

/**
 * `wrapper_search`/`wrapper_inspect` (see src/main/agent/wrappers/tools.ts)
 * are read-only lookups, `wrapper_run` (composition/tools.ts) executes
 * directly — neither returns `details.kind === 'wrapper_plan'`,
 * so a `WrapperPlanItem` built for one would never get a `planId` and
 * WrapperPlanCard's `!item.planId || !plan` branch would show "正在加载计划…"
 * forever instead of the actual search/inspect result. Both share the
 * `wrapper_` prefix with real execute tools (`wrapperToolName()` sanitizes
 * a canonical id into `wrapper_<id-with-slashes-as-underscores>`, which
 * can't collide with these fixed names), so they need an explicit
 * exclusion rather than a prefix check alone.
 */
const WRAPPER_NON_PLAN_TOOL_NAMES = new Set(['wrapper_search', 'wrapper_inspect', 'wrapper_run'])

/**
 * `wrapper_<id>` execute tool calls render as a `WrapperPlanItem` (a plan
 * card), not a generic `ToolCallItem` — see docs/design/phi-wrapper-
 * technical-design.md, "Chat And UI Integration". `wrapper_search`/
 * `wrapper_inspect` are excluded — see `WRAPPER_NON_PLAN_TOOL_NAMES`.
 */
export function isWrapperToolName(toolName: string): boolean {
  return toolName.startsWith(WRAPPER_TOOL_PREFIX) && !WRAPPER_NON_PLAN_TOOL_NAMES.has(toolName)
}

export function isNotebookToolName(toolName: string): boolean {
  return (
    toolName.startsWith(NOTEBOOK_TOOL_PREFIX) || toolName.startsWith(LEGACY_NOTEBOOK_TOOL_PREFIX)
  )
}

/** The main agent's todo-list tool (see the sticky todo panel in TodoStepPanel). */
export function isTodoToolName(toolName: string): boolean {
  return toolName === TODO_TOOL_NAME
}

/**
 * Convention for `wrapper_<id>` tool results (Milestone P1.8): the tool
 * returns `{ content: [...], details: { kind: 'wrapper_plan', planId } }`.
 * Large plan metadata never travels through the chat event stream — only
 * the id, which the card uses to load full detail from the wrapper store.
 */
export function extractWrapperPlanId(result: unknown): string | undefined {
  if (!result || typeof result !== 'object') return undefined
  const details = (result as { details?: unknown }).details
  if (!details || typeof details !== 'object') return undefined
  const record = details as { kind?: unknown; planId?: unknown }
  if (record.kind !== 'wrapper_plan' || typeof record.planId !== 'string') return undefined
  return record.planId
}

function detailsFromToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined
  const record = result as { details?: unknown }
  return record.details ?? result
}

function stringField(record: Record<string, unknown> | null, key: string): string | undefined {
  if (!record) return undefined
  const value = record[key]
  return typeof value === 'string' && value ? value : undefined
}

function numberOrNullField(
  record: Record<string, unknown> | null,
  key: string
): number | null | undefined {
  if (!record) return undefined
  const value = record[key]
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function numberField(record: Record<string, unknown> | null, key: string): number | undefined {
  const value = numberOrNullField(record, key)
  return typeof value === 'number' ? value : undefined
}

function objectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
  const value = record[key]
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function firstDefined<Value>(...values: Array<Value | undefined>): Value | undefined {
  return values.find((value): value is Value => value !== undefined)
}

function optionalField<Key extends string, Value>(
  key: Key,
  value: Value | undefined
): Partial<Record<Key, Value>> {
  return value === undefined ? {} : ({ [key]: value } as Record<Key, Value>)
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

/**
 * Notebook tool results can include full notebook/cell/output objects. Chat history
 * only needs a small operation receipt, so this intentionally projects details down
 * to path, one-based cell number, cell id/type, execution state/count, and the
 * human summary string.
 */
export function extractNotebookToolSummary(result: unknown): NotebookToolSummary | undefined {
  const details = detailsFromToolResult(result)
  if (!details || typeof details !== 'object') return undefined
  const record = details as Record<string, unknown>
  const kind = stringField(record, 'kind')
  if (!kind || !kind.startsWith('notebook_')) return undefined

  const cell = objectField(record, 'cell')
  const execution = objectField(record, 'execution')
  const cellNumber = notebookCellNumberFrom(record, cell)
  const cellId = firstDefined(stringField(record, 'cellId'), stringField(cell, 'id'))
  const cellType = firstDefined(
    stringField(record, 'cellType'),
    stringField(cell, 'cellType'),
    stringField(cell, 'cell_type')
  )
  const executionState = firstDefined(
    stringField(record, 'executionState'),
    stringField(execution, 'state')
  )
  const executionCount =
    numberOrNullField(record, 'executionCount') ?? numberOrNullField(execution, 'executionCount')

  return {
    kind,
    ...optionalField('path', stringField(record, 'path')),
    ...optionalField('relativePath', stringField(record, 'relativePath')),
    ...optionalField('cellNumber', cellNumber),
    ...optionalField('cellId', cellId),
    ...optionalField('cellType', cellType),
    ...optionalField('executionState', executionState),
    ...optionalField('executionCount', executionCount),
    ...optionalField('summary', stringField(record, 'summary'))
  }
}

const TODO_TASK_STATUSES = new Set<TodoTaskSnapshot['status']>([
  'pending',
  'in_progress',
  'completed',
  'abandoned',
  'blocked'
])

function isTodoTaskStatus(value: unknown): value is TodoTaskSnapshot['status'] {
  return typeof value === 'string' && TODO_TASK_STATUSES.has(value as TodoTaskSnapshot['status'])
}

function todoTaskSnapshotFrom(value: unknown): TodoTaskSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.content !== 'string' || !isTodoTaskStatus(record.status)) return undefined
  return {
    content: record.content,
    status: record.status,
    ...(typeof record.blocker === 'string' && record.blocker ? { blocker: record.blocker } : {})
  }
}

function todoPhaseSnapshotFrom(value: unknown): TodoPhaseSnapshot | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  if (typeof record.name !== 'string' || !Array.isArray(record.tasks)) return undefined
  return {
    name: record.name,
    tasks: record.tasks
      .map(todoTaskSnapshotFrom)
      .filter((task): task is TodoTaskSnapshot => task !== undefined)
  }
}

/**
 * The `todo` tool (see @oh-my-pi/pi-coding-agent's TodoTool) returns
 * `{ content: [...], details: { op, phases, storage } }`. The chat timeline
 * only needs the phases/op snapshot to drive the sticky todo panel; the tool
 * already returns the *whole* list on every call, not a diff.
 */
export function extractTodoSnapshot(result: unknown): TodoSnapshot | undefined {
  const details = detailsFromToolResult(result)
  if (!details || typeof details !== 'object') return undefined
  const record = details as Record<string, unknown>
  if (!Array.isArray(record.phases)) return undefined
  return {
    phases: record.phases
      .map(todoPhaseSnapshotFrom)
      .filter((phase): phase is TodoPhaseSnapshot => phase !== undefined),
    ...(typeof record.op === 'string' && record.op ? { op: record.op } : {})
  }
}

function toolOutputArtifactFrom(value: unknown):
  | {
      kind: 'tool_output'
      path: string
      bytes: number
    }
  | undefined {
  if (!value || typeof value !== 'object') return undefined
  const artifact = value as { kind?: unknown; path?: unknown; bytes?: unknown }
  if (
    artifact.kind !== 'tool_output' ||
    typeof artifact.path !== 'string' ||
    typeof artifact.bytes !== 'number'
  ) {
    return undefined
  }
  return { kind: 'tool_output', path: artifact.path, bytes: artifact.bytes }
}

export function toolArgsPreview(args: unknown): string {
  if (!args || typeof args !== 'object') {
    return ''
  }
  const record = args as Record<string, unknown>
  const preferred = ['command', 'path', 'file_path', 'pattern', 'code', 'query']
  for (const key of preferred) {
    if (typeof record[key] === 'string' && record[key]) {
      return record[key] as string
    }
  }
  const firstString = Object.values(record).find(
    (item): item is string => typeof item === 'string' && item.length > 0
  )
  return firstString ?? ''
}

function textFromToolContentParts(content: unknown[]): string {
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') {
        return ''
      }
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

export function extractToolText(value: unknown): string {
  if (typeof value === 'string') {
    return value
  }
  if (Array.isArray(value)) {
    return textFromToolContentParts(value)
  }
  if (value && typeof value === 'object') {
    const record = value as { content?: unknown; output?: unknown; text?: unknown }
    if (Array.isArray(record.content)) {
      const text = textFromToolContentParts(record.content)
      if (text) {
        return text
      }
      if (typeof record.output !== 'string' && typeof record.text !== 'string') {
        return ''
      }
    }
    if (typeof record.output === 'string') {
      return record.output
    }
    if (typeof record.text === 'string') {
      return record.text
    }
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return String(value)
    }
  }
  return value == null ? '' : String(value)
}

function textFromContentParts(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (part && typeof part === 'object' && (part as { type?: string }).type === 'text') {
        return (part as { text?: string }).text ?? ''
      }
      return ''
    })
    .join('')
}

function durationBetween(startedAt?: string, completedAt?: string): number | undefined {
  if (!startedAt || !completedAt) return undefined
  const start = Date.parse(startedAt)
  const end = Date.parse(completedAt)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined
  return Math.max(0, end - start)
}

function createdAtField(createdAt?: string): { createdAt: string } | Record<string, never> {
  return typeof createdAt === 'string' ? { createdAt } : {}
}

function completedAtField(completedAt?: string): { completedAt: string } | Record<string, never> {
  return typeof completedAt === 'string' ? { completedAt } : {}
}

function normalizedVisibleText(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function runIdField(runId?: unknown): { runId: string } | Record<string, never> {
  return typeof runId === 'string' && runId ? { runId } : {}
}

function terminalToolStatusForRunEvent(type: string | undefined): 'done' | 'error' | null {
  if (type === 'run_completed') return 'done'
  if (type === 'run_failed' || type === 'run_interrupted') return 'error'
  return null
}

function shouldFinalizeRestoredToolForRun(
  item: ChatItem,
  runId: string | undefined
): item is Extract<ChatItem, { role: 'tool' | 'agent_execution' }> {
  return (
    (item.role === 'tool' || item.role === 'agent_execution') &&
    item.status === 'running' &&
    // A background agent carries on after the chat run that started it; its own end completes it.
    !(item.role === 'agent_execution' && item.background) &&
    (!runId || !item.runId || item.runId === runId)
  )
}

function finalizeRestoredRunningToolsForRun(
  items: ChatItem[],
  event: { type?: string; runId?: string; createdAt?: string }
): void {
  const status = terminalToolStatusForRunEvent(event.type)
  if (!status) return

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const item = items[index]
    if (!shouldFinalizeRestoredToolForRun(item, event.runId)) continue
    const durationMs = durationBetween(item.createdAt, event.createdAt)
    items[index] = {
      ...item,
      status,
      ...completedAtField(event.createdAt),
      ...(durationMs !== undefined ? { durationMs } : {})
    }
  }
}

export function hasEquivalentErrorMessage(
  items: ChatItem[],
  content: string,
  options: { runId?: string; exceptId?: string } = {}
): boolean {
  const normalized = normalizedVisibleText(content)
  if (!normalized || !options.runId) return false

  return items.some(
    (item) =>
      item.id !== options.exceptId &&
      item.role === 'error' &&
      item.runId === options.runId &&
      normalizedVisibleText(item.content) === normalized
  )
}

export function isDisplayableAssistantText(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && trimmed !== '.'
}

export function runLifecycleItemFromPhiTimelineEvent(event: {
  type?: string
  eventId?: string
  runId?: string
  createdAt?: string
  durationMs?: unknown
}): RunLifecycleItem | null {
  if (typeof event.createdAt !== 'string') return null

  const lifecycleEvent =
    event.type === 'run_started'
      ? 'started'
      : event.type === 'run_completed'
        ? 'completed'
        : event.type === 'run_failed'
          ? 'failed'
          : event.type === 'run_interrupted'
            ? 'interrupted'
            : null
  if (!lifecycleEvent) return null

  return {
    id: `run-${event.eventId ?? `${event.type}-${event.runId ?? event.createdAt}`}`,
    role: 'run',
    event: lifecycleEvent,
    ...(typeof event.runId === 'string' ? { runId: event.runId } : {}),
    createdAt: event.createdAt,
    ...(typeof event.durationMs === 'number' && Number.isFinite(event.durationMs)
      ? { durationMs: Math.max(0, event.durationMs) }
      : {})
  }
}

type RestoredSessionMessage = {
  source?: string
  role?: string
  type?: string
  eventId?: string
  runId?: string
  approvalId?: string
  phiSessionId?: string
  sessionId?: string
  summary?: string
  userMessageId?: string
  preferPhiTimeline?: boolean
  content?: unknown
  files?: unknown
  totalChanged?: unknown
  truncated?: unknown
  images?: unknown
  toolCallId?: string
  toolName?: string
  args?: unknown
  output?: string
  outputPath?: string
  outputBytes?: number
  outputTruncated?: boolean
  outputArtifact?: unknown
  details?: unknown
  isError?: boolean
  durationMs?: number
  createdAt?: string
  agentName?: string
  task?: string
  step?: unknown
  finalReport?: string
  finalReportPath?: string
  finalReportBytes?: number
  finalReportTruncated?: boolean
  finalReportArtifact?: unknown
  toolCalls?: number
  error?: string
  fromProviderId?: string
  fromModelId?: string
  toProviderId?: string
  toModelId?: string
  toModelName?: string
}

type RestoreState = {
  items: ChatItem[]
  toolCallIndexById: Map<string, number>
  duplicateTextCounts: Map<string, number>
  phiToolCallIds: Set<string>
  runtimeToolRecovery: RuntimeToolRecovery
}

function restoredSessionMessageFrom(value: unknown): RestoredSessionMessage | null {
  return value && typeof value === 'object' ? (value as RestoredSessionMessage) : null
}

function collectPhiTimelineCoverage(messages: unknown[]): {
  duplicateTextCounts: Map<string, number>
  phiToolCallIds: Set<string>
  hasPreferredPhiTimeline: boolean
} {
  const duplicateTextCounts = new Map<string, number>()
  const phiToolCallIds = new Set<string>()
  let hasPreferredPhiTimeline = false
  for (const raw of messages) {
    const message = restoredSessionMessageFrom(raw)
    if (!message || message.source !== 'phi') continue
    if (message.preferPhiTimeline === true) hasPreferredPhiTimeline = true
    if (
      (message.type === 'user_message' || message.type === 'assistant_message_finalized') &&
      typeof message.content === 'string'
    ) {
      duplicateTextCounts.set(message.content, (duplicateTextCounts.get(message.content) ?? 0) + 1)
    }
    if (
      (message.type === 'tool_call_started' || message.type === 'tool_call_completed') &&
      typeof message.toolCallId === 'string'
    ) {
      phiToolCallIds.add(message.toolCallId)
    }
  }
  return { duplicateTextCounts, phiToolCallIds, hasPreferredPhiTimeline }
}

function isRuntimeMessageCoveredByPhi(
  raw: unknown,
  duplicateTextCounts: Map<string, number>
): boolean {
  const message = restoredSessionMessageFrom(raw)
  if (!message || message.source === 'phi') return false
  if (message.role === 'user') {
    const text = visibleRuntimeUserText(textFromContentParts(message.content))
    return text.length > 0 && duplicateTextCounts.has(text)
  }
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return false
  return message.content.some((part) => {
    if (!part || typeof part !== 'object' || (part as { type?: string }).type !== 'text') {
      return false
    }
    const text = (part as { text?: string }).text ?? ''
    return text.length > 0 && duplicateTextCounts.has(text)
  })
}

function consumeDuplicateText(duplicateTextCounts: Map<string, number>, text: string): boolean {
  const count = duplicateTextCounts.get(text) ?? 0
  if (count <= 0) return false
  if (count === 1) duplicateTextCounts.delete(text)
  else duplicateTextCounts.set(text, count - 1)
  return true
}

function serializedToolArgs(args: unknown): string {
  try {
    return JSON.stringify(args, null, 2) ?? ''
  } catch {
    return ''
  }
}

function restoredStructuredToolDetails(
  current: ToolCallItem,
  result: unknown
): Partial<Pick<ToolCallItem, 'notebook' | 'todo'>> {
  const details: Partial<Pick<ToolCallItem, 'notebook' | 'todo'>> = {}
  if (isNotebookToolName(current.toolName)) {
    details.notebook = extractNotebookToolSummary(result) ?? current.notebook
  }
  if (isTodoToolName(current.toolName)) {
    details.todo = extractTodoSnapshot(result) ?? current.todo
  }
  return details
}

function applyPrimaryPhiTimelineEvent(items: ChatItem[], message: RestoredSessionMessage): boolean {
  if (applyApprovalTimelineEvent(items, message)) return true
  const planReview = planReviewItemFromEvent(message)
  if (planReview) {
    items.push(planReview)
    return true
  }
  if (applyPlanReviewDecision(items, message)) return true
  const presentedFiles = presentedFilesItemFromPhiTimelineEvent(message)
  if (presentedFiles) {
    items.push(presentedFiles)
    return true
  }
  const workspaceChanges = workspaceChangesItemFromPhiTimelineEvent(message)
  if (!workspaceChanges) return false
  items.push(workspaceChanges)
  return true
}

function appendPhiRunLifecycle(items: ChatItem[], message: RestoredSessionMessage): void {
  const lifecycleItem = runLifecycleItemFromPhiTimelineEvent(message)
  if (!lifecycleItem) return
  finalizeRestoredRunningToolsForRun(items, message)
  items.push(lifecycleItem)
}

function applyPhiAgentExecutionEvent(items: ChatItem[], message: RestoredSessionMessage): boolean {
  switch (message.type) {
    case 'agent_execution_started': {
      const item = agentExecutionFromTimelineEvent(message)
      if (item && agentExecutionIndex(items, item.id) < 0) items.push(item)
      return true
    }
    case 'agent_execution_background':
      applyAgentBackgroundTimelineEvent(items, message)
      return true
    case 'agent_execution_steered':
      applyAgentSteeredTimelineEvent(items, message)
      return true
    case 'agent_execution_step':
      applyAgentStepTimelineEvent(items, message)
      return true
    case 'agent_execution_completed':
      applyAgentCompletedTimelineEvent(items, message)
      return true
    default:
      return false
  }
}

function appendPhiToolCallStarted(state: RestoreState, message: RestoredSessionMessage): boolean {
  if (typeof message.toolCallId !== 'string') return false
  state.toolCallIndexById.set(message.toolCallId, state.items.length)
  state.items.push({
    id: message.toolCallId,
    role: 'tool',
    ...runIdField(message.runId),
    toolName: typeof message.toolName === 'string' ? message.toolName : 'tool',
    argsPreview: toolArgsPreview(message.args),
    argsJson: serializedToolArgs(message.args),
    output: '',
    status: 'running',
    ...createdAtField(message.createdAt)
  })
  return true
}

function applyPhiToolCallCompleted(state: RestoreState, message: RestoredSessionMessage): boolean {
  if (typeof message.toolCallId !== 'string') return false
  const index = state.toolCallIndexById.get(message.toolCallId)
  if (index !== undefined) {
    const current = state.items[index]
    if (current.role === 'tool') {
      const outputArtifact = toolOutputArtifactFrom(message.outputArtifact)
      const durationMs = durationBetween(current.createdAt, message.createdAt)
      state.items[index] = {
        ...current,
        output: message.output ?? current.output,
        outputPath: message.outputPath ?? outputArtifact?.path,
        outputBytes: message.outputBytes ?? outputArtifact?.bytes,
        outputTruncated: message.outputTruncated,
        outputArtifact,
        ...restoredStructuredToolDetails(current, { details: message.details }),
        status: message.isError ? 'error' : 'done',
        ...completedAtField(message.createdAt),
        ...optionalField('durationMs', durationMs)
      }
    }
  }
  const uiBlocks =
    uiBlocksItemFromToolEvent(message) ?? unavailableUiBlocksItemFromToolEvent(message)
  if (uiBlocks && !state.items.some((item) => item.id === uiBlocks.id)) state.items.push(uiBlocks)
  return true
}

function appendPhiUserMessage(state: RestoreState, message: RestoredSessionMessage): boolean {
  if (typeof message.content !== 'string') return false
  const images = storedPromptImages(message.images)
  state.items.push({
    id: message.eventId ?? `user-${state.items.length}`,
    role: 'user',
    content: message.content,
    ...(images.length ? { images } : {}),
    ...createdAtField(message.createdAt)
  })
  return true
}

function applyPhiUserRetry(state: RestoreState, message: RestoredSessionMessage): void {
  const retryImages = storedPromptImages(message.images)
  const nextItems = messagesForUserRetryTarget(state.items, {
    ...(typeof message.userMessageId === 'string' ? { id: message.userMessageId } : {}),
    ...(typeof message.content === 'string' ? { content: message.content } : {}),
    ...(retryImages.length ? { imageIds: retryImages.map((image) => image.id) } : {})
  })
  if (nextItems !== state.items) state.items.splice(0, state.items.length, ...nextItems)
}

function appendPhiAssistantMessage(state: RestoreState, message: RestoredSessionMessage): boolean {
  if (typeof message.content !== 'string') return false
  if (!isDisplayableAssistantText(message.content)) return true
  appendRecoveredRuntimeToolsBeforeAnswer(
    state.items,
    state.runtimeToolRecovery,
    message.content,
    message.runId,
    message.createdAt
  )
  state.items.push({
    id: message.eventId ?? `assistant-${state.items.length}`,
    role: 'assistant',
    content: message.content,
    ...createdAtField(message.createdAt)
  })
  return true
}

function appendPhiThinkingMessage(state: RestoreState, message: RestoredSessionMessage): boolean {
  if (typeof message.content !== 'string') return false
  appendRecoveredRuntimeToolsBeforeThinking(
    state.items,
    state.runtimeToolRecovery,
    message.runId,
    message.createdAt
  )
  state.items.push({
    id: message.eventId ?? `thinking-${state.items.length}`,
    role: 'thinking',
    content: message.content,
    ...completedAtField(message.createdAt),
    ...(typeof message.durationMs === 'number' ? { durationMs: message.durationMs } : {})
  })
  appendRecoveredRuntimeToolsAfterThinking(
    state.items,
    state.runtimeToolRecovery,
    message.runId,
    message.createdAt
  )
  return true
}

function applyTypedPhiTimelineEvent(state: RestoreState, message: RestoredSessionMessage): boolean {
  switch (message.type) {
    case 'tool_call_started':
      return appendPhiToolCallStarted(state, message)
    case 'tool_call_completed':
      return applyPhiToolCallCompleted(state, message)
    case 'user_message':
      return appendPhiUserMessage(state, message)
    case 'user_message_retry':
      applyPhiUserRetry(state, message)
      return true
    case 'assistant_message_finalized':
      return appendPhiAssistantMessage(state, message)
    case 'assistant_thinking_completed':
      return appendPhiThinkingMessage(state, message)
    default:
      return false
  }
}

function appendGenericPhiTimelineItem(items: ChatItem[], message: RestoredSessionMessage): void {
  const item = chatItemFromPhiTimelineEvent(message)
  if (!item) return
  if (
    item.role === 'error' &&
    hasEquivalentErrorMessage(items, item.content, { runId: item.runId })
  ) {
    return
  }
  items.push(item)
}

function appendPhiTimelineMessage(state: RestoreState, message: RestoredSessionMessage): void {
  if (applyPrimaryPhiTimelineEvent(state.items, message)) return
  appendPhiRunLifecycle(state.items, message)
  if (applyPhiAgentExecutionEvent(state.items, message)) return
  if (applyTypedPhiTimelineEvent(state, message)) return
  appendGenericPhiTimelineItem(state.items, message)
}

function appendRuntimeUserMessage(state: RestoreState, message: RestoredSessionMessage): void {
  const text = visibleRuntimeUserText(textFromContentParts(message.content))
  if (consumeDuplicateText(state.duplicateTextCounts, text)) return
  if (text) state.items.push({ id: `user-${state.items.length}`, role: 'user', content: text })
}

function appendRuntimeAssistantPart(state: RestoreState, part: unknown): void {
  if (!part || typeof part !== 'object') return
  const record = part as {
    type?: string
    text?: string
    thinking?: string
    id?: string
    name?: string
    arguments?: unknown
  }
  if (record.type === 'text') {
    const text = record.text ?? ''
    if (consumeDuplicateText(state.duplicateTextCounts, text)) return
    if (isDisplayableAssistantText(text)) {
      state.items.push({ id: `assistant-${state.items.length}`, role: 'assistant', content: text })
    }
    return
  }
  if (record.type === 'thinking') {
    const text = record.thinking ?? ''
    if (text)
      state.items.push({ id: `thinking-${state.items.length}`, role: 'thinking', content: text })
    return
  }
  if (record.type !== 'toolCall') return
  const id = record.id ?? `tool-${state.items.length}`
  if (state.phiToolCallIds.has(id)) return
  state.toolCallIndexById.set(id, state.items.length)
  state.items.push({
    id,
    role: 'tool',
    toolName: record.name ?? 'tool',
    argsPreview: toolArgsPreview(record.arguments),
    argsJson: serializedToolArgs(record.arguments),
    output: '',
    status: 'done'
  })
}

function appendRuntimeAssistantMessage(state: RestoreState, content: unknown[]): void {
  for (const part of content) appendRuntimeAssistantPart(state, part)
}

function applyRuntimeToolResult(state: RestoreState, message: RestoredSessionMessage): void {
  if (typeof message.toolCallId !== 'string' || state.phiToolCallIds.has(message.toolCallId)) return
  const index = state.toolCallIndexById.get(message.toolCallId)
  if (index === undefined) return
  const current = state.items[index]
  if (current.role !== 'tool') return
  state.items[index] = {
    ...current,
    output: extractToolText(message.content) || current.output,
    ...restoredStructuredToolDetails(current, message.content),
    status: message.isError ? 'error' : 'done'
  }
}

function appendRuntimeMessage(state: RestoreState, message: RestoredSessionMessage): void {
  if (message.role === 'user') {
    appendRuntimeUserMessage(state, message)
    return
  }
  if (message.role === 'assistant' && Array.isArray(message.content)) {
    appendRuntimeAssistantMessage(state, message.content)
    return
  }
  if (message.role === 'toolResult') applyRuntimeToolResult(state, message)
}

/**
 * Turns the raw AgentMessage[] a saved session resumes with into the same ChatItem[]
 * shape the live streaming reducer in App.tsx builds incrementally, so resuming an
 * old conversation renders identically to one that just finished streaming.
 */
export function chatItemsFromSessionMessages(messages: unknown[]): ChatItem[] {
  const coverage = collectPhiTimelineCoverage(messages)
  const runtimeCoveredFromIndex = coverage.hasPreferredPhiTimeline
    ? messages.findIndex((message) =>
        isRuntimeMessageCoveredByPhi(message, coverage.duplicateTextCounts)
      )
    : -1
  const state: RestoreState = {
    items: [],
    toolCallIndexById: new Map(),
    duplicateTextCounts: coverage.duplicateTextCounts,
    phiToolCallIds: coverage.phiToolCallIds,
    runtimeToolRecovery: recoverMissingRuntimeTools(
      messages,
      runtimeCoveredFromIndex,
      coverage.phiToolCallIds,
      { textFromContentParts, toolArgsPreview, extractToolText }
    )
  }

  for (const [messageIndex, raw] of messages.entries()) {
    const message = restoredSessionMessageFrom(raw)
    if (!message) continue
    if (
      runtimeCoveredFromIndex >= 0 &&
      messageIndex >= runtimeCoveredFromIndex &&
      message.source !== 'phi'
    ) {
      continue
    }
    if (message.source === 'phi') appendPhiTimelineMessage(state, message)
    else appendRuntimeMessage(state, message)
  }
  return state.items
}
