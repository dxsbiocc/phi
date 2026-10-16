import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { inspect } from 'node:util'
import { fileURLToPath } from 'node:url'
import { RpcExecutionAuthority } from '../src/main/agent/engine/rpc/execution-authority'
import {
  RpcApprovalBridge,
  type RpcApprovalDecision,
  type RpcApprovalEvent
} from '../src/main/agent/engine/rpc/approval-bridge'
import { RpcHostToolBridge } from '../src/main/agent/engine/rpc/host-tool-bridge'
import { createApprovalEnvelope } from '../src/main/agent/engine/phi-extension/lib/rpc-approval-protocol'
import {
  executionRoster,
  parseExecutionMessage,
  RPC_EXECUTION_COMMAND,
  signExecutionMessage
} from '../src/main/agent/engine/phi-extension/lib/rpc-execution-protocol'
import {
  executionFixture,
  executionUntil,
  privateHistoryText
} from './helpers/rpcExecutionAuthorityFixture'
import { deferred } from './helpers/rpc-initialization-wire'
import { extensionPackageBoundary } from './helpers/extensionPackageBoundary'
import { HOST_PROVIDED_OMP_IMPORTS } from '../src/main/agent/engine/rpc/extension-deployment/bundle'

test(
  'actual private CLI discovers and atomically activates signed bridge without model/history/capability disclosure',
  { timeout: 30000 },
  async (t) => {
    const f = await executionFixture()
    t.after(() => f.close())
    const authority = await RpcExecutionAuthority.create({
      connection: f.connection,
      identity: f.identity,
      capability: f.capability,
      roster: f.roster
    })
    t.after(() => authority.dispose())
    assert.equal(authority.currentRun(), undefined)
    const run = await authority.beginRun('first-run')
    assert.equal(authority.currentRun(), run)
    assert.equal(
      run.authorizeCall(
        'self-reported',
        'write',
        { path: 'x', content: 'x' },
        new AbortController().signal
      ),
      undefined
    )
    await authority.finishRun(run.id)
    assert.equal(run.signal.aborted, true)
    assert.equal(authority.currentRun(), undefined)
    assert.equal(f.provider.requests.length, 0)
    const messages = await f.connection.request<{ messages: unknown[] }>({ type: 'get_messages' })
    assert.deepEqual(messages.messages, [])
    const acks = f.frames
      .filter((frame) => frame.type === 'extension_ui_request' && frame.method === 'notify')
      .map((frame) => parseExecutionMessage(frame.message, f.capability))
      .filter((message) => message?.type === 'phi_rpc_execution_ack')
    assert.deepEqual(
      acks.map((ack) => ack?.action),
      ['activate', 'begin', 'end']
    )
    assert.ok(!JSON.stringify(f.frames).includes(f.capability))
    assert.ok(!JSON.stringify(f.provider.requests).includes(f.capability))
    assert.ok(!f.stderr().includes(f.capability))
    assert.ok(!inspect(authority).includes(f.capability))
    assert.ok(!privateHistoryText(join(f.root, 'history')).includes(f.capability))
  }
)

for (const toolName of ['write', 'edit', 'bash'] as const)
  test(
    `actual ${toolName} origin precedes UI and exact main approval controls effects`,
    { timeout: 30000 },
    async (t) => {
      const f = await executionFixture()
      t.after(() => f.close())
      const authority = await RpcExecutionAuthority.create({
        connection: f.connection,
        identity: f.identity,
        capability: f.capability,
        roster: f.roster
      })
      t.after(() => authority.dispose())
      const answer = deferred<RpcApprovalDecision>()
      const events: RpcApprovalEvent[] = []
      const path = join(f.cwd, 'effect.txt')
      if (toolName === 'edit') writeFileSync(path, 'before\n')
      const args =
        toolName === 'write'
          ? { path: 'effect.txt', content: 'after\n' }
          : toolName === 'edit'
            ? { path: 'effect.txt', old_string: 'before', new_string: 'after' }
            : { command: 'printf after > effect.txt' }
      const approval = new RpcApprovalBridge({
        connection: f.connection,
        scope: { ...authority.sessionIdentity(), currentRun: () => authority.currentRun() },
        shouldGate: () => true,
        requestToolApproval: () => answer.promise,
        onEvent: (event) => {
          events.push(event)
        }
      })
      t.after(() => approval.dispose())
      const run = await authority.beginRun('effect-run')
      f.provider.enqueue({ tool: { name: toolName, args, id: 'provider-call' } }, { text: 'done' })
      const prompt = authority.prompt('Perform the requested operation once.')
      await executionUntil(() => events.length === 1).catch((error) => {
        throw new Error(
          `${String(error)} ${f.stderr()} ${JSON.stringify(f.frames.filter((frame) => frame.type === 'extension_ui_request' && ['notify', 'confirm'].includes(String(frame.method))).slice(-5))}`
        )
      })
      const envelope = createApprovalEnvelope(
        { ...authority.sessionIdentity(), runId: run.id },
        'provider-call',
        toolName,
        args
      )
      assert.equal(
        run.authorizeCall(
          'provider-call',
          toolName,
          args,
          envelope.inputDigest,
          new AbortController().signal
        ),
        'main'
      )
      assert.equal(
        run.authorizeCall(
          'provider-call',
          toolName,
          { ...args, extra: 'changed' },
          envelope.inputDigest,
          new AbortController().signal
        ),
        undefined
      )
      const origin = f.frames.findIndex(
        (frame) =>
          parseExecutionMessage(frame.message, f.capability)?.type === 'phi_rpc_execution_origin'
      )
      const confirm = f.frames.findIndex(
        (frame) => frame.type === 'extension_ui_request' && frame.method === 'confirm'
      )
      assert.ok(origin >= 0 && confirm > origin)
      assert.equal(
        toolName === 'edit' ? readFileSync(path, 'utf8') : existsSync(path),
        toolName === 'edit' ? 'before\n' : false
      )
      answer.resolve('approved')
      assert.equal((await prompt).status, 'completed', f.stderr())
      assert.equal(readFileSync(path, 'utf8').trim(), 'after')
      assert.equal(authority.currentRun(), undefined)
      assert.equal(run.signal.aborted, true)
      assert.equal(
        run.authorizeCall('provider-call', toolName, args, new AbortController().signal),
        undefined
      )
      assert.deepEqual(
        events.map((event) => event.type),
        ['approval_requested', 'approval_approved']
      )
      assert.ok(!JSON.stringify(f.provider.requests).includes(f.capability))
      assert.ok(!privateHistoryText(join(f.root, 'history')).includes(f.capability))
      assert.ok(!f.stderr().includes(f.capability))
    }
  )

test(
  'actual host execution requires recorded main origin and receives authenticated top-level projection',
  { timeout: 30000 },
  async (t) => {
    const schema = {
      type: 'object',
      properties: { text: { type: 'string' }, nested: { type: 'object' } },
      required: ['text'],
      additionalProperties: false
    }
    const f = await executionFixture({
      roster: [{ name: 'desktop_echo', site: 'host', parameters: schema }]
    })
    t.after(() => f.close())
    const authority = await RpcExecutionAuthority.create({
      connection: f.connection,
      identity: f.identity,
      capability: f.capability,
      roster: f.roster
    })
    t.after(() => authority.dispose())
    let executions = 0
    const host = await RpcHostToolBridge.create({
      connection: f.connection,
      scope: {
        sessionId: f.identity.phiSessionId,
        projectId: f.identity.projectId,
        cwd: f.cwd,
        currentRun: () => authority.currentRun(),
        recentUserImages: () => []
      },
      tools: [
        {
          name: 'desktop_echo',
          label: 'Echo',
          description: 'Echo a synthetic value',
          site: 'host',
          parameters: schema,
          execute: async (id, input) => {
            executions++
            assert.equal(id, 'host-provider-id')
            assert.deepEqual(input, { text: 'hello', nested: { exact: 1 } })
            assert.ok(
              f.frames.findIndex(
                (frame) =>
                  parseExecutionMessage(frame.message, f.capability)?.type ===
                  'phi_rpc_execution_origin'
              ) < f.frames.findIndex((frame) => frame.type === 'host_tool_call')
            )
            return { content: [{ type: 'text', text: 'trusted host result' }] }
          }
        }
      ]
    })
    t.after(() => host.dispose())
    const run = await authority.beginRun('host-run')
    assert.equal(
      run.authorizeCall(
        'host-provider-id',
        'desktop_echo',
        { text: 'hello' },
        new AbortController().signal
      ),
      undefined
    )
    f.provider.enqueue(
      {
        tool: {
          name: 'desktop_echo',
          args: { text: 'hello', nested: { exact: 1 } },
          id: 'host-provider-id'
        }
      },
      { text: 'done' }
    )
    await authority.prompt('Call desktop_echo once.')
    assert.equal(executions, 1, f.stderr())
    assert.match(JSON.stringify(f.provider.requests), /trusted host result/)
  }
)

test(
  'real repeated provider ID across two desktop runs is independently bound and approved',
  { timeout: 30000 },
  async (t) => {
    const f = await executionFixture()
    t.after(() => f.close())
    const authority = await RpcExecutionAuthority.create({
      connection: f.connection,
      identity: f.identity,
      capability: f.capability,
      roster: f.roster
    })
    t.after(() => authority.dispose())
    let approvals = 0
    const approval = new RpcApprovalBridge({
      connection: f.connection,
      scope: { ...authority.sessionIdentity(), currentRun: () => authority.currentRun() },
      shouldGate: () => true,
      requestToolApproval: () => {
        approvals++
        return 'approved'
      }
    })
    t.after(() => approval.dispose())
    for (const runId of ['run-one', 'run-two']) {
      const run = await authority.beginRun(runId)
      f.provider.enqueue(
        {
          tool: {
            name: 'write',
            args: { path: `${runId}.txt`, content: runId },
            id: 'same-provider-id'
          }
        },
        { text: 'done' }
      )
      await authority.prompt('Write one file for this run.')
      assert.equal(readFileSync(join(f.cwd, `${runId}.txt`), 'utf8'), runId)
      assert.equal(run.signal.aborted, true)
    }
    assert.equal(approvals, 2)
  }
)

test(
  'real cancellation while approval waits revokes main authority, stops SDK and ignores late allow',
  { timeout: 30000 },
  async (t) => {
    const f = await executionFixture()
    t.after(() => f.close())
    const authority = await RpcExecutionAuthority.create({
      connection: f.connection,
      identity: f.identity,
      capability: f.capability,
      roster: f.roster
    })
    t.after(() => authority.dispose())
    const answer = deferred<RpcApprovalDecision>()
    const events: RpcApprovalEvent[] = []
    const approval = new RpcApprovalBridge({
      connection: f.connection,
      scope: { ...authority.sessionIdentity(), currentRun: () => authority.currentRun() },
      shouldGate: () => true,
      requestToolApproval: () => answer.promise,
      onEvent: (event) => {
        events.push(event)
      }
    })
    t.after(() => approval.dispose())
    const cancel = new AbortController()
    const run = await authority.beginRun('stop-run', cancel.signal)
    f.provider.enqueue(
      { tool: { name: 'write', args: { path: 'never.txt', content: 'never' }, id: 'stop' } },
      { text: 'stopped' }
    )
    const prompt = authority.prompt('Write once and await approval.')
    await executionUntil(() => events.length === 1)
    await assert.rejects(authority.beginRun('concurrent'))
    await assert.rejects(authority.prompt('concurrent prompt'))
    cancel.abort()
    answer.resolve('approved')
    await prompt
    assert.equal(run.signal.aborted, true)
    assert.equal(authority.currentRun(), undefined)
    assert.equal(existsSync(join(f.cwd, 'never.txt')), false)
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_requested', 'approval_cancelled']
    )
    const next = await authority.beginRun('after-stop-run')
    f.provider.enqueue({ text: 'next run is usable' })
    assert.equal((await authority.prompt('Respond once in the next main run.')).status, 'completed')
    assert.equal(next.signal.aborted, true)
    const ended = f.frames
      .map((frame) => parseExecutionMessage(frame.message, f.capability))
      .filter(
        (message) =>
          message?.type === 'phi_rpc_execution_ack' &&
          message.action === 'end' &&
          message.runId === run.id
      )
    assert.equal(ended.length, 1)
  }
)

test(
  'real known-command invalid proof does not advance control sequence or invoke a model',
  { timeout: 30000 },
  async (t) => {
    const f = await executionFixture()
    t.after(() => f.close())
    const authority = await RpcExecutionAuthority.create({
      connection: f.connection,
      identity: f.identity,
      capability: f.capability,
      roster: f.roster
    })
    t.after(() => authority.dispose())
    const request = {
      ...authority.sessionIdentity(),
      runId: 'forged-run',
      type: 'phi_rpc_execution_control' as const,
      protocolVersion: 1 as const,
      rosterHash: executionRoster(f.roster).hash,
      sequence: 2,
      requestId: 'forged',
      action: 'begin' as const
    }
    await f.connection
      .prompt(
        `/${RPC_EXECUTION_COMMAND} ${JSON.stringify(signExecutionMessage(request, 'a'.repeat(64)))}`
      )
      .catch(() => undefined)
    assert.equal(authority.currentRun(), undefined)
    assert.equal(f.provider.requests.length, 0)
    const run = await authority.beginRun('valid-run')
    await authority.finishRun(run.id)
    assert.equal(f.provider.requests.length, 0)
  }
)

test(
  'missing real extension fails discovery and closes its owned RPC process without model fallback',
  { timeout: 30000 },
  async (t) => {
    const f = await executionFixture({ missingExtension: true })
    t.after(() => f.close())
    await assert.rejects(
      RpcExecutionAuthority.create({
        connection: f.connection,
        identity: f.identity,
        capability: f.capability,
        roster: f.roster
      }),
      /activation failed/u
    )
    assert.equal(f.provider.requests.length, 0)
    assert.equal(f.running(), false)
  }
)

test('execution authority extension package stays self-contained', () => {
  const [eventStream, internalUrls, agentLifecycle] = HOST_PROVIDED_OMP_IMPORTS
  const boundary = extensionPackageBoundary(
    fileURLToPath(new URL('../src/main/agent/engine/phi-extension', import.meta.url)),
    HOST_PROVIDED_OMP_IMPORTS
  )
  assert.deepEqual(boundary.failures, [])
  assert.deepEqual(boundary.hostImports, [
    `extensions/rpc-child-control.ts -> ${agentLifecycle}`,
    `extensions/rpc-subagents.ts -> ${internalUrls}`,
    `lib/rpc-native-stream-adapter.ts -> ${eventStream}`,
    `rpc-entry.ts -> ${agentLifecycle}`
  ])
})

test(
  'actual unready main invocation is denied; later verified origin plus human denial still has no effect',
  { timeout: 30000 },
  async (t) => {
    const f = await executionFixture()
    t.after(() => f.close())
    f.provider.enqueue(
      { tool: { name: 'write', args: { path: 'unready.txt', content: 'never' }, id: 'unready' } },
      { text: 'blocked' }
    )
    await f.connection.prompt('Attempt one write before activation.')
    assert.equal(existsSync(join(f.cwd, 'unready.txt')), false)
    assert.equal(
      f.frames.some(
        (frame) =>
          parseExecutionMessage(frame.message, f.capability)?.type === 'phi_rpc_execution_origin'
      ),
      false
    )
    const authority = await RpcExecutionAuthority.create({
      connection: f.connection,
      identity: f.identity,
      capability: f.capability,
      roster: f.roster
    })
    t.after(() => authority.dispose())
    const events: RpcApprovalEvent[] = []
    const approval = new RpcApprovalBridge({
      connection: f.connection,
      scope: { ...authority.sessionIdentity(), currentRun: () => authority.currentRun() },
      shouldGate: () => true,
      requestToolApproval: () => 'denied',
      onEvent: (event) => {
        events.push(event)
      }
    })
    t.after(() => approval.dispose())
    await authority.beginRun('deny-run')
    f.provider.enqueue(
      { tool: { name: 'write', args: { path: 'denied.txt', content: 'never' }, id: 'denied' } },
      { text: 'denied' }
    )
    await authority.prompt('Attempt a write and wait for approval.')
    assert.equal(existsSync(join(f.cwd, 'denied.txt')), false)
    assert.deepEqual(
      events.map((event) => event.type),
      ['approval_requested', 'approval_denied']
    )
  }
)

for (const phase of ['activated-idle', 'completed-idle'] as const)
  test(
    `actual main session switch retires ${phase} generation immediately without a model call`,
    { timeout: 30000 },
    async (t) => {
      const f = await executionFixture()
      t.after(() => f.close())
      const authority = await RpcExecutionAuthority.create({
        connection: f.connection,
        identity: f.identity,
        capability: f.capability,
        roster: f.roster
      })
      t.after(() => authority.dispose())
      if (phase === 'completed-idle') {
        const run = await authority.beginRun('finished')
        await authority.finishRun(run.id)
      }
      assert.equal(authority.currentRun(), undefined)
      await f.connection.request({ type: 'new_session' }).catch(() => undefined)
      assert.throws(() => authority.sessionIdentity(), /unavailable/u)
      // The fixture marks running=false only from the actual ChildProcess close event.
      // No explicit disposal may provide the shutdown that this oracle must observe.
      await executionUntil(() => !f.running())
      assert.equal(f.running(), false)
      assert.ok(
        f.frames.some((frame) => {
          const message = parseExecutionMessage(frame.message, f.capability)
          return (
            message?.type === 'phi_rpc_execution_retired' && message.reason === 'session-change'
          )
        })
      )
      assert.equal(f.provider.requests.length, 0)
    }
  )
