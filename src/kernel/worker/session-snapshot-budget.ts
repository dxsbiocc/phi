import type { JsonValue } from '../../shared/kernel-protocol'
import { MAX_FRAME_BYTES } from '../../shared/kernel-protocol/constants'

/** Room left in a frame for the response envelope and the rest of the projected session state. */
export const SNAPSHOT_FRAME_RESERVE_BYTES = 64 * 1024
export const SNAPSHOT_MESSAGE_BUDGET_BYTES = MAX_FRAME_BYTES - SNAPSHOT_FRAME_RESERVE_BYTES
export const SNAPSHOT_TEXT_LIMIT_BYTES = 16 * 1024
export const SNAPSHOT_TEXT_PREFIX_BYTES = 8 * 1024
export const SNAPSHOT_DETAILS_LIMIT_BYTES = 4 * 1024
export const SNAPSHOT_SCALAR_LIMIT_BYTES = 4 * 1024
export const SNAPSHOT_OMITTED_MESSAGE_TEXT = '…[Phi: message omitted from this view]'

/** Fields stage 4 keeps regardless of size; other scalar fields must be small to survive. */
const PRESERVED_SCALAR_FIELDS = new Set(['role', 'toolCallId', 'toolName', 'isError', 'timestamp'])

type JsonRecord = { [key: string]: JsonValue }

type BudgetState = {
  messages: JsonValue[]
  sizes: number[]
}

function isRecord(value: JsonValue | undefined): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isScalar(value: JsonValue): boolean {
  return value === null || typeof value !== 'object'
}

export function jsonByteLength(value: unknown): number {
  const encoded = JSON.stringify(value)
  return Buffer.byteLength(encoded === undefined ? '' : encoded, 'utf8')
}

function firstUtf8Bytes(text: string, maxBytes: number): { prefix: string; bytes: number } {
  let bytes = 0
  let end = 0
  for (const character of text) {
    const size = Buffer.byteLength(character, 'utf8')
    if (bytes + size > maxBytes) break
    bytes += size
    end += character.length
  }
  return { prefix: text.slice(0, end), bytes }
}

/** Returns the shortened text, or undefined when the text already fits the limit. */
function shortenText(text: string, limitBytes: number): string | undefined {
  const originalBytes = Buffer.byteLength(text, 'utf8')
  if (originalBytes <= limitBytes) return undefined
  const { prefix, bytes } = firstUtf8Bytes(text, SNAPSHOT_TEXT_PREFIX_BYTES)
  const omitted = originalBytes - bytes
  return `${prefix}\n…[Phi: ${omitted} bytes omitted from this view; the full output stays in session history]`
}

function withoutProviderPayload(message: JsonValue): JsonValue {
  if (!isRecord(message)) return message
  const copy = { ...message }
  delete copy.providerPayload
  return copy
}

function prepare(messages: JsonValue[]): BudgetState {
  const bounded = messages.map(withoutProviderPayload)
  return { messages: bounded, sizes: bounded.map(jsonByteLength) }
}

function totalBytes(sizes: number[]): number {
  let total = 2 + Math.max(0, sizes.length - 1)
  for (const size of sizes) total += size
  return total
}

function setMessage(state: BudgetState, index: number, message: JsonValue): void {
  state.messages[index] = message
  state.sizes[index] = jsonByteLength(message)
}

/** Stage 1: shorten oversized text blocks in toolResult messages. */
function shortenToolResultText(message: JsonValue): JsonValue {
  if (!isRecord(message) || message.role !== 'toolResult' || !Array.isArray(message.content)) {
    return message
  }
  let changed = false
  const content = message.content.map((item) => {
    if (!isRecord(item) || item.type !== 'text' || typeof item.text !== 'string') return item
    const text = shortenText(item.text, SNAPSHOT_TEXT_LIMIT_BYTES)
    if (text === undefined) return item
    changed = true
    return { ...item, text }
  })
  return changed ? { ...message, content } : message
}

/** Stage 2: remove oversized toolResult detail objects. */
function dropOversizedDetails(message: JsonValue): JsonValue {
  if (!isRecord(message) || message.role !== 'toolResult' || !Object.hasOwn(message, 'details')) {
    return message
  }
  if (jsonByteLength(message.details) <= SNAPSHOT_DETAILS_LIMIT_BYTES) return message
  const copy = { ...message }
  delete copy.details
  return copy
}

function shortenContentItem(item: JsonValue): JsonValue {
  if (!isRecord(item)) return item
  let next = item
  for (const field of ['text', 'thinking'] as const) {
    const value = next[field]
    if (typeof value !== 'string') continue
    const shortened = shortenText(value, SNAPSHOT_TEXT_LIMIT_BYTES)
    if (shortened === undefined) continue
    next = { ...next, [field]: shortened }
  }
  return next
}

/** Stage 3: shorten long text/thinking blocks on assistant, user and custom messages. */
function shortenOtherContent(message: JsonValue): JsonValue {
  if (!isRecord(message) || message.role === 'toolResult' || !Array.isArray(message.content)) {
    return message
  }
  let changed = false
  const content = message.content.map((item) => {
    const next = shortenContentItem(item)
    if (next !== item) changed = true
    return next
  })
  return changed ? { ...message, content } : message
}

/** Stage 4: replace the whole content of one message, keeping small identity fields. */
function omitMessage(message: JsonValue): JsonValue {
  if (!isRecord(message)) return message
  const copy: JsonRecord = {
    content: [{ type: 'text', text: SNAPSHOT_OMITTED_MESSAGE_TEXT }]
  }
  for (const [key, value] of Object.entries(message)) {
    if (key === 'content' || key === 'details') continue
    if (!isScalar(value)) continue
    if (!PRESERVED_SCALAR_FIELDS.has(key) && jsonByteLength(value) > SNAPSHOT_SCALAR_LIMIT_BYTES) {
      continue
    }
    copy[key] = value
  }
  return copy
}

function applyStage(
  state: BudgetState,
  budgetBytes: number,
  transform: (message: JsonValue) => JsonValue
): void {
  for (let index = 0; index < state.messages.length; index += 1) {
    if (totalBytes(state.sizes) <= budgetBytes) return
    const next = transform(state.messages[index])
    if (next !== state.messages[index]) setMessage(state, index, next)
  }
}

/** Stage 4 never touches the last message until every older one has been omitted. */
function applyOmissionStage(state: BudgetState, budgetBytes: number): void {
  const lastIndex = state.messages.length - 1
  for (let index = 0; index < lastIndex; index += 1) {
    if (totalBytes(state.sizes) <= budgetBytes) return
    const next = omitMessage(state.messages[index])
    if (next !== state.messages[index]) setMessage(state, index, next)
  }
  if (lastIndex >= 0 && totalBytes(state.sizes) > budgetBytes) {
    const next = omitMessage(state.messages[lastIndex])
    if (next !== state.messages[lastIndex]) setMessage(state, lastIndex, next)
  }
}

/**
 * Returns a wire-safe copy of a session message list bounded to `budgetBytes` of UTF-8 JSON.
 * The input is never mutated and no message is ever removed.
 */
export function boundSnapshotMessages(messages: JsonValue[], budgetBytes: number): JsonValue[] {
  const state = prepare(messages)
  if (totalBytes(state.sizes) <= budgetBytes) return state.messages

  applyStage(state, budgetBytes, shortenToolResultText)
  applyStage(state, budgetBytes, dropOversizedDetails)
  applyStage(state, budgetBytes, shortenOtherContent)
  applyOmissionStage(state, budgetBytes)
  return state.messages
}
