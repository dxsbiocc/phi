import { isRecord } from '../../../shared/guards'
import type {
  SessionEventPersistenceDeps,
  SessionEventPersistenceRun
} from './session-event-persistence'
import {
  extractAssistantThinkingBlocks,
  summaryTimestampMs,
  toolArgsForPersistence
} from './session-event-payload-projection'

export function persistCompletedThinkingBlocks(
  run: SessionEventPersistenceRun,
  summary: Record<string, unknown>,
  deps: SessionEventPersistenceDeps
): void {
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
    deps.storage.appendSessionEvent(run.phiSessionId, {
      type: 'assistant_thinking_completed',
      runId: run.runId,
      content,
      ...deps.shared.createdAtFromSummary(summary),
      ...(startedAtMs !== undefined
        ? { durationMs: Math.max(0, thinkingEndedAtMs - startedAtMs) }
        : {})
    })
  }
  run.thinkingBlockStartedAtMs.clear()
}

interface AssistantContentPart {
  part: Record<string, unknown>
  contentIndex: number
  endedAtMs: number
}

function persistAssistantContentPart(
  run: SessionEventPersistenceRun,
  summary: Record<string, unknown>,
  input: AssistantContentPart,
  deps: SessionEventPersistenceDeps
): boolean {
  const { part, contentIndex, endedAtMs } = input
  if (part.type === 'thinking') {
    const content = run.thinkingBlocks.get(contentIndex) ?? part.thinking
    if (typeof content === 'string' && content) {
      const startedAtMs = run.thinkingBlockStartedAtMs.get(contentIndex)
      deps.storage.appendSessionEvent(run.phiSessionId, {
        type: 'assistant_thinking_completed',
        runId: run.runId,
        content,
        ...deps.shared.createdAtFromSummary(summary),
        ...(startedAtMs !== undefined ? { durationMs: Math.max(0, endedAtMs - startedAtMs) } : {})
      })
    }
    return false
  }
  if (part.type === 'text' && typeof part.text === 'string' && part.text) {
    deps.storage.appendSessionEvent(run.phiSessionId, {
      type: 'assistant_message_finalized',
      runId: run.runId,
      content: part.text,
      ...deps.shared.createdAtFromSummary(summary)
    })
    return true
  }
  if (part.type !== 'toolCall' || typeof part.id !== 'string') return false
  const toolName = typeof part.name === 'string' ? part.name : 'tool'
  const persistedArgs = toolArgsForPersistence(toolName, part.arguments)
  run.pendingProviderToolCalls.set(part.id, {
    toolName,
    args: persistedArgs,
    ...deps.shared.createdAtFromSummary(summary)
  })
  if (run.persistedToolCallIds.has(part.id)) return false
  run.persistedToolCallIds.add(part.id)
  deps.storage.appendSessionEvent(run.phiSessionId, {
    type: 'tool_call_started',
    runId: run.runId,
    toolCallId: part.id,
    toolName,
    args: persistedArgs,
    ...deps.shared.createdAtFromSummary(summary)
  })
  return false
}

export function persistAssistantContentInOrder(
  run: SessionEventPersistenceRun,
  summary: Record<string, unknown>,
  deps: SessionEventPersistenceDeps
): void {
  const message = summary.message as { content?: unknown }
  const contentParts = Array.isArray(message.content) ? message.content : []
  const orderedParts = contentParts.map((part, contentIndex) => ({
    part,
    contentIndex,
    orphan: false
  }))
  for (const [contentIndex, content] of run.thinkingBlocks) {
    if (isRecord(contentParts[contentIndex]) && contentParts[contentIndex].type === 'thinking')
      continue
    orderedParts.push({ part: { type: 'thinking', thinking: content }, contentIndex, orphan: true })
  }
  orderedParts.sort(
    (left, right) =>
      left.contentIndex - right.contentIndex || Number(right.orphan) - Number(left.orphan)
  )
  const endedAtMs = summaryTimestampMs(summary)
  let storedText = false
  for (const { part, contentIndex } of orderedParts) {
    if (!isRecord(part)) continue
    storedText =
      persistAssistantContentPart(run, summary, { part, contentIndex, endedAtMs }, deps) ||
      storedText
  }
  if (!storedText) {
    const content = deps.shared.extractAssistantText(summary.message)
    if (content) {
      deps.storage.appendSessionEvent(run.phiSessionId, {
        type: 'assistant_message_finalized',
        runId: run.runId,
        content,
        ...deps.shared.createdAtFromSummary(summary)
      })
    }
  }
  run.thinkingBlocks.clear()
  run.thinkingBlockStartedAtMs.clear()
}
