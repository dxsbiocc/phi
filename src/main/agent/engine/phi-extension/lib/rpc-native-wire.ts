import type { SimpleStreamOptions, Tool } from '@oh-my-pi/pi-ai'
import { integrity, NATIVE_EVENT_BYTES, object } from './rpc-native-sse'

// Pinned18.10.3 Tool contract, not AgentTool / wrapped execution state.
const toolFields = {
  name: true,
  description: true,
  parameters: true,
  strict: true,
  deferLoading: true,
  customFormat: true,
  customWireName: true,
  native: true,
  examples: true
} satisfies Record<keyof Tool, true>
export const NATIVE_TOOL_WIRE_KEYS = Object.freeze(Object.keys(toolFields))

// pi-native-server.ts ALLOWED_OPTION_KEYS. Incoming headers are deliberately
// ignored by Phi's existing gateway authority policy; never serialize secrets
// from that local bag just to have the desktop immediately discard them.
export const NATIVE_OPTION_WIRE_KEYS = Object.freeze([
  'temperature',
  'topP',
  'topK',
  'minP',
  'presencePenalty',
  'frequencyPenalty',
  'repetitionPenalty',
  'stopSequences',
  'maxTokens',
  'cacheRetention',
  'cachedContent',
  'userProfileId',
  'initiatorOverride',
  'maxRetryDelayMs',
  'metadata',
  'sessionId',
  'promptCacheKey',
  'promptCache',
  'statefulResponses',
  'storeResponses',
  'streamFirstEventTimeoutMs',
  'streamIdleTimeoutMs',
  'reasoning',
  'disableReasoning',
  'forceReasoningOff',
  'hideThinkingSummary',
  'thinkingBudgets',
  'toolChoice',
  'serviceTier',
  'guardrailIdentifier',
  'guardrailVersion',
  'guardrailTrace',
  'requestMetadata',
  'kimiApiFormat',
  'syntheticApiFormat',
  'preferWebsockets',
  'openrouterVariant',
  'loopGuard',
  'acceptEmptyResponse',
  'anthropicCompaction'
] as const satisfies readonly (keyof SimpleStreamOptions)[])

function pick(record: Record<string, unknown>, fields: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(
    fields.filter((key) => Object.hasOwn(record, key)).map((key) => [key, record[key]])
  )
}
function tools(value: unknown): unknown[] {
  integrity(Array.isArray(value))
  return value.map((tool) => {
    integrity(
      object(tool) &&
        typeof tool.name === 'string' &&
        typeof tool.description === 'string' &&
        object(tool.parameters)
    )
    const result = pick(tool, NATIVE_TOOL_WIRE_KEYS)
    if (Object.hasOwn(tool, 'customFormat')) {
      integrity(
        object(tool.customFormat) &&
          ['lark', 'regex'].includes(String(tool.customFormat.syntax)) &&
          typeof tool.customFormat.definition === 'string'
      )
      result.customFormat = pick(tool.customFormat, ['syntax', 'definition'])
    }
    if (Object.hasOwn(tool, 'native')) {
      integrity(object(tool.native) && tool.native.type === 'computer')
      result.native = { type: tool.native.type }
    }
    if (Object.hasOwn(tool, 'examples')) {
      integrity(Array.isArray(tool.examples))
      result.examples = tool.examples.map((example) => {
        integrity(object(example))
        return pick(example, ['caption', 'call', 'bad', 'good', 'note'])
      })
    }
    return result
  })
}

/** Project only the already serialized native request, never the SDK's live objects. */
export function projectNativeWireBody(body: unknown, modelId: string): string {
  integrity(typeof body === 'string' && Buffer.byteLength(body) <= NATIVE_EVENT_BYTES)
  let value: unknown
  try {
    value = JSON.parse(body)
  } catch {
    integrity(false)
  }
  integrity(
    object(value) &&
      value.modelId === modelId &&
      value.stream === true &&
      object(value.context) &&
      Array.isArray(value.context.messages)
  )
  const context = pick(value.context, ['systemPrompt', 'messages'])
  for (const key of ['tools', 'inactiveTools'])
    if (Object.hasOwn(value.context, key)) context[key] = tools(value.context[key])
  integrity(value.options === undefined || object(value.options))
  const options = pick(value.options ?? {}, NATIVE_OPTION_WIRE_KEYS)
  const projected = JSON.stringify({ modelId, context, options, stream: true })
  integrity(Buffer.byteLength(projected) <= NATIVE_EVENT_BYTES)
  return projected
}
