import assert from 'node:assert/strict'
import test from 'node:test'
import {
  readGatewayJson,
  validateGatewayPayload
} from '../src/main/agent/engine/in-process/model-gateway-request'
import { withNativeWireProjection } from '../src/main/agent/engine/in-process/native-wire-stream'

const model = {
  provider: 'deepseek',
  id: 'deepseek-v4-flash',
  name: 'DeepSeek V4 Flash',
  api: 'openai-completions',
  baseUrl: 'http://127.0.0.1:9',
  transport: 'pi-native',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1000,
  maxTokens: 100
} as unknown as Parameters<typeof withNativeWireProjection>[1]

function toolInstance(index: number): Record<string, unknown> {
  return {
    name: `tool_${index}`,
    description: 'fixture',
    parameters: { type: 'object', properties: {} },
    label: 'local-only',
    session: { settings: Array.from({ length: 5_000 }, (_, item) => item), secret: 'local-marker' }
  }
}

// The exact serialization in OMP's pi-native-client streamPiNative().
function nativeClientBody(context: unknown): string {
  return JSON.stringify({
    modelId: `${model.provider}/${model.id}`,
    context,
    options: { model, cwd: '/remote', credentialId: 7, maxRetryDelayMs: 1 },
    stream: true
  })
}

async function captureBody(context: unknown): Promise<string> {
  let sent: string | undefined
  const capture = (async (_input: unknown, init?: RequestInit) => {
    sent = String(init?.body)
    return new Response('stop', { status: 503 })
  }) as typeof fetch
  await withNativeWireProjection(capture, model)('http://gateway/v1/pi/stream', {
    method: 'POST',
    body: nativeClientBody(context)
  })
  assert.ok(sent)
  return sent
}

const context = {
  messages: [{ role: 'user', content: 'hello', timestamp: 1 }],
  tools: Array.from({ length: 36 }, (_, index) => toolInstance(index))
}

test('a kernel tool-instance request stays within the gateway limits after projection', async () => {
  const raw = nativeClientBody(context)
  await assert.rejects(
    readGatewayJson(
      new Request('http://gateway/v1/pi/stream', { method: 'POST', body: raw }),
      new AbortController().signal
    ),
    /Invalid model request/
  )

  const projected = await captureBody(context)
  assert.equal(projected.includes('local-marker'), false)
  const parsed = await readGatewayJson(
    new Request('http://gateway/v1/pi/stream', { method: 'POST', body: projected }),
    new AbortController().signal
  )
  assert.doesNotThrow(() => validateGatewayPayload(parsed, 'deepseek/deepseek-v4-flash'))
  const tools = (parsed as { context: { tools: Array<Record<string, unknown>> } }).context.tools
  assert.equal(tools.length, 36)
  assert.deepEqual(Object.keys(tools[0]).sort(), ['description', 'name', 'parameters'])
})

test('a non-native model keeps the request fetch unchanged', () => {
  const upstream = (async () => new Response()) as typeof fetch
  assert.equal(
    withNativeWireProjection(upstream, { ...model, transport: undefined } as never),
    upstream
  )
})
