export interface GatewayStreamLimits {
  readonly maxEventBytes: number
  readonly maxQueuedBytes: number
  readonly maxQueuedEvents: number
}
export const GATEWAY_STREAM_LIMITS: GatewayStreamLimits = Object.freeze({
  maxEventBytes: 64 * 1024 * 1024,
  maxQueuedBytes: 64 * 1024 * 1024,
  maxQueuedEvents: 256
})
const encoder = new TextEncoder()
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
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function safeAssistant(value: unknown): unknown {
  if (!record(value)) return value
  const result = { ...value }
  delete result.fallbackCreditHandle
  delete result.errorClassificationMessage
  if (result.errorMessage !== undefined) result.errorMessage = 'Model request failed'
  return result
}
const contentFields: Record<string, readonly string[]> = {
  text: ['type', 'text', 'textSignature'],
  thinking: ['type', 'thinking', 'thinkingSignature', 'itemId', 'summary'],
  redactedThinking: ['type', 'data'],
  image: ['type', 'data', 'mimeType', 'detail', 'providerFile', 'url'],
  toolCall: [
    'type',
    'id',
    'name',
    'arguments',
    'thoughtSignature',
    'intent',
    'rawBlock',
    'customWireName',
    'providerMetadata'
  ],
  fallback: ['type', 'from', 'to'],
  anthropicServerTool: ['type', 'block']
}
function safeErrorContent(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value.map((block) => {
    if (
      !record(block) ||
      typeof block.type !== 'string' ||
      !Object.hasOwn(contentFields, block.type)
    )
      throw new Error('Invalid model content')
    return Object.fromEntries(
      contentFields[block.type]
        .filter((key) => Object.hasOwn(block, key))
        .map((key) => [key, block[key]])
    )
  })
}
function safeUsage(value: unknown): Record<string, unknown> {
  const source = record(value) ? value : {}
  const number = (item: unknown): number =>
    typeof item === 'number' && Number.isFinite(item) && item >= 0 ? item : 0
  const cost = record(source.cost) ? source.cost : {}
  return {
    ...Object.fromEntries(
      ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens'].map((key) => [
        key,
        number(source[key])
      ])
    ),
    cost: Object.fromEntries(
      ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].map((key) => [key, number(cost[key])])
    )
  }
}
function safeReplayMetadata(source: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  if (
    record(source.providerPayload) &&
    ['openaiResponsesHistory', 'anthropicMessage', 'anthropicCompaction', 'cursorHistory'].includes(
      String(source.providerPayload.type)
    )
  )
    result.providerPayload = source.providerPayload
  if (record(source.requestControls)) result.requestControls = source.requestControls
  for (const key of ['duration', 'ttft', 'completedAt', 'elidedOutputTokens']) {
    if (typeof source[key] === 'number' && Number.isFinite(source[key]) && Number(source[key]) >= 0)
      result[key] = source[key]
  }
  for (const key of ['disabledFeatures', 'inputTransformations'])
    if (Array.isArray(source[key])) result[key] = source[key]
  if (typeof source.serviceTier === 'string') result.serviceTier = source.serviceTier
  return result
}

function safeEvent(
  json: string,
  identity: { provider: string; id: string; api: string }
): { bytes: Uint8Array; terminal: boolean } {
  const value: unknown = JSON.parse(json)
  if (!record(value) || typeof value.type !== 'string' || !eventTypes.has(value.type))
    throw new Error('Invalid model stream')
  if (value.type === 'error') {
    const reason = value.reason === 'aborted' ? 'aborted' : 'error'
    const original = record(value.error) ? value.error : {}
    const error = {
      role: 'assistant',
      content: safeErrorContent(original.content),
      api: identity.api,
      provider: identity.provider,
      model: identity.id,
      usage: safeUsage(original.usage),
      ...safeReplayMetadata(original),
      stopReason: reason,
      errorMessage: reason === 'aborted' ? 'Model request aborted' : 'Model request failed',
      timestamp:
        typeof original.timestamp === 'number' && Number.isFinite(original.timestamp)
          ? original.timestamp
          : Date.now(),
      ...(typeof original.errorId === 'number' &&
      Number.isSafeInteger(original.errorId) &&
      original.errorId >= 0
        ? { errorId: original.errorId }
        : {}),
      ...(original.requestBodyReadTimeoutFullReplay === true
        ? { requestBodyReadTimeoutFullReplay: true }
        : {}),
      ...(typeof original.errorStatus === 'number' &&
      Number.isInteger(original.errorStatus) &&
      original.errorStatus >= 400 &&
      original.errorStatus <= 599
        ? { errorStatus: original.errorStatus }
        : {})
    }
    return {
      bytes: encoder.encode(`data: ${JSON.stringify({ type: 'error', reason, error })}\n\n`),
      terminal: true
    }
  }
  if (value.partial !== undefined) value.partial = safeAssistant(value.partial)
  if (value.message !== undefined) value.message = safeAssistant(value.message)
  return {
    bytes: encoder.encode(`data: ${JSON.stringify(value)}\n\n`),
    terminal: value.type === 'done'
  }
}

/** Drain the active SDK encoder immediately; client pull alone cannot bound it. */
export function boundedGatewayStream(
  source: ReadableStream<Uint8Array>,
  abortController: AbortController,
  identity: { provider: string; id: string; api: string },
  onFinish: () => void,
  limits: GatewayStreamLimits = GATEWAY_STREAM_LIMITS
): ReadableStream<Uint8Array> {
  const reader = source.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  const queue: Uint8Array[] = []
  let queuedBytes = 0
  let pendingText = ''
  let pendingBytes = 0
  let seenTerminal = false
  let seenDone = false
  let ended = false
  let stopped = false
  let finished = false
  let demand:
    { controller: ReadableStreamDefaultController<Uint8Array>; resolve(): void } | undefined
  let output!: ReadableStreamDefaultController<Uint8Array>
  const finish = (): void => {
    if (finished) return
    finished = true
    abortController.signal.removeEventListener('abort', onAbort)
    try {
      onFinish()
    } catch {
      /* Cleanup observers cannot corrupt the stream. */
    }
  }
  const fail = (errorOutput = true): void => {
    if (stopped) return
    stopped = true
    queue.length = 0
    queuedBytes = 0
    if (!abortController.signal.aborted) abortController.abort(new Error('Model stream stopped'))
    void reader.cancel().catch(() => undefined)
    if (errorOutput) output.error(new Error('Model stream stopped'))
    else {
      // A native HTTP consumer may already be canceling this stream. Turning
      // that lifecycle signal into controller.error creates a rejected pipe.
      try {
        output.close()
      } catch {
        /* The consumer already canceled it. */
      }
    }
    demand?.resolve()
    demand = undefined
    finish()
  }
  const onAbort = (): void => fail(false)
  const push = (bytes: Uint8Array): void => {
    if (stopped) return
    if (bytes.byteLength > limits.maxEventBytes) {
      fail()
      return
    }
    if (demand) {
      const waiting = demand
      demand = undefined
      waiting.controller.enqueue(bytes)
      waiting.resolve()
    } else {
      if (
        queuedBytes + bytes.byteLength > limits.maxQueuedBytes ||
        queue.length >= limits.maxQueuedEvents
      ) {
        fail()
        return
      }
      queue.push(bytes)
      queuedBytes += bytes.byteLength
    }
  }
  const drain = async (): Promise<void> => {
    try {
      while (!stopped) {
        const next = await reader.read()
        if (stopped) break
        if (next.done) {
          pendingText += decoder.decode()
          if (pendingText.trim() || !seenDone) throw new Error('Incomplete model stream')
          ended = true
          if (!queue.length) {
            output.close()
            demand?.resolve()
            demand = undefined
            finish()
          }
          break
        }
        // A read may coalesce multiple frames. Bound each frame rather than
        // rejecting a valid batch solely because its combined bytes are large.
        for (let offset = 0; offset < next.value.byteLength && !stopped; offset += 64 * 1024) {
          const part = next.value.subarray(offset, offset + 64 * 1024)
          pendingBytes += part.byteLength
          pendingText += decoder.decode(part, { stream: true })
          let boundary: number
          while (!stopped && (boundary = pendingText.indexOf('\n\n')) !== -1) {
            const frame = pendingText.slice(0, boundary)
            const frameBytes = encoder.encode(frame).byteLength + 2
            if (frameBytes > limits.maxEventBytes) {
              fail()
              break
            }
            pendingText = pendingText.slice(boundary + 2)
            pendingBytes -= frameBytes
            const lines = frame.split('\n').filter((line) => line.startsWith('data:'))
            if (lines.length !== 1 || seenDone) throw new Error('Invalid model stream')
            const payload = lines[0].slice(5).trimStart()
            if (payload === '[DONE]') {
              if (!seenTerminal) throw new Error('Incomplete model stream')
              seenDone = true
              push(encoder.encode('data: [DONE]\n\n'))
            } else {
              if (seenTerminal) throw new Error('Invalid model stream')
              const event = safeEvent(payload, identity)
              seenTerminal = event.terminal
              push(event.bytes)
            }
          }
          if (pendingBytes > limits.maxEventBytes) fail()
        }
      }
    } catch {
      fail()
    } finally {
      reader.releaseLock()
    }
  }
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        output = controller
        abortController.signal.addEventListener('abort', onAbort, { once: true })
        if (abortController.signal.aborted) fail()
        else void drain()
      },
      pull(controller) {
        const next = queue.shift()
        if (next) {
          queuedBytes -= next.byteLength
          controller.enqueue(next)
          if (ended && !queue.length) {
            controller.close()
            finish()
          }
          return
        }
        if (ended) {
          controller.close()
          finish()
          return
        }
        return new Promise<void>((resolve) => {
          demand = { controller, resolve }
        })
      },
      cancel() {
        fail(false)
      }
    },
    { highWaterMark: 0 }
  )
}
