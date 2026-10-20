import { isPhiEventType } from '../engine/events'
import type { PhiAgentEvent } from '../engine/types'
import { redactSensitiveText } from '../redaction'
import { agentStepEventFromSummary } from './agent-delegation-event-persistence'
import {
  persistAssistantContentInOrder,
  persistCompletedThinkingBlocks
} from './assistant-message-event-persistence'
import {
  agentNameFromDetails,
  agentResultDetails,
  agentRunRefFrom,
  agentTaskFromArgs,
  browserSafeAssistantMessage,
  browserSafeToolResultMessage,
  browserToolResultForEvent,
  detailsKind,
  extractToolText,
  isAgentDelegationEnd,
  isAgentDelegationStart,
  isAgentDelegationUpdate,
  isAgentToolName,
  isNotebookToolName,
  notebookToolDetailsFromResult,
  summaryTimestampMs,
  toolArgsForPersistence
} from './session-event-payload-projection'
import {
  toolResultDetailsForSession,
  type PersistedToolOutput,
  type SessionEventInput,
  type StoredSessionEvent
} from './session-store'

export interface SessionEventPersistenceRun {
  phiSessionId: string
  runId: string
  recordedFailureMessage?: string
  stoppingPermanentProviderError?: boolean
  thinkingBlocks: Map<number, string>
  thinkingBlockStartedAtMs: Map<number, number>
  compactionReasons: Map<string, string>
  agentToolCallIds: Set<string>
  sdkToolCallIds: Set<string>
  browserSdkToolCallIds: Set<string>
  persistedToolCallIds: Set<string>
  pendingProviderToolCalls: Map<string, { toolName: string; args: unknown; createdAt?: string }>
  session?: { runtimeSessionId?: string }
}

interface ToolOutputInput {
  runId: string
  toolCallId: string
  output: string
  inlineLimit?: number
}

export interface SessionEventPersistenceDeps {
  storage: {
    appendSessionEvent(sessionId: string, event: SessionEventInput): StoredSessionEvent
    persistToolOutput(sessionId: string, input: ToolOutputInput): PersistedToolOutput
    toolOutputInlineLimit: number
  }
  shared: {
    createdAtFromSummary(
      summary: Record<string, unknown>
    ): { createdAt: string } | Record<string, never>
    extractAssistantText(message: unknown): string
    persistSdkCompactionNotice(
      sessionId: string,
      runId: string | undefined,
      summary: Record<string, unknown>
    ): Record<string, unknown> | null
    persistSdkShakeEvent(
      sessionId: string,
      runId: string | undefined,
      summary: Record<string, unknown>,
      reason?: string
    ): Record<string, unknown> | null
    redactStructuredValue(value: unknown): unknown
  }
}

type HandlerResult = Record<string, unknown> | undefined
type EventHandler = (
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
) => HandlerResult

function withRunId(
  run: SessionEventPersistenceRun,
  event: Record<string, unknown>
): Record<string, unknown> {
  return typeof event.runId === 'string' ? event : { ...event, runId: run.runId }
}

function isCursorStreamEndError(message: string | undefined): boolean {
  return (
    message === 'Cursor stream ended before turnEnded' ||
    message ===
      'stream closed before a terminal response event: Cursor stream ended before turnEnded'
  )
}

type CompactionEndEvent = Extract<PhiAgentEvent, { type: 'auto_compaction_end' }>

function compactionResultFields(result: CompactionEndEvent['result']): Record<string, unknown> {
  return {
    ...(typeof result?.shortSummary === 'string' ? { shortSummary: result.shortSummary } : {}),
    ...(typeof result?.summary === 'string' ? { summary: result.summary } : {}),
    ...(typeof result?.tokensBefore === 'number' ? { tokensBefore: result.tokensBefore } : {})
  }
}

function compactionTokensAfterFields(tokensAfter: unknown): Record<string, unknown> {
  return typeof tokensAfter === 'number' && Number.isFinite(tokensAfter) && tokensAfter >= 0
    ? { tokensAfter }
    : {}
}

function persistFailedCompaction(
  run: SessionEventPersistenceRun,
  summary: CompactionEndEvent,
  reason: string | undefined,
  deps: SessionEventPersistenceDeps
): Record<string, unknown> {
  const stored = deps.storage.appendSessionEvent(run.phiSessionId, {
    type: 'context_compaction_failed',
    runId: run.runId,
    action: summary.action,
    ...deps.shared.createdAtFromSummary(summary),
    ...(reason ? { reason } : {}),
    errorMessage: typeof summary.errorMessage === 'string' ? summary.errorMessage : '已取消'
  })
  return { source: 'phi', ...stored }
}

function persistCompletedCompaction(
  run: SessionEventPersistenceRun,
  summary: CompactionEndEvent,
  reason: string | undefined,
  deps: SessionEventPersistenceDeps
): Record<string, unknown> {
  const stored = deps.storage.appendSessionEvent(run.phiSessionId, {
    type: 'context_compacted',
    runId: run.runId,
    action: summary.action,
    ...deps.shared.createdAtFromSummary(summary),
    ...(reason ? { reason } : {}),
    ...compactionResultFields(summary.result),
    ...compactionTokensAfterFields(summary.tokensAfter)
  })
  return { source: 'phi', ...stored }
}

function persistCompactionEnd(
  run: SessionEventPersistenceRun,
  summary: CompactionEndEvent,
  deps: SessionEventPersistenceDeps
): Record<string, unknown> {
  const reason = run.compactionReasons.get(summary.action)
  run.compactionReasons.delete(summary.action)
  if (summary.action === 'shake') {
    return (
      deps.shared.persistSdkShakeEvent(run.phiSessionId, run.runId, summary, reason) ??
      withRunId(run, summary)
    )
  }
  if (summary.skipped) return withRunId(run, summary)
  if (summary.aborted || summary.errorMessage) {
    return persistFailedCompaction(run, summary, reason, deps)
  }
  return persistCompletedCompaction(run, summary, reason, deps)
}

function persistCompactionEvent(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
): HandlerResult {
  const notice = deps.shared.persistSdkCompactionNotice(run.phiSessionId, run.runId, summary)
  if (notice) return notice
  if (isPhiEventType(summary, 'auto_retry_end')) {
    if (summary.success && !run.stoppingPermanentProviderError) delete run.recordedFailureMessage
    return withRunId(run, summary)
  }
  if (summary.type === 'auto_compaction_start' && typeof summary.action === 'string') {
    if (typeof summary.reason === 'string')
      run.compactionReasons.set(summary.action, summary.reason)
    return withRunId(run, summary)
  }
  if (!isPhiEventType(summary, 'auto_compaction_end')) return undefined
  return persistCompactionEnd(run, summary, deps)
}

function persistAssistantMessageEnd(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
): Record<string, unknown> {
  const assistantMessage = summary.message as Record<string, unknown>
  if (assistantMessage.stopReason === 'error') {
    const errorMessage =
      typeof assistantMessage.errorMessage === 'string'
        ? redactSensitiveText(assistantMessage.errorMessage)
        : '请求失败'
    persistCompletedThinkingBlocks(run, summary, deps)
    const cursorStreamFailure =
      assistantMessage.api === 'cursor-agent' && isCursorStreamEndError(errorMessage)
    if (
      !run.stoppingPermanentProviderError &&
      (!cursorStreamFailure ||
        !run.recordedFailureMessage ||
        isCursorStreamEndError(run.recordedFailureMessage))
    ) {
      run.recordedFailureMessage = errorMessage
    }
    return withRunId(run, summary)
  }
  persistAssistantContentInOrder(run, summary, deps)
  if (
    !run.stoppingPermanentProviderError &&
    assistantMessage.api === 'cursor-agent' &&
    assistantMessage.stopReason === 'stop' &&
    isCursorStreamEndError(run.recordedFailureMessage)
  ) {
    delete run.recordedFailureMessage
  }
  return withRunId(run, { ...summary, message: browserSafeAssistantMessage(summary.message) })
}

function persistAssistantMessageEvent(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
): HandlerResult {
  if (isPhiEventType(summary, 'message_start') && summary.message.role === 'assistant') {
    run.thinkingBlocks.clear()
    run.thinkingBlockStartedAtMs.clear()
    return withRunId(run, summary)
  }
  if (isPhiEventType(summary, 'message_update') && summary.message.role === 'assistant') {
    const assistantMessageEvent = summary.assistantMessageEvent
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
    return withRunId(run, summary)
  }
  if (!isPhiEventType(summary, 'message_end') || summary.message.role !== 'assistant')
    return undefined
  return persistAssistantMessageEnd(run, summary, deps)
}

function persistToolResultMessage(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
): HandlerResult {
  if (!isPhiEventType(summary, 'message_end') || summary.message.role !== 'toolResult')
    return undefined
  const result = summary.message
  const toolCallId = result.toolCallId
  if (typeof toolCallId !== 'string') return withRunId(run, summary)
  const pending = run.pendingProviderToolCalls.get(toolCallId)
  run.pendingProviderToolCalls.delete(toolCallId)
  const browserSdkToolResult = run.browserSdkToolCallIds.delete(toolCallId)
  if (!pending || run.sdkToolCallIds.has(toolCallId)) {
    return withRunId(
      run,
      browserSdkToolResult
        ? { ...summary, message: browserSafeToolResultMessage(summary.message) }
        : summary
    )
  }
  if (!run.persistedToolCallIds.has(toolCallId)) {
    run.persistedToolCallIds.add(toolCallId)
    deps.storage.appendSessionEvent(run.phiSessionId, {
      type: 'tool_call_started',
      runId: run.runId,
      toolCallId,
      toolName: pending.toolName,
      args: pending.args,
      ...(pending.createdAt
        ? { createdAt: pending.createdAt }
        : deps.shared.createdAtFromSummary(summary))
    })
  }
  const persisted = deps.storage.persistToolOutput(run.phiSessionId, {
    runId: run.runId,
    toolCallId,
    output: extractToolText(result.content),
    inlineLimit: deps.storage.toolOutputInlineLimit
  })
  const completed = deps.storage.appendSessionEvent(run.phiSessionId, {
    type: 'tool_call_completed',
    runId: run.runId,
    toolCallId,
    toolName: pending.toolName,
    isError: result.isError === true,
    ...deps.shared.createdAtFromSummary(summary),
    output: persisted.outputPreview,
    outputBytes: persisted.outputBytes,
    outputTruncated: persisted.truncated,
    ...(persisted.outputPath ? { outputPath: persisted.outputPath } : {}),
    ...(persisted.outputArtifact ? { outputArtifact: persisted.outputArtifact } : {})
  })
  return { ...completed, type: 'provider_tool_call_completed', args: pending.args, source: 'phi' }
}

function persistToolExecutionStart(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
): HandlerResult {
  if (summary.type !== 'tool_execution_start' || typeof summary.toolCallId !== 'string')
    return undefined
  run.sdkToolCallIds.add(summary.toolCallId)
  if (summary.toolName === 'browser') run.browserSdkToolCallIds.add(summary.toolCallId)
  if (isAgentDelegationStart(summary)) {
    run.agentToolCallIds.add(summary.toolCallId)
    const task = agentTaskFromArgs(summary.args) ?? ''
    const event = {
      type: 'agent_execution_started',
      runId: run.runId,
      toolCallId: summary.toolCallId,
      agentName: typeof summary.toolName === 'string' ? summary.toolName : 'Agent',
      task: redactSensitiveText(task),
      args: deps.shared.redactStructuredValue(summary.args),
      ...deps.shared.createdAtFromSummary(summary)
    }
    deps.storage.appendSessionEvent(run.phiSessionId, event)
    return event
  }
  const persistedArgs = toolArgsForPersistence(summary.toolName, summary.args)
  if (!run.persistedToolCallIds.has(summary.toolCallId)) {
    run.persistedToolCallIds.add(summary.toolCallId)
    deps.storage.appendSessionEvent(run.phiSessionId, {
      type: 'tool_call_started',
      runId: run.runId,
      toolCallId: summary.toolCallId,
      toolName: summary.toolName,
      args: persistedArgs,
      ...deps.shared.createdAtFromSummary(summary)
    })
  }
  return withRunId(
    run,
    summary.toolName === 'browser' ? { ...summary, args: persistedArgs } : summary
  )
}

function persistAgentDelegationUpdate(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
): HandlerResult {
  if (!isAgentDelegationUpdate(run, summary)) return undefined
  const event = agentStepEventFromSummary(run, summary, deps)
  if (event) {
    deps.storage.appendSessionEvent(run.phiSessionId, event)
    return event
  }
  return withRunId(run, summary)
}

function forwardNonToolExecutionEnd(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent
): HandlerResult {
  if (summary.type !== 'tool_execution_end' || typeof summary.toolCallId !== 'string') {
    return withRunId(run, summary)
  }
  run.sdkToolCallIds.add(summary.toolCallId)
  return undefined
}

function persistBackgroundDelegationEnd(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
): Record<string, unknown> {
  // The agent carries on after this tool call returns. Its card stays running; its steps
  // and its end reach the card later, from the agent worker (see agent/agents/run-host.ts).
  run.agentToolCallIds.delete(summary.toolCallId as string)
  const event = {
    type: 'agent_execution_background',
    runId: run.runId,
    toolCallId: summary.toolCallId,
    agentName:
      agentNameFromDetails(summary.result) ??
      (isAgentToolName(summary.toolName) ? summary.toolName : 'Agent'),
    ...agentRunRefFrom(run, summary.result),
    ...deps.shared.createdAtFromSummary(summary)
  }
  deps.storage.appendSessionEvent(run.phiSessionId, event)
  return event
}

function persistCompletedDelegationEnd(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
): Record<string, unknown> {
  const toolCallId = summary.toolCallId as string
  const output = extractToolText(summary.result)
  const persisted = deps.storage.persistToolOutput(run.phiSessionId, {
    runId: run.runId,
    toolCallId,
    output,
    inlineLimit: deps.storage.toolOutputInlineLimit
  })
  const details = agentResultDetails(summary.result)
  const event = {
    type: 'agent_execution_completed',
    runId: run.runId,
    toolCallId,
    agentName:
      (typeof details?.agent === 'string' && details.agent) ||
      (isAgentToolName(summary.toolName) ? summary.toolName : 'Agent'),
    isError: summary.isError,
    ...deps.shared.createdAtFromSummary(summary),
    finalReport: persisted.outputPreview,
    finalReportBytes: persisted.outputBytes,
    finalReportTruncated: persisted.truncated,
    ...(persisted.outputPath ? { finalReportPath: persisted.outputPath } : {}),
    ...(persisted.outputArtifact ? { finalReportArtifact: persisted.outputArtifact } : {}),
    ...(typeof details?.toolCalls === 'number' ? { toolCalls: details.toolCalls } : {}),
    ...(summary.isError && output ? { error: redactSensitiveText(output) } : {})
  }
  run.agentToolCallIds.delete(toolCallId)
  deps.storage.appendSessionEvent(run.phiSessionId, event)
  if (!persisted.truncated) return event
  return {
    ...event,
    result: {
      output: persisted.outputPreview,
      outputPath: persisted.outputPath,
      outputBytes: persisted.outputBytes,
      truncated: true,
      outputArtifact: persisted.outputArtifact
    }
  }
}

function persistAgentDelegationEnd(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
): HandlerResult {
  if (!isAgentDelegationEnd(run, summary)) return undefined
  if (detailsKind(summary.result) === 'agent_started') {
    return persistBackgroundDelegationEnd(run, summary, deps)
  }
  return persistCompletedDelegationEnd(run, summary, deps)
}

function persistToolExecutionEnd(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
): HandlerResult {
  if (summary.type !== 'tool_execution_end' || typeof summary.toolCallId !== 'string')
    return undefined
  const output = extractToolText(summary.result)
  const notebookDetails = isNotebookToolName(summary.toolName)
    ? notebookToolDetailsFromResult(summary.result)
    : undefined
  const sessionDetails =
    toolResultDetailsForSession(summary.toolName, summary.result) ?? notebookDetails
  const persisted = deps.storage.persistToolOutput(run.phiSessionId, {
    runId: run.runId,
    toolCallId: summary.toolCallId,
    output,
    inlineLimit: deps.storage.toolOutputInlineLimit
  })
  deps.storage.appendSessionEvent(run.phiSessionId, {
    type: 'tool_call_completed',
    runId: run.runId,
    toolCallId: summary.toolCallId,
    toolName: summary.toolName,
    isError: summary.isError,
    ...deps.shared.createdAtFromSummary(summary),
    output: persisted.outputPreview,
    outputBytes: persisted.outputBytes,
    outputTruncated: persisted.truncated,
    ...(sessionDetails ? { details: sessionDetails } : {}),
    ...(persisted.outputPath ? { outputPath: persisted.outputPath } : {}),
    ...(persisted.outputArtifact ? { outputArtifact: persisted.outputArtifact } : {})
  })
  if (!persisted.truncated) {
    return withRunId(
      run,
      summary.toolName === 'browser'
        ? { ...summary, result: browserToolResultForEvent(summary.result) }
        : summary
    )
  }
  return withRunId(run, {
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

const orderedHandlers: EventHandler[] = [
  persistCompactionEvent,
  persistAssistantMessageEvent,
  persistToolResultMessage,
  persistToolExecutionStart,
  persistAgentDelegationUpdate,
  forwardNonToolExecutionEnd,
  persistAgentDelegationEnd,
  persistToolExecutionEnd
]

export function persistSessionEvent(
  run: SessionEventPersistenceRun,
  summary: PhiAgentEvent,
  deps: SessionEventPersistenceDeps
): Record<string, unknown> {
  for (const handler of orderedHandlers) {
    const forwarded = handler(run, summary, deps)
    if (forwarded !== undefined) return forwarded
  }
  return withRunId(run, summary)
}
