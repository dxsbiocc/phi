import assert from 'node:assert/strict'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import test from 'node:test'
import { FetchJupyterSessionClient } from '../src/main/agent/notebook/analysis-jupyter-sessions'

const XSRF_TOKEN = 'test-xsrf-token'

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
  })
}

function hasValidXsrf(request: IncomingMessage): boolean {
  const cookie = request.headers.cookie ?? ''
  const header = request.headers['x-xsrftoken']
  return cookie.includes(`_xsrf=${XSRF_TOKEN}`) && header === XSRF_TOKEN
}

/**
 * Emulates the two things real Jupyter Server does that
 * FetchJupyterSessionClient must handle correctly:
 * - GET / hands out an `_xsrf` cookie.
 * - POST/DELETE reject with 403 unless that cookie AND a matching
 *   X-XSRFToken header are both present (Tornado's CSRF protection, which
 *   applies even when ServerApp.token is disabled).
 */
function startFakeJupyterServer(options: { rejectFirstNPosts?: number }): Promise<{
  server: Server
  url: string
  requests: { method: string; url: string }[]
}> {
  const requests: { method: string; url: string }[] = []
  let sessionCounter = 0
  let postsToReject = options.rejectFirstNPosts ?? 0

  const server = createServer((request, response) => {
    void handle(request, response)
  })

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const method = request.method ?? 'GET'
    const url = request.url ?? '/'
    requests.push({ method, url })

    if (method === 'GET' && url === '/') {
      response.setHeader('set-cookie', [`_xsrf=${XSRF_TOKEN}; Path=/`])
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<html></html>')
      return
    }

    if (method === 'POST' && url === '/api/sessions') {
      // Simulate a cached token going stale for reasons outside the
      // client's control (e.g. the server restarted with a new cookie
      // secret): reject the first N attempts unconditionally, regardless of
      // whether the request actually carried a valid xsrf cookie/header.
      if (postsToReject > 0) {
        postsToReject -= 1
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: "'_xsrf' argument missing from POST" }))
        return
      }
      if (!hasValidXsrf(request)) {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: "'_xsrf' argument missing from POST" }))
        return
      }
      await readBody(request)
      sessionCounter += 1
      response.writeHead(201, { 'content-type': 'application/json' })
      response.end(
        JSON.stringify({
          id: `session-${sessionCounter}`,
          kernel: { id: `kernel-${sessionCounter}`, name: 'python3', execution_state: 'starting' }
        })
      )
      return
    }

    if (method === 'DELETE' && url.startsWith('/api/sessions/')) {
      if (!hasValidXsrf(request)) {
        response.writeHead(403, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ message: "'_xsrf' argument missing from DELETE" }))
        return
      }
      response.writeHead(204)
      response.end()
      return
    }

    response.writeHead(404)
    response.end()
  }

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ server, url: `http://127.0.0.1:${port}/`, requests })
    })
  })
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()))
}

test('FetchJupyterSessionClient fetches the _xsrf cookie and sends it back on create/delete', async () => {
  const { server, url, requests } = await startFakeJupyterServer({})
  try {
    const client = new FetchJupyterSessionClient()
    const connection = { url }

    const created = await client.createSession(connection, {
      projectCwd: '/project',
      notebookPath: '/project/demo.ipynb',
      notebookRelativePath: 'demo.ipynb',
      notebookName: 'demo.ipynb',
      kernelName: 'python3'
    })
    assert.equal(created.id, 'session-1')
    assert.equal(created.kernelId, 'kernel-1')

    await client.deleteSession(connection, created.id)

    // GET / (xsrf) -> POST /api/sessions -> DELETE /api/sessions/session-1,
    // with the cookie fetched only once and reused for both mutating calls.
    assert.deepEqual(
      requests.map((entry) => `${entry.method} ${entry.url}`),
      ['GET /', 'POST /api/sessions', 'DELETE /api/sessions/session-1']
    )
  } finally {
    await closeServer(server)
  }
})

test('FetchJupyterSessionClient transparently refreshes a stale _xsrf token after one 403', async () => {
  // The very first POST is rejected once, unconditionally -- this is what
  // happens when the Jupyter Server process was restarted with a new cookie
  // secret between the client's earlier calls and now.
  const { server, url, requests } = await startFakeJupyterServer({ rejectFirstNPosts: 1 })
  try {
    const client = new FetchJupyterSessionClient()
    const connection = { url }

    const created = await client.createSession(connection, {
      projectCwd: '/project',
      notebookPath: '/project/demo.ipynb',
      notebookRelativePath: 'demo.ipynb',
      notebookName: 'demo.ipynb',
      kernelName: 'python3'
    })

    assert.equal(created.id, 'session-1')
    assert.deepEqual(
      requests.map((entry) => `${entry.method} ${entry.url}`),
      ['GET /', 'POST /api/sessions', 'GET /', 'POST /api/sessions']
    )
  } finally {
    await closeServer(server)
  }
})
