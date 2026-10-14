import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AnalysisNotebookExecutor,
  WebSocketJupyterKernelClient
} from '../src/main/agent/notebook/analysis-jupyter-execution'
import { AnalysisNotebookSessionRegistry } from '../src/main/agent/notebook/analysis-jupyter-sessions'
import type { JupyterServerConnection } from '../src/main/agent/notebook/analysis-jupyter-server'
import {
  AnalysisNotebookToolExecutor,
  type NotebookDraftChange
} from '../src/main/agent/notebook/notebook-tool-executor'
import { NotebookToolHostRouter } from '../src/main/agent/notebook/notebook-tool-host-router'
import type { NotebookToolDispatchControl } from '../src/main/agent/notebook/notebook-tools'
import {
  startJupyterProtocolFixture,
  waitForJupyter,
  type JupyterProtocolFixture
} from './helpers/jupyterProtocolFixture'

type OwnershipHarness = {
  root: string
  file: string
  peer: string
  fixture: JupyterProtocolFixture
  changes: NotebookDraftChange[]
  executor: AnalysisNotebookToolExecutor
  sessions: AnalysisNotebookSessionRegistry
  setConnection(value: JupyterServerConnection | null): void
  setReady(value: () => Promise<void>): void
  run(control?: NotebookToolDispatchControl, path?: string): Promise<unknown>
  read(path?: string): ReturnType<AnalysisNotebookToolExecutor['execute']>
  close(): Promise<void>
}

async function harness(): Promise<OwnershipHarness> {
  const root = mkdtempSync(join(tmpdir(), 'phi-notebook-ownership-'))
  mkdirSync(join(root, 'notebooks'))
  const file = join(root, 'notebooks', 'analysis.ipynb')
  const peer = join(root, 'notebooks', 'peer.ipynb')
  const body = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        source: 'print("selected")',
        metadata: {},
        outputs: [],
        execution_count: null
      }
    ]
  })
  writeFileSync(file, body)
  writeFileSync(peer, body)
  const fixture = await startJupyterProtocolFixture()
  const changes: NotebookDraftChange[] = []
  let connection: JupyterServerConnection | null = fixture.connection
  let ensureReady = async (): Promise<void> => {
    connection = fixture.connection
  }
  const sessions = new AnalysisNotebookSessionRegistry({ getConnection: () => connection })
  const executor = new AnalysisNotebookToolExecutor({
    resolveWorkspaceByCwd: (cwd) => (cwd === root ? { workingDirectory: root } : null),
    resolveKernelsByCwd: () => ({
      jupyterServer: { available: true, command: 'jupyter', version: 'fixture' },
      kernels: [
        { name: 'python3', displayName: 'Python 3', language: 'python', rawLanguage: 'python' }
      ],
      preferredKernelName: 'python3',
      hasPythonKernel: true,
      hasRKernel: false,
      messages: []
    }),
    ensureJupyterServerReady: () => ensureReady(),
    notebookSessionRegistry: sessions,
    notebookExecutor: new AnalysisNotebookExecutor({
      client: new WebSocketJupyterKernelClient({ executionTimeoutMs: 2_000 })
    }),
    onDraftChanged: (change) => changes.push(change)
  })
  const router = new NotebookToolHostRouter({
    local: (request, control) => executor.execute(request, control),
    isRemoteCwd: () => false,
    resolveRemote: async () => null
  })
  return {
    root,
    file,
    peer,
    fixture,
    changes,
    executor,
    sessions,
    setConnection(value: JupyterServerConnection | null): void {
      connection = value
    },
    setReady(value: typeof ensureReady): void {
      ensureReady = value
    },
    run(control: NotebookToolDispatchControl = {}, path = file): Promise<unknown> {
      return router.execute(
        { action: 'run_cell', cwd: root, params: { path, cellId: 'cell-1' } },
        control
      )
    },
    async read(path = file) {
      return executor.execute({ action: 'read', cwd: root, params: { path } })
    },
    async close(): Promise<void> {
      await fixture.close()
      rmSync(root, { recursive: true, force: true })
    }
  }
}

test('selected Notebook runs through real Jupyter clients and remains a draft until save', async () => {
  const h = await harness()
  try {
    const original = readFileSync(h.file, 'utf8')
    const running = h.run()
    await waitForJupyter(() => h.fixture.executions.length === 1)
    assert.equal(h.fixture.sessions[0].path, 'notebooks/analysis.ipynb')
    assert.equal(h.fixture.executions[0].code, 'print("selected")')
    h.fixture.finish(h.fixture.executions[0], 'selected\n')
    const result = (await running) as { kind: string; execution: { outputs: string[] } }
    assert.equal(result.kind, 'notebook_cell_executed')
    assert.deepEqual(result.execution.outputs, ['selected\n'])
    assert.equal(readFileSync(h.file, 'utf8'), original)
    assert.equal(h.changes.length, 1)
    assert.equal(h.changes[0].changeKind, 'executed')
    await h.executor.execute({ action: 'save', cwd: h.root, params: { path: h.file } })
    assert.match(readFileSync(h.file, 'utf8'), /selected\\n/)
    assert.equal(h.fixture.interrupts.length, 0)
  } finally {
    await h.close()
  }
})

test('stop awaits captured kernel interrupt acknowledgement AND terminal reply/idle; peer continues', async () => {
  const h = await harness()
  try {
    h.fixture.holdInterruptAcknowledgements()
    const controller = new AbortController()
    let settled = false
    const running = h.run({ signal: controller.signal }).finally(() => {
      settled = true
    })
    const rejected = assert.rejects(running, /selected run stopped/)
    await waitForJupyter(() => h.fixture.executions.length === 1)
    const selected = h.fixture.executions[0]
    const peerRunning = h.run({}, h.peer)
    await waitForJupyter(() => h.fixture.executions.length === 2)
    const peer = h.fixture.executions[1]
    controller.abort(new Error('selected run stopped'))
    await waitForJupyter(() => h.fixture.interrupts.length === 1)
    assert.deepEqual(h.fixture.interrupts, [selected.kernelId])
    assert.notEqual(selected.kernelId, peer.kernelId)
    assert.equal(settled, false)
    h.fixture.finish(selected, 'late output must disappear\n', 'error')
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(settled, false, 'terminal event alone cannot release pending physical interrupt')
    h.fixture.acknowledgeInterrupts()
    await rejected
    h.fixture.finish(peer, 'peer completed\n')
    await peerRunning
    assert.equal(h.changes.length, 1)
    assert.equal(h.changes[0].path, h.peer)
    assert.equal((await h.read()).revision, (await h.read()).savedRevision)
    assert.doesNotMatch(readFileSync(h.file, 'utf8'), /late output/)
    // Removing the old stop listener prevents an old generation from stopping recovery.
    const recovered = h.run()
    await waitForJupyter(() => h.fixture.executions.length === 3)
    controller.abort(new Error('old stopped generation'))
    h.fixture.finish(h.fixture.executions[2], 'recovered\n')
    await recovered
    assert.equal(h.fixture.interrupts.length, 1)
    assert.equal(
      h.fixture.sessions.filter((session) => session.path === 'notebooks/analysis.ipynb').length,
      1
    )
  } finally {
    await h.close()
  }
})

test('interrupt acknowledgement without terminal execution does not claim stop completion', async () => {
  const h = await harness()
  try {
    const controller = new AbortController()
    let settled = false
    const running = h.run({ signal: controller.signal }).finally(() => {
      settled = true
    })
    const rejected = assert.rejects(running, /stop after acknowledgement/)
    await waitForJupyter(() => h.fixture.executions.length === 1)
    controller.abort(new Error('stop after acknowledgement'))
    await waitForJupyter(() => h.fixture.interrupts.length === 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(settled, false)
    await assert.rejects(h.run(), /不能重叠运行/)
    assert.equal(h.fixture.executions.length, 1)
    h.fixture.finish(h.fixture.executions[0], 'discarded', 'error')
    await rejected
    assert.equal(h.changes.length, 0)
  } finally {
    await h.close()
  }
})

test('stop before dispatch and during server readiness or session lookup sends no code or peer interrupt', async () => {
  for (const stage of ['before', 'readiness', 'lookup'] as const) {
    const h = await harness()
    try {
      const controller = new AbortController()
      let readyEntered = false
      let releaseReady!: () => void
      if (stage === 'before') controller.abort(new Error('stopped before dispatch'))
      if (stage === 'lookup') h.fixture.holdSessionCreates()
      if (stage === 'readiness') {
        h.setConnection(null)
        h.setReady(async () => {
          readyEntered = true
          await new Promise<void>((resolve) => {
            releaseReady = resolve
          })
          h.setConnection(h.fixture.connection)
        })
      }
      const running = h.run({ signal: controller.signal })
      const rejected = assert.rejects(running, /stopped/)
      if (stage !== 'before') {
        await waitForJupyter(() =>
          stage === 'lookup' ? h.fixture.sessions.length === 1 : readyEntered
        )
        controller.abort(new Error(`stopped during ${stage}`))
        if (stage === 'lookup') h.fixture.releaseSessionCreates()
        else releaseReady()
      }
      await rejected
      assert.equal(h.fixture.executions.length, 0)
      assert.equal(h.fixture.interrupts.length, 0)
      assert.equal(h.changes.length, 0)
      assert.equal((await h.read()).revision, (await h.read()).savedRevision)
    } finally {
      await h.close()
    }
  }
})

test('project rebind rejects late output and old cleanup cannot mutate or interrupt replacement runtime', async () => {
  const h = await harness()
  const replacement = await startJupyterProtocolFixture()
  try {
    h.fixture.holdInterruptAcknowledgements()
    let binding = 'original'
    const running = h.run({
      beforeDispatch: () => {
        if (binding !== 'original') throw new Error('project binding changed')
      }
    })
    const rejected = assert.rejects(running, /project binding changed/)
    await waitForJupyter(() => h.fixture.executions.length === 1)
    binding = 'replacement'
    h.setConnection({ ...replacement.connection, runtimeId: 'replacement-runtime' })
    h.fixture.stream(h.fixture.executions[0], 'late original output')
    await waitForJupyter(() => h.fixture.interrupts.length === 1)
    const newRunning = h.run()
    await waitForJupyter(() => replacement.executions.length === 1)
    const newTarget = h.sessions.executionTarget(h.root, h.file)
    assert.ok(newTarget)
    h.fixture.finish(h.fixture.executions[0], 'old final output', 'error')
    h.fixture.acknowledgeInterrupts()
    await rejected
    assert.equal(h.changes.length, 0)
    assert.equal(h.sessions.projectSummary(h.root).busySessionCount, 1)
    assert.deepEqual(replacement.interrupts, [])
    replacement.finish(replacement.executions[0], 'replacement output\n')
    await newRunning
    assert.equal(h.changes.length, 1)
    assert.equal(h.changes[0].document.cells[0].outputs[0].text, 'replacement output\n')
    assert.equal(h.sessions.executionTarget(h.root, h.file)?.sessionId, newTarget.sessionId)
    assert.deepEqual(h.fixture.interrupts, [h.fixture.executions[0].kernelId])
    assert.deepEqual(replacement.interrupts, [])
  } finally {
    await replacement.close()
    await h.close()
  }
})
