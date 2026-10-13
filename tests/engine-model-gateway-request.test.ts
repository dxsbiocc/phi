import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readGatewayJson,
  validateGatewayPayload,
  GatewayInputError
} from '../src/main/agent/engine/in-process/model-gateway-request'

function payload(options: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    modelId: 'fixture/model',
    context: { messages: [{ role: 'user', content: 'hello', timestamp: 1 }] },
    options,
    stream: true
  }
}

test('indexed Unicode assistant history above 1 MiB survives the native hop without truncation', async () => {
  const content = Array.from(
    { length: 40000 },
    (_, index) => `${index.toString(16).padStart(8, '0')}:原样保存 history-${index * 7919} 正文\n`
  ).join('')
  assert.ok(content.length > 1024 * 1024)
  const message = {
    role: 'assistant',
    api: 'openai-completions',
    provider: 'fixture',
    model: 'model',
    content: [{ type: 'text', text: content }],
    timestamp: 2,
    stopReason: 'stop',
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
    }
  }
  const body = {
    ...payload(),
    context: { messages: [message, { role: 'user', content: 'continue', timestamp: 3 }] }
  }
  const read = await readGatewayJson(
    new Request('http://127.0.0.1/v1/pi/stream', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    }),
    new AbortController().signal
  )
  const actual = validateGatewayPayload(read, 'lease-session')
  assert.deepEqual(actual.context, body.context)
  assert.equal(actual.options.sessionId, 'lease-session')
})

test('native session/cache identities are replaced, headers and model routing overrides refused', () => {
  const normalized = validateGatewayPayload(
    payload({
      sessionId: 'another-session',
      promptCacheKey: 'other-cache',
      reasoning: 'high',
      thinkingBudgets: { high: 4096 },
      toolChoice: { type: 'tool', name: 'read' }
    }),
    'owned-lease'
  )
  assert.equal(normalized.options.sessionId, 'owned-lease')
  assert.equal(normalized.options.promptCacheKey, 'owned-lease')
  assert.equal(normalized.options.preferWebsockets, false)
  for (const options of [
    { apiKey: 'not-a-desktop-key' },
    { fetch: 'arbitrary transport' },
    { baseUrl: 'http://alternate.invalid' },
    { provider: 'other' }
  ])
    assert.throws(() => validateGatewayPayload(payload(options), 'owned-lease'), GatewayInputError)
  const stripped = validateGatewayPayload(
    payload({
      headers: { Authorization: 'arbitrary' },
      model: { baseUrl: 'http://alternate.invalid' },
      cwd: '/remote-only',
      interruptMode: 'immediate',
      sentToolDefinitions: {},
      appendOnlyContext: {}
    }),
    'owned-lease'
  )
  for (const key of [
    'headers',
    'model',
    'cwd',
    'interruptMode',
    'sentToolDefinitions',
    'appendOnlyContext'
  ])
    assert.equal(Object.hasOwn(stripped.options, key), false)
  for (const extra of [
    { model: { provider: 'other', id: 'model' } },
    { url: 'http://alternate.invalid' }
  ])
    assert.throws(
      () => validateGatewayPayload({ ...payload(), ...extra }, 'owned-lease'),
      GatewayInputError
    )
})

test('invalid option semantics and unknown roles fail before provider dispatch', () => {
  for (const options of [
    { temperature: NaN },
    { temperature: -1 },
    { maxTokens: 0 },
    { topP: 2 },
    { streamIdleTimeoutMs: '20' },
    { reasoning: {} },
    { stopSequences: 'stop' }
  ])
    assert.throws(() => validateGatewayPayload(payload(options), 'owned-lease'), GatewayInputError)
  assert.throws(
    () =>
      validateGatewayPayload(
        {
          ...payload(),
          context: { messages: [{ role: 'system', content: 'invalid', timestamp: 0 }] }
        },
        'owned-lease'
      ),
    GatewayInputError
  )
})

test('native tool-choice variants and signed thinking/tool history retain their canonical shapes', () => {
  for (const toolChoice of [
    'auto',
    'none',
    'any',
    'required',
    { type: 'tool', name: 'read' },
    { type: 'function', name: 'read' },
    { type: 'function', function: { name: 'read' } },
    { type: 'computer' }
  ])
    assert.deepEqual(
      validateGatewayPayload(payload({ toolChoice }), 'owned-lease').options.toolChoice,
      toolChoice
    )
  const content = [
    { type: 'thinking', thinking: 'reasoning', thinkingSignature: 'opaque-thought-signature' },
    {
      type: 'toolCall',
      id: 'call-1',
      name: 'inspect',
      arguments: { constructor: 'ordinary tool data' },
      thoughtSignature: 'opaque-tool-signature'
    }
  ]
  const body = {
    ...payload(),
    context: {
      tools: [
        {
          name: 'inspect',
          description: 'Inspect data',
          parameters: { type: 'object', properties: { constructor: { type: 'string' } } }
        }
      ],
      messages: [
        {
          role: 'assistant',
          api: 'openai-completions',
          provider: 'fixture',
          model: 'model',
          timestamp: 1,
          content
        },
        {
          role: 'toolResult',
          toolName: 'inspect',
          toolCallId: 'call-1',
          timestamp: 2,
          isError: false,
          content: [{ type: 'text', text: 'original tool result' }]
        }
      ]
    }
  }
  assert.deepEqual(validateGatewayPayload(body, 'owned-lease').context, body.context)
})

test('large image wire data is preserved and advertised oversize input is rejected before reading', async () => {
  const data = Buffer.alloc(1024 * 1024 + 1, 42).toString('base64')
  const body = {
    ...payload(),
    context: {
      messages: [
        { role: 'user', timestamp: 1, content: [{ type: 'image', data, mimeType: 'image/png' }] }
      ]
    }
  }
  const request = new Request('http://127.0.0.1/v1/pi/stream', {
    method: 'POST',
    body: JSON.stringify(body)
  })
  assert.deepEqual(
    validateGatewayPayload(
      await readGatewayJson(request, new AbortController().signal),
      'owned-lease'
    ).context,
    body.context
  )
  let reads = 0
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++
        controller.enqueue(new Uint8Array([123]))
      }
    },
    { highWaterMark: 0 }
  )
  const oversized = new Request('http://127.0.0.1/v1/pi/stream', {
    method: 'POST',
    headers: { 'content-length': String(64 * 1024 * 1024 + 1) },
    body: stream,
    duplex: 'half'
  } as RequestInit & { duplex: 'half' })
  await assert.rejects(
    readGatewayJson(oversized, new AbortController().signal),
    (error: unknown) => error instanceof GatewayInputError && error.status === 413
  )
  assert.equal(reads, 0)
  await oversized.body?.cancel()
})

test('actual body bytes are bounded without a Content-Length header', async () => {
  let reads = 0
  let canceled = 0
  const bytes = new Uint8Array(1024 * 1024).fill(32)
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        reads++
        controller.enqueue(bytes)
      },
      cancel() {
        canceled++
      }
    },
    { highWaterMark: 0 }
  )
  const request = new Request('http://127.0.0.1/v1/pi/stream', {
    method: 'POST',
    body,
    ...{ duplex: 'half' }
  })
  assert.equal(request.headers.has('content-length'), false)
  await assert.rejects(
    readGatewayJson(request, new AbortController().signal),
    (error: unknown) => error instanceof GatewayInputError && error.status === 413
  )
  assert.equal(reads, 65)
  assert.equal(canceled, 1)
})
