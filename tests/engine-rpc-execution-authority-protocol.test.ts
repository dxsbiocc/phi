import assert from 'node:assert/strict'
import test from 'node:test'
import { realpathSync } from 'node:fs'
import { browserToolParameters } from '../src/main/agent/browser/browser-tool-schema'
import { encodeRpcCommand } from '../src/main/agent/engine/rpc/frame-codec'
import { RpcExecutionAuthority } from '../src/main/agent/engine/rpc/execution-authority'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import { createApprovalEnvelope } from '../src/main/agent/engine/phi-extension/lib/rpc-approval-protocol'
import { createRpcExecutionAuthorityExtension } from '../src/main/agent/engine/phi-extension/extensions/rpc-execution-authority'
import {
  executionBinding,
  MAX_EXECUTION_ROSTER_ENVELOPE_BYTES,
  executionInput,
  executionLaunchIdentity,
  executionRoster,
  type RpcExecutionTool,
  parseExecutionMessage,
  RPC_EXECUTION_COMMAND,
  RPC_EXECUTION_DESCRIPTION,
  signExecutionMessage,
  type RpcExecutionControl,
  type RpcExecutionLaunchIdentity,
  type RpcExecutionOrigin
} from '../src/main/agent/engine/phi-extension/lib/rpc-execution-protocol'
import { RPC_RUNTIME_MAX_BYTES } from '../src/main/agent/engine/phi-extension/lib/rpc-runtime-config'
import { createInitializationWire } from './helpers/rpc-initialization-wire'
import {
  executionUntil,
  captureExecutionExtension,
  fixtureMcpSchemas
} from './helpers/rpcExecutionAuthorityFixture'

const capability = 'd'.repeat(64)
const identity: RpcExecutionLaunchIdentity = {
  nonce: '0123456789abcdef',
  phiSessionId: 'phi',
  projectId: 'project',
  cwd: '/project',
  generation: 1
}
const roster = [{ name: 'write', site: 'native' as const }]
const control: RpcExecutionControl = {
  ...identity,
  ompSessionId: 'omp',
  runId: 'run-1',
  type: 'phi_rpc_execution_control',
  protocolVersion: 1,
  rosterHash: executionRoster(roster).hash,
  sequence: 2,
  requestId: 'request',
  action: 'begin'
}

test('strict HMAC messages bind every identity, roster, sequence and input-digest field', () => {
  const signed = signExecutionMessage(control, capability)
  assert.deepEqual(parseExecutionMessage(JSON.stringify(signed), capability), signed)
  assert.equal(parseExecutionMessage(JSON.stringify(signed), 'a'.repeat(64)), undefined)
  for (const changed of [
    { nonce: 'fedcba9876543210' },
    { runId: 'other' },
    { sequence: 3 },
    { projectId: 'foreign' },
    { cwd: '/foreign' },
    { generation: 2 },
    { rosterHash: 'a'.repeat(64) },
    { requestId: 'foreign' },
    { action: 'end' },
    { extra: true },
    { proof: 'a'.repeat(64) }
  ])
    assert.equal(
      parseExecutionMessage(JSON.stringify({ ...signed, ...changed }), capability),
      undefined
    )
  assert.throws(() => signExecutionMessage(control, 'public-nonce'))
  assert.throws(
    () => signExecutionMessage({ ...control, extra: true }, capability),
    /Invalid execution message/u
  )
  assert.throws(
    () => signExecutionMessage({ ...control, requestId: capability }, capability),
    /Invalid execution message/u
  )
  assert.throws(() =>
    executionLaunchIdentity({ ...identity, capability } as RpcExecutionLaunchIdentity)
  )
  assert.throws(
    () =>
      createRpcExecutionAuthorityExtension({
        identity: { ...identity, nonce: capability },
        capability,
        roster
      }),
    /overlaps/u
  )
  assert.equal(JSON.stringify(signed).includes(capability), false)
})

test('roster hash and host input normalization are deterministic and preserve union-owned nested data', () => {
  const tool = {
    name: 'desktop',
    site: 'host' as const,
    parameters: {
      oneOf: [
        { properties: { text: { type: 'string' }, nested: { type: 'object' } } },
        { properties: { count: { type: 'number' } } }
      ]
    }
  }
  assert.equal(executionRoster([tool, ...roster]).hash, executionRoster([...roster, tool]).hash)
  assert.deepEqual(executionInput(tool, { text: 'value', nested: { i: 'owned' }, i: 'harness' }), {
    text: 'value',
    nested: { i: 'owned' }
  })
  assert.throws(() => executionRoster([...roster, ...roster]))
  assert.throws(() => executionRoster([{ name: 'unknown', site: 'native' }]))
  assert.throws(() =>
    executionRoster([{ name: 'write', site: 'host', parameters: { type: 'object' } }])
  )
  assert.throws(() => executionInput(tool, []))
})

async function fixture(
  options: {
    missingAck?: boolean
    wrongAck?: boolean
    holdBegin?: boolean
    cleanupFailure?: boolean
  } = {}
): Promise<{
  authority: RpcExecutionAuthority
  wire: ReturnType<typeof createInitializationWire>
  connection: RpcConnection
  origin(
    runId: string,
    sequence: number,
    originSequence: number,
    id: string,
    extra?: Partial<RpcExecutionOrigin>
  ): void
  close(): Promise<void>
}> {
  const wire = createInitializationWire((command, respond, emit) => {
    if (command.type === 'get_state') {
      respond({ sessionId: 'omp' })
      return true
    }
    if (command.type === 'get_available_commands') {
      respond({
        commands: [
          {
            name: RPC_EXECUTION_COMMAND,
            description: RPC_EXECUTION_DESCRIPTION,
            source: 'extension'
          }
        ]
      })
      return true
    }
    if (command.type === 'prompt') {
      const request = parseExecutionMessage(
        String(command.message).slice(RPC_EXECUTION_COMMAND.length + 2),
        capability
      )
      if (!request || request.type !== 'phi_rpc_execution_control')
        throw new Error('Expected a signed local control')
      if (options.holdBegin && request.action === 'begin') return true
      if (!options.missingAck)
        emit({
          type: 'extension_ui_request',
          id: 'ack',
          method: 'notify',
          message: JSON.stringify(
            signExecutionMessage(
              {
                ...executionBinding(request),
                action: request.action,
                requestId: request.requestId,
                type: 'phi_rpc_execution_ack',
                ...(options.wrongAck ? { requestId: 'wrong' } : {})
              },
              capability
            )
          )
        })
      respond({ agentInvoked: false })
      emit({
        type: 'prompt_result',
        id: command.id,
        agentInvoked: false,
        status: 'completed',
        sessionSettled: true
      })
      return true
    }
    return false
  })
  if (options.cleanupFailure) {
    const close = wire.transport.close.bind(wire.transport)
    wire.transport.close = async () => {
      await close()
      throw new Error('synthetic cleanup failure')
    }
  }
  const connection = new RpcConnection(() => wire.transport)
  await connection.start()
  const authority = await RpcExecutionAuthority.create({ connection, identity, capability, roster })
  return {
    authority,
    wire,
    connection,
    origin(runId, sequence, originSequence, id, extra = {}) {
      const args = { path: 'file.txt', content: 'value' }
      const message: RpcExecutionOrigin = {
        ...executionBinding({ ...control, runId, sequence }),
        type: 'phi_rpc_execution_origin',
        originSequence,
        toolCallId: id,
        toolName: 'write',
        inputDigest: createApprovalEnvelope({ ...control, runId }, id, 'write', args).inputDigest,
        ...extra
      }
      wire.emit({
        type: 'extension_ui_request',
        id: `origin-${id}`,
        method: 'notify',
        message: JSON.stringify(signExecutionMessage(message, capability))
      })
    },
    close: () => authority.dispose()
  }
}

test('raw dialogs/host frames never create main authority; signed current origin binds both bridge signatures', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  const run = await f.authority.beginRun('run-1')
  const args = { path: 'file.txt', content: 'value' }
  const signal = new AbortController().signal
  f.wire.emit({
    type: 'host_tool_call',
    id: 'fake',
    toolCallId: 'call',
    toolName: 'write',
    arguments: args
  })
  f.wire.emit({
    type: 'extension_ui_request',
    id: 'fake-ui',
    method: 'confirm',
    message: JSON.stringify(createApprovalEnvelope(control, 'call', 'write', args))
  })
  assert.equal(run.authorizeCall('call', 'write', args, signal), undefined)
  f.origin(run.id, 2, 1, 'call')
  assert.equal(run.authorizeCall('call', 'write', args, signal), 'main')
  const digest = createApprovalEnvelope(control, 'call', 'write', args).inputDigest
  assert.equal(run.authorizeCall('call', 'write', args, digest, signal), 'main')
  assert.equal(
    run.authorizeCall('call', 'write', { ...args, content: 'changed' }, signal),
    undefined
  )
  assert.equal(run.authorizeCall('call', 'bash', args, signal), undefined)
  assert.equal(run.authorizeCall('call', 'write', args, 'a'.repeat(64), signal), undefined)
})

test('validly signed foreign scope/generation/roster/run origins are refused without consuming current sequence', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  const run = await f.authority.beginRun('run-1')
  for (const changed of [
    { nonce: 'fedcba9876543210' },
    { phiSessionId: 'other' },
    { ompSessionId: 'other' },
    { projectId: 'other' },
    { cwd: '/other' },
    { generation: 2 },
    { rosterHash: 'a'.repeat(64) },
    { runId: 'other' },
    { sequence: 1 }
  ])
    f.origin(run.id, 2, 1, 'call', changed)
  const args = { path: 'file.txt', content: 'value' }
  assert.equal(run.authorizeCall('call', 'write', args, new AbortController().signal), undefined)
  f.origin(run.id, 2, 1, 'call')
  assert.equal(run.authorizeCall('call', 'write', args, new AbortController().signal), 'main')
  await f.authority.finishRun(run.id)
  assert.equal(run.signal.aborted, true)
  assert.equal(run.authorizeCall('call', 'write', args, new AbortController().signal), undefined)
})

test('same-run replay retires authority; next desktop run may reuse provider toolCallId', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  const first = await f.authority.beginRun('run-1')
  f.origin(first.id, 2, 1, 'same')
  await f.authority.finishRun(first.id)
  const next = await f.authority.beginRun('run-2')
  f.origin(first.id, 2, 1, 'same')
  assert.equal(
    next.authorizeCall(
      'same',
      'write',
      { path: 'file.txt', content: 'value' },
      new AbortController().signal
    ),
    undefined
  )
  f.origin(next.id, 4, 1, 'same')
  assert.equal(
    next.authorizeCall(
      'same',
      'write',
      { path: 'file.txt', content: 'value' },
      new AbortController().signal
    ),
    'main'
  )
  f.origin(next.id, 4, 1, 'same')
  await executionUntil(() => next.signal.aborted)
  assert.equal(f.authority.currentRun(), undefined)
})

for (const options of [{ missingAck: true }, { wrongAck: true }])
  test(`control admission without exact signed ACK fails closed ${JSON.stringify(options)}`, async () => {
    await assert.rejects(fixture(options), /activation failed/u)
  })

test('signed session retirement closes the generation and revokes all main authority', async (t) => {
  const f = await fixture()
  t.after(() => f.close())
  const run = await f.authority.beginRun('run-1')
  f.wire.emit({
    type: 'extension_ui_request',
    id: 'retired',
    method: 'notify',
    message: JSON.stringify(
      signExecutionMessage(
        {
          ...executionBinding(control),
          type: 'phi_rpc_execution_retired',
          reason: 'session-change'
        },
        capability
      )
    )
  })
  await executionUntil(() => run.signal.aborted)
  await f.authority.dispose()
  assert.equal(f.wire.closeCalls(), 1)
  assert.throws(() => f.authority.sessionIdentity(), /unavailable/u)
})

test('actual factory hook only produces main origin after signed ready/run controls; child depth-zero stays denied', async () => {
  const launch = { ...identity, cwd: realpathSync('.') }
  const f = await captureExecutionExtension({ identity: launch, capability, roster })
  const notifications: string[] = []
  const ctx = {
    cwd: launch.cwd,
    agent: { kind: 'main' as 'main' | 'sub', depth: 0 },
    sessionManager: { getSessionId: () => 'omp' },
    isIdle: () => true,
    abort: () => {},
    ui: {
      notify: (message: string) => {
        notifications.push(message)
      }
    }
  }
  const call = {
    type: 'tool_call',
    toolCallId: 'real-hook-id',
    toolName: 'write',
    input: { path: 'synthetic.txt', content: 'value' }
  }
  const hook = f.hooks.get('tool_call')!
  assert.deepEqual(await hook(call, ctx), {
    block: true,
    reason: 'Phi main execution authority unavailable'
  })
  const signed = (sequence: number, action: 'activate' | 'begin' | 'end', runId: string): string =>
    JSON.stringify(
      signExecutionMessage({ ...control, ...launch, sequence, action, runId }, capability)
    )
  await f.command(signed(1, 'activate', 'bridge-ready'), ctx)
  assert.equal(f.server.readiness(), undefined)
  assert.deepEqual(await hook(call, ctx), {
    block: true,
    reason: 'Phi main execution authority unavailable'
  })
  await f.command(signed(2, 'begin', 'run-1'), ctx)
  const ready = f.server.readiness()!
  assert.ok(ready)
  ctx.agent.kind = 'sub'
  assert.deepEqual(await hook(call, ctx), {
    block: true,
    reason: 'Phi main execution authority unavailable'
  })
  assert.equal(
    notifications
      .map((message) => parseExecutionMessage(message, capability))
      .filter((message) => message?.type === 'phi_rpc_execution_origin').length,
    0
  )
  for (const event of [
    'session_before_switch',
    'session_before_branch',
    'session_switch',
    'session_shutdown'
  ])
    await f.hooks.get(event)!({}, ctx)
  assert.equal(f.server.readiness()?.signal, ready.signal)
  assert.equal(ready.signal.aborted, false)
  ctx.agent.kind = 'main'
  assert.equal(await hook(call, ctx), undefined)
  assert.equal(
    notifications
      .map((message) => parseExecutionMessage(message, capability))
      .filter((message) => message?.type === 'phi_rpc_execution_origin').length,
    1
  )
  assert.deepEqual(await hook({ ...call, input: { ...call.input, content: 'changed' } }, ctx), {
    block: true,
    reason: 'Phi main execution authority unavailable'
  })
  await f.hooks.get('agent_end')!({ willContinue: true }, ctx)
  assert.equal(f.server.readiness()?.signal, ready.signal)
  await f.hooks.get('agent_end')!({ willContinue: false }, ctx)
  assert.equal(f.server.readiness(), undefined)
  assert.equal(ready.signal.aborted, true)
  assert.equal(
    notifications.some((message) => message.includes(capability)),
    false
  )
})

test('factory session change revokes readiness and rejects stale control despite valid proof', async () => {
  const launch = { ...identity, cwd: realpathSync('.') }
  const f = await captureExecutionExtension({ identity: launch, capability, roster })
  let actual = 'omp'
  const ctx = {
    cwd: launch.cwd,
    agent: { kind: 'main' as const, depth: 0 },
    sessionManager: { getSessionId: () => actual },
    isIdle: () => true,
    abort: () => {},
    ui: { notify: () => {} }
  }
  const signed = (sequence: number, action: 'activate' | 'begin', runId: string): string =>
    JSON.stringify(
      signExecutionMessage({ ...control, ...launch, sequence, action, runId }, capability)
    )
  await f.command(signed(1, 'activate', 'bridge-ready'), ctx)
  await f.command(signed(2, 'begin', 'run-1'), ctx)
  const ready = f.server.readiness()!
  await f.hooks.get('session_switch')!({}, ctx)
  assert.equal(ready.signal.aborted, true)
  assert.equal(f.server.readiness(), undefined)
  actual = 'new-omp'
  await assert.rejects(f.command(signed(3, 'begin', 'run-2'), ctx))
})

test('actual browser and repository MCP schemas fit the explicit roster budget; larger legal wire manifest rejects as a whole', () => {
  const browser = browserToolParameters()
  const mcp = fixtureMcpSchemas()
  assert.deepEqual(
    mcp.map((tool) => tool.name),
    ['fixture_first', 'fixture_second']
  )
  const tools = [
    { name: 'browser', site: 'host' as const, parameters: browser },
    ...mcp.map((tool) => ({
      name: `mcp__${tool.name}`,
      site: 'host' as const,
      parameters: tool.inputSchema
    }))
  ]
  assert.ok(executionRoster(tools).hash)
  assert.ok(Buffer.byteLength(JSON.stringify(tools)) < MAX_EXECUTION_ROSTER_ENVELOPE_BYTES)
  assert.deepEqual(
    executionInput(tools[0], {
      action: 'scroll',
      tabId: 'tab',
      deltaX: 0,
      deltaY: 100,
      i: 'harness'
    }),
    { action: 'scroll', tabId: 'tab', deltaX: 0, deltaY: 100 }
  )
  const hostTool = (name: string, size: number): RpcExecutionTool => ({
    name,
    site: 'host' as const,
    parameters: {
      type: 'object',
      properties: { data: { type: 'string', description: 'x'.repeat(size) } }
    }
  })
  // A realistic MCP catalog: ~300 KiB of schemas is accepted and hashes deterministically.
  const catalog = Array.from({ length: 30 }, (_, index) => hostTool(`mcp__cat_${index}`, 10 * 1024))
  const roster = executionRoster([...tools, ...catalog])
  assert.equal(roster.tools.length, tools.length + catalog.length)
  assert.doesNotThrow(() =>
    encodeRpcCommand({
      type: 'set_host_tools',
      id: 'preflight',
      tools: catalog.map(({ name, parameters }) => ({
        name,
        description: 'Catalog fixture',
        parameters
      }))
    })
  )
  assert.equal(executionRoster([...catalog.slice().reverse(), ...tools]).hash, roster.hash)
  // Approvals keep the 128 KiB cap.
  assert.throws(
    () =>
      createApprovalEnvelope(
        {
          nonce: '0123456789abcdef',
          phiSessionId: 's',
          ompSessionId: 'o',
          projectId: 'p',
          cwd: '/',
          generation: 1,
          runId: 'r'
        },
        'call',
        'tool',
        { data: 'x'.repeat(140 * 1024) }
      ),
    /exceeds 128 KiB/u
  )
  // Past the wire budget the error names the budget and the size.
  assert.throws(
    () => executionRoster([...tools, hostTool('mcp__huge', MAX_EXECUTION_ROSTER_ENVELOPE_BYTES)]),
    /1048576-byte.*is \d+ bytes, over its 1048576-byte budget/u
  )
})

test('cancelled in-flight begin closes the generation and a late valid ACK cannot revive readiness', async (t) => {
  const f = await fixture({ holdBegin: true })
  t.after(() => f.close())
  const cancel = new AbortController()
  const binding = f.authority.beginRun('pending-run', cancel.signal)
  await executionUntil(() =>
    f.wire.commands.some(
      (command) => command.type === 'prompt' && String(command.message).includes('pending-run')
    )
  )
  const command = f.wire.commands.find(
    (command) => command.type === 'prompt' && String(command.message).includes('pending-run')
  )!
  const request = parseExecutionMessage(
    String(command.message).slice(RPC_EXECUTION_COMMAND.length + 2),
    capability
  )!
  assert.equal(request.type, 'phi_rpc_execution_control')
  if (request.type !== 'phi_rpc_execution_control') throw new Error('Expected control')
  cancel.abort()
  f.wire.emit({
    type: 'extension_ui_request',
    id: 'late',
    method: 'notify',
    message: JSON.stringify(
      signExecutionMessage(
        {
          ...executionBinding(request),
          action: request.action,
          requestId: request.requestId,
          type: 'phi_rpc_execution_ack'
        },
        capability
      )
    )
  })
  await assert.rejects(binding, /binding failed/u)
  assert.equal(f.authority.currentRun(), undefined)
  assert.equal(f.wire.closeCalls(), 1)
})

test('disconnect and reentrant disposal observe failed owned cleanup without unhandled rejections', async (t) => {
  const f = await fixture({ cleanupFailure: true })
  t.after(() => f.close().catch(() => undefined))
  const run = await f.authority.beginRun('cleanup-run')
  run.signal.addEventListener(
    'abort',
    () => {
      void f.authority.dispose().catch(() => undefined)
    },
    { once: true }
  )
  f.wire.disconnect()
  await executionUntil(() => run.signal.aborted)
  await assert.rejects(f.authority.dispose(), /synthetic cleanup failure/u)
  assert.equal(f.wire.closeCalls(), 1)
})

test('private runtime config file budget fits a roster at the wire budget plus its other fields', () => {
  assert.ok(RPC_RUNTIME_MAX_BYTES >= MAX_EXECUTION_ROSTER_ENVELOPE_BYTES + 256 * 1024)
})

test('roster accepts deeply nested MCP schemas while approvals keep their nesting cap', () => {
  let schema: Record<string, unknown> = { type: 'string' }
  for (let level = 0; level < 30; level++) schema = { type: 'object', properties: { next: schema } }
  const deep = { name: 'mcp__deep_tool', site: 'host' as const, parameters: schema }
  assert.match(executionRoster([deep]).hash, /^[a-f0-9]{64}$/)
  const identity = {
    nonce: '0123456789abcdef',
    phiSessionId: 'phi-1',
    ompSessionId: 'omp-1',
    projectId: 'project-1',
    cwd: '/',
    generation: 1,
    runId: 'run-1'
  }
  assert.throws(() => createApprovalEnvelope(identity, 'call-1', 'tool', { schema }), /too deeply/)
})
