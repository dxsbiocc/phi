import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AnalysisNotebookSessionRegistry,
  type EnsureNotebookSessionInput,
  type JupyterSessionRecord
} from '../src/main/agent/notebook/analysis-jupyter-sessions'
import { AnalysisNotebookExecutor } from '../src/main/agent/notebook/analysis-jupyter-execution'
import { AnalysisNotebookToolExecutor } from '../src/main/agent/notebook/notebook-tool-executor'
import { parseNotebook } from '../src/shared/notebookDocument'
import type { NotebookToolRequest } from '../src/main/agent/notebook/notebook-tools'

type Deferred = { promise: Promise<void>; resolve(): void }
function deferred(): Deferred {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
async function startingFixture(state = 'starting'): Promise<{
  root: string
  path: string
  sessions: AnalysisNotebookSessionRegistry
  tools: AnalysisNotebookToolExecutor
  controls: {
    state: string
    created: number
    executed: number
    holdCreate: Promise<void> | undefined
    holdExecute: Promise<void> | undefined
  }
  entered: Deferred
  executionEntered: Deferred
  input: EnsureNotebookSessionInput
  request: NotebookToolRequest
  close(): Promise<void>
}> {
  const root = await mkdtemp(join(tmpdir(), 'phi-notebook-starting-')),
    path = join(root, 'test.ipynb')
  const body = {
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python', language: 'python' } },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        metadata: {},
        source: 'print(1)',
        outputs: [],
        execution_count: null
      }
    ]
  }
  await writeFile(path, JSON.stringify(body))
  const kernels = {
    jupyterServer: { available: true, command: 'jupyter' as const },
    kernels: [
      { name: 'python3', displayName: 'Python', language: 'python' as const, rawLanguage: 'python' }
    ],
    preferredKernelName: 'python3',
    hasPythonKernel: true,
    hasRKernel: false,
    messages: []
  }
  const controls = {
    state,
    created: 0,
    executed: 0,
    holdCreate: undefined as Promise<void> | undefined,
    holdExecute: undefined as Promise<void> | undefined
  }
  const entered = deferred(),
    executionEntered = deferred()
  const sessions = new AnalysisNotebookSessionRegistry({
    getConnection: () => ({ url: 'http://127.0.0.1:30000', runtimeId: 'same-runtime' }),
    client: {
      createSession: async (): Promise<JupyterSessionRecord> => {
        controls.created++
        entered.resolve()
        await controls.holdCreate
        return {
          id: 'session-' + controls.created,
          kernelId: 'kernel-' + controls.created,
          kernelName: 'python3',
          executionState: controls.state
        }
      },
      deleteSession: async () => undefined,
      interruptKernel: async () => undefined
    }
  })
  const engine = new AnalysisNotebookExecutor({
    client: {
      executeCode: async () => {
        controls.executed++
        executionEntered.resolve()
        await controls.holdExecute
        return { executionCount: controls.executed, status: 'ok' as const, outputs: [] }
      },
      completeCode: async () => ({
        matches: [],
        cursorStart: 0,
        cursorEnd: 0,
        metadata: {},
        status: 'ok' as const
      })
    }
  })
  const tools = new AnalysisNotebookToolExecutor({
    resolveWorkspaceByCwd: (cwd) => (cwd === root ? { workingDirectory: root } : undefined),
    resolveKernelsByCwd: () => kernels,
    ensureJupyterServerReady: async () => undefined,
    notebookSessionRegistry: sessions,
    notebookExecutor: engine
  })
  return {
    root,
    path,
    sessions,
    tools,
    controls,
    entered,
    executionEntered,
    input: { projectCwd: root, notebookPath: path, document: parseNotebook(body), kernels },
    request: {
      action: 'run_cell' as const,
      cwd: root,
      params: { path: 'test.ipynb', cellId: 'cell-1' }
    },
    close: () => rm(root, { recursive: true, force: true })
  }
}
test('fresh starting kernel reaches the original executor without changing its busy status to idle', async () => {
  const f = await startingFixture()
  try {
    const result = await f.tools.execute(f.request)
    assert.equal(result.kind, 'notebook_cell_executed')
    assert.equal(f.controls.executed, 1)
  } finally {
    await f.close()
  }
})
test('cold registry cannot take over a reused physically busy kernel', async () => {
  const f = await startingFixture('busy')
  try {
    await assert.rejects(f.tools.execute(f.request), /不能重叠/)
    assert.equal(f.controls.executed, 0)
  } finally {
    await f.close()
  }
})
test('starting execution permission is one-shot and exact to current session kernel and runtime', async () => {
  const f = await startingFixture()
  try {
    const status = await f.sessions.ensureSession(f.input)
    assert.equal(status.state, 'busy')
    const target = f.sessions.executionTarget(f.root, f.path)!
    assert.equal(
      f.sessions.consumeStartingExecution(f.root, f.path, { ...target, kernelId: 'foreign' }, null),
      false
    )
    assert.equal(
      f.sessions.consumeStartingExecution(
        f.root,
        f.path,
        { ...target, connection: { url: target.connection.url, runtimeId: 'new-runtime' } },
        null
      ),
      false
    )
    assert.equal(f.sessions.consumeStartingExecution(f.root, f.path, target, null), true)
    assert.equal(
      f.sessions.status(f.input).state,
      'busy',
      'Consuming startup metadata must not fabricate idle'
    )
    assert.equal(f.sessions.consumeStartingExecution(f.root, f.path, target, null), false)
    await f.sessions.closeProject(f.root)
    assert.equal(f.sessions.consumeStartingExecution(f.root, f.path, target, null), false)
  } finally {
    await f.close()
  }
})
test('existing same-target busy and concurrently executing kernels still reject without dispatch', async () => {
  const f = await startingFixture()
  const release = deferred()
  try {
    f.controls.holdExecute = release.promise
    const first = f.tools.execute(f.request)
    await f.executionEntered.promise
    await assert.rejects(f.tools.execute(f.request), /不能重叠/)
    assert.equal(f.controls.executed, 1)
    release.resolve()
    await first
    const target = f.sessions.executionTarget(f.root, f.path)!
    f.sessions.updateSessionState(f.root, f.path, 'busy', 'existing work', target)
    await assert.rejects(f.tools.execute(f.request), /不能重叠/)
    assert.equal(f.controls.executed, 1)
  } finally {
    release.resolve()
    await f.close()
  }
})
test('replacement starting identity does not inherit a retired kernel busy decision', async () => {
  const f = await startingFixture('idle')
  try {
    await f.sessions.ensureSession(f.input)
    const old = f.sessions.executionTarget(f.root, f.path)!
    f.sessions.updateSessionState(f.root, f.path, 'error', 'old disconnected', old)
    f.controls.state = 'starting'
    await f.tools.execute(f.request)
    const current = f.sessions.executionTarget(f.root, f.path)!
    assert.notEqual(current.kernelId, old.kernelId)
    assert.equal(f.controls.executed, 1)
    assert.equal(f.sessions.consumeStartingExecution(f.root, f.path, old, null), false)
  } finally {
    await f.close()
  }
})
for (const cancelled of [true, false])
  test(`starting lookup rejects ${cancelled ? 'cancelled' : 'rebound'} owner after await`, async () => {
    const f = await startingFixture(),
      release = deferred(),
      abort = new AbortController()
    let current = true
    try {
      f.controls.holdCreate = release.promise
      const work = f.tools.execute(f.request, {
        signal: abort.signal,
        beforeDispatch: () => {
          if (!current) throw new Error('binding changed')
        }
      })
      const rejected = assert.rejects(work, cancelled ? /cancelled/ : /binding changed/)
      await f.entered.promise
      if (cancelled) abort.abort(new Error('cancelled'))
      else current = false
      release.resolve()
      await rejected
      assert.equal(f.controls.executed, 0)
    } finally {
      release.resolve()
      await f.close()
    }
  })

test('unused starting permit never exempts a later call on the same existing target', async () => {
  const f = await startingFixture()
  try {
    await f.sessions.ensureSession(f.input)
    await assert.rejects(f.tools.execute(f.request), /不能重叠/)
    assert.equal(f.controls.executed, 0)
    const target = f.sessions.executionTarget(f.root, f.path)!
    assert.equal(f.sessions.consumeStartingExecution(f.root, f.path, target, null), false)
  } finally {
    await f.close()
  }
})
for (const state of ['unknown', 'unexpected'])
  test(`${state} reused kernel state cannot dispatch or grant starting permission`, async () => {
    const f = await startingFixture(state)
    try {
      await assert.rejects(f.tools.execute(f.request), /尚未就绪/)
      assert.equal(f.controls.executed, 0)
      const target = f.sessions.executionTarget(f.root, f.path)!
      assert.equal(f.sessions.consumeStartingExecution(f.root, f.path, target, null), false)
    } finally {
      await f.close()
    }
  })
