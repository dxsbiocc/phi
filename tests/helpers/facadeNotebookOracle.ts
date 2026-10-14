import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import { RemoteAnalysisNotebookBackend } from '../../src/main/agent/notebook/remote-analysis-notebook-backend'
import { AnalysisNotebookExecutor } from '../../src/main/agent/notebook/analysis-jupyter-execution'
import { NotebookToolHostRouter } from '../../src/main/agent/notebook/notebook-tool-host-router'
import type { NotebookToolRequest } from '../../src/main/agent/notebook/notebook-tools'
import { SshHost } from '../../src/main/agent/workspace-host/ssh-host'
import {
  createPhiSession,
  createRunId,
  findPhiSessionById,
  readSessionEvents
} from '../../src/main/agent/session/session-store'
import { resolveRemoteWorkspaceHostBinding } from '../../src/main/agent/remote-workspace-boundary'
import { getRemoteHostProfile, saveRemoteHostProfile } from '../../src/main/agent/remote-hosts'
import { createRemoteProject } from '../../src/main/agent/projects'
import { ensureRemoteProjectAnchor } from '../../src/main/agent/remote-project-anchor'
import { createRuntimeAgentSession } from '../../src/main/agent/runtime/runtime-adapter'
import {
  createAppRemoteSessionManager,
  APP_RPC_NOTEBOOK_TOOL_NAMES
} from '../../src/main/agent/remote-session-routing'
import { createLocalShellSession } from './localShellSession'

async function waitFor(check: () => boolean): Promise<void> {
  const started = Date.now()
  while (!check()) {
    assert.ok(Date.now() - started < 15000, 'Notebook scenario did not reach its boundary')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
const body = (source: string): string =>
  JSON.stringify({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      { id: 'cell-1', cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source }
    ]
  })

export async function runApplicationNotebookScenario(
  f: FacadeMetadataFixture,
  mode: string
): Promise<void> {
  const root = f.f.scope.projectRoot,
    path = join(root, 'notebooks/analysis.ipynb')
  await mkdir(join(root, 'notebooks'))
  const original = body('x = 1')
  await writeFile(path, original)
  const proxy = (await f.createApplicationSession()).session
  const id = proxy.runtimeSessionId
  let activeRuntimeId = id
  const identity = {
    runtimeSessionId: id,
    sessionId: f.phi.sessionId,
    projectId: f.phi.manifest.projectId!
  }
  const selectedHost = getRemoteHostProfile(
    f.phi.manifest.projectLocation!.kind === 'ssh'
      ? f.phi.manifest.projectLocation!.hostProfileId
      : ''
  )!
  const effects: string[] = []
  let pendingSave: ((value: 'approved') => void) | undefined
  let lookupReady = false,
    releaseLookup: (() => void) | undefined
  const createBackend = (
    projectRoot: string,
    runtimeSessionId: string,
    projectId: string
  ): RemoteAnalysisNotebookBackend =>
    new RemoteAnalysisNotebookBackend({
      projectCwd: projectRoot,
      projectName: 'Selected Notebook project',
      serverLabel: 'Loopback fixture',
      runtimeSessionId,
      micromambaVersion: 'unused-authoring-only',
      projectId,
      projectHost: new SshHost({
        remoteRoot: projectRoot,
        canonicalRoot: projectRoot,
        connect: async () => ({
          ...f.f.session,
          ...f.hostSession,
          close: async () => undefined
        })
      }),
      openWorkspace: async () => {
        throw new Error('Notebook authoring must not provision Jupyter')
      },
      connection: { host: 'synthetic-no-ssh' },
      confirmEnvironment: async () => {
        throw new Error('unexpected environment prompt')
      },
      notebookExecutor: new AnalysisNotebookExecutor()
    })
  const backend = createBackend(root, id, identity.projectId)
  const router = new NotebookToolHostRouter({
    local: async () => {
      throw new Error('Local Notebook anchor fallback forbidden')
    },
    isRemoteCwd: () => true,
    resolveRemote: async (requested) => {
      assert.deepEqual(requested, { ...identity, runtimeSessionId: activeRuntimeId })
      if (mode.startsWith('notebook-lookup-')) {
        lookupReady = true
        await new Promise<void>((resolve) => {
          releaseLookup = resolve
        })
      }
      return {
        projectCwd: root,
        execute: async (request) => {
          effects.push(request.action)
          return backend.tools.execute(request)
        }
      }
    }
  })
  const detach = f.engine.host.register('notebookTool.execute', (raw, context) => {
    const request = raw as NotebookToolRequest
    assert.equal(context.originSessionId, activeRuntimeId)
    assert.ok(
      context.signal instanceof AbortSignal,
      'RPC passes cancellation only through local service context'
    )
    assert.deepEqual(request.remoteProject, { ...identity, runtimeSessionId: activeRuntimeId })
    assert.equal('signal' in request, false)
    const binding = resolveRemoteWorkspaceHostBinding({
      sessionId: identity.sessionId,
      projectId: identity.projectId
    })
    return router.execute(request, {
      signal: context.signal,
      beforeDispatch: () => {
        assert.equal(
          resolveRemoteWorkspaceHostBinding({
            sessionId: identity.sessionId,
            projectId: identity.projectId
          }).cacheKey,
          binding.cacheKey,
          'Notebook host binding changed'
        )
      }
    })
  })
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: async (request) => {
      assert.equal(request.sessionId, f.phi.sessionId)
      if (request.toolName === 'notebook.update_cell') return 'approved'
      assert.equal(request.toolName, 'notebook.save')
      assert.equal(
        await readFile(path, 'utf8'),
        original,
        'approved draft mutation must not save to disk'
      )
      const draft = await backend.tools.execute({
        action: 'read',
        cwd: root,
        params: { path: 'notebooks/analysis.ipynb' }
      })
      assert.equal((draft.cells as Array<{ source: string }>)[0].source, 'x = 2')
      if (mode === 'notebook-denied') return 'denied'
      if (mode === 'notebook-pending-stop')
        return new Promise((resolve) => {
          pendingSave = resolve
        })
      return 'approved'
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
  let peerBackend: RemoteAnalysisNotebookBackend | undefined
  let peerRun: ReturnType<typeof f.runners.startRun> | undefined
  let peerProxy: Awaited<ReturnType<typeof createRuntimeAgentSession>>['session'] | undefined
  try {
    if (mode.startsWith('notebook-lookup-')) {
      f.provider.enqueue(
        {
          tool: {
            name: 'notebook.save',
            id: 'held-notebook-save',
            args: { path: 'notebooks/analysis.ipynb' }
          }
        },
        { text: 'save refused after stale lookup' }
      )
      // This branch approves the target save without any preceding draft update.
      f.configureApproval({
        shouldGate: () => false,
        requestToolApproval: () => {
          throw new Error('unexpected approval')
        }
      })
    } else
      f.provider.enqueue(
        { tool: { name: 'notebook.list', args: {} } },
        { tool: { name: 'notebook.read', args: { path: 'notebooks/analysis.ipynb' } } },
        {
          tool: {
            name: 'notebook.update_cell',
            args: { path: 'notebooks/analysis.ipynb', cellId: 'cell-1', source: 'x = 2' }
          }
        },
        { tool: { name: 'notebook.save', args: { path: 'notebooks/analysis.ipynb' } } },
        ...(mode === 'notebook-pending-stop' ? [] : [{ text: 'Notebook authoring complete' }])
      )
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: () => proxy.prompt('Read, update, and save the selected project Notebook')
    })
    if (mode.startsWith('notebook-lookup-')) {
      await waitFor(() => lookupReady || !!run.outcome)
      assert.equal(lookupReady, true)
      if (mode === 'notebook-lookup-stop') {
        f.runners.stopRun(f.phi.sessionId)
        await proxy.abort()
      } else saveRemoteHostProfile({ ...selectedHost, hostAlias: 'replacement-no-ssh-host' })
      releaseLookup!()
      if (mode === 'notebook-lookup-stop') await run.done
      else {
        await run.done
        assert.match(
          JSON.stringify(f.provider.requests.at(-1)?.messages),
          /Notebook host binding changed/
        )
      }
      assert.deepEqual(effects, [])
      assert.equal(await readFile(path, 'utf8'), original)
      assert.equal(await f.exists(join(f.phi.manifest.cwd, 'notebooks/analysis.ipynb')), false)
      return
    }
    if (mode === 'notebook-pending-stop') {
      await waitFor(() => !!pendingSave || !!run.outcome)
      assert.ok(pendingSave)
      const peerRoot = join(root, 'peer-project')
      await mkdir(peerRoot)
      await mkdir(join(peerRoot, 'notebooks'))
      const peerNotebookPath = join(peerRoot, 'notebooks/analysis.ipynb')
      const peerDisk = body('peer = 9')
      await writeFile(peerNotebookPath, peerDisk)
      const project = await createRemoteProject(
        {
          name: 'Notebook peer project',
          hostProfileId: selectedHost.id,
          remoteRoot: peerRoot,
          permissionMode: 'ask'
        },
        { connectImpl: async () => createLocalShellSession() }
      )
      const anchor = ensureRemoteProjectAnchor(project.id)
      const peer = createPhiSession({
        kind: 'project',
        projectId: project.id,
        projectLocation: project.location,
        cwd: anchor,
        cwdRealPath: anchor,
        permissionMode: 'ask',
        model: f.phi.manifest.model,
        thinkingLevel: 'high'
      })
      assert.equal(project.location.kind, 'ssh')
      if (project.location.kind !== 'ssh') throw new Error('Expected SSH peer project')
      peerProxy = (
        await createRuntimeAgentSession({
          cwd: anchor,
          model: f.model('model-a'),
          thinkingLevel: 'high',
          projectBound: true,
          sessionManager: createAppRemoteSessionManager(anchor, peer.sessionId, false),
          remoteProject: {
            phiSessionId: peer.sessionId,
            projectId: project.id,
            location: project.location,
            contextFiles: []
          }
        })
      ).session
      peerBackend = createBackend(peerRoot, peerProxy.runtimeSessionId, project.id)
      await peerBackend.tools.execute({
        action: 'read',
        cwd: peerRoot,
        params: { path: 'notebooks/analysis.ipynb' }
      })
      await peerBackend.tools.execute({
        action: 'update_cell',
        cwd: peerRoot,
        params: { path: 'notebooks/analysis.ipynb', cellId: 'cell-1', source: 'peer = 10' }
      })
      // The primary save is still unapproved; the next provider request belongs only to the peer.

      f.provider.enqueue({ text: 'independent Notebook peer', hold: true })
      peerRun = f.runners.startRun({
        sessionId: peer.sessionId,
        runId: createRunId(),
        execute: () => peerProxy!.prompt('Keep the independent project active')
      })
      await waitFor(() => f.provider.requests.length >= 5)
      f.runners.stopRun(f.phi.sessionId)
      await proxy.abort()
      await run.done
      pendingSave('approved')
      assert.equal(run.outcome, 'stopped')
      assert.equal(peerRun.signal.aborted, false)
      assert.equal(peerRun.outcome, undefined)
      assert.equal(peerBackend.projectCwd, peerRoot)
      const peerDraft = await peerBackend.tools.execute({
        action: 'read',
        cwd: peerRoot,
        params: { path: 'notebooks/analysis.ipynb' }
      })
      assert.equal((peerDraft.cells as Array<{ source: string }>)[0].source, 'peer = 10')
      assert.equal(await readFile(peerNotebookPath, 'utf8'), peerDisk)
    } else await run.done
    const roster = (f.provider.requests[0].tools as Array<{ function?: { name: string } }>).map(
      (tool) => tool.function?.name
    )
    for (const name of APP_RPC_NOTEBOOK_TOOL_NAMES)
      assert.ok(roster.includes(name), `application did not expose ${name}`)
    assert.equal(roster.includes('notebook.run_cell'), true)
    assert.deepEqual(
      effects,
      mode === 'notebook-approved'
        ? ['list', 'read', 'update_cell', 'save']
        : ['list', 'read', 'update_cell']
    )
    if (mode !== 'notebook-approved') assert.equal(await readFile(path, 'utf8'), original)
    const saved = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(
      [saved.cells[0].source].flat().join(''),
      mode === 'notebook-approved' ? 'x = 2' : 'x = 1'
    )
    const approvals = readSessionEvents(f.phi.sessionId).filter((event) =>
      event.type.startsWith('approval_')
    )
    assert.deepEqual(
      approvals.map((event) => event.type),
      [
        'approval_requested',
        'approval_approved',
        'approval_requested',
        mode === 'notebook-denied'
          ? 'approval_denied'
          : mode === 'notebook-pending-stop'
            ? 'approval_cancelled'
            : 'approval_approved'
      ]
    )
    assert.equal(new Set(approvals.map((event) => event.approvalId)).size, 2)
    if (mode === 'notebook-approved') {
      const reference = findPhiSessionById(f.phi.sessionId)!.runtimeRef!
      const before = f.provider.requests.length
      await proxy.dispose()
      f.resume()
      const fresh = (await f.createApplicationSession()).session
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.ompSessionId,
        reference.ompSessionId
      )
      assert.equal(
        findPhiSessionById(f.phi.sessionId)!.runtimeRef!.journalBasename,
        reference.journalBasename
      )
      assert.equal(
        f.provider.requests.length,
        before,
        'explicit resume cannot replay Notebook tools or model requests'
      )
      activeRuntimeId = fresh.runtimeSessionId
      f.provider.enqueue(
        { tool: { name: 'notebook.read', args: { path: 'notebooks/analysis.ipynb' } } },
        { text: 'Recovered Notebook binding is unchanged' }
      )
      const resumedRun = f.runners.startRun({
        sessionId: f.phi.sessionId,
        runId: createRunId(),
        execute: () => fresh.prompt('Read the saved Notebook after explicit recovery')
      })
      await resumedRun.done
      assert.equal(resumedRun.outcome, 'completed')
      assert.equal(effects.at(-1), 'read')
      assert.match(JSON.stringify(f.provider.requests.at(-1)?.messages), /x = 2/)
      await fresh.dispose()
    }
  } finally {
    releaseLookup?.()
    saveRemoteHostProfile(selectedHost)
    if (peerProxy) {
      await peerProxy.abort().catch(() => undefined)
      await peerRun?.done.catch(() => undefined)
      await peerProxy.dispose().catch(() => undefined)
    }
    detach()
    await peerBackend?.dispose()
    await backend.dispose()
  }
}
