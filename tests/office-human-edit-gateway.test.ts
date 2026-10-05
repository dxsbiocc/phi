import assert from 'node:assert/strict'
import { createServer, request as requestHttp, type Server } from 'node:http'
import test from 'node:test'

import {
  startOfficePreviewGateway,
  type OfficePreviewGateway
} from '../src/main/agent/office/office-preview'

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server port')
  return address.port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function post(
  gateway: OfficePreviewGateway,
  headers: Readonly<Record<string, string>> = {}
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: 'x' })
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      {
        hostname: '127.0.0.1',
        port: gateway.port,
        path: '/api/send',
        method: 'POST',
        headers: {
          host: `127.0.0.1:${gateway.port}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          ...headers
        }
      },
      (response) => {
        let responseBody = ''
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          responseBody += chunk
        })
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 500, body: responseBody })
        )
      }
    )
    request.on('error', reject)
    request.end(body)
  })
}

async function postBody(gateway: OfficePreviewGateway, body: string): Promise<Response> {
  return fetch(`${gateway.url}api/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  })
}

test('gateway translates one valid cell text edit for its bound artifact without proxying it', async () => {
  let upstreamRequests = 0
  const edits: unknown[] = []
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-a',
    upstreamPort,
    humanEditId: () => '00000000-0000-4000-8000-000000000001',
    onHumanCellEdit: async (edit) => {
      edits.push(edit)
    }
  })
  try {
    const response = await postBody(
      gateway,
      JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: '人工值' })
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { ok: true })
    assert.deepEqual(edits, [
      {
        artifactId: 'artifact-a',
        operationId: '00000000-0000-4000-8000-000000000001',
        sheet: 'Sheet1',
        cell: 'A1',
        text: '人工值'
      }
    ])
    assert.equal(upstreamRequests, 0)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway rejects malformed or over-authorized cell edits without invoking or proxying writes', async () => {
  let upstreamRequests = 0
  let edits = 0
  let now = 0
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-a',
    upstreamPort,
    humanEditClock: () => (now += 1_001),
    onHumanCellEdit: async () => {
      edits += 1
    }
  })
  const invalidBodies = [
    'not json',
    'null',
    '[]',
    JSON.stringify({ path: '/Sheet1/A1', prop: 'text' }),
    JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: 'x', extra: true }),
    JSON.stringify({ path: '/Sheet1/A1', prop: 'formula', value: '=1+1' }),
    JSON.stringify({ path: '/Sheet1/A1', props: { x: 1, y: 2 } }),
    JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: 'x', file: '/tmp/other.xlsx' }),
    JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: 'x', command: 'save' }),
    JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: 'x', batch: [] }),
    JSON.stringify({ path: '/Sheet1/A1:B2', prop: 'text', value: 'x' }),
    JSON.stringify({ path: '../Sheet1/A1', prop: 'text', value: 'x' }),
    JSON.stringify({ path: '/tmp/other.xlsx', prop: 'text', value: 'x' }),
    JSON.stringify({ path: '/Sheet1/a1', prop: 'text', value: 'x' }),
    JSON.stringify({ path: '/Sheet1/K1', prop: 'text', value: 'x' }),
    JSON.stringify({ path: '/Sheet1/A1001', prop: 'text', value: 'x' }),
    JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: `bad\u0000value` })
  ]
  try {
    for (const body of invalidBodies) {
      const response = await postBody(gateway, body)
      assert.equal(response.status, 400, body)
      assert.deepEqual(await response.json(), { ok: false, code: 'invalid_edit' })
    }
    const wrongType = await fetch(`${gateway.url}api/send`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{}'
    })
    assert.equal(wrongType.status, 415)
    assert.equal(edits, 0)
    assert.equal(upstreamRequests, 0)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway rejects oversized cell edits without invoking or proxying writes', async () => {
  let edits = 0
  const upstream = createServer((_request, response) => response.end('unexpected'))
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-a',
    upstreamPort,
    onHumanCellEdit: async () => {
      edits += 1
    }
  })
  try {
    const response = await postBody(
      gateway,
      JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: 'x'.repeat(65 * 1024) })
    )
    assert.equal(response.status, 413)
    assert.deepEqual(await response.json(), { ok: false, code: 'payload_too_large' })
    assert.equal(edits, 0)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway rate limits cell edits to five requests per second', async () => {
  const upstream = createServer((_request, response) => response.end('unexpected'))
  const upstreamPort = await listen(upstream)
  let edits = 0
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-a',
    upstreamPort,
    humanEditClock: () => 1_000,
    onHumanCellEdit: async () => {
      edits += 1
    }
  })
  try {
    const statuses: number[] = []
    for (let index = 0; index < 6; index += 1) {
      const response = await postBody(
        gateway,
        JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: String(index) })
      )
      statuses.push(response.status)
      await response.text()
    }
    assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429])
    assert.equal(edits, 5)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway caps pending cell edits at twenty requests', async () => {
  const upstream = createServer((_request, response) => response.end('unexpected'))
  const upstreamPort = await listen(upstream)
  let now = 0
  let release!: () => void
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-a',
    upstreamPort,
    humanEditClock: () => (now += 1_001),
    onHumanCellEdit: async () => blocked
  })
  try {
    const requests = Array.from({ length: 20 }, (_, index) =>
      postBody(gateway, JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: String(index) }))
    )
    await new Promise((resolve) => setTimeout(resolve, 20))
    const rejected = await postBody(
      gateway,
      JSON.stringify({ path: '/Sheet1/A1', prop: 'text', value: 'overflow' })
    )
    assert.equal(rejected.status, 429)
    assert.deepEqual(await rejected.json(), { ok: false, code: 'too_many_edits' })
    release()
    assert.deepEqual(
      await Promise.all(requests.map(async (request) => (await request).status)),
      Array.from({ length: 20 }, () => 200)
    )
  } finally {
    release()
    await gateway.close()
    await close(upstream)
  }
})

test('cell edit POST preserves Host and Origin checks', async () => {
  const upstream = createServer((_request, response) => response.end('unexpected'))
  const upstreamPort = await listen(upstream)
  let edits = 0
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-a',
    upstreamPort,
    onHumanCellEdit: async () => {
      edits += 1
    }
  })
  try {
    assert.equal((await post(gateway, { host: 'localhost:9999' })).status, 403)
    assert.equal((await post(gateway, { origin: 'https://evil.example' })).status, 403)
    assert.equal((await post(gateway, { origin: `http://127.0.0.1:${gateway.port}` })).status, 200)
    assert.equal(edits, 1)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('read-only and frozen gateways reject every cell edit before parsing or writing', async () => {
  for (const access of ['read_only', 'frozen'] as const) {
    const upstream = createServer((_request, response) => response.end('unexpected'))
    const upstreamPort = await listen(upstream)
    let edits = 0
    const rejected: string[] = []
    const gateway = await startOfficePreviewGateway({
      artifactId: 'artifact-a',
      upstreamPort,
      humanEditAccess: () => access,
      onHumanCellEdit: async () => {
        edits += 1
      },
      onHumanEditRejected: (code) => rejected.push(code)
    })
    try {
      const response = await post(gateway)
      const code = access === 'read_only' ? 'document_read_only' : 'document_frozen'
      assert.equal(response.status, 423)
      assert.deepEqual(JSON.parse(response.body), { ok: false, code })
      assert.equal(edits, 0)
      assert.deepEqual(rejected, [code])
    } finally {
      await gateway.close()
      await close(upstream)
    }
  }
})

test('gateway maps service failures without exposing internal paths, processes, or ports', async () => {
  const upstream = createServer((_request, response) => response.end('unexpected'))
  const upstreamPort = await listen(upstream)
  const rejected: string[] = []
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-a',
    upstreamPort,
    onHumanCellEdit: async () => {
      const error = Object.assign(
        new Error('failed at /private/session/source.xlsx pid 123 port 456'),
        { code: 'write_unknown' }
      )
      throw error
    },
    onHumanEditRejected: (code) => rejected.push(code)
  })
  try {
    const response = await post(gateway)
    assert.equal(response.status, 423)
    assert.deepEqual(JSON.parse(response.body), { ok: false, code: 'document_frozen' })
    assert.doesNotMatch(response.body, /private|source\.xlsx|123|456/u)
    assert.deepEqual(rejected, [], '服务层失败摘要不应被网关通用摘要覆盖')
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway injects the edit recovery adapter and disables double click when frozen', async () => {
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end('<html><head><script id="upstream"></script></head><body></body></html>')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-a',
    upstreamPort,
    humanEditAccess: () => 'frozen',
    onHumanCellEdit: async () => undefined
  })
  try {
    const response = await fetch(gateway.url)
    const html = await response.text()
    assert.equal(response.status, 200)
    assert.ok(html.indexOf('data-phi-office-adapter') < html.indexOf('id="upstream"'))
    assert.match(html, /if\(true\)window\.addEventListener\('dblclick'/u)
    assert.match(html, /url\.pathname==='\/api\/send'/u)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})
