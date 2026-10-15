import type {
  PhiAgentEvent,
  PhiAssistantMessage,
  PhiEventMessage,
  PhiMessageContent,
  PhiKnownAssistantMessageEvent,
  PhiToolResultMessage
} from '../event-types'
import type { PhiToolContent } from '../types'
import type { RpcFrame } from './types'
import { projectRpcMaintenanceEvent } from './facade-maintenance-projection'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string'
const number = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
const privateUri = (value: unknown): boolean => text(value) && /^phi-child:/iu.test(value)
const privateInput = (value: unknown): boolean =>
  record(value) && ['path', 'url', 'file_path'].some((key) => privateUri(value[key]))
const privateTypes = new Set([
  'host_uri_request',
  'host_uri_cancel',
  'host_uri_result',
  'host_tool_call',
  'host_tool_cancel',
  'extension_ui_request',
  'extension_ui_response',
  'response',
  'prompt_result',
  'ready',
  'rpc_chunk'
])
const stopReasons = new Set(['stop', 'length', 'toolUse', 'error', 'aborted'])

function toolContent(raw: unknown): PhiToolContent[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const result: PhiToolContent[] = []
  for (const part of raw) {
    if (!record(part)) return undefined
    if (part.type === 'text' && text(part.text)) result.push({ type: 'text', text: part.text })
    else if (part.type === 'image' && text(part.data) && text(part.mimeType))
      result.push({ type: 'image', data: part.data, mimeType: part.mimeType })
    else return undefined
  }
  return result
}
function json(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
}

/** Public event/message projection. Protocol frames and reserved transport tools never leave this boundary. */
export class RpcFacadeEventProjector {
  private readonly privateCalls = new Set<string>()
  private privateOverflow = false
  constructor(private readonly dispatchPrivate?: (frame: Readonly<RpcFrame>) => void) {}

  private remember(id: unknown): void {
    if (!text(id)) return
    if (this.privateCalls.size >= 4096 && !this.privateCalls.has(id)) {
      this.privateOverflow = true
      throw new Error('Private tool carrier budget exceeded')
    }
    this.privateCalls.add(id)
  }
  private content(raw: unknown): PhiMessageContent[] | undefined {
    if (!Array.isArray(raw)) return undefined
    const result: PhiMessageContent[] = []
    for (const block of raw) {
      if (!record(block)) return undefined
      if (block.type === 'text' && text(block.text))
        result.push({
          type: 'text',
          text: block.text,
          ...(text(block.textSignature) ? { textSignature: block.textSignature } : {})
        })
      else if (block.type === 'thinking' && text(block.thinking))
        result.push({
          type: 'thinking',
          thinking: block.thinking,
          ...(text(block.thinkingSignature) ? { thinkingSignature: block.thinkingSignature } : {}),
          ...(text(block.itemId) ? { itemId: block.itemId } : {})
        })
      else if (block.type === 'redactedThinking' && text(block.data))
        result.push({ type: 'redactedThinking', data: block.data })
      else if (block.type === 'image' && text(block.data) && text(block.mimeType))
        result.push({ type: 'image', data: block.data, mimeType: block.mimeType })
      else if (
        block.type === 'fallback' &&
        record(block.from) &&
        text(block.from.model) &&
        record(block.to) &&
        text(block.to.model)
      )
        result.push({
          type: 'fallback',
          from: { model: block.from.model },
          to: { model: block.to.model }
        })
      else if (
        block.type === 'toolCall' &&
        text(block.id) &&
        text(block.name) &&
        record(block.arguments)
      ) {
        if (privateInput(block.arguments)) {
          this.remember(block.id)
          return undefined
        }
        result.push({
          type: 'toolCall',
          id: block.id,
          name: block.name,
          arguments: json(block.arguments) as Record<string, unknown>,
          ...(text(block.intent) ? { intent: block.intent } : {})
        })
      } else return undefined
    }
    return result
  }

  message(raw: unknown): PhiEventMessage | undefined {
    try {
      if (!record(raw) || !number(raw.timestamp)) return undefined
      if (raw.role === 'compactionSummary') {
        if (
          !text(raw.summary) ||
          !number(raw.tokensBefore) ||
          (raw.shortSummary !== undefined && !text(raw.shortSummary)) ||
          (raw.tokensAfter !== undefined && !number(raw.tokensAfter)) ||
          (raw.method !== undefined &&
            (!text(raw.method) ||
              !['remote', 'snapcompact', 'handoff', 'shake', 'soft'].includes(raw.method))) ||
          (raw.warning !== undefined && !text(raw.warning)) ||
          (raw.historyRewriteAt !== undefined && !number(raw.historyRewriteAt))
        )
          return undefined
        const blocks = raw.blocks === undefined ? undefined : toolContent(raw.blocks)
        const images = raw.images === undefined ? undefined : toolContent(raw.images)
        if (
          (raw.blocks !== undefined && !blocks) ||
          (raw.images !== undefined && (!images || images.some((part) => part.type !== 'image')))
        )
          return undefined
        return {
          role: 'compactionSummary',
          summary: raw.summary,
          tokensBefore: raw.tokensBefore,
          timestamp: raw.timestamp,
          ...(raw.shortSummary === undefined ? {} : { shortSummary: raw.shortSummary }),
          ...(raw.tokensAfter === undefined ? {} : { tokensAfter: raw.tokensAfter }),
          ...(raw.method === undefined ? {} : { method: raw.method }),
          ...(raw.warning === undefined ? {} : { warning: raw.warning }),
          ...(raw.historyRewriteAt === undefined ? {} : { historyRewriteAt: raw.historyRewriteAt }),
          ...(blocks ? { blocks } : {}),
          ...(images ? { images } : {})
        }
      }
      if (
        (raw.role === 'user' || raw.role === 'developer') &&
        (text(raw.content) || Array.isArray(raw.content))
      ) {
        const content = text(raw.content) ? raw.content : toolContent(raw.content)
        return content === undefined
          ? undefined
          : { role: raw.role, content, timestamp: raw.timestamp }
      }
      if (
        raw.role === 'toolResult' &&
        text(raw.toolCallId) &&
        text(raw.toolName) &&
        typeof raw.isError === 'boolean'
      ) {
        if (this.privateCalls.has(raw.toolCallId)) return undefined
        const content = toolContent(raw.content)
        return (
          content && {
            role: 'toolResult',
            toolCallId: raw.toolCallId,
            toolName: raw.toolName,
            content,
            isError: raw.isError,
            timestamp: raw.timestamp,
            ...(raw.details === undefined ? {} : { details: json(raw.details) }),
            ...(number(raw.prunedAt) ? { prunedAt: raw.prunedAt } : {})
          }
        )
      }
      if (
        raw.role !== 'assistant' ||
        !text(raw.api) ||
        !text(raw.provider) ||
        !text(raw.model) ||
        !text(raw.stopReason) ||
        !stopReasons.has(raw.stopReason) ||
        !record(raw.usage) ||
        !record(raw.usage.cost)
      )
        return undefined
      const usage = raw.usage,
        cost = usage.cost
      if (!record(cost)) return undefined
      if (
        ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].some(
          (key) => !number(usage[key])
        ) ||
        ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].some((key) => !number(cost[key]))
      )
        return undefined
      const content = this.content(raw.content)
      if (!content) return undefined
      return {
        role: 'assistant',
        api: raw.api,
        provider: raw.provider,
        model: raw.model,
        content,
        stopReason: raw.stopReason as PhiAssistantMessage['stopReason'],
        timestamp: raw.timestamp,
        ...(text(raw.errorMessage) ? { errorMessage: raw.errorMessage } : {}),
        usage: {
          input: usage.input as number,
          output: usage.output as number,
          cacheRead: usage.cacheRead as number,
          cacheWrite: usage.cacheWrite as number,
          totalTokens: usage.totalTokens as number,
          ...(number(usage.reasoningTokens) ? { reasoningTokens: usage.reasoningTokens } : {}),
          cost: {
            input: cost.input as number,
            output: cost.output as number,
            cacheRead: cost.cacheRead as number,
            cacheWrite: cost.cacheWrite as number,
            total: cost.total as number
          }
        }
      }
    } catch (error) {
      if (this.privateOverflow) throw error
      return undefined
    }
  }

  messages(raw: readonly unknown[]): PhiEventMessage[] {
    const output: PhiEventMessage[] = []
    for (const value of raw) {
      const projected = this.message(value)
      if (projected) {
        output.push(projected)
        continue
      }
      const reserved =
        record(value) &&
        ((value.role === 'toolResult' &&
          text(value.toolCallId) &&
          this.privateCalls.has(value.toolCallId)) ||
          (value.role === 'assistant' &&
            Array.isArray(value.content) &&
            value.content.some(
              (part) => record(part) && part.type === 'toolCall' && privateInput(part.arguments)
            )))
      if (!reserved) throw new Error('Unsupported remote public history message shape')
    }
    if (this.privateOverflow) throw new Error('Private tool carrier budget exceeded')
    return output
  }

  private assistantEvent(raw: unknown): PhiKnownAssistantMessageEvent | undefined {
    if (!record(raw) || !text(raw.type)) return undefined
    const partial = this.message(raw.partial)
    const message = this.message(raw.message)
    const error = this.message(raw.error)
    if (
      raw.type === 'done' &&
      message?.role === 'assistant' &&
      ['stop', 'length', 'toolUse'].includes(String(raw.reason))
    )
      return {
        type: 'done',
        message: message as PhiAssistantMessage,
        reason: raw.reason as 'stop' | 'length' | 'toolUse'
      }
    if (
      raw.type === 'error' &&
      error?.role === 'assistant' &&
      (raw.reason === 'aborted' || raw.reason === 'error')
    )
      return { type: 'error', error: error as PhiAssistantMessage, reason: raw.reason }
    if (partial?.role !== 'assistant') return undefined
    const safePartial = partial as PhiAssistantMessage
    if (raw.type === 'start') return { type: 'start', partial: safePartial }
    if (!number(raw.contentIndex) || !Number.isSafeInteger(raw.contentIndex)) return undefined
    const contentIndex = raw.contentIndex
    switch (raw.type) {
      case 'text_start':
      case 'thinking_start':
      case 'toolcall_start':
        return { type: raw.type, contentIndex, partial: safePartial }
      case 'text_delta':
      case 'thinking_delta':
      case 'toolcall_delta':
        return text(raw.delta)
          ? { type: raw.type, contentIndex, delta: raw.delta, partial: safePartial }
          : undefined
      case 'text_end':
      case 'thinking_end':
        return text(raw.content)
          ? { type: raw.type, contentIndex, content: raw.content, partial: safePartial }
          : undefined
      case 'image_end': {
        const content = toolContent([raw.content])?.[0]
        return content?.type === 'image'
          ? { type: 'image_end', contentIndex, content, partial: safePartial }
          : undefined
      }
      case 'toolcall_end': {
        const toolCall = this.content([raw.toolCall])?.[0]
        return toolCall?.type === 'toolCall'
          ? { type: 'toolcall_end', contentIndex, toolCall, partial: safePartial }
          : undefined
      }
      default:
        return undefined
    }
  }

  event(frame: Readonly<RpcFrame>): PhiAgentEvent | undefined {
    if (this.privateOverflow) throw new Error('Private tool carrier budget exceeded')
    // Private dispatch happens before projection; errors remain visible to the
    // trusted driver, which retires its generation. Never send raw protocol to UI.
    if (privateTypes.has(frame.type)) {
      this.dispatchPrivate?.(frame)
      return undefined
    }
    try {
      switch (frame.type) {
        case 'auto_compaction_start':
        case 'auto_compaction_end':
        case 'auto_retry_start':
        case 'auto_retry_end':
          return projectRpcMaintenanceEvent(frame)
        case 'agent_start':
        case 'turn_start':
        case 'model_changed':
          return { type: frame.type }
        case 'thinking_level_changed': {
          const levels = new Set([
            'minimal',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
            'off',
            'inherit'
          ])
          if (frame.thinkingLevel !== undefined && !levels.has(String(frame.thinkingLevel)))
            return undefined
          return { type: 'thinking_level_changed', thinkingLevel: frame.thinkingLevel }
        }
        case 'agent_end':
          return Array.isArray(frame.messages)
            ? {
                type: 'agent_end',
                messages: this.messages(frame.messages),
                ...(typeof frame.isTerminal === 'boolean' ? { isTerminal: frame.isTerminal } : {})
              }
            : undefined
        case 'turn_end': {
          const message = this.message(frame.message)
          return message && Array.isArray(frame.toolResults)
            ? {
                type: 'turn_end',
                message,
                toolResults: this.messages(frame.toolResults).filter(
                  (value): value is PhiToolResultMessage =>
                    value.role === 'toolResult' && 'toolCallId' in value
                )
              }
            : undefined
        }
        case 'message_start':
        case 'message_end': {
          const message = this.message(frame.message)
          return message ? { type: frame.type, message } : undefined
        }
        case 'message_update': {
          const message = this.message(frame.message),
            assistantMessageEvent = this.assistantEvent(frame.assistantMessageEvent)
          return message && assistantMessageEvent
            ? { type: 'message_update', message, assistantMessageEvent }
            : undefined
        }
        case 'tool_execution_start':
        case 'tool_execution_update':
        case 'tool_execution_end': {
          if (privateInput(frame.args)) {
            this.remember(frame.toolCallId)
            this.dispatchPrivate?.(frame)
            return undefined
          }
          if (
            !text(frame.toolCallId) ||
            !text(frame.toolName) ||
            this.privateCalls.has(frame.toolCallId)
          )
            return undefined
          const result = frame.type === 'tool_execution_update' ? frame.partialResult : frame.result
          const content = record(result) ? toolContent(result.content) : undefined
          return {
            type: frame.type,
            toolCallId: frame.toolCallId,
            toolName: frame.toolName,
            ...(frame.type === 'tool_execution_start' && record(frame.args)
              ? { args: json(frame.args) }
              : {}),
            ...(content
              ? {
                  [frame.type === 'tool_execution_update' ? 'partialResult' : 'result']: {
                    content,
                    ...(record(result) && result.details !== undefined
                      ? { details: json(result.details) }
                      : {}),
                    ...(record(result) && typeof result.isError === 'boolean'
                      ? { isError: result.isError }
                      : {})
                  }
                }
              : {}),
            ...(typeof frame.isError === 'boolean' ? { isError: frame.isError } : {})
          }
        }
        default:
          return undefined
      }
    } catch (error) {
      if (this.privateOverflow) throw error
      return undefined
    }
  }
}
