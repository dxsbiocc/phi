import type { AgentEventSummary, ChatItem } from '../types'
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

function appendErrorItem(next: ChatItem[], event: AgentEventSummary, nextId: number): number {
  next.push({
    id: createBlockId('error', 0, nextId),
    role: 'error',
    get content() {
      return event.message?.errorMessage || chatEventCopy.requestFailed
    },
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
