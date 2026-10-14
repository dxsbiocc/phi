import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { validateRemotePresentedFiles } from '../src/main/agent/deliverables/remote-present-files'
import { wrapperJobHostHandlers } from '../src/main/agent/wrappers/composition/job-host-handlers'
import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'
import { desktopToolsFixture } from './helpers/rpcDesktopToolsFixture'
import { startJupyterProtocolFixture, waitForJupyter } from './helpers/jupyterProtocolFixture'
import {
  AnalysisNotebookExecutor,
  WebSocketJupyterKernelClient
} from '../src/main/agent/notebook/analysis-jupyter-execution'
import { AnalysisNotebookSessionRegistry } from '../src/main/agent/notebook/analysis-jupyter-sessions'
import { AnalysisNotebookToolExecutor } from '../src/main/agent/notebook/notebook-tool-executor'
import { createNotebookWorkspace } from '../src/main/agent/notebook/notebook-workspace'
import { createRemoteRuntimeFixture } from './helpers/remoteRuntimeFixture'
import { mkdirSync, writeFileSync } from 'node:fs'

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}

for (const outcome of ['confirmed', 'unconfirmed'] as const)
  test(`curated Notebook execution scope ${outcome} retains real kernel stop ownership`, async () => {
    const remote = createRemoteRuntimeFixture()
    const kernel = await startJupyterProtocolFixture()
    let connection = kernel.connection
    let peer: Awaited<ReturnType<typeof startJupyterProtocolFixture>> | undefined
    let closed = false
    const path = join(remote.projectRoot, 'notebooks/selected.ipynb')
    mkdirSync(join(remote.projectRoot, 'notebooks'))
    writeFileSync(
      path,
      JSON.stringify({
        nbformat: 4,
        nbformat_minor: 5,
        metadata: {},
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
    )
    const f = desktopToolsFixture({ cwd: remote.projectRoot })
    const executor = new AnalysisNotebookToolExecutor({
      resolveWorkspaceByCwd: () => ({ workingDirectory: remote.projectRoot }),
      resolveNotebookWorkspaceByCwd: () =>
        createNotebookWorkspace({
          projectCwd: remote.projectRoot,
          host: remote.workspace.projectHost
        }),
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
      ensureJupyterServerReady: async () => undefined,
      notebookSessionRegistry: new AnalysisNotebookSessionRegistry({
        getConnection: () => connection
      }),
      notebookExecutor: new AnalysisNotebookExecutor({
        client: new WebSocketJupyterKernelClient({ executionTimeoutMs: 5000 })
      })
    })
    f.services.register('notebookTool.execute', (params, context) =>
      executor.execute(params as Parameters<typeof executor.execute>[0], { signal: context.signal })
    )
    try {
      const invalid = await f.call('notebook.run_cell', {
        path: '../outside.ipynb',
        cellId: 'cell-1'
      })
      assert.equal(invalid.isError, true)
      await f.scope.captureNotebookExecutionDrain('phi-main-run')()
      assert.equal(
        kernel.executions.length,
        0,
        'ordinary validation failure remains a recoverable tool error'
      )
      kernel.holdInterruptAcknowledgements()
      let settled = false
      const execution = f
        .call('notebook.run_cell', { path: 'notebooks/selected.ipynb', cellId: 'cell-1' })
        .finally(() => {
          settled = true
        })
      const rejected = assert.rejects(execution)
      await waitForJupyter(() => kernel.executions.length === 1)
      const originalDrain = f.scope.captureNotebookExecutionDrain('phi-main-run')
      f.controller.abort(new Error('owned kernel stopped'))
      await waitForJupyter(() => kernel.interrupts.length === 1)
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(
        settled,
        false,
        'scope must retain the genuine executor promise while physical stop is unconfirmed'
      )
      if (outcome === 'unconfirmed') {
        await kernel.close()
        closed = true
        await rejected
        const lateDrain = f.scope.captureNotebookExecutionDrain('phi-main-run')
        peer = await startJupyterProtocolFixture()
        connection = { ...peer.connection, runtimeId: 'scope-replacement-runtime' }
        f.setRun({ id: 'replacement-real-run', signal: new AbortController().signal })
        const replacement = f.call('notebook.run_cell', {
          path: 'notebooks/selected.ipynb',
          cellId: 'cell-1'
        })
        await waitForJupyter(() => peer!.executions.length === 1)
        await assert.rejects(lateDrain(), /Notebook 停止未确认/)
        await assert.rejects(originalDrain(), /Notebook 停止未确认/)
        assert.deepEqual(
          peer.interrupts,
          [],
          'old drain cannot cancel or await the successor kernel'
        )
        peer.finish(peer.executions[0], 'replacement remains live')
        const result = await replacement
        assert.equal(result.isError, undefined)
        return
      }
      kernel.acknowledgeInterrupts()
      await new Promise((resolve) => setImmediate(resolve))
      assert.equal(settled, false)
      kernel.finish(kernel.executions[0], 'late output', 'error')
      await rejected
    } finally {
      f.close()
      if (!closed) await kernel.close()
      await peer?.close()
      await Promise.all(remote.sessions.map((session) => session.close()))
      remote.cleanup()
    }
  })

test('remote present builder invokes existing remote validation and preserves SSH references/details', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  let inspected = 0
  f.services.register('deliverables.present', async (params, context) => {
    const request = record(params)
    assert.equal(request.runtimeSessionId, 'runtime-session')
    assert.equal(request.toolCallId, 'present-call')
    assert.ok(context.signal instanceof AbortSignal)
    assert.deepEqual(
      { originSessionId: context.originSessionId, toolCallId: context.toolCallId },
      { originSessionId: 'runtime-session', toolCallId: 'present-call' }
    )
    return {
      files: await validateRemotePresentedFiles(
        { sessionId: 'phi-session', projectId: 'project' },
        request.files,
        {
          inspect: async (path, identity) => {
            assert.deepEqual(identity, { sessionId: 'phi-session', projectId: 'project' })
            assert.equal(path, 'reports/final.txt')
            inspected++
            return {
              path: 'ssh://selected/server/project/reports/final.txt',
              displayPath: 'reports/final.txt',
              bytes: 31,
              identity: '/server/project/reports/final.txt'
            }
          }
        }
      )
    }
  })
  const output = await f.call(
    'present_files',
    { files: [{ path: 'reports/final.txt', description: 'Final report' }] },
    'present-call'
  )
  assert.equal(output.isError, undefined)
  assert.deepEqual(output.details, {
    kind: 'presented_files',
    files: [
      {
        path: 'ssh://selected/server/project/reports/final.txt',
        displayPath: 'reports/final.txt',
        bytes: 31,
        description: 'Final report'
      }
    ]
  })
  assert.equal(inspected, 1)
  const invalid = await f.call(
    'present_files',
    { files: [{ path: '../desktop-file' }] },
    'present-call'
  )
  assert.equal(invalid.isError, true)
  assert.equal(inspected, 1)
})

test('real wrapper host client/handler/manager preserve trusted origin and unavailable project refuses execution', async (t) => {
  const f = desktopToolsFixture()
  t.after(() => f.close())
  const origins: Array<string | undefined> = []
  const jobs = new WrapperJobManager({
    agentDir: () => join(f.root, 'agent'),
    resolveProjectForRun: (origin) => {
      origins.push(origin)
      return undefined
    }
  })
  const methods: string[] = []
  for (const [method, handler] of Object.entries(wrapperJobHostHandlers(jobs)))
    f.services.register(method, (params, context) => {
      methods.push(method)
      assert.equal(context.originSessionId, 'runtime-session')
      assert.equal(context.toolCallId, 'wrapper-call')
      return handler(params)
    })
  const unavailable = await f.call(
    'wrapper_run',
    { id: 'synthetic/missing-wrapper', originSessionId: 'forged' },
    'wrapper-call'
  )
  assert.equal(unavailable.isError, true)
  assert.deepEqual(origins, ['runtime-session'])
  assert.deepEqual(methods, ['wrapperJob.start'])
  await assert.rejects(
    f.call('wrapper_run', { id: 'synthetic/missing-wrapper', target: 'local' }, 'wrapper-call'),
    /cannot run a wrapper on the desktop/
  )
  assert.deepEqual(methods, ['wrapperJob.start'])
  const status = await f.call('wrapper_status', { run_id: 'missing-run' }, 'wrapper-call')
  assert.equal(status.isError, true)
  assert.deepEqual(methods, ['wrapperJob.start', 'wrapperJob.status'])
})
