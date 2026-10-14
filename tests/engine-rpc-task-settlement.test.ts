import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  createRpcTaskAdmissionExtension,
  type RpcTaskParentRun
} from '../src/main/agent/engine/phi-extension/extensions/rpc-task-admission'
import type { RpcChildRuntimeConfig } from '../src/main/agent/engine/phi-extension/lib/rpc-child-config'
import type { RpcChildRootScope } from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
import {
  makeRpcTaskSettlement,
  parseRpcTaskSettlement,
  verifyRpcTaskSettlement,
  MAX_RPC_TASK_SETTLEMENT_BYTES
} from '../src/main/agent/engine/phi-extension/lib/rpc-task-settlement-protocol'
import { createApprovalEnvelope } from '../src/main/agent/engine/phi-extension/lib/rpc-approval-protocol'
import { childProfile } from './helpers/rpcChildAuthorityFixture'

type Admission = ReturnType<typeof createRpcTaskAdmissionExtension>
type Handler = (event: unknown, ctx: unknown) => unknown
interface Fixture {
  admission: Admission
  config: RpcChildRuntimeConfig
  root: RpcChildRootScope
  parent: Readonly<RpcTaskParentRun>
  controller: AbortController
  notifications: string[]
  ctx: { agent: { kind: string; id: string } }
  input: Record<string, unknown>
  admit(id?: string): Promise<unknown>
  end(id?: string, toolName?: string): Promise<void>
  spawn(): Promise<unknown>
  changeActualScope(field: 'journal' | 'omp'): void
  forbidCurrentReads(): void
  close(): Promise<void>
}

/** Synthetic public-hook identity fixture; actual SDK/UI-stop proof belongs to composer. */
async function fixture(): Promise<Fixture> {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'phi-task-settlement-')))
  const root: RpcChildRootScope = {
    phiSessionId: 'phi-session',
    projectId: 'project',
    cwd,
    generation: 1,
    rootAgentId: 'Main',
    rootOmpSessionId: 'omp-main',
    rootSessionFile: join(cwd, 'root.jsonl')
  }
  const nativeName = 'phi_' + 'a'.repeat(24) + '_0_fg'
  const config: RpcChildRuntimeConfig = {
    schema: 1,
    nonce: 'n'.repeat(32),
    phiSessionId: root.phiSessionId,
    projectId: root.projectId,
    projectRoot: cwd,
    generation: root.generation,
    capability: 'f'.repeat(64),
    manifestHash: 'b'.repeat(64),
    manifestBinding: {
      serverId: 'fixture',
      serverIdentitySha256: 'c'.repeat(64),
      projectId: root.projectId,
      projectRoot: cwd
    },
    profiles: [{ ...childProfile, definition: { ...childProfile.definition, nativeName } }],
    files: [
      { path: `agents/${nativeName}.md`, sha256: 'a'.repeat(64) },
      { path: 'phi-agent-definitions.json', sha256: 'b'.repeat(64) }
    ],
    policy: { mode: 'foreground-native', taskShape: 'single' }
  }
  const controller = new AbortController()
  const parent = Object.freeze({ runId: 'parent-A', controlSequence: 7, signal: controller.signal })
  const input = {
    agent: nativeName,
    name: 'controlled-child',
    task: 'Return plain text',
    solutionSpace: 'Private fixture'
  }
  const notifications: string[] = []
  const handlers = new Map<string, Handler[]>()
  const sessionManager = { getSessionId: () => root.rootOmpSessionId }
  const ctx = {
    cwd,
    agent: { kind: 'main', id: 'Main' },
    sessionManager,
    ui: {
      notify: (message: string): void => {
        notifications.push(message)
      }
    }
  }
  const previous = async (call: {
    toolCall: { id: string }
    args: unknown
  }): Promise<undefined> => {
    const event = { toolCallId: call.toolCall.id, toolName: 'task', input: call.args }
    // Production R5 execution and approval hooks both perform this preflight before dispatch.
    admission.preflight(event, ctx as unknown as Parameters<Admission['preflight']>[1])
    admission.preflight(event, ctx as unknown as Parameters<Admission['preflight']>[1])
    return undefined
  }
  const model = { ...childProfile.model, ...childProfile.route }
  const session = {
    sessionId: root.rootOmpSessionId,
    sessionFile: root.rootSessionFile,
    sessionManager,
    model,
    agent: { state: { model }, beforeToolCall: previous },
    effectiveExtensionRoots: {
      mode: 'explicit-only',
      configured: [],
      explicit: ['trusted-fixture']
    },
    preparedExtensions: [{}],
    extensionPaths: ['trusted-fixture']
  }
  const ref = { kind: 'main', session }
  let forbidReads = false
  const admission = createRpcTaskAdmissionExtension({
    config,
    signal: new AbortController().signal,
    root: () => {
      if (forbidReads) throw new Error('Must not read current root B')
      return root
    },
    parentRun: () => {
      if (forbidReads) throw new Error('Must not read current parent B')
      return parent
    },
    assertPublication: () => {}
  })
  await admission.extension({
    on: (event: string, handler: Handler): void => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler])
    },
    events: { on: () => () => {} },
    pi: {
      AgentRegistry: {
        global: () => ({
          get: (id: string) => (id === 'Main' ? ref : undefined),
          onChange: () => () => {}
        })
      }
    }
  } as unknown as Parameters<Admission['extension']>[0])
  const emit = async (type: string, event: unknown): Promise<unknown> => {
    let result: unknown
    for (const handler of handlers.get(type) ?? []) result = await handler(event, ctx)
    return result
  }
  await emit('session_start', {})
  return {
    admission,
    config,
    root,
    parent,
    controller,
    notifications,
    ctx,
    input,
    admit: (id = 'outer-task') =>
      session.agent.beforeToolCall({
        tool: { name: 'task' },
        toolCall: { id, arguments: { ...input, i: 'Controlled intent' } },
        args: input
      } as Parameters<typeof previous>[0]),
    end: async (id = 'outer-task', toolName = 'task') => {
      await emit('tool_execution_end', {
        type: 'tool_execution_end',
        toolName,
        toolCallId: id,
        result: {},
        isError: true
      })
    },
    spawn: () =>
      emit('before_subagent_spawn', {
        agent: nativeName,
        invocationKind: 'task',
        spawnKey: 'controlled-child',
        patterns: ['fixture/model']
      }),
    changeActualScope: (field) => {
      if (field === 'journal') session.sessionFile = join(cwd, 'other-root.jsonl')
      else sessionManager.getSessionId = () => 'other-omp'
    },
    forbidCurrentReads: () => {
      forbidReads = true
    },
    close: async () => {
      admission.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

test('settlement wire authenticates exact bounded original config/root/call with child capability', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  const call = {
    parentRunId: f.parent.runId,
    controlSequence: f.parent.controlSequence,
    toolCallId: 'outer-task',
    inputDigest: 'd'.repeat(64)
  }
  const signed = makeRpcTaskSettlement(f.config, f.root, call)
  const wire = JSON.stringify(signed)
  assert.ok(!wire.includes(f.config.capability))
  assert.deepEqual(verifyRpcTaskSettlement(wire, f.config, f.root), signed)
  assert.ok(Object.isFrozen(parseRpcTaskSettlement(wire, f.config.capability)?.root))
  assert.equal(parseRpcTaskSettlement(wire, 'e'.repeat(64)), undefined)
  assert.equal(
    verifyRpcTaskSettlement(wire, { ...f.config, nonce: 'other-nonce-012345' }, f.root),
    undefined
  )
  assert.equal(
    verifyRpcTaskSettlement(wire, { ...f.config, manifestHash: 'e'.repeat(64) }, f.root),
    undefined
  )
  assert.equal(
    verifyRpcTaskSettlement(wire, f.config, { ...f.root, rootOmpSessionId: 'other-omp' }),
    undefined
  )
  assert.equal(
    parseRpcTaskSettlement(JSON.stringify({ ...signed, controlSequence: 8 }), f.config.capability),
    undefined
  )
  assert.equal(
    parseRpcTaskSettlement(JSON.stringify({ ...signed, extra: true }), f.config.capability),
    undefined
  )
  assert.equal(
    parseRpcTaskSettlement(' '.repeat(MAX_RPC_TASK_SETTLEMENT_BYTES + 1), f.config.capability),
    undefined
  )
  assert.throws(() => makeRpcTaskSettlement(f.config, f.root, { ...call, controlSequence: 0 }))
  assert.throws(() =>
    makeRpcTaskSettlement(f.config, f.root, { ...call, root: f.root } as typeof call)
  )
})

for (const order of ['closed-first', 'ended-first'] as const)
  test(`producer sends once only after original parent closure and actual task end: ${order}`, async (t) => {
    const f = await fixture()
    t.after(() => f.close())
    assert.equal(await f.admit(), undefined)
    if (order === 'closed-first') f.controller.abort()
    else await f.end()
    assert.equal(f.notifications.length, 0)
    // Neither completion edge may recover authority by reading a newer parent/root getter.
    f.forbidCurrentReads()
    if (order === 'closed-first') await f.end()
    else f.controller.abort()
    assert.equal(f.notifications.length, 1)
    const message = verifyRpcTaskSettlement(f.notifications[0], f.config, f.root)!
    const expected = createApprovalEnvelope(
      {
        nonce: f.config.nonce,
        phiSessionId: f.root.phiSessionId,
        projectId: f.root.projectId,
        cwd: f.root.cwd,
        generation: f.root.generation,
        ompSessionId: f.root.rootOmpSessionId,
        runId: f.parent.runId
      },
      'outer-task',
      'task',
      f.input
    )
    assert.equal(message.parentRunId, f.parent.runId)
    assert.equal(message.controlSequence, f.parent.controlSequence)
    assert.equal(message.inputDigest, expected.inputDigest)
    await f.end()
    assert.equal(f.notifications.length, 1)
  })

test('any allowed spawn sibling permanently prevents no-spawn evidence for that parent', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  await f.admit('outer-A')
  await f.admit('outer-sibling')
  assert.equal(await f.spawn(), undefined)
  await f.end('outer-A')
  f.controller.abort()
  await f.end('outer-sibling')
  assert.equal(f.notifications.length, 0)
})

test('missing/wrong tool end and foreign root scope never create settlement; normal end alone is insufficient', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  await f.admit()
  await f.end('missing')
  await f.end('outer-task', 'write')
  f.ctx.agent.kind = 'sub'
  await f.end()
  f.ctx.agent.kind = 'main'
  f.controller.abort()
  assert.equal(f.notifications.length, 0)
  await f.end()
  assert.equal(f.notifications.length, 1)
  const normal = await fixture()
  t.after(() => normal.close())
  await normal.admit()
  await normal.end()
  assert.equal(normal.notifications.length, 0)
})

test('unprepared hook and disposed generation cannot issue a no-spawn receipt', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  assert.throws(() =>
    f.admission.preflight(
      { toolCallId: 'unknown', toolName: 'task', input: f.input },
      f.ctx as unknown as Parameters<Admission['preflight']>[1]
    )
  )
  await f.admit()
  f.admission.dispose()
  f.controller.abort()
  await f.end()
  assert.equal(f.notifications.length, 0)
})

for (const field of ['journal', 'omp'] as const)
  test(`captured root with changed actual ${field} cannot issue a settlement`, async (t) => {
    const f = await fixture()
    t.after(() => f.close())
    await f.admit()
    f.changeActualScope(field)
    f.controller.abort()
    await f.end()
    assert.equal(f.notifications.length, 0)
  })
