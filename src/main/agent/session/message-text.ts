import { isRecord } from '../../../shared/guards'
import { isPhiEventType, isPhiMessageUpdateSummary } from '../engine/events'
import type { PhiAgentEventSummary } from '../engine/types'
import { isSecretMetadataKey, redactSensitiveText } from '../redaction'

function directMessageText(record: Record<string, unknown>): string | undefined {
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
  return undefined
}

function nestedMessageText(record: Record<string, unknown>): string {
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

function arrayMessagePartText(part: unknown): string {
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
}

export function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(arrayMessagePartText).join('')
  if (!content || typeof content !== 'object') return ''
  const record = content as Record<string, unknown>
  return directMessageText(record) ?? nestedMessageText(record)
}

/** Requires an assistant role, then accepts the broad message-content shapes used by Phi events. */
export function extractAssistantMessageText(message: unknown): string {
  if (!message || typeof message !== 'object') return ''
  const record = message as { role?: string; content?: unknown }
  if (record.role !== 'assistant') return ''
  return extractMessageText(record.content)
}

export function redactStructuredValue(value: unknown, key = ''): unknown {
  if (key && isSecretMetadataKey(key)) return '[redacted]'
  if (typeof value === 'string') return redactSensitiveText(value)
  if (Array.isArray(value)) return value.map((item) => redactStructuredValue(item))
  if (!isRecord(value)) return value

  return Object.fromEntries(
    Object.entries(value).map(([entryKey, entryValue]) => [
      entryKey,
      redactStructuredValue(entryValue, entryKey)
    ])
  )
}

export function assistantMessagesFrom(value: unknown): unknown[] {
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

export function lastAssistantMessageFrom(value: unknown): unknown {
  return assistantMessagesFrom(value).at(-1)
}

export function assistantErrorText(
  message: unknown,
  options: { allowContent?: boolean } = {}
): string {
  if (!isRecord(message)) return ''
  if (typeof message.errorMessage === 'string') return message.errorMessage
  if (typeof message.message === 'string') return message.message
  if (message.role !== 'assistant') return ''
  if (message.stopReason === 'error' || options.allowContent) {
    return extractAssistantMessageText(message)
  }
  return ''
}

export function assistantErrorMessageFromEventSummary(
  summary: PhiAgentEventSummary
): string | null {
  const assistantMessageEvent = isPhiMessageUpdateSummary(summary)
    ? summary.assistantMessageEvent
    : undefined
  if (summary.type === 'message_update' && assistantMessageEvent?.type === 'error') {
    const error = assistantMessageEvent.error
    const message = assistantErrorText(error, { allowContent: true })
    return message ? redactSensitiveText(message) : '请求失败'
  }

  const message = isPhiEventType(summary, 'message_end') ? summary.message : undefined
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
