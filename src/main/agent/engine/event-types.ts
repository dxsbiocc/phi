import type { PhiToolContent, PhiToolImage, ThinkingLevel } from './types'

/** Fields outside Phi's contract survive for diagnostics and forward compatibility. */
export interface PhiEventFields {
  [key: string]: unknown
}

export type PhiStopReason = 'stop' | 'length' | 'toolUse' | 'error' | 'aborted'
export type PhiMessageContent =
  | { type: 'text'; text: string; textSignature?: string }
  | { type: 'thinking'; thinking: string; thinkingSignature?: string; itemId?: string }
  | { type: 'redactedThinking'; data: string }
  | PhiToolImage
  | PhiEventToolCall
  | { type: 'fallback'; from: { model: string }; to: { model: string } }
  | { type: 'anthropicServerTool'; block: unknown }

export interface PhiEventToolCall {
  type: 'toolCall'
  id: string
  name: string
  arguments: Record<string, unknown>
  intent?: string
}

export interface PhiAssistantMessage extends PhiEventFields {
  role: 'assistant'
  api: string
  provider: string
  model: string
  content: PhiMessageContent[]
  stopReason: PhiStopReason
  errorMessage?: string
  timestamp: number
  usage: {
    input: number
    output: number
    cacheRead: number
    cacheWrite: number
    totalTokens: number
    reasoningTokens?: number
    cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }
  }
}

export interface PhiToolResultMessage extends PhiEventFields {
  role: 'toolResult'
  toolCallId: string
  toolName: string
  content: PhiToolContent[]
  isError: boolean
  details?: unknown
  timestamp: number
}

export type PhiEventMessage =
  | PhiAssistantMessage
  | PhiToolResultMessage
  | (PhiEventFields & {
      role: 'user' | 'developer'
      content: string | PhiToolContent[]
      timestamp: number
    })
  // OMP extensions may add custom roles. Phi does not interpret their payloads.
  | (PhiEventFields & { role: string })

interface PhiAssistantEventFields extends PhiEventFields {
  partial?: PhiAssistantMessage
  message?: PhiAssistantMessage
  error?: PhiAssistantMessage
  delta?: string
  contentIndex?: number
  content?: string | PhiToolImage
}

export type PhiKnownAssistantMessageEvent = PhiAssistantEventFields &
  (
    | { type: 'start'; partial: PhiAssistantMessage; contentIndex?: undefined }
    | {
        type: 'text_start' | 'thinking_start' | 'toolcall_start'
        contentIndex: number
        partial: PhiAssistantMessage
      }
    | {
        type: 'text_delta' | 'thinking_delta' | 'toolcall_delta'
        contentIndex: number
        delta: string
        partial: PhiAssistantMessage
      }
    | {
        type: 'text_end' | 'thinking_end'
        contentIndex: number
        content: string
        partial: PhiAssistantMessage
      }
    | {
        type: 'image_end'
        contentIndex: number
        content: PhiToolImage
        partial: PhiAssistantMessage
      }
    | {
        type: 'toolcall_end'
        contentIndex: number
        toolCall: PhiEventToolCall
        partial: PhiAssistantMessage
      }
    | {
        type: 'done'
        reason: 'stop' | 'length' | 'toolUse'
        message: PhiAssistantMessage
        contentIndex?: undefined
      }
    | {
        type: 'error'
        reason: 'aborted' | 'error'
        error: PhiAssistantMessage
        contentIndex?: undefined
      }
  )

export type PhiAssistantMessageEvent =
  PhiKnownAssistantMessageEvent | (PhiEventFields & { type: string })

export type PhiCompactionAction = 'context-full' | 'remote' | 'handoff' | 'shake' | 'snapcompact'
export interface PhiCompactionResult {
  summary: string
  shortSummary?: string
  firstKeptEntryId: string
  tokensBefore: number
  details?: unknown
  preserveData?: Record<string, unknown>
}

export type PhiKnownAgentEvent = PhiEventFields &
  (
    | { type: 'agent_start' }
    | {
        type: 'agent_end'
        messages: PhiEventMessage[]
        isTerminal?: boolean
        telemetry?: unknown
        coverage?: unknown
      }
    | { type: 'turn_start' }
    | { type: 'turn_end'; message: PhiEventMessage; toolResults: PhiToolResultMessage[] }
    | { type: 'message_start'; message: PhiEventMessage }
    | {
        type: 'message_update'
        message: PhiEventMessage
        assistantMessageEvent: PhiAssistantMessageEvent
      }
    | { type: 'message_end'; message: PhiEventMessage }
    // Tool inputs/results are tool-defined (including plain strings), hence opaque to the engine.
    | {
        type: 'tool_execution_start'
        toolCallId?: string
        toolName?: string
        args?: unknown
        intent?: string
        id?: string
      }
    | {
        type: 'tool_execution_update'
        toolCallId?: string
        toolName?: string
        args?: unknown
        partialResult?: unknown
        id?: string
      }
    | { type: 'tool_stream_update'; toolCallId: string; toolName: string; update: unknown }
    | {
        type: 'tool_execution_end'
        toolCallId?: string
        toolName?: string
        result?: unknown
        isError?: boolean
        id?: string
      }
    | {
        type: 'auto_compaction_start'
        reason: 'threshold' | 'overflow' | 'idle' | 'incomplete'
        action: PhiCompactionAction
      }
    | {
        type: 'auto_compaction_end'
        action: PhiCompactionAction
        result: PhiCompactionResult | undefined
        aborted: boolean
        willRetry: boolean
        errorMessage?: string
        skipped?: boolean
        tokensAfter?: number
      }
    | {
        type: 'auto_retry_start'
        attempt: number
        maxAttempts: number
        delayMs: number
        errorMessage: string
        errorId?: number
      }
    | {
        type: 'auto_retry_end'
        success: boolean
        attempt: number
        finalError?: string
        retryErrors?: unknown[]
      }
    | {
        type: 'cache_warming_start'
        phase: 'streaming' | 'idle'
        provider: string
        model: string
      }
    | {
        type: 'cache_warming_end'
        phase: 'streaming' | 'idle'
        provider: string
        model: string
        outcome: 'hit' | 'miss' | 'error' | 'aborted'
        usage?: unknown
        warmingStopReason?: string
      }
    | { type: 'queue_update'; steering: string[]; followUp: string[]; liveSteered: number }
    | { type: 'retry_fallback_applied'; from: string; to: string; role: string }
    | { type: 'retry_fallback_succeeded'; model: string; role: string }
    | { type: 'model_changed' }
    | { type: 'config_warnings_changed' }
    | { type: 'advisor_cost_changed' }
    | { type: 'advisor_yielded' }
    | { type: 'ttsr_triggered'; rules: unknown[] }
    | {
        type: 'todo_reminder'
        todos: Array<{
          content: string
          status: 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked'
          blocker?: string
        }>
        attempt: number
        maxAttempts: number
      }
    | { type: 'todo_auto_clear' }
    | { type: 'irc_message'; message: PhiEventMessage }
    | { type: 'notice'; level: 'info' | 'warning' | 'error'; message: string; source?: string }
    | {
        type: 'thinking_level_changed'
        thinkingLevel: ThinkingLevel | 'off' | 'inherit' | undefined
        configured?: ThinkingLevel | 'auto' | 'off' | 'inherit'
        resolved?: ThinkingLevel
      }
    | { type: 'goal_updated'; goal: unknown; state?: unknown }
  )

/** Unknown names remain observable, but consumers must narrow before interpreting payloads. */
export type PhiUnknownAgentEvent = PhiEventFields & { type: string }
export type PhiAgentEvent = PhiKnownAgentEvent | PhiUnknownAgentEvent

/** No-tools callbacks intentionally select a subset of the raw event fields. */
export type PhiMessageUpdateSummary = PhiEventFields & {
  type: 'message_update'
  assistantMessageEvent: PhiAssistantMessageEvent
}
export type PhiAgentEventSummary = PhiMessageUpdateSummary | PhiUnknownAgentEvent
