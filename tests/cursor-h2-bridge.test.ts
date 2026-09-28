import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http2 from 'node:http2'
import test from 'node:test'

import { createCursorH2Bridge } from '../src/main/agent/cursor-h2-bridge'

test('Bun streams a Cursor run through the local bridge while Node uses upstream HTTP/2', async () => {
  const upstream = http2.createServer()
  let upstreamBody = ''
  upstream.on('stream', (stream, headers) => {
    assert.equal(headers[':path'], '/agent.v1.AgentService/Run')
    assert.equal(headers.authorization, 'Bearer test-token')
    stream.on('data', (chunk) => {
      upstreamBody += chunk.toString()
    })
    stream.on('end', () => {
      stream.respond(
        { ':status': 200, 'content-type': 'application/connect+proto' },
        { waitForTrailers: true }
      )
      stream.on('wantTrailers', () => stream.sendTrailers({ 'grpc-status': '0' }))
      stream.end('response-body')
    })
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  const bridge = createCursorH2Bridge(`http://127.0.0.1:${address.port}`)
  try {
    const url = await bridge.ensure()
    assert.equal(await bridge.ensure(), url)
    const script = [
      "import http2 from 'node:http2'",
      `const client = http2.connect(${JSON.stringify(url)})`,
      "const request = client.request({ ':method':'POST', ':path':'/agent.v1.AgentService/Run', authorization:'Bearer test-token' })",
      "let body = ''; let trailers = {}",
      "request.on('data', chunk => body += chunk.toString())",
      "request.on('trailers', value => trailers = value)",
      "request.on('end', () => { console.log(JSON.stringify({ body, status: trailers['grpc-status'] })); client.close() })",
      "request.on('error', error => { console.error(error.message); client.destroy() })",
      "request.end('request-body')"
    ].join(';')
    const child = spawn('bun', ['-e', script], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk.toString()))
    child.stderr.on('data', (chunk) => (stderr += chunk.toString()))
    const timer = setTimeout(() => child.kill(), 8_000)
    const code = await new Promise<number | null>((resolve) => child.once('close', resolve))
    clearTimeout(timer)
    assert.equal(code, 0, stderr)
    assert.equal(upstreamBody, 'request-body')
    assert.deepEqual(JSON.parse(stdout.trim()), { body: 'response-body', status: '0' })
  } finally {
    await bridge.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})

test('bridge rejects unrelated local requests without forwarding them upstream', async () => {
  const upstream = http2.createServer()
  let forwarded = 0
  upstream.on('stream', () => {
    forwarded += 1
  })
  await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve))
  const address = upstream.address()
  assert.ok(address && typeof address !== 'string')
  const bridge = createCursorH2Bridge(`http://127.0.0.1:${address.port}`)
  try {
    const client = http2.connect(await bridge.ensure())
    const request = client.request({ ':method': 'GET', ':path': '/other' })
    let status: number | undefined
    request.on('response', (headers) => {
      status = headers[':status']
    })
    request.resume()
    request.end()
    await new Promise<void>((resolve) => request.once('end', resolve))
    client.close()
    assert.equal(status, 403)
    assert.equal(forwarded, 0)
  } finally {
    await bridge.close()
    await new Promise<void>((resolve) => upstream.close(() => resolve()))
  }
})
