import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createRpcTaskAdmissionExtension,
  type RpcTaskParentRun
} from '../src/main/agent/engine/phi-extension/extensions/rpc-task-admission'
import { childProfile } from './helpers/rpcChildAuthorityFixture'

type SyntheticManager = { getSessionId(): string }
interface SyntheticSession {
  sessionId: string
  sessionFile: string
  sessionManager: SyntheticManager
}
interface GateFixture {
  gate: ReturnType<typeof createRpcTaskAdmissionExtension>
  seal(run: Readonly<RpcTaskParentRun>): boolean
  ctx: { cwd: string; agent: { kind: string; id: string }; sessionManager: SyntheticManager }
  ref: { kind: string; session: SyntheticSession }
  session: SyntheticSession
  sessionManager: SyntheticManager
  parent(): Readonly<RpcTaskParentRun>
  setParent(run: Readonly<RpcTaskParentRun> | undefined): void
}
/** Synthetic identity fixture only; the unchanged composer oracle proves real SDK behavior. */
async function gateFixture(): Promise<GateFixture> {
  const cwd = realpathSync('.')
  const root = {
    phiSessionId: 'phi-session',
    projectId: 'project',
    cwd,
    generation: 1,
    rootAgentId: 'Main',
    rootOmpSessionId: 'omp-main',
    rootSessionFile: join(cwd, 'controlled-root.jsonl')
  }
  let parent: Readonly<RpcTaskParentRun> | undefined = {
    runId: 'parent-A',
    controlSequence: 7,
    signal: new AbortController().signal
  }
  const sessionManager = { getSessionId: () => root.rootOmpSessionId }
  const session = {
    sessionId: root.rootOmpSessionId,
    sessionFile: root.rootSessionFile,
    sessionManager
  }
  const ref = { kind: 'main', session }
  const ctx = { cwd, agent: { kind: 'main', id: 'Main' }, sessionManager }
  const gate = createRpcTaskAdmissionExtension({
    config: {
      schema: 1,
      nonce: 'n'.repeat(32),
      phiSessionId: root.phiSessionId,
      projectId: root.projectId,
      projectRoot: cwd,
      generation: root.generation,
      manifestHash: 'a'.repeat(64),
      manifestBinding: {
        serverId: 'controlled-server',
        serverIdentitySha256: 'b'.repeat(64),
        projectId: root.projectId,
        projectRoot: cwd
      },
      capability: 'c'.repeat(64),
      profiles: [childProfile],
      files: [],
      policy: { mode: 'foreground-native', taskShape: 'single' }
    },
    signal: new AbortController().signal,
    root: () => root,
    parentRun: () => parent,
    assertPublication: () => {
      throw new Error('Grant-time publication checks must not prevent exact run revocation')
    }
  })
  await gate.extension({
    on: () => {},
    pi: {
      AgentRegistry: { global: () => ({ get: (id: string) => (id === 'Main' ? ref : undefined) }) }
    }
  } as unknown as Parameters<typeof gate.extension>[0])
  const seal = (run: Readonly<RpcTaskParentRun>): boolean =>
    gate.sealParent(run, ctx as unknown as Parameters<typeof gate.sealParent>[1])
  return {
    gate,
    seal,
    ctx,
    ref,
    session,
    sessionManager,
    parent: () => parent!,
    setParent: (run: Readonly<RpcTaskParentRun> | undefined) => {
      parent = run
    }
  }
}

test('synthetic exact parent seal closes streaming through permit retirement and fresh begin reopens it', async () => {
  const f = await gateFixture()
  const old = f.parent()
  assert.equal(f.gate.isStreamActive(), true)
  assert.equal(f.seal(old), true)
  assert.equal(f.gate.isStreamActive(), false)
  f.setParent(undefined)
  assert.equal(f.gate.isStreamActive(), false)
  const next = { ...old, controlSequence: 8, signal: new AbortController().signal }
  f.setParent(next)
  assert.equal(f.gate.isStreamActive(), true)
  assert.equal(f.seal(old), false)
  assert.equal(f.gate.isStreamActive(), true)
  assert.equal(f.seal(next), true)
  assert.equal(f.gate.isStreamActive(), false)
  f.gate.dispose()
  f.setParent({ ...next, controlSequence: 9 })
  assert.equal(f.gate.isStreamActive(), false)
  assert.equal(f.seal(f.parent()), false)
})

for (const field of [
  'run',
  'sequence',
  'signal',
  'kind',
  'registry-kind',
  'agent',
  'journal',
  'omp',
  'manager'
] as const)
  test(`synthetic parent seal refuses mismatched ${field} without sealing its live peer`, async () => {
    const f = await gateFixture()
    const captured = f.parent()
    if (field === 'run') f.setParent({ ...captured, runId: 'parent-B' })
    if (field === 'sequence') f.setParent({ ...captured, controlSequence: 8 })
    if (field === 'signal') f.setParent({ ...captured, signal: new AbortController().signal })
    if (field === 'kind') f.ctx.agent.kind = 'sub'
    if (field === 'registry-kind') f.ref.kind = 'sub'
    if (field === 'agent') f.ctx.agent.id = 'peer'
    if (field === 'journal') f.session.sessionFile = join(realpathSync('.'), 'peer-root.jsonl')
    if (field === 'omp') f.sessionManager.getSessionId = () => 'peer-omp'
    if (field === 'manager') f.ctx.sessionManager = { ...f.sessionManager }
    assert.equal(f.seal(captured), false)
    assert.equal(f.gate.isStreamActive(), true)
  })
