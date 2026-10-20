import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { OmpBridge } from '../src/main/agent/engine/omp-bridge'
import { parseModelGatewayLease } from '../src/main/agent/engine/model-gateway-types'

const params = {
  sessionId: 'remote-session',
  generation: 1,
  models: [{ provider: 'fixture', id: 'model' }]
}
async function fixture(t: TestContext): Promise<OmpBridge> {
  const root = await mkdtemp(join(tmpdir(), 'phi-gateway-bridge-'))
  const bridge = new OmpBridge(() =>
    spawn(process.execPath, [join(process.cwd(), 'tests/helpers/fakeModelGatewayWorker.mjs')], {
      env: { PATH: process.env.PATH, PI_CODING_AGENT_DIR: root },
      stdio: ['pipe', 'pipe', 'pipe']
    })
  )
  t.after(async () => {
    await bridge.stop()
    await rm(root, { recursive: true, force: true })
  })
  return bridge
}

/** Generous, loud deadline for the slow worker's late reply (a new worker must start first). */
const LATE_REPLY_TIMEOUT_MS = 60_000

/**
 * The fake worker answers a slow acquisition 120 ms after it reads the request, but under load the
 * worker process itself may take seconds to start, so a fixed sleep cannot cover the late reply.
 * Each inspect also re-arms the bridge's 2 s idle stop, keeping the same worker alive meanwhile.
 */
async function inspectUntilRevoked(
  bridge: OmpBridge
): Promise<{ active: string[]; revoked: string[] }> {
  const until = Date.now() + LATE_REPLY_TIMEOUT_MS
  for (;;) {
    const state = await bridge.request<{ active: string[]; revoked: string[] }>('inspect')
    if (state.revoked.length > 0) return state
    assert.ok(Date.now() < until, 'the late worker reply was never revoked')
    await delay(20)
  }
}

test('a gateway lease keeps the worker alive without local sessions and drops unapproved response fields', async (t) => {
  const bridge = await fixture(t)
  const lease = await bridge.createModelGatewayLease(params)
  assert.equal('credentials' in lease, false)
  assert.equal('baseUrl' in lease.models[0], false)
  assert.equal('headers' in lease.models[0], false)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.timers.tick(2200)
  assert.deepEqual((await bridge.request<{ active: string[] }>('inspect')).active, [lease.leaseId])
  await lease.close()
  await lease.closed
  assert.deepEqual((await bridge.request<{ active: string[] }>('inspect')).active, [])
  t.mock.timers.reset()
})

test('cancelled pending acquisition settles immediately and revokes the late worker listener', async (t) => {
  const bridge = await fixture(t)
  const controller = new AbortController()
  const acquiring = bridge.createModelGatewayLease(
    { ...params, sessionId: 'slow-session' },
    controller.signal
  )
  controller.abort(new Error('cancel preparation'))
  await assert.rejects(acquiring, /cancel preparation/)
  const state = await inspectUntilRevoked(bridge)
  assert.deepEqual(state.active, [])
  assert.equal(state.revoked.length, 1)
})

test('closing one lease preserves another and the worker; repeated close is idempotent', async (t) => {
  const bridge = await fixture(t)
  const first = await bridge.createModelGatewayLease(params)
  const second = await bridge.createModelGatewayLease({ ...params, generation: 2 })
  await Promise.all([first.close(), first.close()])
  const state = await bridge.request<{ active: string[]; revoked: string[] }>('inspect')
  assert.deepEqual(state.active, [second.leaseId])
  assert.deepEqual(state.revoked, [first.leaseId])
  await second.close()
})

test('worker crash invalidates each owned lease and fresh generations use a fresh worker/token', async (t) => {
  const bridge = await fixture(t)
  const first = await bridge.createModelGatewayLease(params)
  const concurrent = await bridge.createModelGatewayLease({ ...params, sessionId: 'concurrent' })
  await assert.rejects(bridge.request('crash'), /OMP worker exited/)
  await Promise.all([first.closed, concurrent.closed])
  await Promise.all([first.close(), concurrent.close()])
  const second = await bridge.createModelGatewayLease({ ...params, generation: 2 })
  assert.equal(second.generation, 2)
  assert.notEqual(second.bearerToken, first.bearerToken)
  assert.deepEqual((await bridge.request<{ active: string[] }>('inspect')).active, [second.leaseId])
  await second.close()
})

test('stopping an old worker with a pending lease cannot poison the replacement', async (t) => {
  const bridge = await fixture(t)
  const pending = bridge.createModelGatewayLease({ ...params, sessionId: 'slow-old' })
  const rejected = assert.rejects(pending, /OMP worker stopped/)
  const stopped = bridge.stop()
  const fresh = await bridge.createModelGatewayLease({ ...params, generation: 3 })
  await Promise.all([stopped, rejected])
  assert.deepEqual((await bridge.request<{ active: string[] }>('inspect')).active, [fresh.leaseId])
  await fresh.close()
})

test('wire response validation binds the exact generation/model set and rejects invalid capabilities', () => {
  const raw = {
    leaseId: 'lease',
    sessionId: params.sessionId,
    generation: 1,
    localPort: 1234,
    bearerToken: 'x'.repeat(43),
    models: [
      {
        ...params.models[0],
        name: 'Test',
        reasoning: false,
        input: ['text'],
        contextWindow: 100,
        maxTokens: 10
      }
    ]
  }
  for (const invalid of [
    { ...raw, sessionId: 'other' },
    { ...raw, generation: 2 },
    { ...raw, localPort: 65536 },
    { ...raw, bearerToken: 'weak' },
    { ...raw, models: [{ ...raw.models[0], id: 'other' }] },
    { ...raw, models: [{ ...raw.models[0], contextWindow: NaN }] },
    { ...raw, models: [{ ...raw.models[0], input: ['secret'] }] },
    { ...raw, models: [{ ...raw.models[0], maxTokens: Infinity }] }
  ])
    assert.throws(() => parseModelGatewayLease(invalid, params))
})

test('pending gateway acquisition also keeps the worker alive without local sessions', async (t) => {
  const bridge = await fixture(t)
  const pending = bridge.createModelGatewayLease({ ...params, sessionId: 'slow-pending' })
  const before = await bridge.request<{ pid: number }>('inspect')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  t.mock.timers.tick(2200)
  const after = await bridge.request<{ pid: number }>('inspect')
  assert.equal(after.pid, before.pid)
  t.mock.timers.reset()
  await (await pending).close()
})

test('caller edits during acquisition cannot change the model or session response ownership', async (t) => {
  const bridge = await fixture(t)
  const input = {
    ...params,
    sessionId: 'slow-mutable',
    models: [{ provider: 'fixture', id: 'model' }]
  }
  const pending = bridge.createModelGatewayLease(input)
  input.sessionId = 'replaced'
  input.models[0].id = 'changed'
  const lease = await pending
  assert.equal(lease.sessionId, 'slow-mutable')
  assert.equal(lease.models[0].id, 'model')
  await lease.close()
})

test('a cancelled unresponsive acquisition cannot retain an otherwise idle worker', async (t) => {
  const bridge = await fixture(t)
  const before = await bridge.request<{ pid: number }>('inspect')
  const controller = new AbortController()
  const pending = bridge.createModelGatewayLease(
    { ...params, sessionId: 'never-completes' },
    controller.signal
  )
  controller.abort(new Error('cancelled acquisition'))
  await assert.rejects(pending, /cancelled acquisition/)
  t.mock.timers.enable({ apis: ['setTimeout'] })
  // Arm the idle timer after the mocked clock starts via another benign response.
  await bridge.request('inspect')
  t.mock.timers.tick(2200)
  const after = await bridge.request<{ pid: number }>('inspect')
  t.mock.timers.reset()
  assert.notEqual(after.pid, before.pid)
})

test('unknown catalog context/token limits remain null in safe metadata', () => {
  const lease = parseModelGatewayLease(
    {
      leaseId: 'unknown-limits',
      sessionId: params.sessionId,
      generation: 1,
      localPort: 1234,
      bearerToken: 'x'.repeat(43),
      models: [
        {
          ...params.models[0],
          name: 'Unknown limits',
          reasoning: false,
          input: ['text'],
          contextWindow: null,
          maxTokens: null
        }
      ]
    },
    params
  )
  assert.equal(lease.models[0].contextWindow, null)
  assert.equal(lease.models[0].maxTokens, null)
})
