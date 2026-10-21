import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionKeyRegistry } from '../src/main/app-state/session-key-registry'
import { SessionLifecycleRegistry } from '../src/main/app-state/session-lifecycle-registry'
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

test('SessionLifecycleRegistry creates once and shares the same lifecycle with aliases', () => {
  const aliases = new Map<string, string>([['alias', 'canonical']])
  const lifecycles = new SessionLifecycleRegistry((key) => aliases.get(key) ?? key)

  const canonical = lifecycles.forKey('canonical')

  assert.equal(lifecycles.forKey('canonical'), canonical)
  assert.equal(lifecycles.forKey('alias'), canonical)
  aliases.delete('alias')
  assert.equal(lifecycles.forKey('alias'), canonical)

  lifecycles.shareWithAlias('second-alias', 'canonical')
  assert.equal(lifecycles.forKey('second-alias'), canonical)
})

test('SessionLifecycleRegistry preserves abort controller identity across set, get, and delete', () => {
  const lifecycles = new SessionLifecycleRegistry((key) => key)
  const controller = new AbortController()

  lifecycles.installAbortController('session:1', controller)
  assert.equal(lifecycles.abortControllerFor('session:1'), controller)

  lifecycles.deleteAbortController('session:1')
  assert.equal(lifecycles.abortControllerFor('session:1'), undefined)
})

test('SessionLifecycleRegistry releases a path cleanup only for the same promise', async () => {
  const lifecycles = new SessionLifecycleRegistry((key) => key)
  let resolveCleanup!: () => void
  const cleanup = new Promise<void>((resolve) => {
    resolveCleanup = resolve
  })

  lifecycles.registerCleanupForPath('/session.jsonl', cleanup)
  lifecycles.releaseCleanupForPath('/session.jsonl', Promise.resolve())
  let finished = false
  const waiting = lifecycles
    .waitForCleanup({ path: '/session.jsonl', cwd: '/workspace', permissionMode: 'auto' })
    .then(() => {
      finished = true
    })

  await Promise.resolve()
  assert.equal(finished, false)
  resolveCleanup()
  await waiting

  lifecycles.releaseCleanupForPath('/session.jsonl', cleanup)
  await lifecycles.waitForCleanup({
    path: '/session.jsonl',
    cwd: '/workspace',
    permissionMode: 'auto'
  })
})

test('SessionLifecycleRegistry path-less waits include only registered unknown-path cleanups', async () => {
  const lifecycles = new SessionLifecycleRegistry((key) => key)
  const knownCleanup = new Promise<void>(() => {})
  const releasedUnknownCleanup = new Promise<void>(() => {})
  let resolveUnknownCleanup!: () => void
  const unknownCleanup = new Promise<void>((resolve) => {
    resolveUnknownCleanup = resolve
  })

  lifecycles.registerCleanupForPath('/session.jsonl', knownCleanup)
  lifecycles.registerUnknownPathCleanup(releasedUnknownCleanup)
  lifecycles.releaseUnknownPathCleanup(releasedUnknownCleanup)
  lifecycles.registerUnknownPathCleanup(unknownCleanup)

  let finished = false
  const waiting = lifecycles
    .waitForCleanup({ path: undefined, cwd: '/workspace', permissionMode: 'auto' })
    .then(() => {
      finished = true
    })
  await Promise.resolve()
  assert.equal(finished, false)

  resolveUnknownCleanup()
  await waiting
})

test(
  'SessionLifecycleRegistry waits unknown barriers before reading the current path barrier',
  { timeout: 1_000 },
  async () => {
    const lifecycles = new SessionLifecycleRegistry((key) => key)
    let resolveUnknownCleanup!: () => void
    const unknownCleanup = new Promise<void>((resolve) => {
      resolveUnknownCleanup = resolve
    })
    const stalePathCleanup = new Promise<void>(() => {})
    const currentPathCleanup = Promise.resolve()

    lifecycles.registerUnknownPathCleanup(unknownCleanup)
    lifecycles.registerCleanupForPath('/session.jsonl', stalePathCleanup)
    const waiting = lifecycles.waitForCleanup({
      path: '/session.jsonl',
      cwd: '/workspace',
      permissionMode: 'auto'
    })

    lifecycles.replaceCleanupForPathIfDifferent('/session.jsonl', stalePathCleanup)
    lifecycles.replaceCleanupForPathIfDifferent('/session.jsonl', currentPathCleanup)
    resolveUnknownCleanup()

    await waiting
  }
)

test('SessionRuntime aliases to the resolved target before sharing lifecycle state', () => {
  const calls: Array<[string, string, string]> = []
  const runtime = new SessionRuntime({
    getFreshSessionCounter: () => 0,
    phiOnlySessionPath: (sessionId) => `phi-session:${sessionId}`
  })
  runtime.keys.setAlias('target-alias', 'canonical')
  const lifecycle = runtime.lifecycles.forKey('canonical')
  const shareWithAlias = runtime.lifecycles.shareWithAlias.bind(runtime.lifecycles)
  runtime.lifecycles.shareWithAlias = (aliasKey, canonicalKey): void => {
    calls.push([aliasKey, canonicalKey, runtime.keys.canonicalize(aliasKey)])
    shareWithAlias(aliasKey, canonicalKey)
  }

  runtime.alias('new-alias', 'target-alias')

  assert.equal(runtime.keys.canonicalize('new-alias'), 'canonical')
  assert.deepEqual(calls, [['new-alias', 'canonical', 'canonical']])
  assert.equal(runtime.lifecycles.forKey('new-alias'), lifecycle)
})

test('SessionRuntime alias is a no-op when the alias already equals the resolved target', () => {
  const calls: Array<[string, string]> = []
  const runtime = new SessionRuntime({
    getFreshSessionCounter: () => 0,
    phiOnlySessionPath: (sessionId) => `phi-session:${sessionId}`
  })
  runtime.keys.setAlias('target-alias', 'canonical')
  const lifecycle = runtime.lifecycles.forKey('canonical')
  runtime.lifecycles.shareWithAlias = (aliasKey, canonicalKey): void => {
    calls.push([aliasKey, canonicalKey])
  }

  runtime.alias('canonical', 'target-alias')

  assert.equal(runtime.keys.canonicalize('canonical'), 'canonical')
  assert.deepEqual(calls, [])
  assert.equal(runtime.lifecycles.forKey('canonical'), lifecycle)
})
