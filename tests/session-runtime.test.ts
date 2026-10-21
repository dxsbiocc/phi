import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionKeyRegistry } from '../src/main/app-state/session-key-registry'
import { SessionRuntime } from '../src/main/app-state/session-runtime'

function createRegistry(getFreshSessionCounter: () => number): SessionKeyRegistry {
  return new SessionKeyRegistry({
    getFreshSessionCounter,
    phiOnlySessionPath: (sessionId) => `phi-session:${sessionId}`
  })
}

test('SessionKeyRegistry creates path, fresh, and Phi keys with call-time defaults', () => {
  let freshSessionCounter = 3
  const keys = createRegistry(() => freshSessionCounter)

  assert.equal(keys.createKey('/sessions/one.jsonl', '/workspace'), 'path:/sessions/one.jsonl')
  assert.equal(keys.createKey(undefined, '/workspace', 7), 'fresh:/workspace:7')
  assert.equal(keys.createKey(undefined, '/workspace'), 'fresh:/workspace:3')

  freshSessionCounter = 4
  assert.equal(keys.createKey(undefined, '/workspace'), 'fresh:/workspace:4')
  assert.equal(keys.createPhiKey('phi-one', '/workspace'), 'path:phi-session:phi-one')
})

test('SessionKeyRegistry resolves single-hop, multi-hop, and cyclic aliases', () => {
  const keys = createRegistry(() => 0)

  keys.setAlias('single', 'canonical')
  keys.setAlias('first', 'second')
  keys.setAlias('second', 'third')
  assert.equal(keys.canonicalize('single'), 'canonical')
  assert.equal(keys.canonicalize('first'), 'third')
  assert.equal(keys.sameCanonical('first', 'third'), true)
  assert.equal(keys.sameCanonical('first', 'single'), false)

  keys.setAlias('cycle-a', 'cycle-b')
  keys.setAlias('cycle-b', 'cycle-a')
  assert.equal(keys.canonicalize('cycle-a'), 'cycle-a')
  assert.equal(keys.canonicalize('cycle-b'), 'cycle-b')
})

test('SessionKeyRegistry round-trips Phi session ids through aliases', () => {
  const keys = createRegistry(() => 0)

  keys.setAlias('alias', 'canonical')
  keys.setPhiSessionId('canonical', 'phi-one')
  assert.equal(keys.phiSessionIdFor('alias'), 'phi-one')

  keys.setPhiSessionId('alias', 'phi-two')
  assert.equal(keys.phiSessionIdFor('canonical'), 'phi-two')
})

test('SessionKeyRegistry keeps runtime origins in their uncanonicalized key space', () => {
  const keys = createRegistry(() => 0)
  const origin = { sessionKey: 'conversation', cwd: '/workspace' }

  keys.setAlias('runtime-alias', 'runtime-canonical')
  keys.recordOrigin('runtime-alias', origin)

  assert.equal(keys.originFor('runtime-alias'), origin)
  assert.equal(keys.originFor('runtime-canonical'), undefined)
})

test('SessionRuntime aliases to the resolved target before sharing lifecycle state', () => {
  const calls: Array<[string, string, string]> = []
  const lifecycle = { generation: 1 }
  const lifecycles = new Map<string, typeof lifecycle>([['canonical', lifecycle]])
  const runtimeHolder: { current?: SessionRuntime } = {}
  const runtime = new SessionRuntime({
    getFreshSessionCounter: () => 0,
    phiOnlySessionPath: (sessionId) => `phi-session:${sessionId}`,
    shareLifecycle: (aliasKey, canonicalKey) => {
      const canonicalLifecycle = lifecycles.get(canonicalKey)
      if (canonicalLifecycle) lifecycles.set(aliasKey, canonicalLifecycle)
      calls.push([
        aliasKey,
        canonicalKey,
        runtimeHolder.current?.keys.canonicalize(aliasKey) ?? 'missing'
      ])
    }
  })
  runtimeHolder.current = runtime
  runtime.keys.setAlias('target-alias', 'canonical')

  runtime.alias('new-alias', 'target-alias')

  assert.equal(runtime.keys.canonicalize('new-alias'), 'canonical')
  assert.deepEqual(calls, [['new-alias', 'canonical', 'canonical']])
  assert.equal(lifecycles.get('new-alias'), lifecycle)
})

test('SessionRuntime alias is a no-op when the alias already equals the resolved target', () => {
  const calls: Array<[string, string]> = []
  const runtime = new SessionRuntime({
    getFreshSessionCounter: () => 0,
    phiOnlySessionPath: (sessionId) => `phi-session:${sessionId}`,
    shareLifecycle: (aliasKey, canonicalKey) => {
      calls.push([aliasKey, canonicalKey])
    }
  })
  runtime.keys.setAlias('target-alias', 'canonical')

  runtime.alias('canonical', 'target-alias')

  assert.equal(runtime.keys.canonicalize('canonical'), 'canonical')
  assert.deepEqual(calls, [])
})
