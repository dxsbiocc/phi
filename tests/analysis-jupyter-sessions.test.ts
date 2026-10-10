import assert from 'node:assert/strict'
import test from 'node:test'
import { parseNotebook, type NotebookDocument } from '../src/shared/notebookDocument'
import {
  AnalysisNotebookSessionRegistry,
  type EnsureNotebookSessionInput,
  type JupyterServerConnection,
  type JupyterSessionClient,
  type JupyterSessionCreateRequest,
  type JupyterSessionRecord
} from '../src/main/agent/notebook/analysis-jupyter-sessions'
import type { AnalysisKernelDiagnostics } from '../src/main/agent/notebook/analysis-kernels'

class FakeJupyterSessionClient implements JupyterSessionClient {
  readonly created: JupyterSessionCreateRequest[] = []
  readonly createConnections: JupyterServerConnection[] = []
  readonly deleted: string[] = []
  readonly deleteConnections: JupyterServerConnection[] = []
  readonly interrupted: string[] = []
  nextSession: JupyterSessionRecord = {
    id: 'session-1',
    kernelId: 'kernel-1',
    kernelName: 'python3',
    executionState: 'idle'
  }

  async createSession(
    connection: JupyterServerConnection,
    request: JupyterSessionCreateRequest
  ): Promise<JupyterSessionRecord> {
    this.createConnections.push(connection)
    this.created.push(request)
    return this.nextSession
  }

  async deleteSession(connection: JupyterServerConnection, sessionId: string): Promise<void> {
    this.deleteConnections.push(connection)
    this.deleted.push(sessionId)
  }

  async interruptKernel(_connection: JupyterServerConnection, kernelId: string): Promise<void> {
    this.interrupted.push(kernelId)
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

test('AnalysisNotebookSessionRegistry interrupts a tracked notebook kernel', async () => {
  const client = new FakeJupyterSessionClient()
  const registry = new AnalysisNotebookSessionRegistry({
    client,
    now: () => new Date('2026-09-09T00:02:00.000Z'),
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
  registry.updateSessionState('/project', '/project/notebooks/demo.ipynb', 'busy', 'running')

  const interrupted = await registry.interruptSession('/project', '/project/notebooks/demo.ipynb')

  assert.deepEqual(client.interrupted, ['kernel-1'])
  assert.equal(interrupted.state, 'idle')
  assert.equal(interrupted.updatedAt, '2026-09-09T00:02:00.000Z')
  assert.match(interrupted.message ?? '', /停止请求/)
})

test('AnalysisNotebookSessionRegistry rejects an execution target from an older runtime', async () => {
  const client = new FakeJupyterSessionClient()
  let connection: JupyterServerConnection = {
    url: 'http://127.0.0.1:41001/',
    runtimeId: 'runtime-1'
  }
  const registry = new AnalysisNotebookSessionRegistry({
    client,
    getConnection: () => connection
  })
  const document = notebook({
    kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }
  })
  const input = {
    projectCwd: '/project',
    notebookPath: '/project/notebooks/demo.ipynb',
    document,
    kernels: kernels()
  }
  await registry.ensureSession(input)

  connection = { url: 'http://127.0.0.1:41002/', runtimeId: 'runtime-2' }

  assert.equal(registry.executionTarget(input.projectCwd, input.notebookPath), null)
  assert.equal(registry.projectSummary(input.projectCwd).activeSessionCount, 0)
})

test('AnalysisNotebookSessionRegistry creates a new kernel without deleting the old id on runtime change', async () => {
  const client = new FakeJupyterSessionClient()
  let connection: JupyterServerConnection = {
    url: 'http://127.0.0.1:41001/',
    runtimeId: 'runtime-1'
  }
  const registry = new AnalysisNotebookSessionRegistry({
    client,
    getConnection: () => connection
  })
  const input = {
    projectCwd: '/project',
    notebookPath: '/project/notebooks/demo.ipynb',
    document: notebook({
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }
    }),
    kernels: kernels()
  }
  await registry.ensureSession(input)
  client.nextSession = {
    id: 'session-2',
    kernelId: 'kernel-2',
    kernelName: 'python3',
    executionState: 'idle'
  }

  connection = { url: 'http://127.0.0.1:41002/', runtimeId: 'runtime-2' }
  const recreated = await registry.ensureSession(input)

  assert.equal(recreated.sessionId, 'session-2')
  assert.equal(client.created.length, 2)
  assert.deepEqual(
    client.createConnections.map((value) => value.runtimeId),
    ['runtime-1', 'runtime-2']
  )
  assert.deepEqual(client.deleted, [])
})

test('AnalysisNotebookSessionRegistry closes a stale runtime session without deleting it on the new server', async () => {
  const client = new FakeJupyterSessionClient()
  let connection: JupyterServerConnection = {
    url: 'http://127.0.0.1:41001/',
    runtimeId: 'runtime-1'
  }
  const registry = new AnalysisNotebookSessionRegistry({
    client,
    getConnection: () => connection
  })
  const input = {
    projectCwd: '/project',
    notebookPath: '/project/notebooks/demo.ipynb',
    document: notebook({
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' }
    }),
    kernels: kernels()
  }
  await registry.ensureSession(input)

  connection = { url: 'http://127.0.0.1:41002/', runtimeId: 'runtime-2' }
  const closed = await registry.closeSession(input.projectCwd, input.notebookPath)

  assert.equal(closed.state, 'disconnected')
  assert.deepEqual(client.deleted, [])
  assert.deepEqual(client.deleteConnections, [])
  assert.equal(registry.projectSummary(input.projectCwd).activeSessionCount, 0)
})

test('AnalysisNotebookSessionRegistry redacts remote tokens from public errors', async () => {
  const client = new FakeJupyterSessionClient()
  const token = 'remote-status-secret'
  client.createSession = async () => {
    throw new Error(`request failed: ?token=${token} ${token}`)
  }
  const registry = new AnalysisNotebookSessionRegistry({
    client,
    getConnection: () => ({
      url: 'http://127.0.0.1:41001/',
      runtimeId: 'remote-runtime-1',
      authorizationHeader: () => `token ${token}`
    })
  })

  const status = await registry.ensureSession({
    projectCwd: '/project',
    notebookPath: '/project/demo.ipynb',
    document: notebook({}),
    kernels: kernels()
  })

  assert.equal(status.state, 'error')
  assert.doesNotMatch(status.message ?? '', new RegExp(token))
  assert.match(status.message ?? '', /<redacted>/u)
})

test('remote runtime resource lifecycle gates concurrent kernels and releases closed sessions', async () => {
  const client = new FakeJupyterSessionClient()
  const claimed = new Set<string>()
  const released: string[] = []
  let activities = 0
  const runtimeBackend = {
    connection: () => ({ url: 'http://127.0.0.1:41001/', runtimeId: 'remote-runtime-1' }),
    claimKernel: (_projectCwd: string, owner: string) => {
      if (!claimed.has(owner) && claimed.size >= 2) {
        throw new Error('远程 Notebook 同时最多运行 2 个 kernel')
      }
      claimed.add(owner)
    },
    releaseKernel: (_projectCwd: string, owner: string) => {
      claimed.delete(owner)
      released.push(owner)
    },
    touchActivity: () => {
      activities += 1
    }
  }
  const registry = new AnalysisNotebookSessionRegistry({ client, runtimeBackend })
  const makeInput = (name: string): EnsureNotebookSessionInput => ({
    projectCwd: '/project',
    notebookPath: `/project/${name}.ipynb`,
    document: notebook({}),
    kernels: kernels()
  })

  assert.equal((await registry.ensureSession(makeInput('one'))).state, 'idle')
  client.nextSession = { ...client.nextSession, id: 'session-2', kernelId: 'kernel-2' }
  assert.equal((await registry.ensureSession(makeInput('two'))).state, 'idle')
  const rejected = await registry.ensureSession(makeInput('three'))

  assert.equal(rejected.state, 'error')
  assert.match(rejected.message ?? '', /最多运行 2 个 kernel/u)
  assert.equal(client.created.length, 2)
  assert.equal(claimed.size, 2)

  registry.updateSessionState('/project', '/project/one.ipynb', 'error')
  const deleteSession = client.deleteSession.bind(client)
  client.deleteSession = async () => {
    throw new Error('delete denied')
  }
  const cleanupBlocked = await registry.ensureSession(makeInput('one'))
  assert.equal(cleanupBlocked.state, 'error')
  assert.equal(client.created.length, 2)
  assert.equal(claimed.size, 2)
  client.deleteSession = deleteSession

  await registry.closeSession('/project', '/project/one.ipynb')
  assert.deepEqual(released, ['/project\0/project/one.ipynb'])
  assert.equal(claimed.size, 1)

  client.nextSession = { ...client.nextSession, id: 'session-3', kernelId: 'kernel-3' }
  const concurrent = await Promise.all([
    registry.ensureSession(makeInput('four')),
    registry.ensureSession(makeInput('four'))
  ])
  assert.equal(client.created.length, 3)
  assert.equal(concurrent[0].sessionId, concurrent[1].sessionId)
  assert.equal(claimed.size, 2)
  assert.ok(activities >= 3)
})
