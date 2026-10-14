import assert from 'node:assert/strict'
import { RpcSessionBackend } from '../../src/main/agent/engine/rpc/rpc-session-backend'
import { createInitializationWire } from './rpc-initialization-wire'

// A separate strict Node process proves that cleanup rejection is handled before
// a gated preparation cleanup settles. No global rejection listener is installed.
const scenario = process.argv[2]
const primary = new Error('primary selection denied')
const secondary = new Error('secondary transport cleanup failed')
const wire = createInitializationWire()
let cleaned = 0
let selections = 0
const backend = new RpcSessionBackend(
  () => ({
    ...wire.transport,
    async close() {
      await wire.transport.close()
      if (scenario === 'timeout') await new Promise<void>(() => undefined)
      throw secondary
    }
  }),
  {
    closeTimeoutMs: 20,
    prepare: () => () => {
      cleaned++
      if (scenario === 'gated') return new Promise<void>(() => undefined)
      return undefined
    },
    selectModel: () => {
      if (++selections === 2) throw primary
    }
  }
)
const params = {
  sessionId: 'cleanup-session',
  cwd: '/synthetic-project',
  agentDir: '/unused',
  model: {
    provider: 'fixture',
    id: 'model',
    name: 'Fixture',
    reasoning: false,
    supportsImages: false
  }
}
await backend.create(params)
const started = performance.now()
await assert.rejects(backend.setModel(params), (error) => error === primary)
assert.equal(cleaned, 1)
assert.equal(wire.closeCalls(), 1)
assert.ok(performance.now() - started < 1000, 'resource cleanup must stay bounded')
await assert.rejects(
  backend.prompt({ sessionId: params.sessionId, text: 'must remain unavailable' }),
  /unavailable/
)
console.log(`selection primary retained; ${scenario} cleanup completed within budget`)
