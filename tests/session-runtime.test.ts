import assert from 'node:assert/strict'
import test from 'node:test'

import { SessionKeyRegistry } from '../src/main/app-state/session-key-registry'
import { SessionLifecycleRegistry } from '../src/main/app-state/session-lifecycle-registry'
import { SessionPreferences } from '../src/main/app-state/session-preferences'
import { PromptRunRegistry } from '../src/main/app-state/prompt-run-registry'
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

test('SessionPreferences keeps its three tables independent and uses keys as given', () => {
  const preferences = new SessionPreferences()
  const selection = { providerId: 'provider-one', modelId: 'model-one' }

  assert.deepEqual(Object.keys(preferences.modelSelections).sort(), ['delete', 'get', 'has', 'set'])
  assert.equal(preferences.modelSelections.set('alias', selection), undefined)
  preferences.modelSelections.set('canonical', null)
  preferences.thinkingLevels.set('alias', 'high')
  preferences.permissionModes.set('alias', 'ask')

  assert.equal(preferences.modelSelections.get('alias'), selection)
  assert.equal(preferences.modelSelections.get('canonical'), null)
  assert.equal(preferences.thinkingLevels.get('alias'), 'high')
  assert.equal(preferences.thinkingLevels.get('canonical'), undefined)
  assert.equal(preferences.permissionModes.get('alias'), 'ask')
  assert.equal(preferences.permissionModes.get('canonical'), undefined)
})

test('SessionPreferences tables preserve Map get, has, delete, and value identity semantics', () => {
  const preferences = new SessionPreferences()
  const selection = { providerId: 'provider-one', modelId: 'model-one' }

  preferences.modelSelections.set('session', selection)
  preferences.thinkingLevels.set('session', 'xhigh')
  preferences.permissionModes.set('session', 'full')

  assert.equal(preferences.modelSelections.has('session'), true)
  assert.equal(preferences.modelSelections.get('session'), selection)
  assert.equal(preferences.thinkingLevels.has('session'), true)
  assert.equal(preferences.thinkingLevels.get('session'), 'xhigh')
  assert.equal(preferences.permissionModes.has('session'), true)
  assert.equal(preferences.permissionModes.get('session'), 'full')

  assert.equal(preferences.modelSelections.delete('session'), true)
  assert.equal(preferences.thinkingLevels.delete('session'), true)
  assert.equal(preferences.permissionModes.delete('session'), true)
  assert.equal(preferences.modelSelections.has('session'), false)
  assert.equal(preferences.modelSelections.get('session'), undefined)
  assert.equal(preferences.thinkingLevels.has('session'), false)
  assert.equal(preferences.thinkingLevels.get('session'), undefined)
  assert.equal(preferences.permissionModes.has('session'), false)
  assert.equal(preferences.permissionModes.get('session'), undefined)
  assert.equal(preferences.modelSelections.delete('session'), false)
  assert.equal(preferences.thinkingLevels.delete('session'), false)
  assert.equal(preferences.permissionModes.delete('session'), false)
})

test('PromptRunRegistry supplies a resolved default queue and preserves replacement identity', async () => {
  const registry = new PromptRunRegistry((key) => (key === 'alias' ? 'canonical' : key))
  const replacement = new Promise<void>(() => {})

  await registry.queueFor('missing')
  registry.setQueue('alias', replacement)

  assert.equal(registry.queueFor('canonical'), replacement)
})

test('PromptRunRegistry generations start at zero and advance through aliases', () => {
  const registry = new PromptRunRegistry((key) => (key === 'alias' ? 'canonical' : key))

  assert.equal(registry.generationFor('alias'), 0)
  assert.equal(registry.advanceGeneration('alias'), 1)
  assert.equal(registry.generationFor('canonical'), 1)
  assert.equal(registry.advanceGeneration('canonical'), 2)
  assert.equal(registry.generationFor('alias'), 2)
})

test('PromptRunRegistry sets, checks, and gets active runs through aliases', () => {
  const registry = new PromptRunRegistry<{ id: string }>((key) =>
    key === 'alias' ? 'canonical' : key
  )
  const run = { id: 'run-one' }

  registry.setActiveRun('alias', run)

  assert.equal(registry.hasActiveRun('canonical'), true)
  assert.equal(registry.activeRun('alias'), run)
})

test('PromptRunRegistry deletes an active run only when the stored object is current', () => {
  const registry = new PromptRunRegistry<{ id: string }>((key) =>
    key === 'alias' ? 'canonical' : key
  )
  const current = { id: 'current' }
  const stale = { id: 'stale' }
  registry.setActiveRun('canonical', current)

  registry.deleteActiveRunIfCurrent('alias', stale)
  assert.equal(registry.activeRun('canonical'), current)

  registry.deleteActiveRunIfCurrent('alias', current)
  assert.equal(registry.hasActiveRun('canonical'), false)
})

test('PromptRunRegistry active-run iteration preserves Map insertion order', () => {
  const registry = new PromptRunRegistry<{ id: string }>((key) => key)
  const first = { id: 'first' }
  const second = { id: 'second' }
  registry.setActiveRun('session-b', first)
  registry.setActiveRun('session-a', second)

  assert.deepEqual(registry.activeRuns(), [first, second])
  assert.deepEqual(registry.activeEntries(), [
    ['session-b', first],
    ['session-a', second]
  ])
  assert.equal(
    registry.findActiveRun(() => true),
    first
  )
})

test('PromptRunRegistry Phi-id tables are narrow and do not canonicalize keys', () => {
  const registry = new PromptRunRegistry<{ id: string }>((key) =>
    key === 'alias' ? 'canonical' : key
  )
  const recovery = { controller: new AbortController(), done: Promise.resolve() }
  const failure = 'disconnected'
  const compaction = { cancelled: false, done: Promise.resolve() }

  assert.deepEqual(Object.keys(registry.runtimeRecoveryOperations).sort(), [
    'delete',
    'get',
    'has',
    'set',
    'values'
  ])
  assert.deepEqual(Object.keys(registry.runtimeRecoveryFailures).sort(), [
    'delete',
    'get',
    'has',
    'set'
  ])
  assert.deepEqual(Object.keys(registry.manualCompactionIds).sort(), ['add', 'delete', 'has'])
  assert.deepEqual(Object.keys(registry.manualCompactionOperations).sort(), [
    'delete',
    'get',
    'has',
    'set'
  ])

  registry.runtimeRecoveryOperations.set('alias', recovery)
  registry.runtimeRecoveryFailures.set('alias', failure)
  registry.manualCompactionIds.add('alias')
  registry.manualCompactionOperations.set('alias', compaction)

  assert.equal(registry.runtimeRecoveryOperations.get('alias'), recovery)
  assert.equal(registry.runtimeRecoveryOperations.get('canonical'), undefined)
  assert.deepEqual([...registry.runtimeRecoveryOperations.values()], [recovery])
  assert.equal(registry.runtimeRecoveryFailures.get('alias'), failure)
  assert.equal(registry.runtimeRecoveryFailures.get('canonical'), undefined)
  assert.equal(registry.manualCompactionIds.has('alias'), true)
  assert.equal(registry.manualCompactionIds.has('canonical'), false)
  assert.equal(registry.manualCompactionOperations.get('alias'), compaction)
  assert.equal(registry.manualCompactionOperations.get('canonical'), undefined)
})

test('SessionRuntime owns and exposes SessionPreferences', () => {
  const runtime = new SessionRuntime({
    getFreshSessionCounter: () => 0,
    phiOnlySessionPath: (sessionId) => `phi-session:${sessionId}`
  })

  assert.equal(runtime.preferences instanceof SessionPreferences, true)
})

test('SessionRuntime owns and exposes PromptRunRegistry using its key canonicalizer', () => {
  const runtime = new SessionRuntime({
    getFreshSessionCounter: () => 0,
    phiOnlySessionPath: (sessionId) => `phi-session:${sessionId}`
  })
  const run = { id: 'run-one' }
  runtime.alias('alias', 'canonical')

  runtime.runs.setActiveRun('alias', run)

  assert.equal(runtime.runs instanceof PromptRunRegistry, true)
  assert.equal(runtime.runs.activeRun('canonical'), run)
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
