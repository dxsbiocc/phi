import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FetchJupyterSessionClient,
  type JupyterFetch,
  type JupyterSessionCreateRequest
} from '../src/main/agent/notebook/analysis-jupyter-sessions'

const XSRF_TOKEN = 'test-xsrf-token'
const REMOTE_TOKEN = 'remote-secret-token'

type CapturedRequest = {
  method: string
  url: string
  headers: Record<string, string>
  body: string
}

class FakeJupyterHttpService {
  readonly requests: CapturedRequest[] = []
  rejectFirstNPosts = 0
  failNextSessionPost = false
  requiredAuthorization?: string
  private sessionCounter = 0

  readonly fetch: JupyterFetch = async (input, init) => {
    const request = new Request(input, init)
    const captured = await captureRequest(request)
    this.requests.push(captured)

    if (
      this.requiredAuthorization &&
      captured.headers.authorization !== this.requiredAuthorization
    ) {
      return jsonResponse({ message: 'unauthorized' }, 401)
    }
    if (captured.method === 'GET' && new URL(captured.url).pathname === '/') {
      return new Response('<html></html>', {
        status: 200,
        headers: { 'content-type': 'text/html', 'set-cookie': `_xsrf=${XSRF_TOKEN}; Path=/` }
      })
    }
    if (captured.method === 'POST' && new URL(captured.url).pathname === '/api/sessions') {
      if (this.failNextSessionPost) {
        this.failNextSessionPost = false
        throw new Error('ECONNRESET after request receipt')
      }
      if (this.rejectFirstNPosts > 0) {
        this.rejectFirstNPosts -= 1
        return jsonResponse({ message: "'_xsrf' argument missing from POST" }, 403)
      }
      if (!hasValidXsrf(captured)) {
        return jsonResponse({ message: "'_xsrf' argument missing from POST" }, 403)
      }
      this.sessionCounter += 1
      return jsonResponse(
        {
          id: `session-${this.sessionCounter}`,
          kernel: {
            id: `kernel-${this.sessionCounter}`,
            name: 'python3',
            execution_state: 'starting'
          }
        },
        201
      )
    }
    if (captured.method === 'DELETE' && /^\/api\/sessions\//.test(new URL(captured.url).pathname)) {
      return hasValidXsrf(captured)
        ? new Response(null, { status: 204 })
        : jsonResponse({ message: "'_xsrf' argument missing from DELETE" }, 403)
    }
    if (
      captured.method === 'POST' &&
      /^\/api\/kernels\/[^/]+\/interrupt$/.test(new URL(captured.url).pathname)
    ) {
      return hasValidXsrf(captured)
        ? new Response(null, { status: 204 })
        : jsonResponse({ message: "'_xsrf' argument missing from POST" }, 403)
    }
    return new Response(null, { status: 404 })
  }
}

function hasValidXsrf(request: CapturedRequest): boolean {
  return (
    request.headers.cookie?.includes(`_xsrf=${XSRF_TOKEN}`) === true &&
    request.headers['x-xsrftoken'] === XSRF_TOKEN
  )
}

async function captureRequest(request: Request): Promise<CapturedRequest> {
  return {
    method: request.method,
    url: request.url,
    headers: Object.fromEntries(request.headers.entries()),
    body: await request.text()
  }
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

function createRequest(): JupyterSessionCreateRequest {
  return {
    projectCwd: '/project',
    notebookPath: '/project/demo.ipynb',
    notebookRelativePath: 'demo.ipynb',
    notebookName: 'demo.ipynb',
    kernelName: 'python3'
  }
}

test('FetchJupyterSessionClient fetches the _xsrf cookie and sends it back on create/delete', async () => {
  const service = new FakeJupyterHttpService()
  const client = new FetchJupyterSessionClient(service.fetch)
  const connection = { url: 'http://127.0.0.1:41001/', runtimeId: 'runtime-1' }

  const created = await client.createSession(connection, createRequest())
  assert.equal(created.id, 'session-1')
  assert.equal(created.kernelId, 'kernel-1')
  await client.deleteSession(connection, created.id)

  assert.deepEqual(
    service.requests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`),
    ['GET /', 'POST /api/sessions', 'DELETE /api/sessions/session-1']
  )
  assert.ok(service.requests.slice(1).every(hasValidXsrf))
})

test('FetchJupyterSessionClient sends xsrf credentials when interrupting a kernel', async () => {
  const service = new FakeJupyterHttpService()
  const client = new FetchJupyterSessionClient(service.fetch)
  const connection = { url: 'http://127.0.0.1:41001/', runtimeId: 'runtime-1' }

  await client.interruptKernel(connection, 'kernel-1')

  assert.deepEqual(
    service.requests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`),
    ['GET /', 'POST /api/kernels/kernel-1/interrupt']
  )
  assert.equal(hasValidXsrf(service.requests[1]), true)
})

test('FetchJupyterSessionClient transparently refreshes a stale _xsrf token after one 403', async () => {
  const service = new FakeJupyterHttpService()
  service.rejectFirstNPosts = 1
  const client = new FetchJupyterSessionClient(service.fetch)

  const created = await client.createSession(
    { url: 'http://127.0.0.1:41001/', runtimeId: 'runtime-1' },
    createRequest()
  )

  assert.equal(created.id, 'session-1')
  assert.deepEqual(
    service.requests.map((entry) => `${entry.method} ${new URL(entry.url).pathname}`),
    ['GET /', 'POST /api/sessions', 'GET /', 'POST /api/sessions']
  )
})

test('FetchJupyterSessionClient sends remote authorization on GET and mutations without URL token', async () => {
  const service = new FakeJupyterHttpService()
  service.requiredAuthorization = `token ${REMOTE_TOKEN}`
  const client = new FetchJupyterSessionClient(service.fetch)
  const connection = {
    url: 'http://127.0.0.1:41001/',
    runtimeId: 'runtime-remote-1',
    authorizationHeader: () => `token ${REMOTE_TOKEN}`
  }

  const created = await client.createSession(connection, createRequest())
  await client.interruptKernel(connection, created.kernelId)
  await client.deleteSession(connection, created.id)

  assert.ok(
    service.requests.every((request) => request.headers.authorization === `token ${REMOTE_TOKEN}`)
  )
  assert.ok(service.requests.every((request) => !request.url.includes(REMOTE_TOKEN)))
  assert.ok(service.requests.filter((request) => request.method !== 'GET').every(hasValidXsrf))
})

test('FetchJupyterSessionClient does not replay a session POST after transport failure', async () => {
  const service = new FakeJupyterHttpService()
  service.failNextSessionPost = true
  const client = new FetchJupyterSessionClient(service.fetch)

  await assert.rejects(
    client.createSession(
      { url: 'http://127.0.0.1:41001/', runtimeId: 'runtime-1' },
      createRequest()
    ),
    /ECONNRESET/
  )

  assert.equal(
    service.requests.filter(
      (request) => request.method === 'POST' && new URL(request.url).pathname === '/api/sessions'
    ).length,
    1
  )
})
