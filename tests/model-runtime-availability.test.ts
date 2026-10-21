import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { getPhiEngine } from '../src/main/agent/engine/in-process-engine'
import { createModelRuntime } from '../src/main/agent/runtime/runtime-adapter'
import { writeModelAvailabilityChange } from '../src/main/agent/model-availability'

test('cached model facade filters fresh switches per read and never resurrects an explicitly disabled model', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-runtime-availability-'))
  const engine = getPhiEngine()
  const original = engine.models.snapshot
  let discoveryCalls = 0
  const models = ['one', 'two'].map((id) => ({ provider: 'chat', id, name: id, reasoning: false }))
  engine.models.snapshot = async () => {
    discoveryCalls++
    return {
      providers: [{ id: 'chat', name: 'Chat', modelKinds: ['chat'], status: { configured: true } }],
      models,
      credentials: [{ providerId: 'chat', type: 'api_key', label: 'stored' }]
    }
  }
  t.after(() => {
    engine.models.snapshot = original
    rmSync(dir, { recursive: true, force: true })
  })
  const runtime = await createModelRuntime(dir)
  assert.equal(runtime.getModels().length, 2)
  writeModelAvailabilityChange({ providerId: 'chat', modelId: 'one', enabled: false }, dir)
  assert.deepEqual(runtime.getModels(), [models[1]])
  assert.equal(runtime.getModel('chat', 'one'), undefined)
  writeModelAvailabilityChange({ providerId: 'chat', enabled: false }, dir)
  assert.deepEqual(runtime.getModels(), [])
  assert.equal(runtime.getModel('chat', 'two'), undefined)
  assert.equal((await runtime.listCredentials()).length, 1)
  assert.equal(runtime.getProviderAuthStatus('chat').configured, true)
  assert.deepEqual(runtime.getProviders()[0].modelKinds, ['chat'])
  writeModelAvailabilityChange({ providerId: 'chat', enabled: true }, dir)
  assert.equal(runtime.getModel('chat', 'one'), undefined)
  assert.deepEqual(runtime.getModel('chat', 'two'), models[1])
  writeModelAvailabilityChange({ providerId: 'chat', modelId: 'one', enabled: true }, dir)
  assert.deepEqual(runtime.getModels(), models)
  assert.equal(discoveryCalls, 1)
})
