import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { resolveBunExecutable } from '../src/main/agent/engine/bun-executable'
import {
  DESKTOP_BROKER_API_KEY_CONFIG,
  projectDesktopBrokerModelsConfig
} from '../src/kernel/model-access/desktop-model-config'

const BUN_CHILD_ENV = 'PHI_DESKTOP_MODEL_ACCESS_BUN_CHILD'
const bunRuntime = 'Bun' in globalThis
const brokerModule = bunRuntime
  ? await import('../src/kernel/model-access/desktop-broker')
  : undefined
const BROKER_REGISTRY_TEST =
  'desktop broker registry resolves custom models and auth through stored credentials'

test('desktop broker admits credential-backed custom models without persisting the credential', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-kernel-desktop-model-config-'))
  const modelsPath = join(root, 'models.yml')
  const original = {
    providers: {
      'desktop-stored': {
        baseUrl: 'http://127.0.0.1:1/v1',
        api: 'openai-completions',
        authHeader: true,
        models: [
          {
            id: 'fixture-model',
            name: 'Fixture Model',
            reasoning: false,
            input: ['text'],
            contextWindow: 32_000,
            maxTokens: 4_096,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
          }
        ]
      },
      inline: {
        baseUrl: 'http://127.0.0.1:2/v1',
        api: 'openai-completions',
        apiKey: 'fake-inline-key',
        models: [{ id: 'inline-model' }]
      },
      'no-auth': {
        baseUrl: 'http://127.0.0.1:3/v1',
        api: 'openai-completions',
        auth: 'none',
        models: [{ id: 'no-auth-model' }]
      }
    }
  }
  writeFileSync(modelsPath, JSON.stringify(original), { mode: 0o600 })

  try {
    const projection = projectDesktopBrokerModelsConfig(modelsPath)
    assert.notEqual(projection.modelsPath, modelsPath)
    assert.deepEqual([...projection.credentialProviders], ['desktop-stored'])
    assert.deepEqual([...projection.authHeaderProviders], ['desktop-stored'])

    const projected = JSON.parse(readFileSync(projection.modelsPath!, 'utf8')) as {
      providers: Record<string, Record<string, unknown>>
    }
    assert.equal(projected.providers['desktop-stored'].apiKey, DESKTOP_BROKER_API_KEY_CONFIG)
    assert.equal(projected.providers['desktop-stored'].authHeader, false)
    assert.equal(projected.providers.inline.apiKey, 'fake-inline-key')
    assert.equal(projected.providers['no-auth'].auth, 'none')
    assert.equal(projected.providers['no-auth'].apiKey, undefined)
    assert.deepEqual(JSON.parse(readFileSync(modelsPath, 'utf8')), original)

    original.providers['desktop-stored'].models[0].id = 'replacement-model'
    writeFileSync(modelsPath, JSON.stringify(original), { mode: 0o600 })
    projection.sync()
    const refreshed = JSON.parse(readFileSync(projection.modelsPath!, 'utf8')) as {
      providers: Record<string, { apiKey?: string; models: Array<{ id: string }> }>
    }
    assert.equal(refreshed.providers['desktop-stored'].models[0].id, 'replacement-model')
    assert.equal(refreshed.providers['desktop-stored'].apiKey, DESKTOP_BROKER_API_KEY_CONFIG)
    assert.deepEqual([...projection.credentialProviders], ['desktop-stored'])

    const projectedPath = projection.modelsPath!
    projection.dispose()
    assert.equal(existsSync(projectedPath), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

if (!bunRuntime) {
  test(BROKER_REGISTRY_TEST, () => {
    execFileSync(
      resolveBunExecutable(),
      ['test', fileURLToPath(import.meta.url), '--test-name-pattern', BROKER_REGISTRY_TEST],
      {
        cwd: resolve('.'),
        env: { ...process.env, [BUN_CHILD_ENV]: '1' },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
  })
} else if (process.env[BUN_CHILD_ENV] === '1' || process.env[BUN_CHILD_ENV] === undefined) {
  test(BROKER_REGISTRY_TEST, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'phi-kernel-desktop-model-registry-'))
    const modelsPath = join(root, 'models.yml')
    const config = (id: string): Record<string, unknown> => ({
      providers: {
        'desktop-stored': {
          baseUrl: 'http://127.0.0.1:1/v1',
          api: 'openai-completions',
          authHeader: true,
          headers: { 'X-Fixture': 'kept' },
          models: [
            {
              id,
              name: 'Fixture Model',
              reasoning: false,
              input: ['text'],
              contextWindow: 32_000,
              maxTokens: 4_096,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
            }
          ]
        }
      }
    })
    writeFileSync(modelsPath, JSON.stringify(config('fixture-model')), { mode: 0o600 })
    let credentials = [
      {
        id: 41,
        provider: 'desktop-stored',
        credential: { type: 'api_key' as const, key: 'fake-desktop-stored-key' },
        identityKey: null
      }
    ]
    const access = await brokerModule!.createDesktopBrokerModelAccess({
      hydrate: false,
      modelsPath,
      cacheDbPath: ':memory:',
      requestCredentials: ({ provider } = {}) => ({
        credentials: provider
          ? credentials.filter((credential) => credential.provider === provider)
          : credentials
      }),
      requestRefresh: async () => {
        throw new Error('API-key fixture does not refresh')
      }
    })
    t.after(() => {
      access.close()
      rmSync(root, { recursive: true, force: true })
    })

    await access.authStorage.credentials.revalidate()
    const initial = access.modelRegistry.find('desktop-stored', 'fixture-model')
    assert.ok(initial)
    assert.equal(await access.modelRegistry.getApiKey(initial), 'fake-desktop-stored-key')
    assert.deepEqual(await initial.resolveHeaders?.(), {
      'X-Fixture': 'kept',
      Authorization: 'Bearer fake-desktop-stored-key'
    })

    writeFileSync(modelsPath, JSON.stringify(config('replacement-model')), { mode: 0o600 })
    await access.modelRegistry.refresh('offline')
    const refreshed = access.modelRegistry.find('desktop-stored', 'replacement-model')
    assert.ok(refreshed)
    assert.equal(await access.modelRegistry.getApiKey(refreshed), 'fake-desktop-stored-key')
    const headers = await refreshed.resolveHeaders?.()
    assert.equal(headers?.Authorization, 'Bearer fake-desktop-stored-key')
    assert.equal(JSON.stringify(headers).includes(DESKTOP_BROKER_API_KEY_CONFIG), false)

    credentials = []
    await access.authStorage.credentials.revalidate()
    assert.deepEqual(
      access.status().find(({ provider }) => provider === 'desktop-stored'),
      { provider: 'desktop-stored', status: 'unauthenticated' }
    )
  })
}
