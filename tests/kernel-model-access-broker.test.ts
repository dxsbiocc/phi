import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test, { type TestContext } from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import {
  createModelAccessBroker,
  ModelAccessBrokerError,
  type ModelAccessAuthStorage,
  type ModelAccessBroker,
  type ModelAccessRefreshReason
} from '../src/main/agent/engine/kernel-host/model-access-broker'
import { KERNEL_HOST_CAPABILITY_REGISTRY } from '../src/shared/kernel-protocol'

const PI_AI_PACKAGE = ['@oh-my-pi', 'pi-ai'].join('/')
const REMOTE_REFRESH_SENTINEL = '__remote__' as const
const BUN_CHILD_TEST_ENV = 'PHI_KERNEL_MODEL_ACCESS_BROKER_BUN_TEST'
const bunRuntime = 'Bun' in globalThis
const selectedBunTest = bunRuntime ? process.env[BUN_CHILD_TEST_ENV] : undefined

function testWithBunAuthStorage(
  name: string,
  body: (context: TestContext) => void | Promise<void>
): void {
  if (bunRuntime) {
    if (!selectedBunTest || selectedBunTest === name) test(name, body)
    return
  }
  test(name, () => {
    execFileSync(
      resolveBunExecutable(),
      ['test', fileURLToPath(import.meta.url), '--test-name-pattern', name],
      {
        cwd: resolve('.'),
        env: { ...process.env, [BUN_CHILD_TEST_ENV]: name },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  })
}

type SnapshotEntry = Awaited<ReturnType<ModelAccessBroker['refresh']>>
type SnapshotCredential = SnapshotEntry['credential']
type OAuthCredential = Extract<SnapshotCredential, { type: 'oauth' }>
type StoredOAuthCredential = Omit<OAuthCredential, 'refresh'> & { refresh: string }
type StoredCredential = Exclude<SnapshotCredential, { type: 'oauth' }> | StoredOAuthCredential

interface TestAuthStorage extends ModelAccessAuthStorage {
  readonly credentials: ModelAccessAuthStorage['credentials'] & {
    reload(): Promise<void>
    set(provider: string, credential: StoredCredential | StoredCredential[]): Promise<void>
    remove(provider: string): Promise<void>
    list(provider?: string): Array<{
      id: number
      provider: string
      credential: StoredCredential
    }>
  }
  close(): void
}

interface TestAuthStorageOptions {
  refreshOAuthCredential?(
    provider: string,
    credentialId: number,
    credential: StoredOAuthCredential,
    signal?: AbortSignal,
    reason?: ModelAccessRefreshReason
  ): Promise<StoredOAuthCredential>
}

async function createStorage(
  t: TestContext,
  options: TestAuthStorageOptions = {}
): Promise<TestAuthStorage> {
  const root = await mkdtemp(join(tmpdir(), 'phi-model-access-broker-'))
  const { AuthStorage } = (await import(PI_AI_PACKAGE)) as {
    AuthStorage: {
      create(path: string, options?: TestAuthStorageOptions): Promise<TestAuthStorage>
    }
  }
  const storage = await AuthStorage.create(join(root, 'agent.db'), options)
  await storage.credentials.reload()
  t.after(async () => {
    storage.close()
    await rm(root, { recursive: true, force: true })
  })
  return storage
}

testWithBunAuthStorage(
  'modelAccess.credentials returns only the requested provider with OAuth refresh tokens redacted',
  async (t) => {
    const storage = await createStorage(t)
    await storage.credentials.set('provider-a', [
      {
        type: 'oauth',
        refresh: 'fake-refresh-a',
        access: 'fake-access-a',
        expires: Date.now() + 60_000,
        accountId: 'account-a'
      },
      { type: 'api_key', key: 'fake-key-a' }
    ])
    await storage.credentials.set('provider-b', { type: 'api_key', key: 'fake-key-b' })

    const result = createModelAccessBroker(storage).credentials({ provider: 'provider-a' })

    assert.equal(result.credentials.length, 2)
    assert.ok(result.credentials.every((entry) => entry.provider === 'provider-a'))
    const oauth = result.credentials.find((entry) => entry.credential.type === 'oauth')
    assert.equal(
      oauth?.credential.type === 'oauth' ? oauth.credential.refresh : undefined,
      REMOTE_REFRESH_SENTINEL
    )
    assert.equal(JSON.stringify(result).includes('fake-refresh-a'), false)
    assert.equal(JSON.stringify(result).includes('fake-key-b'), false)

    const all = createModelAccessBroker(storage).credentials({})
    assert.deepEqual(
      new Set(all.credentials.map((entry) => entry.provider)),
      new Set(['provider-a', 'provider-b'])
    )
  }
)

testWithBunAuthStorage(
  'modelAccess.credentials drops non-model entries so one foreign OAuth login cannot void the response',
  async (t) => {
    const storage = await createStorage(t)
    await storage.credentials.set('provider-a', { type: 'api_key', key: 'fake-key-a' })
    // Shape of a real MCP connector login: OAuth plus fields the model schema rejects.
    await storage.credentials.set('mcp_oauth:profile:default:https://mcp.example.test/mcp', {
      type: 'oauth',
      refresh: 'fake-refresh-mcp',
      access: 'fake-access-mcp',
      expires: Date.now() + 60_000,
      tokenUrl: 'https://mcp.example.test/token',
      clientId: 'client',
      resource: 'https://mcp.example.test/mcp',
      authorizationUrl: 'https://mcp.example.test/authorize'
    } as StoredOAuthCredential)

    const result = createModelAccessBroker(storage).credentials({})

    assert.deepEqual(
      result.credentials.map((entry) => entry.provider),
      ['provider-a']
    )
    assert.equal(
      KERNEL_HOST_CAPABILITY_REGISTRY['modelAccess.credentials'].result.safeParse(result).success,
      true
    )
  }
)

testWithBunAuthStorage(
  'modelAccess.credentials observes desktop logout on the next read',
  async (t) => {
    const storage = await createStorage(t)
    await storage.credentials.set('provider-a', { type: 'api_key', key: 'fake-key-a' })
    const broker = createModelAccessBroker(storage)
    assert.equal(broker.credentials({ provider: 'provider-a' }).credentials.length, 1)

    await storage.credentials.remove('provider-a')

    assert.deepEqual(broker.credentials({ provider: 'provider-a' }), { credentials: [] })
  }
)

test('modelAccess.refresh collapses concurrent refreshes of one credential into one desktop write', async () => {
  const deferred = Promise.withResolvers<SnapshotEntry>()
  let refreshCalls = 0
  const refreshed: SnapshotEntry = {
    id: 41,
    provider: 'provider-a',
    credential: {
      type: 'oauth',
      refresh: REMOTE_REFRESH_SENTINEL,
      access: 'fake-refreshed-access',
      expires: Date.now() + 60_000
    },
    identityKey: null
  }
  const storage = {
    credentials: {
      snapshot: () => ({ generation: 1, generatedAt: Date.now(), credentials: [] })
    },
    oauth: {
      refresh: async () => {
        refreshCalls += 1
        return deferred.promise
      }
    }
  } satisfies ModelAccessAuthStorage
  const broker = createModelAccessBroker(storage)

  const first = broker.refresh({ credentialId: 41 })
  const second = broker.refresh({ credentialId: 41 })

  assert.equal(refreshCalls, 1)
  deferred.resolve(refreshed)
  assert.strictEqual(await first, refreshed)
  assert.strictEqual(await second, refreshed)
  assert.equal(refreshCalls, 1)
})

testWithBunAuthStorage(
  'modelAccess.refresh uses AuthStorage as the writer and returns a redacted persisted row',
  async (t) => {
    let observedReason: string | undefined
    const storage = await createStorage(t, {
      refreshOAuthCredential: async (_provider, _credentialId, credential, _signal, reason) => {
        observedReason = reason
        return {
          ...credential,
          refresh: 'fake-rotated-refresh',
          access: 'fake-rotated-access',
          expires: Date.now() + 60_000
        }
      }
    })
    await storage.credentials.set('provider-a', {
      type: 'oauth',
      refresh: 'fake-original-refresh',
      access: 'fake-expired-access',
      expires: 0
    })
    const credentialId = storage.credentials.list('provider-a')[0]?.id
    assert.ok(credentialId)

    const result = await createModelAccessBroker(storage).refresh({
      credentialId,
      reason: 'auth-recovery'
    })

    assert.equal(observedReason, 'auth-recovery')
    assert.equal(
      result.credential.type === 'oauth' ? result.credential.access : undefined,
      'fake-rotated-access'
    )
    assert.equal(
      result.credential.type === 'oauth' ? result.credential.refresh : undefined,
      REMOTE_REFRESH_SENTINEL
    )
    assert.equal(JSON.stringify(result).includes('fake-rotated-refresh'), false)
    const persisted = storage.credentials.list('provider-a')[0]?.credential
    assert.equal(persisted?.type === 'oauth' ? persisted.access : undefined, 'fake-rotated-access')
    assert.equal(
      persisted?.type === 'oauth' ? persisted.refresh : undefined,
      'fake-rotated-refresh'
    )
  }
)

test('modelAccess.refresh does not expose an upstream credential in its error', async () => {
  const storage = {
    credentials: {
      snapshot: () => ({ generation: 1, generatedAt: Date.now(), credentials: [] })
    },
    oauth: {
      refresh: async () => {
        throw new Error('refresh rejected fake-secret-from-provider')
      }
    }
  } satisfies ModelAccessAuthStorage

  await assert.rejects(createModelAccessBroker(storage).refresh({ credentialId: 41 }), (error) => {
    assert.ok(error instanceof ModelAccessBrokerError)
    assert.equal(error.code, 'REFRESH_FAILED')
    assert.equal(error.message, 'Model credential refresh failed.')
    assert.equal(String(error.stack).includes('fake-secret-from-provider'), false)
    assert.equal('cause' in error, false)
    return true
  })
})

test('a cancelled concurrent waiter stops waiting without cancelling the shared desktop refresh', async () => {
  const deferred = Promise.withResolvers<SnapshotEntry>()
  let refreshCalls = 0
  const refreshed: SnapshotEntry = {
    id: 41,
    provider: 'provider-a',
    credential: { type: 'api_key', key: 'fake-refreshed-key' },
    identityKey: null
  }
  const storage = {
    credentials: {
      snapshot: () => ({ generation: 1, generatedAt: Date.now(), credentials: [] })
    },
    oauth: {
      refresh: async () => {
        refreshCalls += 1
        return deferred.promise
      }
    }
  } satisfies ModelAccessAuthStorage
  const broker = createModelAccessBroker(storage)
  const controller = new AbortController()

  const active = broker.refresh({ credentialId: 41 })
  const cancelled = broker.refresh({ credentialId: 41 }, { signal: controller.signal })
  controller.abort()

  await assert.rejects(cancelled, (error) => {
    assert.ok(error instanceof ModelAccessBrokerError)
    assert.equal(error.code, 'REFRESH_ABORTED')
    return true
  })
  assert.equal(refreshCalls, 1)
  deferred.resolve(refreshed)
  assert.strictEqual(await active, refreshed)
})

test('cancelling the first waiter does not abort a refresh still needed by another waiter', async () => {
  const deferred = Promise.withResolvers<SnapshotEntry>()
  const refreshed: SnapshotEntry = {
    id: 41,
    provider: 'provider-a',
    credential: { type: 'api_key', key: 'fake-refreshed-key' },
    identityKey: null
  }
  const storage = {
    credentials: {
      snapshot: () => ({ generation: 1, generatedAt: Date.now(), credentials: [] })
    },
    oauth: {
      refresh: async (_credentialId: number, signal?: AbortSignal) => {
        return new Promise<SnapshotEntry>((resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('desktop refresh aborted')), {
            once: true
          })
          void deferred.promise.then(resolve, reject)
        })
      }
    }
  } satisfies ModelAccessAuthStorage
  const broker = createModelAccessBroker(storage)
  const controller = new AbortController()

  const cancelled = broker.refresh({ credentialId: 41 }, { signal: controller.signal })
  const active = broker.refresh({ credentialId: 41 })
  controller.abort()

  await assert.rejects(cancelled, (error) => {
    assert.ok(error instanceof ModelAccessBrokerError)
    assert.equal(error.code, 'REFRESH_ABORTED')
    return true
  })
  deferred.resolve(refreshed)
  assert.strictEqual(await active, refreshed)
})
