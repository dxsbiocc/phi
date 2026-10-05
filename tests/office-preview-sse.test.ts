import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'

import { startOfficePreviewGateway } from '../src/main/agent/office/office-preview'

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

test('gateway parses upstream selection-update SSE while preserving the event stream', async () => {
  const selections: unknown[] = []
  const paths = ['/Sheet1/A1', '/Sheet1/B1', '/Sheet1/A2', '/Sheet1/B2', '/Sheet1/A3', '/Sheet1/B3']
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/events')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('event: update\ndata: {"action":"selection-')
    response.end(`update","paths":${JSON.stringify(paths)}}\n\n`)
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-a',
    upstreamPort,
    onSelection: (selection) => selections.push(selection)
  })
  try {
    const response = await fetch(`${gateway.url}events`)
    assert.match(await response.text(), /selection-update/)
    assert.deepEqual(selections, [{ sheet: 'Sheet1', range: 'A1:B3', paths }])
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway taps excel-patch cell paths while preserving the event stream', async () => {
  const patches: unknown[] = []
  const upstream = createServer((request, response) => {
    assert.equal(request.url, '/events')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `event: update\ndata: ${JSON.stringify({
        action: 'excel-patch',
        version: 2,
        baseVersion: 1,
        patches: [
          {
            op: 'replace',
            row: '0-2',
            html: '<tr><td data-path="/Sheet1/A1">实验编号</td></tr>'
          }
        ]
      })}\n\n`
    )
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-a',
    upstreamPort,
    onCellPatch: (patch) => patches.push(patch)
  })
  try {
    const response = await fetch(`${gateway.url}events`)
    assert.match(await response.text(), /excel-patch/)
    assert.deepEqual(patches, [{ sheet: 'Sheet1', cell: 'A1' }])
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway taps DOCX word-patch versions while preserving the event stream', async () => {
  const versions: number[] = []
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `event: update\ndata: ${JSON.stringify({
        action: 'word-patch',
        version: 2,
        baseVersion: 1,
        patches: [{ op: 'add', blockId: '2', html: '<p>中文</p>' }]
      })}\n\n`
    )
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-docx',
    kind: 'docx',
    upstreamPort,
    onDocumentPatch: (version) => versions.push(version)
  })
  try {
    const response = await fetch(`${gateway.url}events`)
    assert.match(await response.text(), /word-patch/u)
    assert.deepEqual(versions, [2])
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway reports a PPTX slide-list change while preserving the event stream', async () => {
  const changes: Array<{ version: number; slideCountChanged: boolean }> = []
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `event: update\ndata: ${JSON.stringify({
        action: 'add',
        slide: 1,
        version: 1,
        html: '<div class="slide-container" data-slide="1">中文第一页</div>'
      })}\n\n`
    )
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-pptx',
    kind: 'pptx',
    upstreamPort,
    onPresentationChange: (version, slideCountChanged) => {
      changes.push({ version, slideCountChanged })
    }
  })
  try {
    const response = await fetch(`${gateway.url}events`)
    assert.match(await response.text(), /"action":"add"/u)
    assert.deepEqual(changes, [{ version: 1, slideCountChanged: true }])
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('gateway reports PPTX replace versions without requesting a slide-count change', async () => {
  const changes: Array<{ version: number; slideCountChanged: boolean }> = []
  const upstream = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `event: update\ndata: ${JSON.stringify({
        action: 'replace',
        slide: 1,
        version: 4,
        html: '<div class="slide-container" data-slide="1">新标题</div>'
      })}\n\n`
    )
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-pptx',
    kind: 'pptx',
    upstreamPort,
    onPresentationChange: (version, slideCountChanged) => {
      changes.push({ version, slideCountChanged })
    }
  })
  try {
    const response = await fetch(`${gateway.url}events`)
    assert.match(await response.text(), /"action":"replace"/u)
    assert.deepEqual(changes, [{ version: 4, slideCountChanged: false }])
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('a reconnected SSE stream continues publishing selection updates', async () => {
  const selections: unknown[] = []
  let connections = 0
  const upstream = createServer((_request, response) => {
    connections += 1
    const cell = connections === 1 ? 'A1' : 'B2'
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.end(
      `event: update\ndata: ${JSON.stringify({
        action: 'selection-update',
        paths: [`/Sheet1/${cell}`]
      })}\n\n`
    )
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({
    artifactId: 'artifact-a',
    upstreamPort,
    onSelection: (selection) => selections.push(selection)
  })
  try {
    await (await fetch(`${gateway.url}events`)).text()
    await (await fetch(`${gateway.url}events`)).text()
    assert.equal(connections, 2)
    assert.deepEqual(selections, [
      { sheet: 'Sheet1', range: 'A1', paths: ['/Sheet1/A1'] },
      { sheet: 'Sheet1', range: 'B2', paths: ['/Sheet1/B2'] }
    ])
  } finally {
    await gateway.close()
    await close(upstream)
  }
})

test('closing the gateway aborts its open upstream SSE connection', async () => {
  let resolveClosed: (() => void) | undefined
  const upstreamClosed = new Promise<void>((resolve) => {
    resolveClosed = resolve
  })
  const upstream = createServer((request, response) => {
    request.once('close', () => resolveClosed?.())
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write(': connected\n\n')
  })
  const upstreamPort = await listen(upstream)
  const gateway = await startOfficePreviewGateway({ artifactId: 'artifact-a', upstreamPort })
  const response = await fetch(`${gateway.url}events`)
  assert.equal(response.status, 200)
  await gateway.close()
  const closed = await Promise.race([
    upstreamClosed.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), 250))
  ])
  assert.equal(closed, true)
  await close(upstream)
})
