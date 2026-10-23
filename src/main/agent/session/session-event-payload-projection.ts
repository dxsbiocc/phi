import { isRecord } from '../../../shared/guards'
import type { RemoteOmpFailureCause, RemoteOmpFailureDetail } from '../../../shared/errorCodes'
import type { SessionEventPersistenceRun } from './session-event-persistence'

const REMOTE_OMP_FAILURE_CAUSES = new Set<RemoteOmpFailureCause>([
  'http',
  'stall',
  'network',
  'checksum',
  'invalid_response'
])

function boundedInteger(value: unknown, minimum: number, maximum: number): number | undefined {
  return typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
    ? value
    : undefined
}

/** Keep only bounded numeric OMP failure context before it reaches storage and renderer IPC. */
export function remoteOmpFailureDetailForPersistence(
  error: unknown
): RemoteOmpFailureDetail | undefined {
  if (!isRecord(error) || !isRecord(error.errorDetail)) return undefined
  const detail = error.errorDetail
  if (
    typeof detail.cause !== 'string' ||
    !REMOTE_OMP_FAILURE_CAUSES.has(detail.cause as RemoteOmpFailureCause)
  ) {
    return undefined
  }
  const cause = detail.cause as RemoteOmpFailureCause
  const attempts = boundedInteger(detail.attempts, 1, 100)
  const httpStatus = cause === 'http' ? boundedInteger(detail.httpStatus, 100, 599) : undefined
  const stallMs = cause === 'stall' ? boundedInteger(detail.stallMs, 1, 3_600_000) : undefined
  return {
    cause,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(stallMs !== undefined ? { stallMs } : {}),
    ...(attempts !== undefined ? { attempts } : {})
  }
}

export function extractAssistantThinkingBlocks(message: unknown): string[] {
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

export function summaryTimestampMs(summary: Record<string, unknown>): number {
  if (typeof summary.createdAt === 'string') {
    const timestamp = Date.parse(summary.createdAt)
    if (Number.isFinite(timestamp)) return timestamp
  }
  return Date.now()
}

export function textFromToolContentParts(content: unknown[]): string {
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const text = (part as { text?: unknown }).text
      return typeof text === 'string' ? text : ''
    })
    .join('')
}

export function extractToolText(value: unknown): string {
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

export function isAgentToolName(toolName: unknown): toolName is string {
  return typeof toolName === 'string' && /^[A-Z][A-Za-z0-9]*$/.test(toolName)
}

export function detailsFromToolResult(result: unknown): unknown {
  if (!result || typeof result !== 'object') return undefined
  return (result as { details?: unknown }).details
}

export function detailsKind(value: unknown): string | undefined {
  const details = detailsFromToolResult(value)
  if (!isRecord(details)) return undefined
  return typeof details.kind === 'string' ? details.kind : undefined
}

export function agentNameFromDetails(value: unknown): string | undefined {
  const details = detailsFromToolResult(value)
  if (!isRecord(details)) return undefined
  return typeof details.agent === 'string' && details.agent ? details.agent : undefined
}

export function agentTaskFromArgs(args: unknown): string | undefined {
  if (!isRecord(args)) return undefined
  const task = args.task
  return typeof task === 'string' && task.trim() ? task.trim() : undefined
}

export function isAgentDelegationStart(summary: Record<string, unknown>): boolean {
  return (
    summary.type === 'tool_execution_start' &&
    typeof summary.toolCallId === 'string' &&
    isAgentToolName(summary.toolName) &&
    agentTaskFromArgs(summary.args) !== undefined
  )
}

export function isAgentDelegationUpdate(
  run: SessionEventPersistenceRun,
  summary: Record<string, unknown>
): boolean {
  if (summary.type !== 'tool_execution_update' || typeof summary.toolCallId !== 'string') {
    return false
  }
  const kind = detailsKind(summary.partialResult)
  return (
    run.agentToolCallIds.has(summary.toolCallId) ||
    kind === 'agent_step' ||
    kind === 'agent_progress'
  )
}

export function isAgentDelegationEnd(
  run: SessionEventPersistenceRun,
  summary: Record<string, unknown>
): boolean {
  if (summary.type !== 'tool_execution_end' || typeof summary.toolCallId !== 'string') return false
  return (
    detailsKind(summary.result) === 'agent_result' || run.agentToolCallIds.has(summary.toolCallId)
  )
}

export function agentRunRefFrom(
  run: SessionEventPersistenceRun,
  toolResult: unknown
): { agentRunId?: string; agentSessionId?: string } {
  const details = detailsFromToolResult(toolResult)
  const agentRunId =
    isRecord(details) && typeof details.agentRunId === 'string' && details.agentRunId
      ? details.agentRunId
      : isRecord(details) && details.kind === 'agent_started' && typeof details.runId === 'string'
        ? details.runId
        : undefined
  const agentSessionId = run.session?.runtimeSessionId
  return {
    ...(agentRunId ? { agentRunId } : {}),
    ...(agentRunId && typeof agentSessionId === 'string' ? { agentSessionId } : {})
  }
}

export function agentStepRecordFrom(value: unknown): Record<string, unknown> | null {
  const details = detailsFromToolResult(value)
  if (!isRecord(details) || details.kind !== 'agent_step' || !isRecord(details.step)) return null
  return details.step
}

export function agentToolStepId(step: Record<string, unknown>, parentToolCallId: string): string {
  const value = step.id
  return typeof value === 'string' && value ? value : `${parentToolCallId}:step`
}

export function agentResultDetails(value: unknown): Record<string, unknown> | null {
  const details = detailsFromToolResult(value)
  return isRecord(details) && details.kind === 'agent_result' ? details : null
}

export function isNotebookToolName(toolName: unknown): boolean {
  return (
    typeof toolName === 'string' &&
    (toolName.startsWith('notebook_') || toolName.startsWith('notebook.'))
  )
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key]
  return typeof value === 'string' && value ? value : undefined
}

export function numberOrNullField(
  record: Record<string, unknown>,
  key: string
): number | null | undefined {
  const value = record[key]
  if (value === null) return null
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

export function numberField(record: Record<string, unknown>, key: string): number | undefined {
  const value = numberOrNullField(record, key)
  return typeof value === 'number' ? value : undefined
}

export function notebookCellNumberFrom(
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

function notebookPathFields(record: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(stringField(record, 'path') ? { path: stringField(record, 'path') } : {}),
    ...(stringField(record, 'relativePath')
      ? { relativePath: stringField(record, 'relativePath') }
      : {})
  }
}

function notebookCellFields(
  record: Record<string, unknown>,
  cell: Record<string, unknown> | null
): Record<string, unknown> {
  const cellNumber = notebookCellNumberFrom(record, cell)
  const cellId = stringField(record, 'cellId') ?? (cell ? stringField(cell, 'id') : undefined)
  const cellType =
    stringField(record, 'cellType') ??
    (cell ? (stringField(cell, 'cellType') ?? stringField(cell, 'cell_type')) : undefined)
  return {
    ...(cellId ? { cellId } : {}),
    ...(cellNumber !== undefined ? { cellNumber } : {}),
    ...(cellType ? { cellType } : {})
  }
}

function notebookExecutionFields(
  execution: Record<string, unknown> | null
): Record<string, unknown> {
  return {
    ...(execution && stringField(execution, 'state')
      ? { executionState: stringField(execution, 'state') }
      : {}),
    ...(execution && numberOrNullField(execution, 'executionCount') !== undefined
      ? { executionCount: numberOrNullField(execution, 'executionCount') }
      : {})
  }
}

export function notebookToolDetailsFromResult(
  result: unknown
): Record<string, unknown> | undefined {
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

  return {
    kind,
    ...notebookPathFields(record),
    ...notebookCellFields(record, cell),
    ...notebookExecutionFields(execution),
    ...(stringField(record, 'summary') ? { summary: stringField(record, 'summary') } : {})
  }
}

function browserActionFields(args: Record<string, unknown>): Record<string, unknown> {
  if (
    args.action === 'open' ||
    args.action === 'snapshot' ||
    args.action === 'click' ||
    args.action === 'typeText' ||
    args.action === 'scroll' ||
    args.action === 'keypress'
  ) {
    return { action: args.action }
  }
  return {}
}

function browserTargetFields(args: Record<string, unknown>): Record<string, unknown> {
  return args.target === 'current' || args.target === 'dedicated' ? { target: args.target } : {}
}

function browserTabFields(args: Record<string, unknown>): Record<string, unknown> {
  if (
    typeof args.tabId === 'string' &&
    args.tabId.length > 0 &&
    Buffer.byteLength(args.tabId, 'utf8') <= 256
  ) {
    return { tabId: args.tabId }
  }
  return {}
}

function browserRevisionFields(args: Record<string, unknown>): Record<string, unknown> {
  const expectedDocumentRevision = args.expectedDocumentRevision
  if (
    typeof expectedDocumentRevision === 'number' &&
    Number.isSafeInteger(expectedDocumentRevision) &&
    expectedDocumentRevision >= 0
  ) {
    return { expectedDocumentRevision }
  }
  return {}
}

export function toolArgsForPersistence(toolName: unknown, args: unknown): unknown {
  if (toolName !== 'browser') return args
  if (!isRecord(args)) return {}
  return {
    ...browserActionFields(args),
    ...browserTargetFields(args),
    ...browserTabFields(args),
    ...browserRevisionFields(args)
  }
}

export function browserToolResultForEvent(result: unknown): unknown {
  if (!isRecord(result) || !Array.isArray(result.content)) return { content: [] }
  return {
    content: result.content.flatMap((part) =>
      isRecord(part) && part.type === 'text' && typeof part.text === 'string'
        ? [{ type: 'text', text: part.text }]
        : []
    )
  }
}

export function browserSafeAssistantMessage(message: unknown): unknown {
  if (!isRecord(message) || !Array.isArray(message.content)) return message
  return {
    ...message,
    content: message.content.map((part) =>
      isRecord(part) && part.type === 'toolCall' && part.name === 'browser'
        ? { ...part, arguments: toolArgsForPersistence('browser', part.arguments) }
        : part
    )
  }
}

export function browserSafeToolResultMessage(message: unknown): unknown {
  if (!isRecord(message)) return { role: 'toolResult', content: [] }
  const result = browserToolResultForEvent(message)
  return {
    role: 'toolResult',
    ...(typeof message.toolCallId === 'string' ? { toolCallId: message.toolCallId } : {}),
    ...(isRecord(result) && Array.isArray(result.content) ? { content: result.content } : {}),
    ...(typeof message.isError === 'boolean' ? { isError: message.isError } : {})
  }
}
