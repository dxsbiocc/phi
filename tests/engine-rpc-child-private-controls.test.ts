import assert from 'node:assert/strict'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { childLifecycleControlFixture } from './helpers/childLifecycleControlFixture'
import {
  createRpcChildSteerRequest,
  parseRpcChildSteerRequest,
  createRpcChildControlAck,
  verifyRpcChildControlAck,
  parseRpcChildControlAck,
  RPC_CHILD_CONTROL_COMMAND
} from '../src/main/agent/engine/phi-extension/lib/rpc-child-control'
import {
  createRpcChildControlExtension,
  acknowledgeOwnedRpcChildDelivery
} from '../src/main/agent/engine/phi-extension/extensions/rpc-child-control'
import { createRpcChildSteerPermits } from '../src/main/agent/engine/phi-extension/extensions/rpc-child-steer-permit'
import type { RpcChildScope } from '../src/main/agent/engine/phi-extension/lib/rpc-child-protocol'
type AgentSession = Parameters<typeof acknowledgeOwnedRpcChildDelivery>[0]
type ExtensionContext = Parameters<typeof acknowledgeOwnedRpcChildDelivery>[1]
type ExtensionFactory = ReturnType<typeof createRpcChildControlExtension>

test('private control binds exact child, message, configuration, sequence and one successful receipt', async (t) => {
  const f = await childLifecycleControlFixture()
  t.after(f.close)
  const scope = await f.activate()
  const request = createRpcChildSteerRequest(f.config, scope, 1, 'Keep the verified target')
  assert.deepEqual(parseRpcChildSteerRequest(JSON.stringify(request), f.config), request)
  const ack = createRpcChildControlAck(request, f.config)
  assert.equal(verifyRpcChildControlAck(JSON.stringify(ack), request, f.config), true)
  for (const patch of [
    { message: 'different' },
    { sequence: 2 },
    { nonce: 'foreign' },
    { proof: 'a'.repeat(64) },
    { scope: { ...scope, nativeAgentId: 'peer' } }
  ]) {
    assert.throws(() =>
      parseRpcChildSteerRequest(JSON.stringify({ ...request, ...patch }), f.config)
    )
  }
  assert.equal(
    verifyRpcChildControlAck(
      JSON.stringify({ ...ack, scope: { ...scope, nativeAgentId: 'peer' } }),
      request,
      f.config
    ),
    false
  )
  for (const message of ['/template private', '  /extension', '!shell', '\n!shell']) {
    assert.throws(() => createRpcChildSteerRequest(f.config, scope, 2, message), /plain-text/)
  }
  assert.throws(
    () => createRpcChildSteerRequest(f.config, scope, 2, 'text' + '\n'.repeat(17000)),
    /exceeds its bound/
  )
  assert.equal(JSON.stringify(ack).includes(request.message), false)
  assert.equal(JSON.stringify(ack).includes(f.config.capability), false)
})

function sdkObjects(
  scope: RpcChildScope,
  notify: (message: string) => void = () => {}
): {
  parent: { sessionId: string; sessionFile: string; sessionManager: { getSessionId(): string } }
  ctx: ExtensionContext
} {
  const parentManager = { getSessionId: () => scope.rootOmpSessionId }
  const parent = {
    sessionId: scope.rootOmpSessionId,
    sessionFile: scope.rootSessionFile,
    sessionManager: parentManager
  }
  const ctx = {
    agent: { id: scope.rootAgentId, kind: 'main' },
    sessionManager: parentManager,
    cwd: scope.cwd,
    ui: { notify }
  } as unknown as ExtensionContext
  return { parent, ctx }
}

test('the production private handler consumes a one-shot exact-session permit and rejects a replaced or replayed child', async (t) => {
  const f = await childLifecycleControlFixture()
  t.after(f.close)
  const original = await f.activate()
  const scope = { ...original, cwd: realpathSync(tmpdir()) }
  const config = {
    ...f.config,
    projectRoot: scope.cwd,
    manifestBinding: { ...f.config.manifestBinding, projectRoot: scope.cwd }
  }
  const root = { ...f.authority.registry.identity, cwd: scope.cwd }
  const acks: string[] = []
  const { parent, ctx } = sdkObjects(scope, (message) => {
    acks.push(message)
  })
  const permits = createRpcChildSteerPermits()
  let calls = 0
  const child = {
    isStreaming: true,
    sessionId: scope.childOmpSessionId,
    sessionFile: scope.childSessionFile,
    sessionManager: {
      getSessionId: () => scope.childOmpSessionId,
      getHeader: () => ({ parentSession: scope.rootSessionFile })
    },
    steer: async () => {
      calls++
    }
  }
  const childRef = {
    id: scope.nativeAgentId,
    kind: 'sub',
    parentId: scope.rootAgentId,
    status: 'running',
    sessionFile: scope.childSessionFile,
    session: child
  }
  const refs = new Map<string, unknown>([
    [scope.rootAgentId, { kind: 'main', session: parent }],
    [scope.nativeAgentId, childRef]
  ])
  const handlers = new Map<string, (args: string, ctx: ExtensionContext) => Promise<void>>()
  const api = {
    pi: { AgentRegistry: { global: () => ({ get: (id: string) => refs.get(id) }) } },
    registerCommand: (
      name: string,
      command: { handler: (args: string, ctx: ExtensionContext) => Promise<void> }
    ) => handlers.set(name, command.handler)
  } as unknown as Parameters<ExtensionFactory>[0]
  createRpcChildControlExtension({
    config,
    root: () => root,
    signal: f.controller.signal,
    assertPublication: () => {},
    steerPermits: permits
  })(api)
  const handler = handlers.get(RPC_CHILD_CONTROL_COMMAND)!
  const request = createRpcChildSteerRequest(config, scope, 1, 'Ordinary child instruction')
  await handler(JSON.stringify(request), ctx)
  assert.equal(calls, 1)
  assert.equal(permits.hasPending(child as unknown as AgentSession), true)
  const busy = createRpcChildSteerRequest(
    config,
    scope,
    2,
    'Do not overwrite the queued instruction'
  )
  await handler(JSON.stringify(busy), ctx)
  assert.equal(parseRpcChildControlAck(acks.at(-1), busy, config)?.accepted, false)
  assert.equal(calls, 1)
  assert.equal(permits.consume(child as unknown as AgentSession, scope, request.message), true)
  assert.equal(permits.consume(child as unknown as AgentSession, scope, request.message), false)
  await handler(
    JSON.stringify(createRpcChildSteerRequest(config, scope, 3, 'Next consumed instruction')),
    ctx
  )
  assert.equal(calls, 2)
  await assert.rejects(handler(JSON.stringify(request), ctx), /replay/)
  childRef.sessionFile = '/different-child.jsonl'
  await assert.rejects(
    handler(
      JSON.stringify(createRpcChildSteerRequest(config, scope, 4, 'Still the original child')),
      ctx
    ),
    /unavailable/
  )
  assert.equal(calls, 2)
  f.controller.abort()
  assert.equal(permits.hasPending(child as unknown as AgentSession), false)
})

test('steer permits cannot be consumed by another session, prompt or images', async (t) => {
  const f = await childLifecycleControlFixture()
  t.after(f.close)
  const scope = await f.activate()
  const permits = createRpcChildSteerPermits()
  const session = {} as AgentSession
  const release = permits.grant(session, scope, 'control-id', 'Exact plain instruction')
  assert.equal(permits.consume({} as AgentSession, scope, 'Exact plain instruction'), false)
  assert.equal(permits.consume(session, scope, 'Changed instruction'), false)
  assert.equal(permits.consume(session, scope, 'Exact plain instruction', [{}]), false)
  release()
  assert.equal(permits.consume(session, scope, 'Exact plain instruction'), false)
  const peer = {} as AgentSession
  permits.grant(session, scope, 'again', 'One child')
  permits.grant(peer, { ...scope, nativeAgentId: 'peer' }, 'peer-control', 'Peer remains pending')
  assert.throws(() => permits.grant(session, scope, 'overwrite', 'Must be busy'), /pending/)
  permits.revoke(session)
  assert.equal(permits.hasPending(session), false)
  assert.equal(permits.hasPending(peer), true)
  permits.dispose()
  assert.equal(permits.hasPending(peer), false)
})

test('background delivery waits for real public job registration then rechecks ownership before ACK', async (t) => {
  const f = await childLifecycleControlFixture()
  t.after(f.close)
  const scope = await f.activate()
  const root = f.authority.registry.identity
  const { parent, ctx } = sdkObjects(scope)
  let job: { ownerId: string; agentId: string; type: string } | undefined
  const acknowledged: string[][] = []
  const manager = {
    getJob: () => job,
    acknowledgeDeliveries: (ids: string[]) => acknowledged.push(ids)
  }
  const session = { ...parent, asyncJobManager: manager } as unknown as AgentSession
  const waiting = acknowledgeOwnedRpcChildDelivery(
    session,
    ctx,
    root,
    'real-job',
    f.controller.signal
  )
  assert.equal(acknowledged.length, 0)
  job = { ownerId: root.rootAgentId, agentId: 'real-job', type: 'task' }
  await waiting
  assert.deepEqual(acknowledged, [['real-job']])
  job = { ownerId: 'peer', agentId: 'real-job', type: 'task' }
  await assert.rejects(
    acknowledgeOwnedRpcChildDelivery(session, ctx, root, 'real-job', f.controller.signal),
    /not owned/
  )
  assert.equal(acknowledged.length, 1)
})

test('background ACK waiting stops on generation cancellation without acknowledging an absent job', async (t) => {
  const f = await childLifecycleControlFixture()
  t.after(f.close)
  const scope = await f.activate()
  const { parent, ctx } = sdkObjects(scope)
  let acknowledgements = 0
  const session = {
    ...parent,
    asyncJobManager: {
      getJob: () => undefined,
      acknowledgeDeliveries: () => {
        acknowledgements++
      }
    }
  } as unknown as AgentSession
  const abort = new AbortController()
  const waiting = acknowledgeOwnedRpcChildDelivery(
    session,
    ctx,
    f.authority.registry.identity,
    'pending-job',
    abort.signal
  )
  abort.abort()
  await assert.rejects(waiting)
  assert.equal(acknowledgements, 0)
})
