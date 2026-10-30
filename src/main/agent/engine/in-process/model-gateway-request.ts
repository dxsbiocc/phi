import type { Context, SimpleStreamOptions } from '@oh-my-pi/pi-ai'

export const MAX_GATEWAY_BODY_BYTES = 64 * 1024 * 1024

export type GatewayInputRejectionReason =
  | 'body_aborted'
  | 'body_content_length_invalid'
  | 'body_invalid_json'
  | 'body_missing'
  | 'body_too_complex'
  | 'body_too_large'
  | 'context_invalid_shape'
  | 'options_invalid_shape'
  | 'options_invalid_value'
  | 'options_unknown_field'
  | 'payload_invalid_shape'
  | 'payload_unknown_field'

function safeFieldName(value: string | undefined): string | undefined {
  return value && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/u.test(value) ? value : undefined
}

export class GatewayInputError extends Error {
  readonly field: string | undefined

  constructor(
    readonly status: number = 400,
    readonly reason: GatewayInputRejectionReason = status === 413
      ? 'body_too_large'
      : 'payload_invalid_shape',
    field?: string
  ) {
    super(status === 413 ? 'Model request exceeds its input limit' : 'Invalid model request')
    this.field = safeFieldName(field)
  }
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function reject(
  reason: GatewayInputRejectionReason = 'payload_invalid_shape',
  field?: string
): never {
  throw new GatewayInputError(400, reason, field)
}
function text(value: unknown, limit = MAX_GATEWAY_BODY_BYTES): value is string {
  return typeof value === 'string' && value.length <= limit
}
function keys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  reason: Extract<
    GatewayInputRejectionReason,
    'options_unknown_field' | 'payload_unknown_field'
  > = 'options_unknown_field'
): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key))
  if (unknown) reject(reason, unknown)
}
function number(value: unknown, min: number, max: number, integer = false): boolean {
  return (
    typeof value === 'number' &&
    Number.isFinite(value) &&
    value >= min &&
    value <= max &&
    (!integer || Number.isSafeInteger(value))
  )
}

/** Names the exceeded limit and request section for diagnostics; never includes request values. */
function complexityField(limit: 'depth' | 'nodes', path: readonly string[], body: unknown): string {
  const [section, group, index] = path
  if (section !== 'context') return [limit, section ?? 'body'].join('.')
  if (group !== 'tools') return [limit, section, group ?? 'root'].join('.')
  const tools = record(body) && record(body.context) ? body.context.tools : undefined
  const tool = Array.isArray(tools) ? (tools[Number(index)] as unknown) : undefined
  const name = record(tool) && typeof tool.name === 'string' ? tool.name : index
  return [limit, section, group, name ?? 'root'].join('.').slice(0, 64)
}

/** Bound the actual read too: Content-Length is advisory and may be absent. */
export async function readGatewayJson(request: Request, signal: AbortSignal): Promise<unknown> {
  const length = request.headers.get('content-length')
  if (length && !/^\d+$/u.test(length))
    throw new GatewayInputError(400, 'body_content_length_invalid')
  if (length && Number(length) > MAX_GATEWAY_BODY_BYTES)
    throw new GatewayInputError(413, 'body_too_large')
  if (!request.body) reject('body_missing')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  const abort = (): void => {
    void reader.cancel().catch(() => undefined)
  }
  signal.addEventListener('abort', abort, { once: true })
  try {
    if (signal.aborted) reject('body_aborted')
    while (true) {
      const next = await reader.read()
      if (signal.aborted) reject('body_aborted')
      if (next.done) break
      size += next.value.byteLength
      if (size > MAX_GATEWAY_BODY_BYTES) throw new GatewayInputError(413, 'body_too_large')
      chunks.push(next.value)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const parsed: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
    let nodes = 0
    const visit = (value: unknown, depth: number, path: readonly string[]): void => {
      if (++nodes > 100_000) reject('body_too_complex', complexityField('nodes', path, parsed))
      if (depth > 64) reject('body_too_complex', complexityField('depth', path, parsed))
      const next = (key: string): readonly string[] => (path.length < 3 ? [...path, key] : path)
      if (Array.isArray(value)) {
        value.forEach((item, index) => visit(item, depth + 1, next(String(index))))
      } else if (record(value)) {
        for (const [key, item] of Object.entries(value)) {
          visit(item, depth + 1, next(key))
        }
      }
    }
    visit(parsed, 0, [])
    return parsed
  } catch (error) {
    await reader.cancel().catch(() => undefined)
    if (error instanceof GatewayInputError) throw error
    throw new GatewayInputError(400, signal.aborted ? 'body_aborted' : 'body_invalid_json')
  } finally {
    signal.removeEventListener('abort', abort)
    reader.releaseLock()
  }
}

function validateContent(value: unknown): void {
  if (!Array.isArray(value) || value.length > 4096) reject()
  for (const block of value) {
    if (!record(block) || !text(block.type, 64)) reject()
    switch (block.type) {
      case 'text':
        if (!text(block.text)) reject()
        break
      case 'thinking':
        if (
          !text(block.thinking) ||
          (block.thinkingSignature !== undefined && !text(block.thinkingSignature))
        )
          reject()
        break
      case 'redactedThinking':
        if (!text(block.data)) reject()
        break
      case 'image':
        if (
          !text(block.data, MAX_GATEWAY_BODY_BYTES) ||
          !text(block.mimeType, 128) ||
          block.url !== undefined ||
          block.providerFile !== undefined
        )
          reject()
        break
      case 'toolCall':
        if (!text(block.id, 512) || !text(block.name, 256) || !record(block.arguments)) reject()
        break
      case 'fallback':
      case 'anthropicServerTool':
        // Native in-band provider replay metadata; not a Model or transport hook.
        break
      default:
        reject()
    }
  }
}
function validateTools(value: unknown): void {
  if (!Array.isArray(value) || value.length > 256) reject()
  for (const tool of value) {
    if (
      !record(tool) ||
      !text(tool.name, 256) ||
      !text(tool.description) ||
      !record(tool.parameters)
    )
      reject()
  }
}
function validateContext(value: unknown): Context {
  if (!record(value)) reject('context_invalid_shape', 'context')
  const unknown = Object.keys(value).find(
    (key) => !['systemPrompt', 'messages', 'tools', 'inactiveTools'].includes(key)
  )
  if (unknown) reject('context_invalid_shape', unknown)
  if (!Array.isArray(value.messages) || value.messages.length > 4096)
    reject('context_invalid_shape', 'messages')
  if (
    value.systemPrompt !== undefined &&
    (!Array.isArray(value.systemPrompt) ||
      value.systemPrompt.length > 64 ||
      value.systemPrompt.some((part) => !text(part)))
  )
    reject()
  if (value.tools !== undefined) validateTools(value.tools)
  if (value.inactiveTools !== undefined) validateTools(value.inactiveTools)
  for (const message of value.messages) {
    if (
      !record(message) ||
      !['user', 'developer', 'assistant', 'toolResult'].includes(String(message.role)) ||
      !number(message.timestamp, 0, Number.MAX_SAFE_INTEGER)
    )
      reject()
    if (typeof message.content === 'string') {
      if (!['user', 'developer'].includes(String(message.role)) || !text(message.content)) reject()
    } else validateContent(message.content)
    if (
      message.role === 'toolResult' &&
      (!text(message.toolCallId, 512) ||
        !text(message.toolName, 256) ||
        typeof message.isError !== 'boolean')
    )
      reject()
    if (
      message.role === 'assistant' &&
      (!text(message.provider, 256) || !text(message.model, 256) || !text(message.api, 128))
    )
      reject()
    if (message.fallbackCreditHandle !== undefined) reject()
  }
  return value as unknown as Context
}

const numeric: Record<string, readonly [number, number, boolean?]> = {
  temperature: [0, 2],
  topP: [0, 1],
  minP: [0, 1],
  topK: [0, 1_000_000, true],
  presencePenalty: [-2, 2],
  frequencyPenalty: [-2, 2],
  repetitionPenalty: [0, 100],
  maxTokens: [1, 10_000_000, true],
  maxRetryDelayMs: [0, 86_400_000, true],
  streamFirstEventTimeoutMs: [0, 86_400_000, true],
  streamIdleTimeoutMs: [0, 86_400_000, true]
}
const booleans = new Set([
  'statefulResponses',
  'storeResponses',
  'disableReasoning',
  'forceReasoningOff',
  'hideThinkingSummary',
  'preferWebsockets',
  'acceptEmptyResponse'
])
const enums: Record<string, readonly string[]> = {
  reasoning: ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'],
  cacheRetention: ['none', 'short', 'long'],
  initiatorOverride: ['user', 'agent'],
  serviceTier: ['auto', 'default', 'flex', 'scale', 'priority', 'ultrafast'],
  kimiApiFormat: ['openai', 'anthropic'],
  syntheticApiFormat: ['openai', 'anthropic']
}
const strings = new Set([
  'cachedContent',
  'userProfileId',
  'guardrailIdentifier',
  'guardrailVersion',
  'guardrailTrace',
  'openrouterVariant',
  'sessionId',
  'promptCacheKey'
])

// Official AgentLoopConfig fields leak through buildWireOptions. The native
// server itself ignores them; never send its model/cwd/local execution state on.
const localAgentOptions = new Set([
  'model',
  'cwd',
  'interruptMode',
  'deadline',
  'sentToolDefinitions',
  'speculativeToolExecution',
  'intentTracing',
  'pruneToolDescriptions',
  'dialect',
  'abortOnFabricatedToolResult',
  'appendOnlyContext',
  'transformAssistantMessagePreservesToolCalls',
  'softToolRequirementState',
  'liveSteering',
  'waitForTerminalDrain',
  // The native client also serializes remote-local endpoint/concurrency defaults.
  // The official gateway drops these; the desktop SDK owns its own defaults.
  'antigravityEndpointMode',
  'maxInFlightRequests',
  'codexCompaction',
  // The remote credential row belongs to its broker snapshot. The desktop
  // gateway resolves its own credential and must not honor that row id.
  'credentialId'
])

function validateOptions(value: unknown, sessionKey: string): SimpleStreamOptions {
  if (value === undefined) value = {}
  if (!record(value)) reject('options_invalid_shape', 'options')
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (localAgentOptions.has(key) || key === 'headers') continue
    if (Object.hasOwn(numeric, key)) {
      const [min, max, integer] = numeric[key]
      if (!number(item, min, max, integer)) reject()
    } else if (booleans.has(key)) {
      if (typeof item !== 'boolean') reject()
    } else if (Object.hasOwn(enums, key)) {
      if (typeof item !== 'string' || !enums[key].includes(item)) reject()
    } else if (strings.has(key)) {
      if (!text(item, 1024)) reject()
    } else if (key === 'toolChoice') {
      if (typeof item === 'string') {
        if (!['auto', 'any', 'none', 'required'].includes(item)) reject()
      } else {
        if (!record(item)) reject()
        if (item.type === 'computer') {
          keys(item, ['type'])
        } else if (item.type === 'function' && record(item.function)) {
          keys(item, ['type', 'function'])
          keys(item.function, ['name'])
          if (!text(item.function.name, 256)) reject()
        } else {
          keys(item, ['type', 'name'])
          if (!['tool', 'function'].includes(String(item.type)) || !text(item.name, 256)) reject()
        }
      }
    } else if (key === 'stopSequences') {
      if (!Array.isArray(item) || item.length > 64 || item.some((part) => !text(part, 4096)))
        reject()
    } else if (key === 'thinkingBudgets') {
      if (
        !record(item) ||
        Object.entries(item).some(
          ([effort, budget]) =>
            !enums.reasoning.includes(effort) || !number(budget, 0, 10_000_000, true)
        )
      )
        reject()
    } else if (key === 'metadata') {
      if (!record(item)) reject()
    } else if (key === 'requestMetadata') {
      if (
        !record(item) ||
        Object.keys(item).length > 128 ||
        Object.values(item).some((part) => !text(part, 4096))
      )
        reject()
    } else if (key === 'loopGuard') {
      if (!record(item)) reject()
      keys(item, ['enabled', 'checkAssistantContent'])
      if (Object.values(item).some((part) => typeof part !== 'boolean')) reject()
    } else if (key === 'promptCache') {
      if (!record(item)) reject()
      keys(item, ['mode', 'ttl', 'breakpoint'])
      if (
        !['implicit', 'explicit'].includes(String(item.mode)) ||
        (item.ttl !== undefined && item.ttl !== '30m') ||
        (item.breakpoint !== undefined &&
          !['latest-stable-message', 'none'].includes(String(item.breakpoint)))
      )
        reject()
    } else if (key === 'anthropicCompaction') {
      if (!record(item)) reject()
      keys(item, ['instructions', 'filesDueBefore'])
      if (
        (item.instructions !== undefined && !text(item.instructions)) ||
        (item.filesDueBefore !== undefined &&
          !number(item.filesDueBefore, 0, Number.MAX_SAFE_INTEGER))
      )
        reject()
    } else reject('options_unknown_field', key) // Includes API keys, endpoints, fetch and provider transport hooks.
    result[key] = item
  }
  return {
    ...result,
    sessionId: sessionKey,
    promptCacheKey: sessionKey,
    preferWebsockets: false
  } as SimpleStreamOptions
}

export function validateGatewayPayload(
  value: unknown,
  sessionKey: string
): { modelId: string; context: Context; options: SimpleStreamOptions; stream: true } {
  if (!record(value)) reject('payload_invalid_shape', 'payload')
  keys(value, ['modelId', 'context', 'options', 'stream'], 'payload_unknown_field')
  if (
    !text(value.modelId, 513) ||
    !value.modelId ||
    (value.stream !== undefined && value.stream !== true)
  )
    reject()
  return {
    modelId: value.modelId,
    context: validateContext(value.context),
    options: validateOptions(value.options, sessionKey),
    stream: true
  }
}
