import type { AgentEventSummary, ChatItem, ChatMessage } from '../types'
import { chatEventCopy } from '../features/chat/lib/chatEventCopy'
import { hasEquivalentErrorMessage } from './chatItems'
import { isStreamedErrorText } from '../../../shared/streamErrorText'

function createBlockId(prefix: string, contentIndex: number, nextId: number): string {
  return `${prefix}-${nextId}-${contentIndex}`
}

function createdAtField(createdAt?: string): { createdAt: string } | Record<string, never> {
  return typeof createdAt === 'string' ? { createdAt } : {}
}

function completedAtField(completedAt?: string): { completedAt: string } | Record<string, never> {
  return typeof completedAt === 'string' ? { completedAt } : {}
}

/** True when the failed attempt this message represents was superseded by a successful retry. */
export function assistantMessageWasRecovered(
  message: AgentEventSummary['message'] | undefined
): boolean {
  return message?.retryRecovery?.status === 'recovered'
}

function assistantRequestErrorFields(
  event: AgentEventSummary
): Pick<ChatMessage, 'errorSource' | 'assistantMessageTimestamp'> {
  return {
    errorSource: 'assistant-request',
    ...(typeof event.message?.timestamp === 'number'
      ? { assistantMessageTimestamp: event.message.timestamp }
      : {})
  }
}

function removeLatestAssistantRequestErrors(next: ChatItem[], runId: string, count: number): void {
  let remaining = count
  for (let index = next.length - 1; index >= 0 && remaining > 0; index -= 1) {
    const item = next[index]
    if (item.role === 'error' && item.runId === runId && item.errorSource === 'assistant-request') {
      next.splice(index, 1)
      remaining -= 1
    }
  }
}

function removeAssistantRequestErrors(next: ChatItem[], runId: string): void {
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const item = next[index]
    if (item.role === 'error' && item.runId === runId && item.errorSource === 'assistant-request') {
      next.splice(index, 1)
    }
  }
}

function removeRecoveredAssistantRequestError(
  next: ChatItem[],
  runId: string,
  recoveredMessage: NonNullable<AgentEventSummary['message']>
): void {
  const recoveredTimestamp =
    typeof recoveredMessage.timestamp === 'number' ? recoveredMessage.timestamp : undefined
  if (recoveredTimestamp !== undefined) {
    const exact = next.findIndex(
      (item) =>
        item.role === 'error' &&
        item.runId === runId &&
        item.errorSource === 'assistant-request' &&
        item.assistantMessageTimestamp === recoveredTimestamp
    )
    if (exact >= 0) {
      next.splice(exact, 1)
      return
    }
  }

  const errorMessage =
    typeof recoveredMessage.errorMessage === 'string' ? recoveredMessage.errorMessage.trim() : ''
  if (!errorMessage) return
  const matches: number[] = []
  for (let index = 0; index < next.length; index += 1) {
    const item = next[index]
    if (
      item.role === 'error' &&
      item.runId === runId &&
      item.errorSource === 'assistant-request' &&
      // Text fallback is only for legacy records without an attempt timestamp. Two known but
      // different timestamps are different attempts, even when the provider text is identical.
      (recoveredTimestamp === undefined ||
        typeof item.assistantMessageTimestamp !== 'number' ||
        item.assistantMessageTimestamp === recoveredTimestamp) &&
      item.content === errorMessage
    )
      matches.push(index)
  }
  // Only an unambiguous match is attributable; otherwise keep the evidence.
  if (matches.length === 1) next.splice(matches[0], 1)
}

function recoveredRetryErrorCount(retryErrors: AgentEventSummary['retryErrors']): number {
  let count = 0
  for (const error of retryErrors ?? []) {
    if (error.retryRecovery?.status === 'recovered') count += 1
  }
  return count
}

/**
 * A recovered retry erases the assistant request errors it superseded. Other errors in the same run
 * (approval denials, compaction/run failures) and later different failures stay visible. A recovered
 * `message_end` carries its attempt timestamp; older/replayed records fall back to an unambiguous
 * matching error message rather than deleting every error in the run.
 */
export function removeRetryErrorItems(
  next: ChatItem[],
  runId?: string,
  recoveredMessage?: AgentEventSummary['message'],
  retryErrors?: AgentEventSummary['retryErrors']
): void {
  // Without a run id there is no way to tell this attempt's error from other runs' errors.
  if (typeof runId !== 'string') return
  if (recoveredMessage === undefined) {
    if (retryErrors === undefined) {
      // Original events carried no per-attempt count. Every failed request that continued to a
      // successful retry belongs to this recovery, so clear all marked assistant-request errors
      // in the run while leaving approval/compaction/run-failure evidence untouched.
      removeAssistantRequestErrors(next, runId)
      return
    }
    // One auto_retry_end closes the whole saga. OMP accumulates every recovered attempt in
    // `retryErrors`; remove exactly that many latest marked request errors.
    removeLatestAssistantRequestErrors(
      next,
      runId,
      Math.max(1, recoveredRetryErrorCount(retryErrors))
    )
    return
  }
  removeRecoveredAssistantRequestError(next, runId, recoveredMessage)
}

function appendErrorItem(next: ChatItem[], event: AgentEventSummary, nextId: number): number {
  next.push({
    id: createBlockId('error', 0, nextId),
    role: 'error',
    get content() {
      return event.message?.errorMessage || chatEventCopy.requestFailed
    },
    ...assistantRequestErrorFields(event),
    ...(typeof event.runId === 'string' ? { runId: event.runId } : {}),
    ...createdAtField(event.createdAt)
  })
  return nextId + 1
}

function appendErrorUnlessDuplicate(
  next: ChatItem[],
  event: AgentEventSummary,
  content: string,
  nextId: number,
  exceptId?: string
): number {
  const duplicateExists =
    content.length > 0 && hasEquivalentErrorMessage(next, content, { runId: event.runId, exceptId })
  return duplicateExists ? nextId : appendErrorItem(next, event, nextId)
}

function applyConvertedTextError(
  next: ChatItem[],
  event: AgentEventSummary,
  index: number,
  current: ChatItem | null,
  nextId: number
): number {
  const errorText = event.message?.errorMessage || chatEventCopy.requestFailed
  const content = current?.role === 'assistant' ? current.content || errorText : errorText
  if (current?.role !== 'assistant') {
    return appendErrorUnlessDuplicate(next, event, errorText, nextId)
  }
  if (hasEquivalentErrorMessage(next, content, { runId: event.runId, exceptId: current.id })) {
    next.splice(index, 1)
    return nextId
  }
  next[index] = {
    ...current,
    role: 'error',
    get content() {
      return current.content || event.message?.errorMessage || chatEventCopy.requestFailed
    },
    ...assistantRequestErrorFields(event),
    ...(typeof event.runId === 'string' ? { runId: event.runId } : {}),
    ...completedAtField(event.createdAt)
  }
  return nextId
}

/**
 * An error-ended assistant message can still contain text the model finished before the stream
 * failed. Keep that answer visible and add the provider error separately. Providers that stream
 * their error text as the answer keep the old behavior: convert the text into the visible error.
 */
export function applyAssistantMessageError(
  next: ChatItem[],
  event: AgentEventSummary,
  textBlockIds: Map<number, string>,
  nextId: number
): number {
  const textIds = [...textBlockIds.values()]
  const lastTextId = textIds[textIds.length - 1]
  const index = lastTextId ? next.findIndex((item) => item.id === lastTextId) : -1
  const current = index >= 0 ? next[index] : null
  const errorMessage =
    typeof event.message?.errorMessage === 'string' ? event.message.errorMessage : ''
  const streamedText = current?.role === 'assistant' ? current.content : ''
  const keepsStreamedText =
    current?.role === 'assistant' &&
    errorMessage.trim().length > 0 &&
    !isStreamedErrorText(streamedText, errorMessage)

  return keepsStreamedText
    ? appendErrorUnlessDuplicate(next, event, errorMessage, nextId)
    : applyConvertedTextError(next, event, index, current, nextId)
}
