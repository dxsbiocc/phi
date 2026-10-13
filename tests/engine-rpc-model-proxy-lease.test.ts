import assert from 'node:assert/strict'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { RpcSessionBackend } from '../src/main/agent/engine/rpc/rpc-session-backend'
import { modelProxyLifecycleFixture } from './helpers/modelProxyLifecycleFixture'
import { deferred } from './helpers/rpc-initialization-wire'

const params = {
  sessionId: 'remote',
  cwd: '/project',
  agentDir: '/ignored',
  model: {
    provider: 'fixture',
    id: 'model',
    name: 'Fixture',
    reasoning: false,
    supportsImages: false
  }
}
function backend(
  fixture: Awaited<ReturnType<typeof modelProxyLifecycleFixture>>
): RpcSessionBackend {
  return new RpcSessionBackend(fixture.transport.open, {
    prepare: fixture.transport.prepare,
    initialize: fixture.transport.initialize,
    selectModel: fixture.transport.selectModel,
    preparationTimeoutMs: 1000,
    startupTimeoutMs: 100,
    initializationTimeoutMs: 100
  })
}

test('each reused transport generation receives fresh access and closing one preserves another', async () => {
  const fixture = await modelProxyLifecycleFixture()
  const engine = backend(fixture)
  await engine.create(params)
  await engine.create({ ...params, sessionId: 'other' })
  assert.notEqual(fixture.gateways[0].bearerToken, fixture.gateways[1].bearerToken)
  assert.notEqual(fixture.gateways[0].localPort, fixture.gateways[1].localPort)
  assert.notEqual(fixture.tunnels[0].remotePort, fixture.tunnels[1].remotePort)
  assert.equal(fixture.configurations[0].gatewayBearer, fixture.gateways[0].bearerToken)
  await engine.dispose(params)
  assert.equal(fixture.gateways[0].closes, 1)
  assert.equal(fixture.tunnels[0].closes, 1)
  assert.equal(fixture.wires[0].closeCalls(), 1)
  assert.equal(fixture.gateways[1].closes, 0)
  assert.equal(fixture.tunnels[1].closes, 0)
  await engine.create(params)
  assert.equal(fixture.gateways[2].generation, 3)
  assert.notEqual(fixture.gateways[2].bearerToken, fixture.gateways[0].bearerToken)
  assert.equal(
    fixture.wires.some((wire) => wire.commands.some((command) => command.type === 'prompt')),
    false
  )
  await engine.dispose(params)
  await engine.dispose({ sessionId: 'other' })
})

test('gateway, tunnel, configuration, RPC acquisition and attestation failures roll back exact owned stages', async () => {
  for (const stage of ['gateway', 'tunnel', 'configuration', 'open', 'initialize']) {
    const fixture = await modelProxyLifecycleFixture()
    const expected = new Error(`${stage} refused`)
    if (stage === 'gateway')
      fixture.gatewayHook(async (_params, lease) => {
        await lease.close()
        throw expected
      })
    if (stage === 'tunnel')
      fixture.tunnelHook(async (_options, tunnel) => {
        await tunnel.close()
        throw expected
      })
    if (stage === 'configuration')
      fixture.configHook(async () => {
        throw expected
      })
    if (stage === 'open') fixture.failOpen(expected)
    if (stage === 'initialize') fixture.failInitialize(expected)
    const engine = backend(fixture)
    await assert.rejects(engine.create(params), (error) => error === expected)
    assert.equal(engine.has(params.sessionId), false)
    assert.ok(fixture.gateways.every((lease) => lease.closes === 1))
    assert.ok(fixture.tunnels.every((tunnel) => tunnel.closes === 1))
    assert.ok(fixture.wires.every((wire) => wire.closeCalls() === 1))
  }
})

test('pending gateway cancellation settles before acquisition and closes a late result', async () => {
  const fixture = await modelProxyLifecycleFixture()
  const gate = deferred<void>()
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  fixture.gatewayHook(async (_params, lease) => {
    started()
    await gate.promise
    return lease
  })
  const engine = backend(fixture)
  const creation = engine.create(params)
  const rejection = assert.rejects(creation, /disposed/)
  await entered
  await engine.dispose(params)
  await rejection
  assert.equal(fixture.tunnels.length, 0)
  gate.resolve()
  await delay(1)
  assert.equal(fixture.gateways[0].closes, 1)
})

test('pending forward invalidation revokes access immediately and closes a late forwarding result', async () => {
  const fixture = await modelProxyLifecycleFixture()
  const gate = deferred<void>()
  let invalidate!: () => void
  let started!: () => void
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  fixture.tunnelHook(async (options, tunnel) => {
    invalidate = options.onInvalidated!
    started()
    await gate.promise
    return tunnel
  })
  const engine = backend(fixture)
  const creation = engine.create(params)
  const rejection = assert.rejects(creation, /forwarding was invalidated/)
  await entered
  invalidate()
  await rejection
  assert.equal(fixture.gateways[0].closes, 1)
  assert.equal(fixture.wires.length, 0)
  gate.resolve()
  await delay(1)
  assert.equal(fixture.tunnels[0].closes, 1)
})

test('worker and tunnel loss interrupt the remote channel without replay or affecting another session', async () => {
  for (const source of ['worker', 'tunnel']) {
    const fixture = await modelProxyLifecycleFixture()
    const engine = backend(fixture)
    await engine.create(params)
    await engine.create({ ...params, sessionId: 'other' })
    const statuses: string[] = []
    engine.onSessionStatus(params.sessionId, (status) => statuses.push(status.phase))
    if (source === 'worker') fixture.gateways[0].lost()
    else fixture.tunnels[0].lost()
    await delay(1)
    assert.equal(fixture.gateways[0].closes, 1)
    assert.equal(fixture.tunnels[0].closes, 1)
    assert.equal(fixture.wires[0].closeCalls(), 1)
    assert.deepEqual(statuses, ['interrupted'])
    await assert.rejects(
      engine.prompt({ sessionId: params.sessionId, text: 'must not send' }),
      /unavailable/
    )
    assert.equal(
      fixture.wires[0].commands.some((command) => command.type === 'prompt'),
      false
    )
    assert.equal(fixture.gateways[1].closes, 0)
    await engine.dispose(params)
    await engine.dispose({ sessionId: 'other' })
  }
})

test('unavailable selected model fails before any gateway or forwarding acquisition', async () => {
  const fixture = await modelProxyLifecycleFixture()
  const engine = backend(fixture)
  await assert.rejects(
    engine.create({ ...params, model: { ...params.model, id: 'missing' } }),
    /Selected remote model is unavailable/
  )
  assert.equal(fixture.gateways.length, 0)
  assert.equal(fixture.tunnels.length, 0)
})

test('loss during two live streams interrupts only its generation and never replays the turn', async () => {
  const fixture = await modelProxyLifecycleFixture()
  fixture.streamPrompts()
  const engine = backend(fixture)
  await engine.create(params)
  await engine.create({ ...params, sessionId: 'other' })
  const first = engine.prompt({ sessionId: params.sessionId, text: 'synthetic first' })
  const firstRejected = assert.rejects(first, /RPC process exited/)
  const second = engine.prompt({ sessionId: 'other', text: 'synthetic second' })
  const secondRejected = assert.rejects(second, /RPC process exited \(0\)/)
  const statuses: string[] = []
  engine.onSessionStatus(params.sessionId, (status) => statuses.push(status.phase))
  await delay(1)
  assert.equal(fixture.wires[0].commands.filter((command) => command.type === 'prompt').length, 1)
  fixture.gateways[0].lost()
  await firstRejected
  assert.deepEqual(statuses, ['interrupted'])
  assert.equal(fixture.wires[1].closeCalls(), 0)
  assert.equal(fixture.gateways[1].closes, 0)
  assert.equal(fixture.wires[0].commands.filter((command) => command.type === 'prompt').length, 1)
  await engine.dispose(params)
  await engine.dispose({ sessionId: 'other' })
  await secondRejected
})
