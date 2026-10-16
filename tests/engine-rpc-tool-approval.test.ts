import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  RpcApprovalBridge,
  type RpcApprovalDecision,
  type RpcApprovalEvent
} from '../src/main/agent/engine/rpc/approval-bridge'
import {
  createApprovalEnvelope,
  parseApprovalEnvelope,
  RPC_APPROVAL_TITLE
} from '../src/main/agent/engine/phi-extension/lib/rpc-approval-protocol'
import {
  realApprovalFixture,
  deferred,
  until,
  captureApprovalHook,
  approvalIdentity
} from './helpers/rpcApprovalFixture'
import { extensionPackageBoundary } from './helpers/extensionPackageBoundary'
import type { PermissionMode } from '../src/main/agent/projects'
import { HOST_PROVIDED_OMP_IMPORTS } from '../src/main/agent/engine/rpc/extension-deployment/bundle'

function mainBridge(
  f: Awaited<ReturnType<typeof realApprovalFixture>>,
  ask: (signal: AbortSignal) => RpcApprovalDecision | Promise<RpcApprovalDecision>,
  runSignal: AbortSignal,
  expected: { id: string; name: string; input: Record<string, unknown> },
  events: RpcApprovalEvent[] = []
): RpcApprovalBridge {
  const run = Object.freeze({
    id: f.identity.runId,
    signal: runSignal,
    authorizeCall: (
      id: string,
      name: string,
      input: Readonly<Record<string, unknown>>,
      digest: string
    ) => {
      const envelope = createApprovalEnvelope(
        f.identity,
        expected.id,
        expected.name,
        expected.input
      )
      return id === expected.id &&
        name === expected.name &&
        createApprovalEnvelope(f.identity, id, name, input).inputDigest === envelope.inputDigest &&
        digest === envelope.inputDigest
        ? ('main' as const)
        : undefined
    }
  })
  return new RpcApprovalBridge({
    connection: f.connection,
    scope: { ...f.identity, currentRun: () => run },
    shouldGate: () => true,
    requestToolApproval: (_, signal) => ask(signal),
    onEvent: (event) => {
      events.push(event)
    }
  })
}

test(
  'actual running RPC honors ask, auto, full and ask again without releasing an existing waiter',
  { timeout: 30000 },
  async (t) => {
    const f = await realApprovalFixture()
    t.after(() => f.close())
    let mode: PermissionMode = 'ask'
    const answer = deferred<RpcApprovalDecision>()
    const events: RpcApprovalEvent[] = []
    const waits: string[] = []
    const inputFor = (id: string): Record<string, unknown> => ({
      command: `printf ${id} > ${id}.txt`
    })
    const run = Object.freeze({
      id: f.identity.runId,
      signal: new AbortController().signal,
      authorizeCall: (
        id: string,
        name: string,
        input: Readonly<Record<string, unknown>>,
        digest: string
      ) => {
        if (!['ask-first', 'auto-next', 'full-next', 'ask-last'].includes(id) || name !== 'bash')
          return undefined
        const expected = createApprovalEnvelope(f.identity, id, name, inputFor(id))
        return digest === expected.inputDigest &&
          createApprovalEnvelope(f.identity, id, name, input).inputDigest === digest
          ? ('main' as const)
          : undefined
      }
    })
    const bridge = new RpcApprovalBridge({
      connection: f.connection,
      scope: { ...f.identity, currentRun: () => run },
      shouldGate: () => mode === 'ask',
      requestToolApproval: (request) => {
        waits.push(request.toolCallId!)
        return request.toolCallId === 'ask-first' ? answer.promise : 'denied'
      },
      onEvent: (event) => {
        events.push(event)
      }
    })
    t.after(() => bridge.dispose())
    const detach = f.connection.onEvent((event) => {
      if (event.type !== 'tool_execution_end') return
      if (event.toolCallId === 'auto-next') mode = 'full'
      if (event.toolCallId === 'full-next') mode = 'ask'
    })
    t.after(detach)
    f.provider.enqueue(
      ...['ask-first', 'auto-next', 'full-next', 'ask-last'].map((id) => ({
        tool: { name: 'bash', args: inputFor(id), id }
      })),
      { text: 'done' }
    )
    const prompt = f.connection.prompt('Execute each scripted command once.')
    await until(() => waits.length === 1)
    mode = 'auto'
    await new Promise((resolve) => setTimeout(resolve, 10))
    assert.equal(existsSync(join(f.cwd, 'ask-first.txt')), false)
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_requested']
    )
    answer.resolve('approved')
    assert.equal((await prompt).status, 'completed', f.stderr())
    for (const id of ['ask-first', 'auto-next', 'full-next']) {
      assert.equal(readFileSync(join(f.cwd, `${id}.txt`), 'utf8'), id)
    }
    assert.equal(existsSync(join(f.cwd, 'ask-last.txt')), false)
    assert.deepEqual(waits, ['ask-first', 'ask-last'])
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_requested', 'approval_approved', 'approval_requested', 'approval_denied']
    )
  }
)

for (const name of ['write', 'edit', 'bash'] as const)
  test(
    `actual native ${name} has no effect until matching main approval`,
    { timeout: 30000 },
    async (t) => {
      const f = await realApprovalFixture()
      t.after(() => f.close())
      const path = join(f.cwd, 'approved.txt')
      if (name === 'edit') writeFileSync(path, 'before\n')
      const args =
        name === 'write'
          ? { path: 'approved.txt', content: 'after\n' }
          : name === 'edit'
            ? { path: 'approved.txt', old_string: 'before', new_string: 'after' }
            : { command: 'printf after > approved.txt' }
      const answer = deferred<RpcApprovalDecision>()
      const events: RpcApprovalEvent[] = []
      const run = new AbortController()
      const bridge = mainBridge(
        f,
        () => answer.promise,
        run.signal,
        { id: 'effect', name, input: args },
        events
      )
      t.after(() => bridge.dispose())
      f.provider.enqueue({ tool: { name, args, id: 'effect' } }, { text: 'done' })
      const prompt = f.connection.prompt(`Execute ${name} once.`)
      await until(() => events.length === 1).catch((error) => {
        throw new Error(
          `${String(error)} ${f.stderr()} ${JSON.stringify(f.frames.filter((frame) => frame.type === 'extension_ui_request' && ['confirm', 'notify'].includes(String(frame.method))).slice(-4))}`
        )
      })
      assert.equal(events[0].type, 'approval_requested')
      assert.equal(
        name === 'edit' ? readFileSync(path, 'utf8') : existsSync(path),
        name === 'edit' ? 'before\n' : false
      )
      const ui = f.frames.find(
        (frame) => frame.type === 'extension_ui_request' && frame.method === 'confirm'
      )!
      assert.equal(ui.title, RPC_APPROVAL_TITLE)
      assert.equal(ui.timeout, undefined)
      assert.equal(parseApprovalEnvelope(ui.message)?.ompSessionId, f.identity.ompSessionId)
      answer.resolve('approved')
      assert.equal((await prompt).status, 'completed', f.stderr())
      assert.equal(readFileSync(path, 'utf8').trim(), 'after')
      assert.deepEqual(
        events.map((event) => event.type),
        ['approval_requested', 'approval_approved']
      )
    }
  )

for (const name of ['write', 'edit', 'bash'] as const)
  test(`actual native ${name} denial prevents its effect`, { timeout: 30000 }, async (t) => {
    const f = await realApprovalFixture()
    t.after(() => f.close())
    const path = join(f.cwd, 'denied.txt')
    if (name === 'edit') writeFileSync(path, 'before\n')
    const args =
      name === 'write'
        ? { path: 'denied.txt', content: 'after\n' }
        : name === 'edit'
          ? { path: 'denied.txt', old_string: 'before', new_string: 'after' }
          : { command: 'printf after > denied.txt' }
    const events: RpcApprovalEvent[] = []
    const bridge = mainBridge(
      f,
      () => 'denied',
      new AbortController().signal,
      { id: 'deny', name, input: args },
      events
    )
    t.after(() => bridge.dispose())
    f.provider.enqueue({ tool: { name, args, id: 'deny' } }, { text: 'denied' })
    await f.connection.prompt(`Attempt ${name} once.`)
    const end = f.frames.find(
      (frame) => frame.type === 'tool_execution_end' && frame.toolName === name
    )
    assert.equal(end?.isError, true, `${JSON.stringify(end)} ${f.stderr()}`)
    assert.equal(
      name === 'edit' ? readFileSync(path, 'utf8') : existsSync(path),
      name === 'edit' ? 'before\n' : false
    )
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_requested', 'approval_denied']
    )
  })

test(
  'actual pending approval stop cancels SDK UI and ignores a late allow',
  { timeout: 30000 },
  async (t) => {
    const f = await realApprovalFixture()
    t.after(() => f.close())
    const answer = deferred<RpcApprovalDecision>()
    const events: RpcApprovalEvent[] = []
    const run = new AbortController()
    const bridge = mainBridge(
      f,
      () => answer.promise,
      run.signal,
      { id: 'stop', name: 'write', input: { path: 'stopped.txt', content: 'must not exist' } },
      events
    )
    t.after(() => bridge.dispose())
    f.provider.enqueue(
      {
        tool: {
          name: 'write',
          args: { path: 'stopped.txt', content: 'must not exist' },
          id: 'stop'
        }
      },
      { text: 'cancelled' }
    )
    const prompt = f.connection.prompt('Attempt write and wait for approval.')
    await until(() => events.length === 1).catch((error) => {
      throw new Error(
        `${String(error)} ${f.stderr()} ${JSON.stringify(f.frames.filter((frame) => frame.type === 'extension_ui_request' && ['confirm', 'notify'].includes(String(frame.method))).slice(-4))}`
      )
    })
    run.abort()
    await f.connection.abort()
    answer.resolve('approved')
    const result = await prompt
    assert.ok(['aborted', 'completed'].includes(result.status), JSON.stringify(result))
    assert.equal(existsSync(join(f.cwd, 'stopped.txt')), false)
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_requested', 'approval_cancelled']
    )
  }
)

for (const missing of ['readiness', 'policy'] as const)
  test(
    `actual ${missing} failure denies before dialog or effects`,
    { timeout: 30000 },
    async (t) => {
      const f = await realApprovalFixture(
        missing === 'readiness' ? { ready: false } : { classify: false }
      )
      t.after(() => f.close())
      f.provider.enqueue(
        { tool: { name: 'write', args: { path: 'missing.txt', content: 'must not exist' } } },
        { text: 'blocked' }
      )
      await f.connection.prompt('Try the write once.')
      assert.equal(existsSync(join(f.cwd, 'missing.txt')), false)
      assert.equal(
        f.frames.some(
          (frame) => frame.type === 'extension_ui_request' && frame.method === 'confirm'
        ),
        false
      )
      assert.equal(f.frames.find((frame) => frame.type === 'tool_execution_end')?.isError, true)
    }
  )

test(
  'actual project and remote URL guards deny independently without asking for approval',
  { timeout: 30000 },
  async (t) => {
    const f = await realApprovalFixture()
    t.after(() => f.close())
    for (const path of ['../outside.txt', 'ssh://fixture/outside.txt']) {
      f.provider.enqueue(
        { tool: { name: 'write', args: { path, content: 'must not exist' } } },
        { text: 'blocked' }
      )
      await f.connection.prompt('Try this path once.')
    }
    assert.equal(existsSync(join(f.root, 'outside.txt')), false)
    assert.equal(
      f.frames.some((frame) => frame.type === 'extension_ui_request' && frame.method === 'confirm'),
      false
    )
    const ends = f.frames.filter((frame) => frame.type === 'tool_execution_end')
    assert.equal(ends.length, 2)
    assert.ok(ends.every((frame) => frame.isError === true))
  }
)

test('approval modules remain within the deployed extension package', () => {
  const root = fileURLToPath(new URL('../src/main/agent/engine/phi-extension', import.meta.url))
  const [eventStream, internalUrls, agentLifecycle, task, taskAgents] = HOST_PROVIDED_OMP_IMPORTS
  const boundary = extensionPackageBoundary(root, HOST_PROVIDED_OMP_IMPORTS)
  assert.deepEqual(boundary.failures, [])
  assert.deepEqual(boundary.hostImports, [
    `extensions/rpc-child-control.ts -> ${agentLifecycle}`,
    `extensions/rpc-subagents.ts -> ${internalUrls}`,
    `extensions/rpc-task-definition-verifier.ts -> ${task}`,
    `extensions/rpc-task-definition-verifier.ts -> ${taskAgents}`,
    `lib/rpc-native-stream-adapter.ts -> ${eventStream}`,
    `rpc-entry.ts -> ${agentLifecycle}`
  ])
})

test('server hook denies subagent depth-zero, unready and forged OMP identity before opening UI', async () => {
  let dialogs = 0
  const readiness = {
    ...approvalIdentity,
    cwd: realpathSync('.'),
    signal: new AbortController().signal
  }
  let ready: typeof readiness | undefined = readiness
  const hook = await captureApprovalHook({ readiness: () => ready, classifyTool: () => 'write' })
  const ctx = {
    cwd: readiness.cwd,
    agent: { kind: 'sub' as 'main' | 'sub' },
    sessionManager: { getSessionId: () => readiness.ompSessionId },
    ui: {
      confirm: async () => {
        dialogs++
        return true
      }
    }
  }
  const event = {
    type: 'tool_call' as const,
    toolCallId: 'hook',
    toolName: 'write',
    input: { path: 'test.txt', content: 'x' }
  }
  assert.equal(((await hook(event, ctx)) as { block: boolean }).block, true)
  ctx.agent.kind = 'main'
  ready = undefined
  assert.equal(((await hook(event, ctx)) as { block: boolean }).block, true)
  ready = { ...readiness, ompSessionId: 'foreign' }
  assert.equal(((await hook(event, ctx)) as { block: boolean }).block, true)
  assert.equal(dialogs, 0)
})

test('server hook blocks changed effective args, revoked readiness and run cancellation after UI approval', async () => {
  for (const change of ['input', 'run', 'signal', 'policy'] as const) {
    const lifetime = new AbortController()
    const readiness = { ...approvalIdentity, cwd: realpathSync('.'), signal: lifetime.signal }
    let ready = readiness
    let classification: 'write' | undefined = 'write'
    const answer = deferred<boolean>()
    let opened = false
    const hook = await captureApprovalHook({
      readiness: () => ready,
      classifyTool: () => classification
    })
    const ctx = {
      cwd: readiness.cwd,
      agent: { kind: 'main' as const },
      sessionManager: { getSessionId: () => readiness.ompSessionId },
      ui: {
        confirm: async (
          _: string,
          __: string,
          options?: { signal?: AbortSignal; timeout?: number }
        ) => {
          assert.equal(options?.timeout, undefined)
          assert.equal(options?.signal, lifetime.signal)
          opened = true
          return answer.promise
        }
      }
    }
    const event = {
      type: 'tool_call' as const,
      toolCallId: 'hook',
      toolName: 'write',
      input: { path: 'test.txt', content: 'x' }
    }
    const result = hook(event, ctx)
    await until(() => opened)
    if (change === 'input') event.input.content = 'different'
    if (change === 'run') ready = { ...ready, runId: 'new-run' }
    if (change === 'signal') lifetime.abort()
    if (change === 'policy') classification = undefined
    answer.resolve(true)
    assert.equal(((await result) as { block: boolean }).block, true, change)
  }
})

test('server hook does not duplicate trusted host approvals or downgrade native mutations to read/host', async () => {
  let dialogs = 0
  const ready = {
    ...approvalIdentity,
    cwd: realpathSync('.'),
    signal: new AbortController().signal
  }
  const hook = await captureApprovalHook({
    readiness: () => ready,
    classifyTool: (name) => (name === 'browser' ? 'host' : 'read')
  })
  const ctx = {
    cwd: ready.cwd,
    agent: { kind: 'main' as const },
    sessionManager: { getSessionId: () => ready.ompSessionId },
    ui: {
      confirm: async () => {
        dialogs++
        return true
      }
    }
  }
  assert.equal(
    await hook(
      { type: 'tool_call', toolCallId: 'browser', toolName: 'browser', input: { action: 'click' } },
      ctx
    ),
    undefined
  )
  for (const name of ['write', 'edit', 'bash', 'powershell'])
    assert.equal(
      (
        (await hook(
          {
            type: 'tool_call',
            toolCallId: name,
            toolName: name,
            input: { path: 'test.txt', content: 'x' }
          },
          ctx
        )) as { block: boolean }
      ).block,
      true
    )
  assert.equal(dialogs, 0)
})
