import assert from 'node:assert/strict'
import http2 from 'node:http2'
import test from 'node:test'

import { createScopedCursorH2Gateway } from '../src/main/agent/engine/in-process/scoped-cursor-h2-gateway'

const RUN_PATH = '/agent.v1.AgentService/Run'

function field(tag: number, payload: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag, payload.length]), payload])
}

function frame(modelId: string, requestedModelId = modelId, extraDetailId?: string): Buffer {
  const detailFields = [field(0x0a, Buffer.from(modelId))]
  if (extraDetailId) detailFields.push(field(0x0a, Buffer.from(extraDetailId)))
  const details = field(0x1a, Buffer.concat(detailFields))
  const requested = field(0x4a, field(0x0a, Buffer.from(requestedModelId)))
  const bytes = field(0x0a, Buffer.concat([details, requested]))
  const result = Buffer.alloc(5 + bytes.length)
  result.writeUInt32BE(bytes.length, 1)
  result.set(bytes, 5)
  return result
}

function request(
  client: http2.ClientHttp2Session,
  body: Buffer,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const stream = client.request({
      ':method': 'POST',
      ':path': RUN_PATH,
      authorization: 'Bearer generation-token',
      'content-type': 'application/connect+proto',
      'connect-protocol-version': '1',
      ...headers
    })
    let status = 0
    let result = ''
    stream.on('response', (response) => {
      status = Number(response[':status'])
    })
    stream.on('data', (chunk) => {
      result += chunk.toString()
    })
    stream.on('end', () => resolve({ status, body: result }))
    stream.on('error', reject)
    stream.end(body)
  })
}

test('scoped gateway validates model, replaces bearer, and strips untrusted headers', async () => {
  const upstream = http2.createServer()
  const seen: Array<{ headers: http2.IncomingHttpHeaders; body: Buffer }> = []
  upstream.on('stream', (stream, headers) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    stream.on('end', () => {
      seen.push({ headers, body: Buffer.concat(chunks) })
      stream.respond({ ':status': 200, 'content-type': 'application/connect+proto' })
      stream.end('ok')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  let resolves = 0
  const gateway = await createScopedCursorH2Gateway({
    token: 'generation-token',
    allowedModelIds: ['leased-model'],
    resolveBearer: async (id) => {
      resolves++
      assert.equal(id, 'leased-model')
      return 'real-secret'
    },
    upstreamOrigin: `http://127.0.0.1:${address.port}`
  })
  const client = http2.connect(`http://127.0.0.1:${gateway.port}`)
  try {
    assert.deepEqual(await request(client, frame('leased-model'), { 'x-injected': 'bad' }), {
      status: 200,
      body: 'ok'
    })
    assert.equal(resolves, 1)
    assert.equal(seen.length, 1)
    assert.equal(seen[0].headers.authorization, 'Bearer real-secret')
    assert.equal(seen[0].headers['x-injected'], undefined)
    assert.deepEqual(seen[0].body, frame('leased-model'))
    assert.equal((await request(client, frame('wrong-model'))).status, 403)
    assert.equal((await request(client, frame('leased-model', 'other-route'))).status, 403)
    assert.equal(
      (await request(client, frame('leased-model'), { authorization: 'Bearer wrong' })).status,
      403
    )
    assert.equal((await request(client, frame('leased-model'), { ':path': '/other' })).status, 403)
    assert.equal(
      (await request(client, Buffer.concat([frame('leased-model'), frame('wrong-model')]))).status,
      403
    )
    assert.equal(resolves, 2)
    assert.equal(seen.length, 1)
  } finally {
    client.destroy()
    await gateway.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})

test('scoped gateway rejects malformed and oversized frames before credential lookup', async () => {
  let resolves = 0
  const gateway = await createScopedCursorH2Gateway({
    token: 'generation-token',
    allowedModelIds: ['leased-model'],
    resolveBearer: async () => {
      resolves++
      return 'real-secret'
    }
  })
  const client = http2.connect(`http://127.0.0.1:${gateway.port}`)
  try {
    assert.equal((await request(client, Buffer.from([0, 0, 0, 0, 8, 1]))).status, 403)
    const oversized = Buffer.alloc(5)
    oversized.writeUInt32BE(16 * 1024 * 1024 + 1, 1)
    assert.equal((await request(client, oversized)).status, 403)
    assert.equal(
      (await request(client, frame('leased-model', 'leased-model', 'wrong-model'))).status,
      403
    )
    assert.equal(resolves, 0)
  } finally {
    client.destroy()
    await gateway.close()
  }
})

test('abort retires the gateway and its listener', async () => {
  const abort = new AbortController()
  const gateway = await createScopedCursorH2Gateway({
    token: 'generation-token',
    allowedModelIds: ['leased-model'],
    resolveBearer: async () => 'real-secret',
    signal: abort.signal
  })
  abort.abort()
  await gateway.close()
  await assert.rejects(async () => {
    const client = http2.connect(`http://127.0.0.1:${gateway.port}`)
    await new Promise<void>((resolve, reject) => {
      client.once('error', reject)
      client.once('connect', resolve)
    })
    client.destroy()
  })
})
