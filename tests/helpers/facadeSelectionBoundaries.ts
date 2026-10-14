import assert from 'node:assert/strict'
import { mock } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import type { RuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import { createRuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import { createAppRemoteSessionManager } from '../../src/main/agent/remote-session-routing'
import { RpcConnection } from '../../src/main/agent/engine/rpc/connection'
import type { RpcCommand, RpcRequestOptions } from '../../src/main/agent/engine/rpc/types'
import {
  createPhiSession,
  createRunId,
  findPhiSessionById
} from '../../src/main/agent/session/session-store'
import { getRemoteHostProfile, saveRemoteHostProfile } from '../../src/main/agent/remote-hosts'
import { NotebookToolHostRouter } from '../../src/main/agent/notebook/notebook-tool-host-router'
import { RemoteAnalysisNotebookBackend } from '../../src/main/agent/notebook/remote-analysis-notebook-backend'
import { AnalysisNotebookExecutor } from '../../src/main/agent/notebook/analysis-jupyter-execution'
import { SshHost } from '../../src/main/agent/workspace-host/ssh-host'
import type { NotebookToolRequest } from '../../src/main/agent/notebook/notebook-tools'
import type { RpcChildRuntimeConfig } from '../../src/main/agent/engine/phi-extension/lib/rpc-child-config'

function gate(): { promise: Promise<void>; release(): void } {
  let release!: () => void
  return {
    promise: new Promise<void>((resolve) => {
      release = resolve
    }),
    release: () => release()
  }
}
async function until(check: () => boolean): Promise<void> {
  const start = Date.now()
  while (!check()) {
    assert.ok(Date.now() - start < 15000, 'selection boundary not reached')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
export async function runSelectionBoundary(
  f: FacadeMetadataFixture,
  proxy: RuntimeAgentSession,
  mode: string,
  oldInterrupted?: (error: Error) => void
): Promise<void> {
  const original = findPhiSessionById(f.phi.sessionId)!
  if (mode === 'invalid') {
    const catalog = await f.engine.models.snapshot({ agentDir: process.env.PI_CODING_AGENT_DIR! })
    assert.ok(catalog.models.length > 256, 'real registry exceeds private lease maximum')
    await assert.rejects(
      proxy.setModel({ ...f.model('model-b'), id: 'not-in-main-registry' }),
      /unavailable/
    )
    await assert.rejects(proxy.setThinkingLevel('max'), /Unsupported/)
    const snapshot = f.engine.models.snapshot.bind(f.engine.models)
    // Fault: trusted desktop metadata advertises more than this actual SDK lineage supports.
    const mismatch = mock.method(
      f.engine.models,
      'snapshot',
      async (...args: Parameters<typeof snapshot>) => {
        const actual = await snapshot(...args)
        return {
          ...actual,
          models: actual.models.map((model) =>
            model.provider === f.model('model-a').provider && model.id === 'model-a'
              ? {
                  ...model,
                  thinkingLevelMap: { ...model.thinkingLevelMap, xhigh: 'xhigh', max: 'max' }
                }
              : model
          )
        }
      }
    )
    try {
      await assert.rejects(proxy.setThinkingLevel('max'), /does not support/)
      assert.equal(f.channels.length, 1, 'invalid controls cannot retire the live generation')
      assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.runtimeRef, original.runtimeRef)
      assert.equal(f.provider.requests.length, 0)
      // The actual SDK must confirm a supported level after the main metadata changes.
      await proxy.setThinkingLevel('xhigh')
      assert.equal(proxy.thinkingLevel, 'xhigh')
      assert.equal(findPhiSessionById(f.phi.sessionId)!.thinkingLevel, 'xhigh')
      assert.ok(f.leases.every((lease) => lease.models.length <= 2))
    } finally {
      mismatch.mock.restore()
    }
    return
  }
  if (mode.startsWith('lookup-')) {
    const reached = gate(),
      held = gate()
    const snapshot = f.engine.models.snapshot.bind(f.engine.models)
    const probe = mock.method(
      f.engine.models,
      'snapshot',
      async (...args: Parameters<typeof snapshot>) => {
        reached.release()
        await held.promise
        return snapshot(...args)
      }
    )
    const location = original.projectLocation!
    assert.equal(location.kind, 'ssh')
    if (location.kind !== 'ssh') throw new Error('Expected remote project')
    const host = getRemoteHostProfile(location.hostProfileId)!
    try {
      const pending = proxy.setModel(f.model('model-b'))
      const rejected = assert.rejects(pending, /cancel|绑定|changed/)
      await reached.promise
      let stopping: Promise<void> | undefined
      if (mode === 'lookup-abort') {
        stopping = proxy.abort()
        void stopping.catch(() => undefined)
      } else saveRemoteHostProfile({ ...host, hostAlias: 'rebound-synthetic-no-ssh' })
      held.release()
      await rejected
      if (stopping) await assert.rejects(stopping, /cancel/)
      assert.equal(f.channels.length, 1)
      assert.equal(f.provider.requests.length, 0)
      assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.model, original.model)
      assert.deepEqual(findPhiSessionById(f.phi.sessionId)!.runtimeRef, original.runtimeRef)
    } finally {
      held.release()
      probe.mock.restore()
      saveRemoteHostProfile(host)
    }
    return
  }
  if (mode === 'late-ack') {
    const reached = gate(),
      held = gate()
    const request = RpcConnection.prototype.request
    const probe = mock.method(
      RpcConnection.prototype,
      'request',
      function (this: RpcConnection, command: RpcCommand, options?: RpcRequestOptions) {
        const reply = request.call(this, command, options)
        if (command.type !== 'set_thinking_level' || command.level !== 'low') return reply
        return reply.then(async (value) => {
          reached.release()
          await held.promise
          return value
        })
      }
    )
    try {
      const pending = proxy.setThinkingLevel('low')
      const rejected = assert.rejects(pending, /cancel|closed|abort/)
      await reached.promise // Official CLI already acknowledged a durable thinking change.
      assert.equal(findPhiSessionById(f.phi.sessionId)!.thinkingLevel, 'high')
      const stopping = proxy.abort()
      void stopping.catch(() => undefined)
      held.release()
      await rejected
      await assert.rejects(stopping, /cancel|closed|abort/)
      assert.equal(f.engine.sessions.has(proxy.runtimeSessionId), false)
      assert.equal(findPhiSessionById(f.phi.sessionId)!.thinkingLevel, 'high')
      probe.mock.restore()
      f.resume()
      const fresh = (await f.createApplicationSession()).session
      try {
        assert.equal(fresh.thinkingLevel, 'high', 'explicit restore confirms saved Phi policy')
        assert.equal(
          findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
          original.runtimeRef!.journalBasename
        )
        assert.equal(f.provider.requests.length, 0)
        assert.equal(f.engine.sessions.has(fresh.runtimeSessionId), true)
      } finally {
        await fresh.dispose()
      }
    } finally {
      held.release()
      probe.mock.restore()
    }
    return
  }
  if (mode !== 'resource-child') throw new Error('Unknown selection boundary mode')
  const root = f.f.scope.projectRoot
  await mkdir(join(root, 'notebooks'))
  const path = join(root, 'notebooks/selection.ipynb')
  await writeFile(
    path,
    JSON.stringify({
      nbformat: 4,
      nbformat_minor: 5,
      metadata: {},
      cells: [
        {
          id: 'cell-1',
          cell_type: 'code',
          execution_count: null,
          metadata: {},
          outputs: [],
          source: 'selection_survives = 1'
        }
      ]
    })
  )
  const backend = new RemoteAnalysisNotebookBackend({
    projectCwd: root,
    projectName: 'Selection project',
    serverLabel: 'Loopback fixture',
    runtimeSessionId: proxy.runtimeSessionId,
    micromambaVersion: 'unused-authoring-only',
    projectId: original.projectId!,
    projectHost: new SshHost({
      remoteRoot: root,
      canonicalRoot: root,
      connect: async () => ({ ...f.f.session, ...f.hostSession, close: async () => undefined })
    }),
    openWorkspace: async () => {
      throw new Error('No Jupyter provisioning')
    },
    connection: { host: 'synthetic-no-ssh' },
    confirmEnvironment: async () => {
      throw new Error('No environment prompt')
    },
    notebookExecutor: new AnalysisNotebookExecutor()
  })
  let reads = 0
  const router = new NotebookToolHostRouter({
    local: async () => {
      throw new Error('No local anchor fallback')
    },
    isRemoteCwd: () => true,
    resolveRemote: async (identity) => {
      assert.deepEqual(identity, {
        runtimeSessionId: proxy.runtimeSessionId,
        sessionId: f.phi.sessionId,
        projectId: original.projectId
      })
      return {
        projectCwd: root,
        execute: async (request, control) => {
          reads++
          return backend.tools.execute(request, control)
        }
      }
    }
  })
  const detach = f.engine.host.register('notebookTool.execute', (raw, context) => {
    assert.equal(context.originSessionId, proxy.runtimeSessionId)
    return router.execute(raw as NotebookToolRequest, { signal: context.signal })
  })
  const peerPhi = createPhiSession({
    kind: 'project',
    cwd: original.cwd,
    cwdRealPath: original.cwdRealPath,
    projectId: original.projectId,
    projectLocation: original.projectLocation,
    permissionMode: 'ask',
    model: original.model,
    thinkingLevel: 'high'
  })
  const peer = (
    await createRuntimeAgentSession({
      cwd: original.cwd,
      agentDir: process.env.PI_CODING_AGENT_DIR!,
      model: f.model('model-a'),
      thinkingLevel: 'high',
      projectBound: true,
      sessionManager: createAppRemoteSessionManager(original.cwd, peerPhi.sessionId, false),
      remoteProject: { ...f.params('unused').remoteProject!, phiSessionId: peerPhi.sessionId }
    })
  ).session
  console.log('selection resource boundary: actual peer ready')
  f.configureApproval({
    shouldGate: () => false,
    requestToolApproval: () => {
      throw new Error('Unexpected read approval')
    }
  })
  f.provider.enqueue({ text: 'Peer remains active', hold: true })
  const peerRun = f.runners.startRun({
    sessionId: peerPhi.sessionId,
    runId: createRunId(),
    execute: () => peer.prompt('Independent peer')
  })
  await until(() => f.provider.requests.length === 1)
  console.log('selection resource boundary: peer model request held')
  const peerReference = findPhiSessionById(peerPhi.sessionId)!.runtimeRef
  try {
    await proxy.setModel(f.model('model-b'))
    console.log('selection resource boundary: main model confirmed')
    oldInterrupted?.(new Error('Synthetic delayed old-generation EOF'))
    assert.equal(f.engine.sessions.has(proxy.runtimeSessionId), true)
    assert.equal(peerRun.signal.aborted, false)
    assert.equal(f.engine.sessions.has(peer.runtimeSessionId), true)
    assert.deepEqual(findPhiSessionById(peerPhi.sessionId)!.runtimeRef, peerReference)
    f.provider.enqueue(
      { tool: { name: 'notebook.read', args: { path: 'notebooks/selection.ipynb' } } },
      { text: 'Notebook remains available' }
    )
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy.prompt('Read the selected Notebook after model rotation')
    })
    await run.done
    console.log('selection resource boundary: Notebook run settled', run.outcome)
    assert.equal(run.outcome, 'completed')
    assert.equal(reads, 1)
    assert.match(JSON.stringify(proxy.messages), /selection_survives = 1/)
    assert.equal(f.provider.requests[1].model, 'model-b')
    const configs = await Promise.all(
      (await f.privateDirectories()).map(
        async (dir) =>
          JSON.parse(
            await readFile(join(dir, 'child-runtime.json'), 'utf8')
          ) as RpcChildRuntimeConfig
      )
    )
    const config = configs.find((value) => value.phiSessionId === f.phi.sessionId)
    assert.ok(config, 'rotated main foreground configuration')
    const profile = config.profiles[0]
    assert.equal(profile.model.id, 'model-b')
    assert.equal(profile.definition.thinkingLevel, 'off')
    f.provider.enqueue(
      {
        tool: {
          name: 'task',
          args: {
            i: 'Run a bounded check',
            agent: profile.definition.nativeName,
            name: 'selection-check',
            task: 'Return the selected model identity',
            solutionSpace: 'Private fixture'
          }
        }
      },
      { text: 'Child follows confirmed model' },
      { text: 'Parent done' }
    )
    const child = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy.prompt('Delegate one explicit foreground check')
    })
    await child.done
    console.log('selection resource boundary: foreground child settled', child.outcome)
    assert.equal(child.outcome, 'completed')
    assert.ok(f.provider.requests.slice(1).every((request) => request.model === 'model-b'))
    assert.equal(peerRun.signal.aborted, false)
    assert.equal(findPhiSessionById(peerPhi.sessionId)!.thinkingLevel, 'high')
  } finally {
    f.runners.stopRun(peerPhi.sessionId)
    await peer.abort()
    await peerRun.done
    await peer.dispose()
    detach()
    await backend.dispose()
  }
}
