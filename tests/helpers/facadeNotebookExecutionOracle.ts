import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import {
  AnalysisNotebookExecutor,
  WebSocketJupyterKernelClient
} from '../../src/main/agent/notebook/analysis-jupyter-execution'
import { AnalysisNotebookSessionRegistry } from '../../src/main/agent/notebook/analysis-jupyter-sessions'
import { AnalysisNotebookToolExecutor } from '../../src/main/agent/notebook/notebook-tool-executor'
import { NotebookToolHostRouter } from '../../src/main/agent/notebook/notebook-tool-host-router'
import type { NotebookToolRequest } from '../../src/main/agent/notebook/notebook-tools'
import { createNotebookWorkspace } from '../../src/main/agent/notebook/notebook-workspace'
import { SshHost } from '../../src/main/agent/workspace-host/ssh-host'
import { resolveRemoteWorkspaceHostBinding } from '../../src/main/agent/remote-workspace-boundary'
import {
  createRunId,
  findPhiSessionById,
  readSessionEvents
} from '../../src/main/agent/session/session-store'
import { startJupyterProtocolFixture, waitForJupyter } from './jupyterProtocolFixture'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import { mock } from 'node:test'

export async function runApplicationNotebookExecutionScenario(
  f: FacadeMetadataFixture,
  mode: string
): Promise<void> {
  const kernel = await startJupyterProtocolFixture()
  let kernelClosed = false
  let unconfirmed: unknown
  const root = f.f.scope.projectRoot
  const path = join(root, 'notebooks/execute.ipynb')
  await mkdir(join(root, 'notebooks'), { recursive: true })
  const original = JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: { kernelspec: { name: 'python3', display_name: 'Python 3', language: 'python' } },
    cells: [
      {
        id: 'cell-1',
        cell_type: 'code',
        source: 'print("selected app kernel")',
        metadata: {},
        outputs: [],
        execution_count: null
      }
    ]
  })
  await writeFile(path, original)
  const host = new SshHost({
    remoteRoot: root,
    canonicalRoot: root,
    connect: async () => ({ ...f.f.session, ...f.hostSession, close: async () => undefined })
  })
  const workspace = createNotebookWorkspace({ projectCwd: root, host })
  const sessions = new AnalysisNotebookSessionRegistry({ getConnection: () => kernel.connection })
  const executor = new AnalysisNotebookToolExecutor({
    resolveWorkspaceByCwd: (cwd) => (cwd === root ? { workingDirectory: root } : undefined),
    resolveNotebookWorkspaceByCwd: (cwd) => (cwd === root ? workspace : undefined),
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
    notebookSessionRegistry: sessions,
    notebookExecutor: new AnalysisNotebookExecutor({
      client: new WebSocketJupyterKernelClient({ executionTimeoutMs: 5000 })
    })
  })
  let nativeAbortAcknowledged = false
  const originalRequest = RpcConnection.prototype.request
  const requestProbe = mock.method(
    RpcConnection.prototype,
    'request',
    function (this: RpcConnection, ...args: Parameters<RpcConnection['request']>) {
      return originalRequest.apply(this, args).then((result) => {
        if (args[0].type === 'abort') nativeAbortAcknowledged = true
        return result
      })
    }
  )
  let proxy = (await f.createApplicationSession()).session
  const router = new NotebookToolHostRouter({
    local: async () => {
      throw new Error('Notebook execution cannot fall back to a local anchor')
    },
    isRemoteCwd: () => true,
    resolveRemote: async (identity) => {
      assert.equal(identity.runtimeSessionId, proxy.runtimeSessionId)
      assert.equal(identity.sessionId, f.phi.sessionId)
      assert.equal(identity.projectId, f.phi.manifest.projectId)
      return { projectCwd: root, execute: (request, control) => executor.execute(request, control) }
    }
  })
  f.engine.host.register('notebookTool.execute', (params, context) => {
    const request = params as NotebookToolRequest
    assert.equal(context.originSessionId, proxy.runtimeSessionId)
    const boundary = { sessionId: f.phi.sessionId, projectId: f.phi.manifest.projectId! }
    const binding = resolveRemoteWorkspaceHostBinding(boundary).cacheKey
    return router.execute(request, {
      signal: context.signal,
      beforeDispatch: () => {
        context.signal?.throwIfAborted()
        assert.equal(resolveRemoteWorkspaceHostBinding(boundary).cacheKey, binding)
      }
    })
  })
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: async (request) => {
      assert.ok(['notebook_run_cell', 'notebook_save'].includes(request.toolName))
      if (request.toolName === 'notebook_save') assert.equal(await readFile(path, 'utf8'), original)
      return mode === 'notebook-execution-denied' ? 'denied' : 'approved'
    },
    onEvent: (event) => {
      if (event.type === 'approval_requested')
        f.runners.markNeedsApproval(event.sessionId, event.approvalId, {
          toolName: event.request.toolName,
          summary: event.request.summary
        })
      else if (event.type === 'approval_approved')
        f.runners.markApprovalApproved(event.sessionId, event.approvalId)
      else if (event.type === 'approval_denied')
        f.runners.markApprovalDenied(event.sessionId, event.approvalId)
      else f.runners.markApprovalCancelled(event.sessionId, event.approvalId)
    }
  })
  try {
    f.provider.enqueue(
      {
        tool: {
          name: 'notebook_run_cell',
          args: { path: 'notebooks/execute.ipynb', cellId: 'cell-1' }
        }
      },
      ...(mode === 'notebook-execution-flow'
        ? [{ tool: { name: 'notebook_save', args: { path: 'notebooks/execute.ipynb' } } }]
        : []),
      { text: 'Notebook execution settled' }
    )
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy.prompt('Run the selected remote Notebook cell')
    })
    if (mode !== 'notebook-execution-denied') {
      await waitForJupyter(() => kernel.executions.length === 1)
      assert.equal(kernel.executions[0].code, 'print("selected app kernel")')
      if (mode === 'notebook-execution-stop' || mode === 'notebook-execution-unconfirmed') {
        kernel.holdInterruptAcknowledgements()
        let stopSettled = false
        f.runners.stopRun(f.phi.sessionId)
        const stopping = proxy.abort().then(
          () => {
            stopSettled = true
          },
          (error: unknown) => {
            stopSettled = true
            unconfirmed = error
          }
        )
        await waitForJupyter(() => kernel.interrupts.length === 1)
        const deadline = Date.now() + 4000
        while (!nativeAbortAcknowledged && !stopSettled) {
          assert.ok(Date.now() < deadline, 'native abort acknowledgement did not arrive')
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(
          stopSettled,
          false,
          'app stop cannot succeed before captured kernel ACK and terminal'
        )
        if (mode === 'notebook-execution-unconfirmed') {
          await kernel.close()
          kernelClosed = true
          await stopping
          assert.ok(unconfirmed instanceof Error)
          assert.match(unconfirmed.message, /Notebook 停止未确认/)
        } else {
          kernel.stream(kernel.executions[0], 'LATE_STOPPED_KERNEL_OUTPUT')
          kernel.acknowledgeInterrupts()
          await new Promise((resolve) => setTimeout(resolve, 50))
          assert.equal(stopSettled, false, 'interrupt HTTP ACK alone is not execution terminal')
          kernel.finish(kernel.executions[0], 'LATE_STOPPED_KERNEL_OUTPUT', 'error')
          await stopping
          assert.equal(unconfirmed, undefined)
        }
      } else kernel.finish(kernel.executions[0], 'selected app kernel\n')
    }
    await run.done
    if (mode === 'notebook-execution-flow') {
      assert.match(await readFile(path, 'utf8'), /selected app kernel\\n/)
      const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      const before = f.provider.requests.length
      await proxy.dispose()
      f.resume()
      proxy = (await f.createApplicationSession()).session
      assert.equal(f.provider.requests.length, before)
      assert.equal(kernel.executions.length, 1, 'restore never replays the cell')
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
        reference.journalBasename
      )
      assert.equal(
        readSessionEvents(f.phi.sessionId).filter((event) => event.type === 'approval_requested')
          .length,
        2
      )
    } else {
      assert.equal(await readFile(path, 'utf8'), original)
      assert.doesNotMatch(JSON.stringify(proxy.messages), /LATE_STOPPED_KERNEL_OUTPUT/)
      if (mode === 'notebook-execution-denied') assert.equal(kernel.executions.length, 0)
      else assert.deepEqual(kernel.interrupts, [kernel.executions[0].kernelId])
    }
    assert.equal(await f.exists(join(f.phi.manifest.cwd, 'notebooks/execute.ipynb')), false)
  } finally {
    requestProbe.mock.restore()
    await proxy.dispose().catch((error: unknown) => {
      if (!unconfirmed) throw error
      assert.ok(error instanceof Error)
      assert.match(error.message, /Notebook 停止未确认/)
    })
    if (!kernelClosed) await kernel.close()
    await host.close()
  }
}
