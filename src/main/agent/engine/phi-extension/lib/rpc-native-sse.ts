import type { AssistantMessageEvent } from '@oh-my-pi/pi-ai'

export class NativeStreamIntegrityError extends Error {
  constructor() {
    super('Phi native stream integrity could not be verified')
    this.name = 'NativeStreamIntegrityError'
  }
}
export const NATIVE_EVENT_BYTES = 64 * 1024 * 1024
export const NATIVE_CONTENT_BLOCKS = 4096
export function integrity(condition: unknown): asserts condition {
  if (!condition) throw new NativeStreamIntegrityError()
}
export function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function boundedTree(value: unknown): void {
  const stack: Array<[unknown, number]> = [[value, 0]]
  let nodes = 0
  while (stack.length) {
    const [entry, depth] = stack.pop()!
    integrity(++nodes <= 100000 && depth <= 64)
    if (Array.isArray(entry)) for (const child of entry) stack.push([child, depth + 1])
    else if (object(entry)) for (const child of Object.values(entry)) stack.push([child, depth + 1])
  }
}
export function validateNativeContent(
  value: unknown
): asserts value is Array<Record<string, unknown>> {
  integrity(Array.isArray(value) && value.length <= NATIVE_CONTENT_BLOCKS)
  for (const block of value) {
    integrity(object(block))
    switch (block.type) {
      case 'text':
        integrity(typeof block.text === 'string')
        break
      case 'thinking':
        integrity(
          typeof block.thinking === 'string' &&
            (block.thinkingSignature === undefined || typeof block.thinkingSignature === 'string')
        )
        break
      case 'redactedThinking':
        integrity(typeof block.data === 'string')
        break
      case 'toolCall':
        integrity(
          typeof block.id === 'string' && typeof block.name === 'string' && object(block.arguments)
        )
        break
      case 'image':
        integrity(
          typeof block.mimeType === 'string' &&
            (typeof block.data === 'string' ||
              typeof block.url === 'string' ||
              object(block.providerFile))
        )
        break
      case 'fallback':
        integrity(typeof block.from === 'string' && typeof block.to === 'string')
        break
      case 'anthropicServerTool':
        integrity(object(block.block))
        break
      default:
        integrity(false)
    }
  }
}
const eventTypes = new Set([
  'start',
  'text_start',
  'text_delta',
  'text_end',
  'thinking_start',
  'thinking_delta',
  'thinking_end',
  'image_end',
  'toolcall_start',
  'toolcall_delta',
  'toolcall_end',
  'done',
  'error'
])

/** Per-request SSE observer. It never owns or rewrites the bytes passed to the SDK. */
export class NativeSseCapture {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly encoder = new TextEncoder()
  private line = ''
  private data: string[] = []
  private bytes = 0
  private pendingCr = false
  private marker = false
  private closed = false
  private terminal?: AssistantMessageEvent
  private complete!: () => void
  private invalid!: (error: Error) => void
  readonly completed: Promise<void>
  readonly thinkingDeltas = new Set<number>()
  constructor(readonly maxEventBytes = NATIVE_EVENT_BYTES) {
    this.completed = new Promise<void>((resolve, reject) => {
      this.complete = resolve
      this.invalid = reject
    })
    void this.completed.catch(() => undefined)
    integrity(
      Number.isSafeInteger(maxEventBytes) &&
        maxEventBytes > 0 &&
        maxEventBytes <= NATIVE_EVENT_BYTES
    )
  }
  get rawTerminal(): AssistantMessageEvent | undefined {
    return this.terminal
  }
  feed(chunk: Uint8Array): void {
    integrity(!this.closed)
    try {
      this.text(this.decoder.decode(chunk, { stream: true }))
    } catch {
      const error = new NativeStreamIntegrityError()
      this.invalid(error)
      throw error
    }
  }
  finish(): void {
    integrity(!this.closed)
    try {
      this.text(this.decoder.decode())
      if (this.pendingCr) {
        this.pendingCr = false
        this.newline(1)
      }
      integrity(this.line === '' && this.data.length === 0 && this.terminal && this.marker)
      this.closed = true
    } catch {
      const error = new NativeStreamIntegrityError()
      this.invalid(error)
      throw error
    }
  }
  clear(): void {
    this.line = ''
    this.data = []
    this.terminal = undefined
    this.thinkingDeltas.clear()
    this.closed = true
    this.invalid(new NativeStreamIntegrityError())
  }
  private addBytes(bytes: number): void {
    this.bytes += bytes
    integrity(this.bytes <= this.maxEventBytes)
  }
  private text(value: string): void {
    if (!value) return
    if (this.pendingCr) {
      this.pendingCr = false
      const joinedLf = value.startsWith('\n')
      this.newline(joinedLf ? 2 : 1)
      if (joinedLf) value = value.slice(1)
    }
    const parts = value.split(/(\r\n|\r|\n)/u)
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]
      if (part === '\r' && index === parts.length - 2 && parts[index + 1] === '')
        this.pendingCr = true
      else if (part === '\r' || part === '\n' || part === '\r\n') this.newline(part.length)
      else {
        this.addBytes(this.encoder.encode(part).byteLength)
        this.line += part
      }
    }
  }
  private newline(bytes: number): void {
    this.addBytes(bytes)
    const line = this.line
    this.line = ''
    if (line === '') {
      if (this.data.length) this.event(this.data.join('\n'))
      this.data = []
      this.bytes = 0
    } else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /u, ''))
    // Other SSE fields and comments have no canonical event semantics.
  }
  private event(json: string): void {
    if (json === '[DONE]') {
      integrity(this.terminal && !this.marker)
      this.marker = true
      this.complete()
      return
    }
    integrity(!this.marker && !this.terminal)
    const value: unknown = JSON.parse(json)
    boundedTree(value)
    integrity(object(value) && typeof value.type === 'string' && eventTypes.has(value.type))
    if (value.type === 'thinking_delta') {
      integrity(
        Number.isSafeInteger(value.contentIndex) &&
          Number(value.contentIndex) >= 0 &&
          Number(value.contentIndex) < NATIVE_CONTENT_BLOCKS &&
          typeof value.delta === 'string'
      )
      if (value.delta) this.thinkingDeltas.add(Number(value.contentIndex))
    }
    if (value.type === 'done' || value.type === 'error') {
      const message = value.type === 'done' ? value.message : value.error
      integrity(
        object(message) &&
          message.role === 'assistant' &&
          typeof message.provider === 'string' &&
          typeof message.model === 'string' &&
          typeof message.api === 'string' &&
          message.api.length > 0 &&
          message.api.length <= 128
      )
      integrity(
        value.reason === message.stopReason &&
          (value.type === 'done'
            ? ['stop', 'length', 'toolUse'].includes(String(value.reason))
            : ['error', 'aborted'].includes(String(value.reason)))
      )
      validateNativeContent(message.content)
      this.terminal = value as unknown as AssistantMessageEvent
    }
  }
}
