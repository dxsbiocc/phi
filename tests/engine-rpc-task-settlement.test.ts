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
  assertInstalled(): void
  hook(): unknown
  setWrongModel(wrong: boolean): void
  replaceHook(): void
  admitChild(
    nativeId: string,
    beforeLifecycle?: boolean,
    spawnKey?: string,
    toolCallId?: string,
    extraNativeId?: string
  ): Promise<void>
  registerChild(nativeId: string): void
  changeParent(id: string, sequence: number): void
  sealCurrentParent(): boolean
  replaceChildRef(id: string): void
  close(): Promise<void>
}

/** Synthetic public-hook identity fixture; actual SDK/UI-stop proof belongs to composer. */
async function fixture(startup = true): Promise<Fixture> {
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
  let parent: Readonly<RpcTaskParentRun> = Object.freeze({
    runId: 'parent-A',
    controlSequence: 7,
    signal: controller.signal
  })
  const input = {
    agent: nativeName,
    name: 'controlled-child',
    task: 'Return plain text',
    solutionSpace: 'Private fixture'
  }
  const notifications: string[] = []
  const handlers = new Map<string, Handler[]>()
  const sessionManager = { getSessionId: () => root.rootOmpSessionId, getCwd: () => cwd }
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
  let taskWork = async (): Promise<void> => {}
  const taskTool = {
    execute: async (id: string, input: unknown): Promise<void> => {
      assert.ok(id && input)
      return taskWork()
    }
  }
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
    extensionPaths: ['trusted-fixture'],
    getToolByName: () => taskTool
  }
  const ref = { id: root.rootAgentId, kind: 'main', session }
  const refs = new Map<string, unknown>([['Main', ref]])
  const lifecycle: Handler[] = []
  const registryChanges = new Set<(event: unknown) => void>()
  const registerChild = (nativeId: string): void => {
    const file = join(cwd, nativeId + '.jsonl')
    const manager = {
      getSessionId: () => 'omp-' + nativeId,
      getHeader: () => ({ parentSession: root.rootSessionFile })
    }
    const child = {
      id: nativeId,
      displayName: nativeName,
      kind: 'sub',
      parentId: root.rootAgentId,
      status: 'running',
      sessionFile: file,
      session: { sessionId: 'omp-' + nativeId, sessionFile: file, sessionManager: manager }
    }
    refs.set(nativeId, child)
    for (const listener of registryChanges) listener({ type: 'registered', ref: child })
  }
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
    events: {
      on: (_name: string, listener: Handler) => {
        lifecycle.push(listener)
        return () => {
          const index = lifecycle.indexOf(listener)
          if (index >= 0) lifecycle.splice(index, 1)
        }
      }
    },
    pi: {
      AgentRegistry: {
        global: () => ({
          get: (id: string) => refs.get(id),
          onChange: (listener: (event: unknown) => void) => {
            registryChanges.add(listener)
            return () => registryChanges.delete(listener)
          }
        })
      }
    }
  } as unknown as Parameters<Admission['extension']>[0])
  const emit = async (type: string, event: unknown): Promise<unknown> => {
    let result: unknown
    for (const handler of handlers.get(type) ?? []) result = await handler(event, ctx)
    return result
  }
  if (startup) await emit('session_start', {})
  let lastAdmittedId = 'outer-task'
  return {
    admission,
    config,
    root,
    get parent() {
      return parent
    },
    controller,
    notifications,
    ctx,
    input,
    admit: (id = 'outer-task') => {
      lastAdmittedId = id
      return session.agent.beforeToolCall({
        tool: { name: 'task' },
        toolCall: { id, arguments: { ...input, i: 'Controlled intent' } },
        args: input
      } as Parameters<typeof previous>[0])
    },
    end: async (id = 'outer-task', toolName = 'task') => {
      await emit('tool_execution_end', {
        type: 'tool_execution_end',
        toolName,
        toolCallId: id,
        result: {},
        isError: true
      })
    },
    spawn: async () => {
      let result: unknown
      taskWork = async () => {
        result = await emit('before_subagent_spawn', {
          agent: nativeName,
          invocationKind: 'task',
          spawnKey: 'controlled-child',
          patterns: ['fixture/model']
        })
      }
      await taskTool.execute(lastAdmittedId, input)
      return result
    },
    changeActualScope: (field) => {
      if (field === 'journal') session.sessionFile = join(cwd, 'other-root.jsonl')
      else sessionManager.getSessionId = () => 'other-omp'
    },
    forbidCurrentReads: () => {
      forbidReads = true
    },
    assertInstalled: () =>
      admission.assertInstalled(ctx as unknown as Parameters<Admission['assertInstalled']>[0]),
    hook: () => session.agent.beforeToolCall,
    setWrongModel: (wrong) => {
      model.id = wrong ? 'wrong-parent-model' : childProfile.model.id
    },
    replaceHook: () => {
      session.agent.beforeToolCall = async () => undefined
    },
    admitChild: async (
      nativeId,
      beforeLifecycle = false,
      spawnKey = nativeId,
      id = 'outer-' + nativeId,
      extraNativeId
    ) => {
      const result = await session.agent.beforeToolCall({
        tool: { name: 'task' },
        toolCall: { id, arguments: { ...input, i: 'Captured child' } },
        args: input
      } as Parameters<typeof previous>[0])
      assert.equal(result, undefined)
      taskWork = async () => {
        assert.equal(
          await emit('before_subagent_spawn', {
            agent: nativeName,
            invocationKind: 'task',
            spawnKey,
            patterns: ['fixture/model']
          }),
          undefined
        )
        registerChild(nativeId)
        if (extraNativeId) registerChild(extraNativeId)
      }
      await taskTool.execute(id, input)
      if (beforeLifecycle) return
      for (const listener of lifecycle)
        await listener(
          {
            id: nativeId,
            status: 'started',
            agent: nativeName,
            agentSource: 'user',
            parentToolCallId: id,
            sessionFile: join(cwd, nativeId + '.jsonl')
          },
          ctx
        )
    },
    registerChild,
    changeParent: (id, sequence) => {
      parent = Object.freeze({
        runId: id,
        controlSequence: sequence,
        signal: new AbortController().signal
      })
    },
    sealCurrentParent: () =>
      admission.sealParent(parent, ctx as unknown as Parameters<Admission['sealParent']>[1]),
    replaceChildRef: (id) => {
      refs.set(id, { kind: 'sub', parentId: root.rootAgentId, status: 'running', session: null })
    },
    close: async () => {
      admission.dispose()
      await rm(cwd, { recursive: true, force: true })
    }
  }
}

test('private attestation installs a missing hook after the exact parent model is confirmed', async (t) => {
  const f = await fixture(false)
  t.after(() => f.close())
  const original = f.hook()
  f.assertInstalled()
  assert.notEqual(f.hook(), original)
  const installed = f.hook()
  f.assertInstalled()
  assert.equal(f.hook(), installed, 'repeat attestation cannot double-wrap')
})

test('private attestation never repairs a wrong parent model or a replaced installed hook', async (t) => {
  const f = await fixture(false)
  t.after(() => f.close())
  const original = f.hook()
  f.setWrongModel(true)
  assert.throws(() => f.assertInstalled(), /parent model or route differs/)
  assert.equal(f.hook(), original)
  f.setWrongModel(false)
  f.assertInstalled()
  f.replaceHook()
  const replaced = f.hook()
  assert.throws(() => f.assertInstalled(), /admission is not installed/)
  assert.equal(f.hook(), replaced, 'an existing installation cannot be overwritten')
})

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

test('captured child stream isolates a later negative parent and preserves the negative tombstone across new Main runs', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  await f.admitChild('child-A')
  assert.equal(f.admission.isChildStreamActive('child-A'), true)
  assert.equal(f.admission.isChildStreamActive('unknown-child'), false)
  // Ordinary execution-authority agent_end retires the parent signal too.
  f.controller.abort()
  assert.equal(f.admission.isChildStreamActive('child-A'), true)
  f.changeParent('parent-B', 8)
  await f.admitChild('child-B')
  assert.equal(f.sealCurrentParent(), true)
  assert.equal(f.admission.isStreamActive(), false)
  assert.equal(f.admission.isChildStreamActive('child-A'), true)
  assert.equal(f.admission.isChildStreamActive('child-B'), false)
  f.changeParent('parent-C', 9)
  await f.admitChild('child-C')
  assert.equal(f.admission.isStreamActive(), true)
  assert.equal(f.admission.isChildStreamActive('child-A'), true)
  assert.equal(
    f.admission.isChildStreamActive('child-B'),
    false,
    'a new Main never revives a denied old parent'
  )
  assert.equal(f.admission.isChildStreamActive('child-C'), true)
  f.replaceChildRef('child-A')
  assert.equal(f.admission.isChildStreamActive('child-A'), false)
  f.admission.dispose()
  assert.equal(f.admission.isChildStreamActive('child-C'), false)
})

test('captured child stream rejects changed original root and never queries a newer Main binding', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  await f.admitChild('child-A')
  f.forbidCurrentReads()
  assert.equal(f.admission.isChildStreamActive('child-A'), true)
  f.changeActualScope('journal')
  assert.equal(f.admission.isChildStreamActive('child-A'), false)
})

test('captured first child model request does not depend on a later started lifecycle notification', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  await f.admitChild('child-first-model', true)
  assert.equal(f.admission.isChildStreamActive('child-first-model'), true)
  assert.equal(f.admission.isChildStreamActive('unknown-child'), false)
})

test('foreground unique native IDs preserve repeated labels and tool IDs across distinct parent runs', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  await f.admitChild('bounded-child', true, 'bounded-child', 'reused-task')
  assert.equal(f.admission.isChildStreamActive('bounded-child'), true)
  await f.end('reused-task')
  f.controller.abort()
  f.changeParent('parent-B', 8)
  await f.admitChild('bounded-child-2', true, 'bounded-child', 'reused-task')
  assert.equal(f.admission.isChildStreamActive('bounded-child-2'), true)
  assert.equal(f.admission.isChildStreamActive('bounded-child'), true)
  f.sealCurrentParent()
  assert.equal(f.admission.isChildStreamActive('bounded-child-2'), false)
  assert.equal(f.admission.isChildStreamActive('bounded-child'), true)
})

test('unnamed foreground dispatch binds only its actual registered actor within the admitted count', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  await f.admitChild('GeneratedActor', true, 'outer-task:0', 'outer-task', 'extra-actor')
  assert.equal(f.admission.isChildStreamActive('GeneratedActor'), true)
  assert.equal(f.admission.isChildStreamActive('outer-task:0'), false)
  assert.equal(f.admission.isChildStreamActive('extra-actor'), false)
  f.registerChild('outside-dispatch')
  assert.equal(f.admission.isChildStreamActive('outside-dispatch'), false)
  f.registerChild('GeneratedActor')
  assert.equal(f.admission.isChildStreamActive('GeneratedActor'), false)
})
