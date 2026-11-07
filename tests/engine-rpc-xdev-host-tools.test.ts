import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import test from 'node:test'
import { createRpcExecutionAuthorityExtension } from '../src/main/agent/engine/phi-extension/extensions/rpc-execution-authority'
import {
  executionRoster,
  signExecutionMessage,
  type RpcExecutionControl,
  type RpcExecutionLaunchIdentity,
  type RpcExecutionTool
} from '../src/main/agent/engine/phi-extension/lib/rpc-execution-protocol'

type HookContext = {
  cwd: string
  agent: { kind: 'main'; depth: number }
  sessionManager: { getSessionId(): string }
  isIdle(): boolean
  abort(): void
  ui: { notify(message: string): void }
}

type ToolCall = {
  type: 'tool_call'
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}

const capability = 'd'.repeat(64)
const identity: RpcExecutionLaunchIdentity = {
  nonce: '0123456789abcdef',
  phiSessionId: 'phi-xdev',
  projectId: 'project-xdev',
  cwd: realpathSync('.'),
  generation: 1
}
const roster: RpcExecutionTool[] = [
  { name: 'read', site: 'native' },
  { name: 'write', site: 'native' },
  { name: 'edit', site: 'native' },
  { name: 'grep', site: 'native' },
  { name: 'bash', site: 'native' },
  {
    name: 'xd_host_0',
    site: 'host',
    parameters: {
      type: 'object',
      properties: { field_0: { type: 'string' } },
      additionalProperties: false
    }
  },
  {
    name: 'xd_host_1',
    site: 'host',
    parameters: {
      type: 'object',
      properties: { field_1: { type: 'string' } },
      additionalProperties: false
    }
  }
]

async function authorityFixture(): Promise<{
  server: ReturnType<typeof createRpcExecutionAuthorityExtension>
  call(event: ToolCall): Promise<unknown>
}> {
  const server = createRpcExecutionAuthorityExtension({ identity, capability, roster })
  const hooks = new Map<string, (event: ToolCall, context: HookContext) => unknown>()
  let command: ((args: string, context: HookContext) => Promise<void>) | undefined
  const api = {
    on(name: string, handler: unknown): void {
      hooks.set(name, handler as (event: ToolCall, context: HookContext) => unknown)
    },
    registerCommand(_name: string, definition: { handler: unknown }): void {
      command = definition.handler as (args: string, context: HookContext) => Promise<void>
    }
  }
  await server.extension(api as unknown as Parameters<typeof server.extension>[0])
  assert.ok(command)
  const hook = hooks.get('tool_call')
  assert.ok(hook)
  const context: HookContext = {
    cwd: identity.cwd,
    agent: { kind: 'main', depth: 0 },
    sessionManager: { getSessionId: () => 'omp-xdev' },
    isIdle: () => true,
    abort: () => undefined,
    ui: { notify: () => undefined }
  }
  const rosterHash = executionRoster(roster).hash
  const control = (
    sequence: number,
    action: RpcExecutionControl['action'],
    runId: string
  ): string =>
    JSON.stringify(
      signExecutionMessage(
        {
          ...identity,
          ompSessionId: 'omp-xdev',
          runId,
          type: 'phi_rpc_execution_control',
          protocolVersion: 1,
          rosterHash,
          sequence,
          requestId: `request-${sequence}`,
          action
        },
        capability
      )
    )
  await command(control(1, 'activate', 'bridge-ready'), context)
  await command(control(2, 'begin', 'run-1'), context)
  return {
    server,
    call: async (event) => await hook(event, context)
  }
}

test('canonical xd:// dispatch grants one projected nested host call', async () => {
  const fixture = await authorityFixture()
  const outer: ToolCall = {
    type: 'tool_call',
    toolCallId: 'dispatch-1',
    toolName: 'write',
    input: { path: 'xd://xd_host_0', content: '{"field_0":"value"}' }
  }
  assert.equal(await fixture.call(outer), undefined)
  assert.equal(fixture.server.xdevDispatching('dispatch-1', 'xd_host_0'), true)
  assert.deepEqual(
    await fixture.call({
      type: 'tool_call',
      toolCallId: 'dispatch-1',
      toolName: 'xd_host_0',
      input: { field_0: 'value', ignored: 'not in the authenticated schema' }
    }),
    { input: { field_0: 'value' } }
  )
  assert.equal(fixture.server.xdevDispatching('dispatch-1', 'xd_host_0'), false)
  assert.deepEqual(await fixture.call(outer), {
    block: true,
    reason: 'Phi main execution authority unavailable'
  })
})

test('forged and non-canonical xd:// calls are refused without retiring the active run', async () => {
  const fixture = await authorityFixture()
  const forged: Array<[string, string, Record<string, unknown>]> = [
    ['unknown', 'write', { path: 'xd://xd_missing', content: '{}' }],
    ['native', 'write', { path: 'xd://bash', content: '{"command":"echo owned"}' }],
    ['upper', 'write', { path: 'XD://xd_host_0', content: '{}' }],
    ['space', 'write', { path: ' xd://xd_host_0', content: '{}' }],
    ['subpath', 'write', { path: 'xd://xd_host_0/extra', content: '{}' }],
    ['hashline', 'write', { path: '[xd://xd_host_0#ABCD]', content: '{}' }],
    ['root', 'write', { path: 'xd://', content: '{}' }],
    ['readsub', 'read', { path: 'xd://a/b' }],
    ['edit', 'edit', { path: 'xd://xd_host_0', old_string: 'a', new_string: 'b' }],
    ['grep', 'grep', { pattern: 'x', path: 'xd://xd_host_0' }]
  ]
  for (const [toolCallId, toolName, input] of forged)
    assert.deepEqual(
      await fixture.call({ type: 'tool_call', toolCallId, toolName, input }),
      { block: true, reason: 'Phi refuses this xd:// device call' },
      toolCallId
    )
  assert.ok(fixture.server.readiness())
  assert.equal(
    await fixture.call({
      type: 'tool_call',
      toolCallId: 'legitimate',
      toolName: 'write',
      input: { path: 'xd://xd_host_1', content: '{"field_1":"safe"}' }
    }),
    undefined
  )
  assert.deepEqual(
    await fixture.call({
      type: 'tool_call',
      toolCallId: 'legitimate',
      toolName: 'xd_host_1',
      input: { field_1: 'safe' }
    }),
    { input: { field_1: 'safe' } }
  )
})
