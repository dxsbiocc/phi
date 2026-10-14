import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { FacadeMetadataFixture } from './facadeMetadataFixture'
import { NotebookToolHostRouter } from '../../src/main/agent/notebook/notebook-tool-host-router'
import { createPhiSession, createRunId } from '../../src/main/agent/session/session-store'

const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
async function waitFor(check: () => boolean): Promise<void> {
  const began = Date.now()
  while (!check()) {
    assert.ok(Date.now() - began < 15000)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
/** Actual curated Notebook builder, host registry and remote router; the app backend is a private file marker. */
export async function runForegroundHostStop(f: FacadeMetadataFixture): Promise<void> {
  const id = 'foreground-host-stop',
    marker = join(f.f.scope.projectRoot, 'unapproved-notebook-effect.txt')
  let effects = 0,
    decide!: (value: 'approved') => void,
    ready = false
  const router = new NotebookToolHostRouter({
    local: async () => {
      throw new Error('Local notebook fallback forbidden')
    },
    isRemoteCwd: () => true,
    resolveRemote: async (identity) => {
      assert.deepEqual(identity, {
        runtimeSessionId: id,
        sessionId: f.phi.sessionId,
        projectId: f.phi.manifest.projectId
      })
      return {
        projectCwd: f.f.scope.projectRoot,
        execute: async (request) => {
          effects++
          await writeFile(marker, request.action)
          return { summary: 'controlled actual remote service effect' }
        }
      }
    }
  })
  const detach = f.engine.host.register('notebookTool.execute', (raw, context) => {
    assert.equal(context.originSessionId, id)
    assert.ok(
      record(raw) &&
        raw.action === 'save' &&
        typeof raw.cwd === 'string' &&
        record(raw.params) &&
        record(raw.remoteProject)
    )
    const identity = raw.remoteProject
    assert.ok(
      typeof identity.runtimeSessionId === 'string' &&
        typeof identity.sessionId === 'string' &&
        typeof identity.projectId === 'string'
    )
    return router.execute({
      action: 'save',
      cwd: raw.cwd,
      params: raw.params,
      remoteProject: {
        runtimeSessionId: identity.runtimeSessionId,
        sessionId: identity.sessionId,
        projectId: identity.projectId
      }
    })
  })
  f.configureApproval({
    shouldGate: () => true,
    requestToolApproval: (request) => {
      assert.equal(request.toolName, 'notebook.save')
      assert.equal(request.sessionId, f.phi.sessionId)
      ready = true
      return new Promise((resolve) => {
        decide = resolve
      })
    }
  })
  try {
    await f.engine.sessions.create(f.params(id))
    f.provider.enqueue({
      tool: { name: 'notebook.save', id: 'actual-host-save', args: { path: 'unapproved.ipynb' } }
    })
    const run = f.runners.startRun({
      sessionId: f.phi.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.engine.sessions.prompt({
          sessionId: id,
          text: 'Wait for an actual desktop-host save approval'
        })
      }
    })
    await waitFor(() => ready || !!run.outcome)
    assert.equal(run.outcome, undefined)
    assert.equal(effects, 0)
    assert.equal(await f.exists(marker), false)
    const peer = createPhiSession({
      kind: 'project',
      projectId: f.phi.manifest.projectId,
      projectLocation: f.phi.manifest.projectLocation,
      cwd: f.phi.manifest.cwd,
      cwdRealPath: f.phi.manifest.cwdRealPath,
      permissionMode: 'ask',
      model: f.phi.manifest.model,
      thinkingLevel: 'high'
    })
    const params = f.params('foreground-host-peer')
    params.remoteProject = { ...params.remoteProject!, phiSessionId: peer.sessionId }
    await f.engine.sessions.create(params)
    f.provider.enqueue({ text: 'independent host peer streaming', hold: true })
    const peerRun = f.runners.startRun({
      sessionId: peer.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.engine.sessions.prompt({ sessionId: params.sessionId, text: 'Keep peer active' })
      }
    })
    await waitFor(() => f.provider.requests.length === 2)
    f.runners.stopRun(run.sessionId)
    await f.engine.sessions.abort({ sessionId: id })
    await run.done
    decide('approved')
    assert.equal(run.outcome, 'stopped')
    assert.equal(effects, 0)
    assert.equal(await f.exists(marker), false)
    assert.equal(
      f.provider.requests.length,
      2,
      'revoked MAIN host approval must not continue the provider'
    )
    assert.equal(peerRun.signal.aborted, false)
    f.provider.enqueue({ text: 'next explicitly submitted turn after host stop' })
    const next = f.runners.startRun({
      sessionId: run.sessionId,
      runId: createRunId(),
      execute: async () => {
        await f.engine.sessions.prompt({ sessionId: id, text: 'Continue with a model-only turn' })
      }
    })
    await next.done
    assert.equal(next.outcome, 'completed')
    assert.equal(f.provider.requests.length, 3)
    assert.equal(peerRun.signal.aborted, false)
    await f.engine.sessions.abort({ sessionId: params.sessionId })
    await peerRun.done
    assert.equal(peerRun.outcome, 'stopped')
    console.log(
      'R6-enabled real MAIN host approval stop has no effect/provider continuation and preserves peer/next turn'
    )
  } finally {
    detach()
  }
}
