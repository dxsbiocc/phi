import assert from 'node:assert/strict'
import test from 'node:test'

import { phiOnlySessionPath } from '../src/main/agent/session/sessions'
import { createSessionKeyLinking } from '../src/main/session-runtime/session-key-linking'

test('linkPhiManagedSessionKey preserves alias, id writes, and SessionState update order', () => {
  const calls: string[] = []
  const linking = createSessionKeyLinking({
    sessionRuntime: {
      alias: (aliasKey, canonicalKey) => {
        calls.push(`alias:${aliasKey}:${canonicalKey}`)
      }
    },
    sessionKeys: {
      createKey: () => 'materialized-key',
      createPhiKey: (sessionId, cwd) => {
        calls.push(`create:${sessionId}:${cwd}`)
        return 'stable-key'
      },
      phiSessionIdFor: () => undefined,
      setPhiSessionId: (sessionKey, sessionId) => {
        calls.push(`id:${sessionKey}:${sessionId}`)
      },
      sameCanonical: () => true
    },
    sessionState: {
      linkPhiManagedSessionKey: (sessionKey, stablePath, stableKey) => {
        calls.push(`state:${sessionKey}:${stablePath}:${stableKey}`)
      }
    },
    sessionResolution: {
      findPhiManifestForSession: () => null,
      resolveSessionModelSelection: () => null,
      resolveSessionThinkingLevel: () => 'high'
    }
  })

  assert.equal(
    linking.linkPhiManagedSessionKey('source-key', '/workspace', 'phi-1'),
    phiOnlySessionPath('phi-1')
  )
  assert.deepEqual(calls, [
    'create:phi-1:/workspace',
    'alias:stable-key:source-key',
    'id:source-key:phi-1',
    'id:stable-key:phi-1',
    `state:source-key:${phiOnlySessionPath('phi-1')}:stable-key`
  ])
})

test('aliasMaterializedSessionPath aliases the materialized key without extra canonicalization', () => {
  const calls: string[] = []
  const linking = createSessionKeyLinking({
    sessionRuntime: {
      alias: (aliasKey, canonicalKey) => calls.push(`alias:${aliasKey}:${canonicalKey}`)
    },
    sessionKeys: {
      createKey: (path, cwd) => {
        calls.push(`create:${String(path)}:${cwd}`)
        return 'materialized-key'
      },
      createPhiKey: () => 'stable-key',
      phiSessionIdFor: () => undefined,
      setPhiSessionId: () => undefined,
      sameCanonical: () => true
    },
    sessionState: { linkPhiManagedSessionKey: () => undefined },
    sessionResolution: {
      findPhiManifestForSession: () => null,
      resolveSessionModelSelection: () => null,
      resolveSessionThinkingLevel: () => 'high'
    }
  })

  linking.aliasMaterializedSessionPath('source-key', '/runtime/session.jsonl', '/workspace')
  assert.deepEqual(calls, [
    'create:/runtime/session.jsonl:/workspace',
    'alias:materialized-key:source-key'
  ])
})

test('runtimeSessionPath removes only Phi-owned stable paths', () => {
  const linking = createSessionKeyLinking({
    sessionRuntime: { alias: () => undefined },
    sessionKeys: {
      createKey: () => 'materialized-key',
      createPhiKey: () => 'stable-key',
      phiSessionIdFor: () => undefined,
      setPhiSessionId: () => undefined,
      sameCanonical: () => true
    },
    sessionState: { linkPhiManagedSessionKey: () => undefined },
    sessionResolution: {
      findPhiManifestForSession: () => null,
      resolveSessionModelSelection: () => null,
      resolveSessionThinkingLevel: () => 'high'
    }
  })

  assert.equal(linking.runtimeSessionPath(phiOnlySessionPath('phi-1')), undefined)
  assert.equal(linking.runtimeSessionPath('/runtime/session.jsonl'), '/runtime/session.jsonl')
  assert.equal(linking.runtimeSessionPath(undefined), undefined)
})

test('updatePhiRuntimeSessionPath writes only when the stable manifest path changes', () => {
  const updates: Array<{ sessionId: string; path: string }> = []
  let runtimeSessionPath = '/runtime/same.jsonl'
  const linking = createSessionKeyLinking({
    sessionRuntime: { alias: () => undefined },
    sessionKeys: {
      createKey: () => 'materialized-key',
      createPhiKey: () => 'stable-key',
      phiSessionIdFor: () => undefined,
      setPhiSessionId: () => undefined,
      sameCanonical: () => true
    },
    sessionState: { linkPhiManagedSessionKey: () => undefined },
    sessionResolution: {
      findPhiManifestForSession: () => null,
      resolveSessionModelSelection: () => null,
      resolveSessionThinkingLevel: () => 'high'
    },
    stores: {
      findPhiSessionById: () => ({ runtimeSessionPath }) as never,
      updateSessionManifest: (sessionId, patch) => {
        updates.push({ sessionId, path: patch.runtimeSessionPath as string })
        return {} as never
      },
      createPhiSession: () => {
        throw new Error('not used')
      },
      getProjectByCwd: () => undefined
    }
  })

  linking.updatePhiRuntimeSessionPath('phi-1', '/runtime/same.jsonl')
  runtimeSessionPath = '/runtime/old.jsonl'
  linking.updatePhiRuntimeSessionPath('phi-1', '/runtime/new.jsonl')
  assert.deepEqual(updates, [{ sessionId: 'phi-1', path: '/runtime/new.jsonl' }])
})

test('ensurePhiSessionId re-links and returns an existing registry id', () => {
  const calls: string[] = []
  const linking = createSessionKeyLinking({
    sessionRuntime: { alias: () => calls.push('alias') },
    sessionKeys: {
      createKey: () => 'materialized-key',
      createPhiKey: () => 'stable-key',
      phiSessionIdFor: () => 'phi-existing',
      setPhiSessionId: (key) => calls.push(`id:${key}`),
      sameCanonical: () => true
    },
    sessionState: {
      linkPhiManagedSessionKey: () => calls.push('state')
    },
    sessionResolution: {
      findPhiManifestForSession: () => {
        throw new Error('manifest lookup must not run')
      },
      resolveSessionModelSelection: () => {
        throw new Error('model lookup must not run')
      },
      resolveSessionThinkingLevel: () => {
        throw new Error('thinking lookup must not run')
      }
    },
    stores: {
      findPhiSessionById: (sessionId) =>
        sessionId === 'phi-existing' ? ({ sessionId } as never) : null,
      updateSessionManifest: () => {
        throw new Error('not used')
      },
      createPhiSession: () => {
        throw new Error('not used')
      },
      getProjectByCwd: () => undefined
    }
  })

  assert.equal(
    linking.ensurePhiSessionId('source-key', {
      path: undefined,
      cwd: '/workspace',
      permissionMode: 'ask'
    }),
    'phi-existing'
  )
  assert.deepEqual(calls, ['alias', 'id:source-key', 'id:stable-key', 'state'])
})

test('ensurePhiSessionId creates a record when the registry id has no settings file', () => {
  const created: string[] = []
  const linking = createSessionKeyLinking({
    sessionRuntime: { alias: () => undefined },
    sessionKeys: {
      createKey: () => 'materialized-key',
      createPhiKey: () => 'stable-key',
      phiSessionIdFor: () => 'phi-missing',
      setPhiSessionId: () => undefined,
      sameCanonical: () => true
    },
    sessionState: { linkPhiManagedSessionKey: () => undefined },
    sessionResolution: {
      findPhiManifestForSession: () => null,
      resolveSessionModelSelection: () => null,
      resolveSessionThinkingLevel: () => 'high'
    },
    stores: {
      findPhiSessionById: () => null,
      updateSessionManifest: () => {
        throw new Error('not used')
      },
      createPhiSession: () => {
        created.push('created')
        return { sessionId: 'phi-new' } as never
      },
      getProjectByCwd: () => undefined
    }
  })

  assert.equal(
    linking.ensurePhiSessionId('source-key', {
      path: undefined,
      cwd: '/workspace',
      permissionMode: 'auto'
    }),
    'phi-new'
  )
  assert.deepEqual(created, ['created'])
})

test('ensurePhiSessionId re-links a manifest discovered by session resolution', () => {
  const linked: string[] = []
  const linking = createSessionKeyLinking({
    sessionRuntime: { alias: () => undefined },
    sessionKeys: {
      createKey: () => 'materialized-key',
      createPhiKey: (sessionId, cwd) => `${sessionId}:${cwd}`,
      phiSessionIdFor: () => undefined,
      setPhiSessionId: () => undefined,
      sameCanonical: () => true
    },
    sessionState: {
      linkPhiManagedSessionKey: (_key, stablePath) => linked.push(stablePath)
    },
    sessionResolution: {
      findPhiManifestForSession: () =>
        ({ sessionId: 'phi-manifest', cwd: '/manifest-workspace' }) as never,
      resolveSessionModelSelection: () => {
        throw new Error('model lookup must not run')
      },
      resolveSessionThinkingLevel: () => {
        throw new Error('thinking lookup must not run')
      }
    }
  })

  assert.equal(
    linking.ensurePhiSessionId('source-key', {
      path: '/runtime/session.jsonl',
      cwd: '/snapshot-workspace',
      permissionMode: 'ask'
    }),
    'phi-manifest'
  )
  assert.deepEqual(linked, [phiOnlySessionPath('phi-manifest')])
})

test('ensurePhiSessionId creates and links a new session with the original fields', () => {
  const created: unknown[] = []
  const linking = createSessionKeyLinking({
    sessionRuntime: { alias: () => undefined },
    sessionKeys: {
      createKey: () => 'materialized-key',
      createPhiKey: () => 'stable-key',
      phiSessionIdFor: () => undefined,
      setPhiSessionId: () => undefined,
      sameCanonical: () => true
    },
    sessionState: { linkPhiManagedSessionKey: () => undefined },
    sessionResolution: {
      findPhiManifestForSession: () => null,
      resolveSessionModelSelection: () => ({ providerId: 'provider', modelId: 'model' }),
      resolveSessionThinkingLevel: () => 'medium'
    },
    stores: {
      findPhiSessionById: () => null,
      updateSessionManifest: () => {
        throw new Error('not used')
      },
      createPhiSession: (input) => {
        created.push(input)
        return { sessionId: 'phi-new' } as never
      },
      getProjectByCwd: () => undefined
    }
  })

  assert.equal(
    linking.ensurePhiSessionId(
      'source-key',
      {
        path: '/runtime/session.jsonl',
        cwd: '/workspace',
        permissionMode: 'ask'
      },
      'New session'
    ),
    'phi-new'
  )
  assert.deepEqual(created, [
    {
      kind: 'ordinary',
      projectId: null,
      cwd: '/workspace',
      cwdRealPath: '/workspace',
      title: 'New session',
      runtimeSessionPath: '/runtime/session.jsonl',
      permissionMode: 'ask',
      model: { providerId: 'provider', modelId: 'model' },
      thinkingLevel: 'medium'
    }
  ])
})
