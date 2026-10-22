import { createHash } from 'node:crypto'
import { isBrowserTextPlaceholder, type BrowserTextVault } from '../../browser/browser-text-vault'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

interface BrowserReplayScope {
  browser: boolean
  id: string
}
type BrowserReplayInput = (input: unknown, id: string, depth: number) => unknown

/** Native providers encode browser calls as objects or JSON strings, including Cursor records. */
function browserReplay(
  value: unknown,
  input: BrowserReplayInput,
  scope: BrowserReplayScope = { browser: false, id: '' },
  depth = 0
): unknown {
  if (depth > 64) throw new Error('Browser replay metadata is too deep')
  if (typeof value === 'string') {
    let decoded: unknown
    try {
      decoded = JSON.parse(value)
    } catch {
      return value
    }
    const projected = browserReplay(decoded, input, scope, depth + 1)
    return JSON.stringify(projected) === JSON.stringify(decoded) ? value : JSON.stringify(projected)
  }
  if (Array.isArray(value)) return value.map((item) => browserReplay(item, input, scope, depth + 1))
  if (!record(value)) return value
  const browser =
    scope.browser ||
    [value.name, value.toolName, record(value.function) ? value.function.name : undefined].includes(
      'browser'
    )
  const id = browser ? String(value.id ?? value.call_id ?? value.toolCallId ?? scope.id) : ''
  const next = { browser, id }
  if (browser && Object.hasOwn(value, 'text')) return input(value, id, depth)
  const result = { ...value }
  for (const [key, item] of Object.entries(result))
    result[key] =
      browser &&
      (['arguments', 'input', 'args', 'partial_json'].includes(key) ||
        (['rawBlock', 'providerMetadata'].includes(key) && typeof item === 'string'))
        ? typeof item === 'string'
          ? JSON.stringify(input(item, id, depth + 1))
          : input(item, id, depth + 1)
        : browserReplay(item, input, next, depth + 1)
  return result
}

/** The provider's raw browser arguments stay desktop-private until a complete call is available. */
export function browserToolStreamProjector(vault: BrowserTextVault, signal: AbortSignal) {
  const completed = new Map<string, Record<string, unknown>>()
  const fingerprints = new Map<string, string>()
  const browserIndexes = new Set<number>()
  const sanitize = (block: Record<string, unknown>, complete: boolean): Record<string, unknown> => {
    const id = typeof block.id === 'string' ? block.id : ''
    let args = completed.get(id)
    const fingerprint = complete
      ? createHash('sha256')
          .update(JSON.stringify(block.arguments) ?? '')
          .digest('hex')
      : undefined
    if (args && complete && fingerprints.get(id) !== fingerprint) {
      vault.markDenied(id)
      args = { action: 'invalid' }
      completed.set(id, args)
    }
    if (!args && complete) {
      if (completed.size >= 128) throw new Error('Browser stream call budget exceeded')
      if (vault.approvalInput(id, block.arguments).action === 'typeText') {
        vault.markDenied(id)
        args = { action: 'invalid' }
      } else args = vault.sanitize(id, block.arguments)
      completed.set(id, args)
      fingerprints.set(id, fingerprint!)
      vault.watchAbort(id, signal)
    }
    // Browser owned syntax/computer metadata may duplicate private bytes and is not executed here.
    return {
      type: 'toolCall',
      id,
      name: 'browser',
      arguments: args ?? {},
      ...(typeof block.thoughtSignature === 'string'
        ? { thoughtSignature: replay(block.thoughtSignature, { browser: true, id }) }
        : {})
    }
  }
  const replay = (value: unknown, scope?: BrowserReplayScope): unknown =>
    browserReplay(value, (_input, id) => completed.get(id) ?? { action: 'invalid' }, scope)
  return (event: Record<string, unknown>): Record<string, unknown> | undefined => {
    signal.throwIfAborted()
    const complete = event.type === 'toolcall_end' || event.type === 'done'
    const result = { ...event }
    for (const key of ['partial', 'message', 'error']) {
      const message = event[key]
      if (!record(message) || !Array.isArray(message.content)) continue
      const browser = message.content.some(
        (block) => record(block) && block.type === 'toolCall' && block.name === 'browser'
      )
      if (!browser) {
        if (Object.hasOwn(message, 'providerPayload'))
          result[key] = { ...message, providerPayload: replay(message.providerPayload) }
        continue
      }
      const content = message.content.map((block, index) => {
        if (!record(block) || block.type !== 'toolCall' || block.name !== 'browser') return block
        browserIndexes.add(index)
        return sanitize(block, complete && (event.type === 'done' || event.contentIndex === index))
      })
      result[key] = { ...message, content }
      if (Object.hasOwn(message, 'providerPayload'))
        (result[key] as Record<string, unknown>).providerPayload = replay(message.providerPayload)
    }
    if (record(event.toolCall) && event.toolCall.name === 'browser') {
      result.toolCall = sanitize(event.toolCall, complete)
      if (typeof event.contentIndex === 'number') browserIndexes.add(event.contentIndex)
    }
    if (event.type === 'toolcall_delta') {
      const partial = record(event.partial) ? event.partial : undefined
      const block = Array.isArray(partial?.content)
        ? partial.content[Number(event.contentIndex)]
        : undefined
      // An unidentified partial call cannot prove that its delta is non-private.
      if (
        !record(block) ||
        typeof block.name !== 'string' ||
        !block.name ||
        block.name === 'browser'
      )
        return undefined
    }
    if (typeof event.contentIndex === 'number' && browserIndexes.has(event.contentIndex)) {
      if (event.type === 'toolcall_delta') return undefined
      if (Object.hasOwn(result, 'delta')) delete result.delta
    }
    return result
  }
}

/** Restore may retain opaque args, but never grants fresh authority to historical plaintext. */
export function assertSafeBrowserHistory(messages: unknown): void {
  const args: BrowserReplayInput = (value, id, depth): unknown => {
    if (depth > 64) throw new Error('Browser replay metadata is too deep')
    let decoded = value
    if (typeof decoded === 'string') {
      try {
        decoded = JSON.parse(decoded)
      } catch {
        throw new Error('Historical browser input is invalid')
      }
    }
    if (decoded !== undefined && !record(decoded))
      throw new Error('Historical browser input is invalid')
    if (
      record(decoded) &&
      Object.hasOwn(decoded, 'text') &&
      !isBrowserTextPlaceholder(decoded.text)
    )
      throw new Error('Historical browser input is not private')
    if (record(decoded))
      for (const [key, item] of Object.entries(decoded))
        if (key !== 'text') browserReplay(item, args, { browser: true, id }, depth + 1)
    return decoded
  }
  if (!Array.isArray(messages)) return
  for (const message of messages) {
    if (!record(message) || message.role !== 'assistant') continue
    if (Array.isArray(message.content))
      for (const block of message.content)
        if (record(block) && block.type === 'toolCall' && block.name === 'browser') {
          if (typeof block.rawBlock === 'string') {
            let parsed: unknown
            try {
              parsed = JSON.parse(block.rawBlock)
            } catch {
              throw new Error('Historical browser replay is unavailable')
            }
            if (!record(parsed) && !Array.isArray(parsed))
              throw new Error('Historical browser replay is unavailable')
          }
          browserReplay(block, args, { browser: true, id: String(block.id ?? '') })
        }
    if (Object.hasOwn(message, 'providerPayload')) browserReplay(message.providerPayload, args)
  }
}

export function assertBrowserHistoryPrivate(payload: unknown): void {
  if (record(payload) && record(payload.context)) assertSafeBrowserHistory(payload.context.messages)
}

/**
 * The browser text vault protects pi-native model requests. Cursor's native H2
 * transport has no equivalent text projection, so a generation that can select
 * Cursor does not receive the browser tool.
 */
export function cursorSafeHostTools<T extends { readonly name: string }>(options: {
  readonly tools: readonly T[]
  readonly transport: { readonly models: readonly { readonly provider: string }[] }
}): readonly T[] {
  return options.transport.models.some((model) => model.provider === 'cursor')
    ? options.tools.filter((tool) => tool.name !== 'browser')
    : options.tools
}
