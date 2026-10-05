import assert from 'node:assert/strict'
import { createServer, request as requestHttp, type Server } from 'node:http'
import test from 'node:test'

import {
  clearOfficePreviewSelection,
  OFFICE_PREVIEW_CSP,
  startOfficePreviewGateway,
  type OfficePreviewGateway
} from '../src/main/agent/office/office-preview'
import {
  OFFICE_HIGHLIGHT_EVENT,
  OFFICE_HIGHLIGHT_FOLLOW_EVENT,
  OFFICE_SHEET_HIGHLIGHT_FOLLOW_EVENT
} from '../src/main/agent/office/office-preview-control'

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('missing server port')
  return address.port
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()))
}

async function requestStatus(
  port: number,
  headers: Record<string, string>
): Promise<number | undefined> {
  return new Promise((resolve, reject) => {
    const request = requestHttp(
      { host: '127.0.0.1', port, path: '/', method: 'GET', headers },
      (response) => {
        response.resume()
        response.on('end', () => resolve(response.statusCode))
      }
    )
    request.on('error', reject)
    request.end()
  })
}

async function postSelection(
  gateway: OfficePreviewGateway,
  body: string,
  contentType = 'application/json'
): Promise<Response> {
  return fetch(`${gateway.url}api/selection`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body
  })
}

interface PreviewEventStream {
  next(): Promise<{ event: string; data: unknown }>
  close(): void
}

function connectPreviewEvents(gateway: OfficePreviewGateway): Promise<PreviewEventStream> {
  return new Promise((resolve, reject) => {
    const frames: Array<{ event: string; data: unknown }> = []
    const waiters: Array<(frame: { event: string; data: unknown }) => void> = []
    let buffer = ''
    const request = requestHttp(
      {
        host: '127.0.0.1',
        port: gateway.port,
        path: '/__phi/preview-events',
        method: 'GET',
        headers: { host: `127.0.0.1:${gateway.port}` }
      },
      (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`preview event stream returned ${String(response.statusCode)}`))
          return
        }
        response.setEncoding('utf8')
        response.on('data', (chunk: string) => {
          buffer = `${buffer}${chunk}`.replaceAll('\r\n', '\n')
          let boundary = buffer.indexOf('\n\n')
          while (boundary >= 0) {
            const frame = parsePreviewEventFrame(buffer.slice(0, boundary))
            buffer = buffer.slice(boundary + 2)
            if (frame) {
              const waiter = waiters.shift()
              if (waiter) waiter(frame)
              else frames.push(frame)
            }
            boundary = buffer.indexOf('\n\n')
          }
        })
        resolve({
          next: () => {
            const frame = frames.shift()
            return frame
              ? Promise.resolve(frame)
              : new Promise((resolveFrame) => waiters.push(resolveFrame))
          },
          close: () => request.destroy()
        })
      }
    )
    request.once('error', reject)
    request.end()
  })
}

function parsePreviewEventFrame(frame: string): { event: string; data: unknown } | undefined {
  const event = frame
    .split('\n')
    .find((line) => line.startsWith('event:'))
    ?.slice('event:'.length)
    .trim()
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice('data:'.length).trimStart())
    .join('\n')
  return event && data ? { event, data: JSON.parse(data) as unknown } : undefined
}

test('gateway allows only the read-only preview routes and adds CSP', async () => {
  const seen: string[] = []
  const upstream = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`)
    response.writeHead(200, {
      'content-type': request.url === '/events' ? 'text/event-stream' : 'text/plain'
    })
    response.end(request.url === '/events' ? 'data: ready\n\n' : 'ok')
  })
  const upstreamPort = await listen(upstream)
  let gateway: OfficePreviewGateway | undefined
  try {
    gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
    for (const [method, path] of [
      ['GET', '/'],
      ['GET', '/events'],
      ['POST', '/api/selection']
    ] as const) {
      const response = await fetch(`${gateway.url.slice(0, -1)}${path}`, {
        method,
        ...(method === 'POST'
          ? { headers: { 'content-type': 'application/json' }, body: '{"paths":[]}' }
          : {})
      })
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-security-policy'), OFFICE_PREVIEW_CSP)
      await response.text()
    }
    assert.deepEqual(seen, ['GET /', 'GET /events', 'POST /api/selection'])
  } finally {
    await gateway?.close()
    await close(upstream)
  }
})

test('gateway rejects write, switch, batch, and unknown routes without reaching upstream', async () => {
  let upstreamRequests = 0
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
  try {
    for (const path of ['/api/send', '/api/switch', '/api/batch', '/other']) {
      const response = await fetch(`${gateway.url.slice(0, -1)}${path}`, {
        method: 'POST',
        body: '{}'
      })
      assert.equal(response.status, 403)
      assert.equal(response.headers.get('content-security-policy'), OFFICE_PREVIEW_CSP)
    }
    assert.equal(upstreamRequests, 0)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('XLSX gateway exposes a read-only trusted preview event stream', async () => {
  let upstreamRequests = 0
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-highlight',
    kind: 'xlsx',
    upstreamPort
  })
  let events: PreviewEventStream | undefined
  try {
    events = await connectPreviewEvents(gateway)
    gateway.publishHighlight!({ sheet: 'Sheet 1', range: 'A1:B3' }, false)
    assert.deepEqual(await events.next(), {
      event: OFFICE_HIGHLIGHT_EVENT,
      data: { sheet: 'Sheet 1', range: 'A1:B3' }
    })
    gateway.publishHighlight!({ sheet: 'Sheet 2', range: 'Z999' }, true)
    assert.deepEqual(await events.next(), {
      event: OFFICE_HIGHLIGHT_FOLLOW_EVENT,
      data: { sheet: 'Sheet 2', range: 'Z999' }
    })
    gateway.publishHighlight!({ sheet: '新表' }, true)
    assert.deepEqual(await events.next(), {
      event: OFFICE_SHEET_HIGHLIGHT_FOLLOW_EVENT,
      data: { sheet: '新表' }
    })
    assert.throws(
      () =>
        gateway.publishHighlight!(
          { sheet: 'Sheet1', range: 'A1', file: '/tmp/other.xlsx' } as never,
          true
        ),
      /高亮目标无效/u
    )
    assert.equal(upstreamRequests, 0)
  } finally {
    events?.close()
    await gateway.close()
    await close(upstream)
  }
})

test('webview POST cannot publish a highlight through the trusted preview event route', async () => {
  let upstreamRequests = 0
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-highlight',
    kind: 'xlsx',
    upstreamPort
  })
  try {
    const response = await fetch(`${gateway.url}__phi/preview-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sheet: 'Sheet1', range: 'A1:B3', follow: true })
    })
    assert.equal(response.status, 403)
    assert.equal(upstreamRequests, 0)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('DOCX and PPTX gateways do not expose XLSX preview interaction events', async () => {
  const upstream = createServer((_request, response) => response.end('unexpected'))
  const upstreamPort = await listen(upstream)
  try {
    for (const kind of ['docx', 'pptx'] as const) {
      const gateway = await startOfficePreviewGateway({
        artifactId: `artifact-${kind}`,
        kind,
        upstreamPort
      })
      try {
        const response = await fetch(`${gateway.url}__phi/preview-events`)
        assert.equal(response.status, 403)
      } finally {
        await gateway.close()
      }
    }
  } finally {
    await close(upstream)
  }
})

test('DOCX gateway rejects spreadsheet selection and send routes without reaching upstream', async () => {
  let upstreamRequests = 0
  const upstream = createServer((request, response) => {
    upstreamRequests += 1
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html><head></head><body><main>文档</main></body></html>')
      return
    }
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-docx',
    kind: 'docx',
    upstreamPort,
    onHumanCellEdit: async () => undefined
  })
  try {
    for (const path of ['/api/selection', '/api/send']) {
      const response = await fetch(`${gateway.url.slice(0, -1)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
      assert.equal(response.status, 403)
    }
    assert.equal(upstreamRequests, 0)
    const html = await (await fetch(gateway.url)).text()
    assert.match(html, /if\(true\)window\.addEventListener\('dblclick'/u)
    assert.doesNotMatch(html, /__phi\/preview-events/u)
    assert.equal(upstreamRequests, 1)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('PPTX gateway rejects spreadsheet selection and send routes without reaching upstream', async () => {
  let upstreamRequests = 0
  const upstream = createServer((request, response) => {
    upstreamRequests += 1
    if (request.url === '/') {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html><head></head><body><main>演示文稿</main></body></html>')
      return
    }
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-pptx',
    kind: 'pptx',
    upstreamPort,
    onHumanCellEdit: async () => undefined
  })
  try {
    for (const path of ['/api/selection', '/api/send']) {
      const response = await fetch(`${gateway.url.slice(0, -1)}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
      assert.equal(response.status, 403)
    }
    assert.equal(upstreamRequests, 0)
    const html = await (await fetch(gateway.url)).text()
    assert.match(html, /if\(true\)window\.addEventListener\('dblclick'/u)
    assert.doesNotMatch(html, /__phi\/preview-events/u)
    assert.equal(upstreamRequests, 1)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('XLSX gateway admits the larger HTML required by the 80,000-cell workbook limit', async () => {
  const payload = `<html><head></head><body>${'x'.repeat(2 * 1024 * 1024)}</body></html>`
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' })
    response.end(payload)
  })
  const upstreamPort = await listen(upstream)
  const xlsx = await startOfficePreviewGateway({
    artifactId: 'artifact-wide-xlsx',
    kind: 'xlsx',
    upstreamPort
  })
  const docx = await startOfficePreviewGateway({
    artifactId: 'artifact-wide-docx',
    kind: 'docx',
    upstreamPort
  })
  try {
    const xlsxResponse = await fetch(xlsx.url)
    assert.equal(xlsxResponse.status, 200)
    assert.ok((await xlsxResponse.text()).length > 2 * 1024 * 1024)

    const docxResponse = await fetch(docx.url)
    assert.equal(docxResponse.status, 502)
    assert.equal(await docxResponse.text(), 'Office preview page is too large')
  } finally {
    await xlsx.close()
    await docx.close()
    await close(upstream)
  }
})

test('gateway rejects selection payloads with file authority without reaching upstream', async () => {
  let upstreamRequests = 0
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
  try {
    for (const body of [
      JSON.stringify({ paths: ['/Sheet1/A1'], file: '/tmp/other.xlsx' }),
      JSON.stringify({ paths: ['/Sheet1/A1'], sourcePath: '../other.xlsx' }),
      JSON.stringify({ paths: ['/Sheet1/A1'], artifactId: 'artifact-b' })
    ]) {
      const response = await postSelection(gateway, body)
      assert.equal(response.status, 400)
    }
    assert.equal(upstreamRequests, 0)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway rejects oversized selection bodies without reaching upstream', async () => {
  let upstreamRequests = 0
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
  try {
    const response = await postSelection(
      gateway,
      JSON.stringify({ paths: [`/Sheet1/${'A'.repeat(8 * 1024)}`] })
    )
    assert.equal(response.status, 413)
    assert.equal(upstreamRequests, 0)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway caps a selection request at 200 paths', async () => {
  let upstreamRequests = 0
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
  try {
    const response = await postSelection(
      gateway,
      JSON.stringify({ paths: Array.from({ length: 201 }, () => '/Sheet1/A1') })
    )
    assert.equal(response.status, 400)
    assert.equal(upstreamRequests, 0)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway rejects malformed selection path items', async () => {
  let upstreamRequests = 0
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
  try {
    for (const paths of [[42], [null], [''], [`/Sheet1/${'A'.repeat(129)}`]]) {
      const response = await postSelection(gateway, JSON.stringify({ paths }))
      assert.equal(response.status, 400)
    }
    assert.equal(upstreamRequests, 0)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway rejects non-JSON and non-object selection bodies', async () => {
  let upstreamRequests = 0
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
  try {
    for (const body of ['not json', 'null', '[]', '{"paths":']) {
      const response = await postSelection(gateway, body)
      assert.equal(response.status, 400)
    }
    const wrongType = await postSelection(gateway, '{"paths":[]}', 'text/plain')
    assert.equal(wrongType.status, 415)
    assert.equal(upstreamRequests, 0)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway rejects paths outside the verified Office selection grammar', async () => {
  let upstreamRequests = 0
  const upstream = createServer((_request, response) => {
    upstreamRequests += 1
    response.end('unexpected')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
  try {
    for (const path of [
      '../Sheet1/A1',
      '/tmp/other.xlsx',
      '/Sheet1/../../etc/passwd',
      '/Sheet1/A0',
      '/Sheet1/XFE1',
      '/Sheet1/A1048577',
      '/Sheet1/A1:B2:C3',
      '/Sheet1/%2e%2e',
      '/She\u007fet/A1'
    ]) {
      const response = await postSelection(gateway, JSON.stringify({ paths: [path] }))
      assert.equal(response.status, 400, path)
    }
    assert.equal(upstreamRequests, 0)
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway forwards only verified cell, range, row, column, and clear selections', async () => {
  const bodies: string[] = []
  const upstream = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      bodies.push(body)
      response.end('ok')
    })
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
  try {
    for (const paths of [
      ['/Sheet 1/A1', '/Sheet 1/B1'],
      ['/Sheet 1/A1:B3'],
      ['/汇总/row[1]', '/汇总/row[2]'],
      ['/Sheet-2/col[A]', '/Sheet-2/col[B]'],
      []
    ]) {
      const response = await postSelection(gateway, JSON.stringify({ paths }))
      assert.equal(response.status, 200)
      await response.text()
    }
    assert.deepEqual(
      bodies.map((body) => JSON.parse(body)),
      [
        { paths: ['/Sheet 1/A1', '/Sheet 1/B1'] },
        { paths: ['/Sheet 1/A1:B3'] },
        { paths: ['/汇总/row[1]', '/汇总/row[2]'] },
        { paths: ['/Sheet-2/col[A]', '/Sheet-2/col[B]'] },
        { paths: [] }
      ]
    )
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway validates Host and Origin against its own loopback origin', async () => {
  const upstream = createServer((_request, response) => response.end('ok'))
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
  try {
    assert.equal(await requestStatus(gateway.port, { host: 'localhost:9999' }), 403)
    assert.equal(
      await requestStatus(gateway.port, {
        host: `127.0.0.1:${gateway.port}`,
        origin: 'https://evil.example'
      }),
      403
    )
    assert.equal(
      await requestStatus(gateway.port, {
        host: `127.0.0.1:${gateway.port}`,
        origin: `http://127.0.0.1:${gateway.port}`
      }),
      200
    )
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('each gateway remains bound to one artifact and cannot select another upstream', async () => {
  const upstreamA = createServer((_request, response) => response.end('artifact-a'))
  const upstreamB = createServer((_request, response) => response.end('artifact-b'))
  const [portA, portB] = await Promise.all([listen(upstreamA), listen(upstreamB)])
  const [gatewayA, gatewayB] = await Promise.all([
    startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort: portA }),
    startOfficePreviewGateway({ artifactId: 'artifact-b', upstreamPort: portB })
  ])
  try {
    assert.equal(await (await fetch(gatewayA.url)).text(), 'artifact-a')
    assert.equal(await (await fetch(gatewayB.url)).text(), 'artifact-b')
    assert.equal((await fetch(`${gatewayA.url}?artifactId=artifact-b`)).status, 403)
  } finally {
    await Promise.all([gatewayA.close(), gatewayB.close()])
    await Promise.all([close(upstreamA), close(upstreamB)])
  }
})

test('gateway returns 502 when its fixed upstream is unavailable', async () => {
  const unused = createServer()
  const upstreamPort = await listen(unused)
  await close(unused)
  const gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
  try {
    const response = await fetch(gateway.url)
    assert.equal(response.status, 502)
    assert.equal(response.headers.get('content-security-policy'), OFFICE_PREVIEW_CSP)
  } finally {
    await gateway.close()
  }
})

test('main-process clear selection sends only an empty paths payload to the fixed upstream', async () => {
  let received: { method?: string; url?: string; body?: string } = {}
  const upstream = createServer((request, response) => {
    let body = ''
    request.setEncoding('utf8')
    request.on('data', (chunk) => {
      body += chunk
    })
    request.on('end', () => {
      received = { method: request.method, url: request.url, body }
      response.writeHead(204).end()
    })
  })
  const upstreamPort = await listen(upstream)
  try {
    await clearOfficePreviewSelection(upstreamPort)
    assert.deepEqual(received, {
      method: 'POST',
      url: '/api/selection',
      body: '{"paths":[]}'
    })
  } finally {
    await close(upstream)
  }
})
