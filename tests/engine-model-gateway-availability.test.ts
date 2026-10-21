import assert from 'node:assert/strict'
import test from 'node:test'
import { writeModelAvailabilityChange } from '../src/main/agent/model-availability'
import type {
  ModelGatewayLease,
  ModelGatewayModelRef
} from '../src/main/agent/engine/model-gateway-types'
import {
  startModelGatewaySdkFixture,
  MODEL_GATEWAY_FIXTURE_REFS as refs,
  MODEL_GATEWAY_FIXTURE_SECRETS as secrets
} from './helpers/model-gateway-sdk-fixture'

function request(lease: ModelGatewayLease, model: ModelGatewayModelRef): Promise<Response> {
  return fetch(`http://127.0.0.1:${lease.localPort}/v1/pi/stream`, {
    method: 'POST',
    headers: { authorization: `Bearer ${lease.bearerToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      modelId: `${model.provider}/${model.id}`,
      stream: true,
      context: { messages: [{ role: 'user', content: 'Availability fixture.', timestamp: 1 }] }
    })
  })
}

test(
  'a retained gateway lease rejects disabled models before auth, preserves streams and re-enables with existing credentials',
  { timeout: 30000 },
  async (t) => {
    const f = await startModelGatewaySdkFixture()
    t.after(() => f.close())
    const lease = await f.create({
      sessionId: 'availability',
      generation: 1,
      models: [refs.key, refs.none]
    })
    await f.enqueue({ text: 'already running', hold: true })
    const active = await request(lease, refs.key)
    assert.equal(active.status, 200)
    const reader = active.body!.getReader()
    await reader.read()
    const before = await f.snapshot()
    assert.equal(before.activeProviderStreams, 1)
    writeModelAvailabilityChange(
      { providerId: refs.key.provider, modelId: refs.key.id, enabled: false },
      f.agentDir
    )
    const blocked = await request(lease, refs.key)
    assert.equal(blocked.status, 403)
    assert.match(await blocked.text(), /Model request unavailable/)
    const disabled = await f.snapshot()
    assert.equal(disabled.authCalls, before.authCalls)
    assert.equal(disabled.providerRequests.length, before.providerRequests.length)
    assert.equal(
      disabled.activeProviderStreams,
      1,
      'Switching availability must not abort an admitted stream'
    )
    await f.enqueue({ text: 'independent provider' })
    assert.match(await (await request(lease, refs.none)).text(), /independent provider/)
    writeModelAvailabilityChange(
      { providerId: refs.key.provider, modelId: refs.key.id, enabled: true },
      f.agentDir
    )
    await f.enqueue({ text: 'same credential works' })
    assert.match(await (await request(lease, refs.key)).text(), /same credential works/)
    const restored = await f.snapshot()
    assert.equal(restored.providerRequests.at(-1)?.headers.authorization, `Bearer ${secrets.key}`)
    writeModelAvailabilityChange({ providerId: refs.key.provider, enabled: false }, f.agentDir)
    assert.equal((await request(lease, refs.key)).status, 403)
    assert.equal((await f.snapshot()).activeProviderStreams, 1)
    await reader.cancel()
  }
)
