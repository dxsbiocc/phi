import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNotebook, type NotebookDocument } from '../src/shared/notebookDocument'
import {
  AnalysisNotebookSessionRegistry,
  type JupyterServerConnection,
  type JupyterSessionClient,
  type JupyterSessionCreateRequest,
  type JupyterSessionRecord
} from '../src/main/agent/notebook/analysis-jupyter-sessions'
import type { AnalysisKernelDiagnostics } from '../src/main/agent/notebook/analysis-kernels'

class FakeJupyterSessionClient implements JupyterSessionClient {
  readonly created: JupyterSessionCreateRequest[] = []
  readonly deleted: string[] = []
  nextSession: JupyterSessionRecord = {
    id: 'session-1',
    kernelId: 'kernel-1',
    kernelName: 'python3',
    executionState: 'idle'
  }

  async createSession(
    _connection: JupyterServerConnection,
    request: JupyterSessionCreateRequest
  ): Promise<JupyterSessionRecord> {
    this.created.push(request)
    return this.nextSession
  }

  async deleteSession(_connection: JupyterServerConnection, sessionId: string): Promise<void> {
    this.deleted.push(sessionId)
  }
}

function notebook(metadata: Record<string, unknown>): NotebookDocument {
  return parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata,
    cells: []
  })
}

function kernels(): AnalysisKernelDiagnostics {
  return {
    jupyterServer: { available: true, command: 'jupyter', version: '2.14.0' },
    kernels: [
      {
        name: 'python3',
        displayName: 'Python 3',
        language: 'python',
        rawLanguage: 'python'
      }
    ],
    preferredKernelName: 'python3',
    hasPythonKernel: true,
    hasRKernel: false,
    messages: []
  }
}

test('AnalysisNotebookSessionRegistry creates one session for a notebook kernel', async () => {
  const client = new FakeJupyterSessionClient()
  const registry = new AnalysisNotebookSessionRegistry({
    client,
    now: () => new Date('2026-09-09T00:00:00.000Z'),
    getConnection: () => ({ url: 'http://127.0.0.1:8888/lab', token: 'secret-token' })
  })
  const document = notebook({
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }
  })

  const status = await registry.ensureSession({
    projectCwd: '/project',
    notebookPath: '/project/notebooks/demo.ipynb',
    document,
    kernels: kernels()
  })
  const second = await registry.ensureSession({
    projectCwd: '/project',
    notebookPath: '/project/notebooks/demo.ipynb',
    document,
    kernels: kernels()
  })

  assert.equal(client.created.length, 1)
  assert.equal(client.created[0].notebookRelativePath, 'notebooks/demo.ipynb')
  assert.equal(status.state, 'idle')
  assert.equal(status.sessionId, 'session-1')
  assert.equal(status.kernelName, 'python3')
  assert.equal(second.sessionId, 'session-1')
  assert.deepEqual(registry.executionTarget('/project', '/project/notebooks/demo.ipynb'), {
    connection: { url: 'http://127.0.0.1:8888/lab', token: 'secret-token' },
    sessionId: 'session-1',
    kernelId: 'kernel-1',
    kernelName: 'python3'
  })
  assert.doesNotMatch(JSON.stringify(status), /secret-token/)
  assert.doesNotMatch(JSON.stringify(status), /127\.0\.0\.1/)
})

test('AnalysisNotebookSessionRegistry recreates the session once it is marked errored/disconnected', async () => {
  const client = new FakeJupyterSessionClient()
  const registry = new AnalysisNotebookSessionRegistry({
    client,
    now: () => new Date('2026-09-09T00:00:00.000Z'),
    getConnection: () => ({ url: 'http://127.0.0.1:8888/lab', token: 'secret-token' })
  })
  const document = notebook({
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }
  })

  await registry.ensureSession({
    projectCwd: '/project',
    notebookPath: '/project/notebooks/demo.ipynb',
    document,
    kernels: kernels()
  })

  // Simulate what execution failure / a dead kernel does: mark the cached
  // session unhealthy. A stale cache entry must not be served back forever
  // (e.g. after the Jupyter Server process was restarted) -- the next
  // ensureSession call should create a brand new session.
  registry.updateSessionState('/project', '/project/notebooks/demo.ipynb', 'error', 'kernel died')

  client.nextSession = {
    id: 'session-2',
    kernelId: 'kernel-2',
    kernelName: 'python3',
    executionState: 'idle'
  }
  const status = await registry.ensureSession({
    projectCwd: '/project',
    notebookPath: '/project/notebooks/demo.ipynb',
    document,
    kernels: kernels()
  })

  assert.equal(client.created.length, 2)
  assert.equal(status.sessionId, 'session-2')
  assert.equal(status.state, 'idle')
  assert.deepEqual(registry.executionTarget('/project', '/project/notebooks/demo.ipynb'), {
    connection: { url: 'http://127.0.0.1:8888/lab', token: 'secret-token' },
    sessionId: 'session-2',
    kernelId: 'kernel-2',
    kernelName: 'python3'
  })
})

test('AnalysisNotebookSessionRegistry recreates a session even if deleting the stale one fails', async () => {
  const client = new FakeJupyterSessionClient()
  client.deleteSession = async () => {
    throw new Error('session already gone')
  }
  const registry = new AnalysisNotebookSessionRegistry({
    client,
    getConnection: () => ({ url: 'http://127.0.0.1:8888/lab' })
  })
  const document = notebook({
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }
  })

  await registry.ensureSession({
    projectCwd: '/project',
    notebookPath: '/project/notebooks/demo.ipynb',
    document,
    kernels: kernels()
  })
  registry.updateSessionState('/project', '/project/notebooks/demo.ipynb', 'disconnected', 'lost')

  const status = await registry.ensureSession({
    projectCwd: '/project',
    notebookPath: '/project/notebooks/demo.ipynb',
    document,
    kernels: kernels()
  })

  assert.equal(status.state, 'idle')
  assert.equal(status.sessionId, 'session-1')
})

test('AnalysisNotebookSessionRegistry reports disconnected before Jupyter is ready', async () => {
  const client = new FakeJupyterSessionClient()
  const registry = new AnalysisNotebookSessionRegistry({
    client,
    getConnection: () => null
  })

  const status = await registry.ensureSession({
    projectCwd: '/project',
    notebookPath: '/project/notebooks/demo.ipynb',
    document: notebook({
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }
    }),
    kernels: kernels()
  })

  assert.equal(status.state, 'disconnected')
  assert.equal(status.kernelName, 'python3')
  assert.match(status.message ?? '', /Jupyter Server/)
  assert.equal(client.created.length, 0)
})

test('AnalysisNotebookSessionRegistry reports missing when notebook requires absent R kernel', () => {
  const client = new FakeJupyterSessionClient()
  const registry = new AnalysisNotebookSessionRegistry({
    client,
    getConnection: () => ({ url: 'http://127.0.0.1:8888/lab' })
  })

  const status = registry.status({
    projectCwd: '/project',
    notebookPath: '/project/notebooks/r-demo.ipynb',
    document: notebook({
      kernelspec: { display_name: 'R', language: 'R', name: 'ir' }
    }),
    kernels: kernels()
  })

  assert.equal(status.state, 'missing')
  assert.equal(status.sessionId, undefined)
  assert.equal(client.created.length, 0)
})

test('AnalysisNotebookSessionRegistry closes a tracked notebook session', async () => {
  const client = new FakeJupyterSessionClient()
  const registry = new AnalysisNotebookSessionRegistry({
    client,
    now: () => new Date('2026-09-09T00:01:00.000Z'),
    getConnection: () => ({ url: 'http://127.0.0.1:8888/lab', token: 'secret-token' })
  })
  const document = notebook({
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }
  })
  await registry.ensureSession({
    projectCwd: '/project',
    notebookPath: '/project/notebooks/demo.ipynb',
    document,
    kernels: kernels()
  })

  const closed = await registry.closeSession('/project', '/project/notebooks/demo.ipynb')

  assert.deepEqual(client.deleted, ['session-1'])
  assert.equal(closed.state, 'disconnected')
  assert.equal(closed.sessionId, undefined)
  assert.match(closed.message ?? '', /已断开/)
})
