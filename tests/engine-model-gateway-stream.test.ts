import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'
import { boundedGatewayStream } from '../src/main/agent/engine/in-process/model-gateway-stream'

const encoder = new TextEncoder()
const identity = { provider: 'fixture', id: 'model', api: 'openai-completions' }
const frame = (event: unknown): Uint8Array => encoder.encode(`data: ${JSON.stringify(event)}\n\n`)
const done = encoder.encode('data: [DONE]\n\n')
function source(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
}
async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text()
}

test('fragmented multibyte native thinking/tools/history events remain unchanged', async () => {
  const message = {
    role: 'assistant',
    provider: 'fixture',
    model: 'model',
    api: 'openai-completions',
    content: [
      { type: 'thinking', thinking: '保留签名', thinkingSignature: 'opaque-signature' },
      {
        type: 'toolCall',
        id: 'call-1',
        name: 'inspect',
        arguments: { path: '普通文件.txt' },
        thoughtSignature: 'opaque-tool-signature'
      }
    ]
  }
  const events = [
    { type: 'start', partial: message },
    { type: 'thinking_end', contentIndex: 0, content: '保留签名', partial: message },
    { type: 'toolcall_end', contentIndex: 1, toolCall: message.content[1], partial: message },
    { type: 'done', reason: 'toolUse', message }
  ]
  const bytes = Buffer.concat([...events.map(frame), done])
  const chunks = Array.from(bytes, (_, index) => bytes.subarray(index, index + 1))
  let finished = 0
  const controller = new AbortController()
  const result = await text(
    boundedGatewayStream(source(chunks), controller, identity, () => {
      finished++
    })
  )
  const actual = result
    .trim()
    .split('\n\n')
    .map((part) => part.slice(6))
    .filter((part) => part !== '[DONE]')
    .map((part) => JSON.parse(part) as unknown)
  assert.deepEqual(actual, events)
  assert.equal(finished, 1)
  assert.equal(controller.signal.aborted, false)
})

test('SDK raw provider errors and fallback credits never leave native stream error envelopes', async () => {
  const secret = 'SYNTHETIC_PROVIDER_SECRET'
  const error = {
    role: 'assistant',
    content: [
      { type: 'text', text: 'legitimate partial', textSignature: 'text-signature' },
      {
        type: 'thinking',
        thinking: 'legitimate thinking',
        thinkingSignature: 'thinking-signature'
      },
      {
        type: 'toolCall',
        id: 'partial-tool',
        name: 'inspect',
        arguments: {},
        thoughtSignature: 'tool-signature'
      }
    ],
    errorMessage: `${secret} https://private.invalid/?secret=${secret}`,
    errorClassificationMessage: secret,
    headers: { authorization: secret },
    fallbackCreditHandle: { token: secret },
    providerPayload: { secret },
    errorStatus: 401
  }
  const result = await text(
    boundedGatewayStream(
      source([frame({ type: 'error', reason: 'error', error }), done]),
      new AbortController(),
      identity,
      () => undefined
    )
  )
  assert.doesNotMatch(
    result,
    /SYNTHETIC_PROVIDER_SECRET|private\.invalid|fallbackCreditHandle|headers|providerPayload/
  )
  const event = JSON.parse(result.split('\n')[0].slice(6)) as {
    type: string
    error: { errorMessage: string; errorStatus: number; provider: string }
  }
  assert.equal(event.type, 'error')
  assert.equal(event.error.errorMessage, 'Model request failed')
  assert.equal(event.error.errorStatus, 401)
  assert.equal(event.error.provider, 'fixture')
  assert.match(result, /legitimate partial|text-signature/)
  assert.match(result, /thinking-signature/)
  assert.match(result, /tool-signature/)
})

test('continuous draining bounds slow-consumer queues and cancels the upstream producer', async () => {
  let upstream!: ReadableStreamDefaultController<Uint8Array>
  let cancellations = 0
  let finished = 0
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      upstream = controller
    },
    cancel() {
      cancellations++
    }
  })
  const controller = new AbortController()
  const output = boundedGatewayStream(
    input,
    controller,
    identity,
    () => {
      finished++
    },
    { maxEventBytes: 1024, maxQueuedBytes: 400, maxQueuedEvents: 2 }
  )
  for (let index = 0; index < 8; index++)
    upstream.enqueue(frame({ type: 'text_delta', delta: 'x'.repeat(128), contentIndex: index }))
  // No client pull. An active SDK producer must still be consumed and stopped.
  await nextTurn()
  assert.equal(controller.signal.aborted, true)
  assert.equal(cancellations, 1)
  assert.equal(finished, 1)
  await assert.rejects(text(output), /Model stream stopped/)
})

test('client cancellation aborts the producer once while another stream remains usable', async () => {
  let cancellations = 0
  let finished = 0
  const controller = new AbortController()
  const output = boundedGatewayStream(
    new ReadableStream({
      cancel() {
        cancellations++
      }
    }),
    controller,
    identity,
    () => {
      finished++
    }
  )
  const reader = output.getReader()
  const pending = reader.read()
  await reader.cancel()
  assert.equal((await pending).done, true)
  assert.equal(controller.signal.aborted, true)
  assert.equal(cancellations, 1)
  assert.equal(finished, 1)
  const otherController = new AbortController()
  await text(
    boundedGatewayStream(
      source([frame({ type: 'done', reason: 'stop', message: {} }), done]),
      otherController,
      identity,
      () => undefined
    )
  )
  assert.equal(otherController.signal.aborted, false)
})

test('individual event limits reject oversized snapshots but accept coalesced bounded frames', async () => {
  const limits = { maxEventBytes: 128, maxQueuedBytes: 4096, maxQueuedEvents: 64 }
  const controller = new AbortController()
  await assert.rejects(
    text(
      boundedGatewayStream(
        source([frame({ type: 'text_delta', delta: 'x'.repeat(1024) })]),
        controller,
        identity,
        () => undefined,
        limits
      )
    ),
    /Model stream stopped/
  )
  assert.equal(controller.signal.aborted, true)
  const batch = Buffer.concat([
    ...Array.from({ length: 8 }, () => frame({ type: 'text_start' })),
    frame({ type: 'done', reason: 'stop', message: {} }),
    done
  ])
  assert.ok(batch.byteLength > limits.maxEventBytes)
  const normal = new AbortController()
  const result = await text(
    boundedGatewayStream(source([batch]), normal, identity, () => undefined, limits)
  )
  assert.match(result, /\[DONE\]/)
  assert.equal(normal.signal.aborted, false)
})

test('half-streams and malformed terminal sequencing fail instead of reporting completion', async () => {
  for (const chunks of [
    [frame({ type: 'start', partial: {} })],
    [done],
    [frame({ type: 'done', reason: 'stop', message: {} }), frame({ type: 'text_start' }), done],
    [encoder.encode('data: {"type":"text_delta"')]
  ]) {
    const controller = new AbortController()
    await assert.rejects(
      text(boundedGatewayStream(source(chunks), controller, identity, () => undefined)),
      /Model stream stopped/
    )
    assert.equal(controller.signal.aborted, true)
  }
})
