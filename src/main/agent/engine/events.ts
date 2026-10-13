import type { CreateAgentSessionResult } from '@oh-my-pi/pi-coding-agent'
import type { PhiAgentEvent, PhiKnownAgentEvent, PhiEventMessage } from './types'
import type {
  PhiAssistantMessage,
  PhiToolResultMessage,
  PhiKnownAssistantMessageEvent,
  PhiAgentEventSummary,
  PhiMessageUpdateSummary
} from './event-types'

export function contextTokensNow(session: CreateAgentSessionResult['session']): number | undefined {
  try {
    const tokens = session.getContextUsage()?.tokens
    return typeof tokens === 'number' && Number.isFinite(tokens) && tokens >= 0 ? tokens : undefined
  } catch {
    return undefined
  }
}

export function compactedTokensAfter(
  session: CreateAgentSessionResult['session']
): number | undefined {
  try {
    const leaf = session.sessionManager.getLeafEntry()
    if (
      leaf?.type === 'compaction' &&
      typeof leaf.tokensAfter === 'number' &&
      Number.isFinite(leaf.tokensAfter) &&
      leaf.tokensAfter >= 0
    ) {
      return leaf.tokensAfter
    }
    return contextTokensNow(session)
  } catch {
    return undefined
  }
}

type OmpEvent = Parameters<Parameters<CreateAgentSessionResult['session']['subscribe']>[0]>[0]
type OmpMessage = Extract<OmpEvent, { type: 'message_end' }>['message']

function translateMessage(message: OmpMessage): PhiEventMessage {
  // Check known payloads independently of the opaque custom-role fallback.
  switch (message.role) {
    case 'assistant':
      return { ...message } satisfies PhiAssistantMessage
    case 'toolResult':
      return { ...message } satisfies PhiToolResultMessage
    case 'user':
    case 'developer':
      return { ...message } satisfies {
        role: 'user' | 'developer'
        content: string | import('./types').PhiToolContent[]
        timestamp: number
      }
    default:
      return { ...message }
  }
}

function translateAssistantEvent(
  event: Extract<OmpEvent, { type: 'message_update' }>['assistantMessageEvent']
): PhiKnownAssistantMessageEvent {
  switch (event.type) {
    case 'done':
      return { ...event, message: { ...event.message } }
    case 'error':
      return { ...event, error: { ...event.error } }
    case 'start':
    case 'text_start':
    case 'text_delta':
    case 'text_end':
    case 'thinking_start':
    case 'thinking_delta':
    case 'thinking_end':
    case 'image_end':
    case 'toolcall_start':
    case 'toolcall_delta':
    case 'toolcall_end':
      return { ...event, partial: { ...event.partial } }
    default: {
      const unhandled: never = event
      return unhandled
    }
  }
}

/** Preserve the specialist session object, properties, and method receivers. */
export function adaptOmpSessionEvents<T extends CreateAgentSessionResult['session']>(
  session: T
): Omit<T, 'subscribe'> & { subscribe(listener: (event: PhiAgentEvent) => void): () => void } {
  const subscribe = session.subscribe.bind(session)
  return Object.assign(session, {
    subscribe: (listener: (event: PhiAgentEvent) => void) =>
      subscribe((event) => listener(translateOmpEvent(event, session)))
  })
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string'
}

function optionalBoolean(value: unknown): boolean {
  return value === undefined || typeof value === 'boolean'
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || typeof value === 'number'
}

function oneOf(value: unknown, choices: readonly string[]): boolean {
  return typeof value === 'string' && choices.includes(value)
}

const compactionActions = ['context-full', 'remote', 'handoff', 'shake', 'snapcompact']
const thinkingLevels = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

function isMessage(value: unknown): boolean {
  return isObject(value) && typeof value.role === 'string'
}

function isToolContent(value: unknown): boolean {
  return (
    isObject(value) &&
    ((value.type === 'text' && typeof value.text === 'string') ||
      (value.type === 'image' &&
        typeof value.data === 'string' &&
        typeof value.mimeType === 'string'))
  )
}

function isToolResultMessage(value: unknown): boolean {
  return (
    isObject(value) &&
    value.role === 'toolResult' &&
    typeof value.toolCallId === 'string' &&
    typeof value.toolName === 'string' &&
    Array.isArray(value.content) &&
    value.content.every(isToolContent) &&
    typeof value.isError === 'boolean' &&
    typeof value.timestamp === 'number'
  )
}

function isCompactionResult(value: unknown): boolean {
  return (
    value === undefined ||
    (isObject(value) &&
      typeof value.summary === 'string' &&
      optionalString(value.shortSummary) &&
      typeof value.firstKeptEntryId === 'string' &&
      typeof value.tokensBefore === 'number' &&
      (value.preserveData === undefined || isObject(value.preserveData)))
  )
}

/** Summary callbacks can stream a delta without carrying a full message. */
export function isPhiMessageUpdateSummary(
  event: PhiAgentEventSummary
): event is PhiMessageUpdateSummary {
  return (
    isObject(event) &&
    event.type === 'message_update' &&
    isObject(event.assistantMessageEvent) &&
    typeof event.assistantMessageEvent.type === 'string'
  )
}

/** Validate interpreted fields instead of trusting JSON or a matching event name. */
export function isPhiEventType<T extends PhiKnownAgentEvent['type']>(
  event: PhiAgentEvent,
  type: T
): event is Extract<PhiKnownAgentEvent, { type: T }> {
  if (!isObject(event) || event.type !== type) return false
  switch (type) {
    case 'message_start':
    case 'message_end':
    case 'irc_message':
      return isMessage(event.message)
    case 'message_update':
      return (
        isMessage(event.message) &&
        isObject(event.assistantMessageEvent) &&
        typeof event.assistantMessageEvent.type === 'string'
      )
    case 'agent_end':
      return (
        Array.isArray(event.messages) &&
        event.messages.every(isMessage) &&
        optionalBoolean(event.isTerminal)
      )
    case 'turn_end':
      return (
        isMessage(event.message) &&
        Array.isArray(event.toolResults) &&
        event.toolResults.every(isToolResultMessage)
      )
    case 'tool_execution_start':
      return (
        optionalString(event.toolCallId) &&
        optionalString(event.toolName) &&
        optionalString(event.id) &&
        optionalString(event.intent)
      )
    case 'tool_execution_update':
      return (
        optionalString(event.toolCallId) &&
        optionalString(event.toolName) &&
        optionalString(event.id)
      )
    case 'tool_execution_end':
      return (
        optionalString(event.toolCallId) &&
        optionalString(event.toolName) &&
        optionalString(event.id) &&
        optionalBoolean(event.isError)
      )
    case 'tool_stream_update':
      return (
        typeof event.toolCallId === 'string' &&
        typeof event.toolName === 'string' &&
        'update' in event
      )
    case 'auto_compaction_start':
      return (
        oneOf(event.action, compactionActions) &&
        oneOf(event.reason, ['threshold', 'overflow', 'idle', 'incomplete'])
      )
    case 'auto_compaction_end':
      return (
        oneOf(event.action, compactionActions) &&
        typeof event.aborted === 'boolean' &&
        typeof event.willRetry === 'boolean' &&
        isCompactionResult(event.result) &&
        optionalString(event.errorMessage) &&
        optionalBoolean(event.skipped) &&
        optionalNumber(event.tokensAfter)
      )
    case 'auto_retry_start':
      return (
        typeof event.attempt === 'number' &&
        typeof event.maxAttempts === 'number' &&
        typeof event.delayMs === 'number' &&
        typeof event.errorMessage === 'string' &&
        optionalNumber(event.errorId)
      )
    case 'auto_retry_end':
      return (
        typeof event.success === 'boolean' &&
        typeof event.attempt === 'number' &&
        optionalString(event.finalError) &&
        (event.retryErrors === undefined || Array.isArray(event.retryErrors))
      )
    case 'retry_fallback_applied':
      return (
        typeof event.from === 'string' &&
        typeof event.to === 'string' &&
        typeof event.role === 'string'
      )
    case 'retry_fallback_succeeded':
      return typeof event.model === 'string' && typeof event.role === 'string'
    case 'ttsr_triggered':
      return Array.isArray(event.rules)
    case 'todo_reminder':
      return (
        Array.isArray(event.todos) &&
        event.todos.every(
          (todo) =>
            isObject(todo) &&
            typeof todo.content === 'string' &&
            oneOf(todo.status, ['pending', 'in_progress', 'completed', 'abandoned', 'blocked']) &&
            optionalString(todo.blocker)
        ) &&
        typeof event.attempt === 'number' &&
        typeof event.maxAttempts === 'number'
      )
    case 'notice':
      return (
        typeof event.message === 'string' &&
        oneOf(event.level, ['info', 'warning', 'error']) &&
        optionalString(event.source)
      )
    case 'thinking_level_changed':
      return (
        (event.thinkingLevel === undefined ||
          oneOf(event.thinkingLevel, [...thinkingLevels, 'off', 'inherit'])) &&
        (event.configured === undefined ||
          oneOf(event.configured, [...thinkingLevels, 'off', 'inherit', 'auto'])) &&
        (event.resolved === undefined || oneOf(event.resolved, thinkingLevels))
      )
    case 'goal_updated':
      return 'goal' in event
    default:
      return true
  }
}

/** Preserve valid event envelopes; malformed payloads remain opaque to known handlers. */
export function phiEventFromWire(value: unknown): PhiAgentEvent | undefined {
  if (!isObject(value) || typeof value.type !== 'string') return undefined
  return { ...value, type: value.type }
}

export function translateOmpEvent(
  event: OmpEvent,
  session: CreateAgentSessionResult['session']
): PhiAgentEvent {
  switch (event.type) {
    case 'agent_end':
      return {
        ...event,
        messages: event.messages.map(translateMessage)
      } satisfies PhiKnownAgentEvent
    case 'turn_end':
      return {
        ...event,
        message: translateMessage(event.message),
        toolResults: event.toolResults.map((result) => ({ ...result }))
      } satisfies PhiKnownAgentEvent
    case 'message_start':
    case 'message_end':
      return { ...event, message: translateMessage(event.message) } satisfies PhiKnownAgentEvent
    case 'message_update':
      return {
        ...event,
        message: translateMessage(event.message),
        assistantMessageEvent: translateAssistantEvent(event.assistantMessageEvent)
      } satisfies PhiKnownAgentEvent
    case 'irc_message':
      return { ...event, message: translateMessage(event.message) } satisfies PhiKnownAgentEvent
    case 'auto_compaction_end': {
      const tokensAfter =
        !event.aborted && !event.skipped
          ? event.action === 'shake'
            ? contextTokensNow(session)
            : compactedTokensAfter(session)
          : undefined
      return (
        tokensAfter === undefined ? { ...event } : { ...event, tokensAfter }
      ) satisfies PhiKnownAgentEvent
    }
    case 'agent_start':
    case 'turn_start':
    case 'tool_execution_start':
    case 'tool_execution_update':
    case 'tool_stream_update':
    case 'tool_execution_end':
    case 'auto_compaction_start':
    case 'auto_retry_start':
    case 'auto_retry_end':
    case 'retry_fallback_applied':
    case 'retry_fallback_succeeded':
    case 'model_changed':
    case 'config_warnings_changed':
    case 'advisor_cost_changed':
    case 'advisor_yielded':
    case 'ttsr_triggered':
    case 'todo_reminder':
    case 'todo_auto_clear':
    case 'notice':
    case 'thinking_level_changed':
    case 'goal_updated':
      return { ...event } satisfies PhiKnownAgentEvent
    default: {
      // Exhaustiveness makes SDK additions a deliberate adaptation point. At runtime,
      // an unfamiliar event still passes through rather than losing diagnostics.
      const unhandled: never = event
      return unhandled
    }
  }
}
