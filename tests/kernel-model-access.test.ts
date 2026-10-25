import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  createClientProxyModelAccess,
  createDesktopBrokerModelAccess,
  ModelAccessReadOnlyError,
  ModelAccessWaitCancelledError,
  ModelConnectionLostError,
  type DesktopBrokerCredentialEntry
} from '../src/kernel/model-access'
import { promptWithAutomaticModelFallback } from '../src/main/agent/session/automatic-model-fallback'
import type { ModelAccessConfigureParams } from '../src/shared/kernel-protocol'

const provider = 'phi-kernel-model-access-fixture'
const desktopProvider = 'anthropic'
const REMOTE_REFRESH_SENTINEL = '__remote__' as const
const descriptor = {
  provider,
  id: 'fixture-model',
  name: 'Fixture Model',
  reasoning: true,
  input: ['text', 'image'] as const,
  contextWindow: 32_000,
  maxTokens: 4_096,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }
}

function configuration(port: number, bearerToken: string): ModelAccessConfigureParams {
  return {
    endpoint: `http://127.0.0.1:${port}/v1/pi/stream`,
    bearerToken,
    models: [{ ...descriptor, input: [...descriptor.input] }]
  }
}

test('desktop broker is memory-only, read-only, observes logout and single-flights refresh', async (t) => {
  let rows: DesktopBrokerCredentialEntry[] = [
    {
      id: 41,
      provider: desktopProvider,
      credential: {
        type: 'oauth',
        refresh: REMOTE_REFRESH_SENTINEL,
        access: 'expired-fake-access',
        expires: 0
      },
      identityKey: null
    }
  ]
  let refreshCalls = 0
  const pending = Promise.withResolvers<DesktopBrokerCredentialEntry>()
  const access = await createDesktopBrokerModelAccess({
    requestCredentials: () => ({ credentials: rows }),
    async requestRefresh() {
      refreshCalls += 1
      return pending.promise
    }
  })
  t.after(() => access.close())

  assert.equal(
    access.status().find((entry) => entry.provider === desktopProvider)?.status,
    'available'
  )
  await assert.rejects(
    access.authStorage.credentials.set(desktopProvider, { type: 'api_key', key: 'x' }),
    (error) => error instanceof ModelAccessReadOnlyError && error.operation === 'set'
  )
  await assert.rejects(
    access.authStorage.credentials.remove(desktopProvider),
    (error) => error instanceof ModelAccessReadOnlyError && error.operation === 'remove'
  )
  await assert.rejects(
    access.authStorage.oauth.login(desktopProvider, {
      onAuth: () => undefined,
      onPrompt: async () => '',
      onProgress: () => undefined
    }),
    (error) => error instanceof ModelAccessReadOnlyError && error.operation === 'login'
  )

  const mainTurn = access.authStorage.keys.get(desktopProvider)
  const compactionTurn = access.authStorage.keys.get(desktopProvider)
  const controlledSubtask = access.authStorage.keys.get(desktopProvider)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(refreshCalls, 1)
  const refreshed: DesktopBrokerCredentialEntry = {
    id: 41,
    provider: desktopProvider,
    credential: {
      type: 'oauth',
      refresh: REMOTE_REFRESH_SENTINEL,
      access: 'refreshed-fake-access',
      expires: Date.now() + 3_600_000
    },
    identityKey: null
  }
  rows = [refreshed]
  pending.resolve(refreshed)
  assert.equal(await mainTurn, 'refreshed-fake-access')
  assert.equal(await compactionTurn, 'refreshed-fake-access')
  assert.equal(await controlledSubtask, 'refreshed-fake-access')
  assert.equal(refreshCalls, 1)

  rows = []
  assert.equal(await access.authStorage.keys.get(desktopProvider), undefined)
  assert.equal(
    access.status().find((entry) => entry.provider === desktopProvider)?.status,
    'unauthenticated'
  )
})

test('desktop broker never falls back to ambient provider credentials', async (t) => {
  const agentDir = await mkdtemp(join(tmpdir(), 'phi-kernel-model-access-agent-'))
  process.env.ANTHROPIC_API_KEY = 'fake-ambient-key-that-must-not-be-used'
  process.env.PI_CODING_AGENT_DIR = agentDir
  t.after(() => {
    delete process.env.ANTHROPIC_API_KEY
    delete process.env.PI_CODING_AGENT_DIR
    return rm(agentDir, { recursive: true, force: true })
  })
  const access = await createDesktopBrokerModelAccess({
    requestCredentials: () => ({ credentials: [] }),
    requestRefresh: async () => {
      throw new Error('refresh is not expected')
    }
  })
  t.after(() => access.close())

  assert.equal(await access.authStorage.keys.get('anthropic'), undefined)
  assert.equal(
    access.status().find((entry) => entry.provider === 'anthropic')?.status,
    'unauthenticated'
  )
  assert.deepEqual(await readdir(agentDir), [])
})

test('client proxy reconfigures stable session models and bearer credentials in place', async (t) => {
  const firstBearer = 'a'.repeat(43)
  const secondBearer = 'b'.repeat(43)
  const access = createClientProxyModelAccess()
  t.after(() => access.close())
  let changes = 0
  access.onChange(() => {
    changes += 1
  })

  access.controllerAttached()
  await access.configure(configuration(41001, firstBearer))
  const selected = access.modelRegistry.find(provider, descriptor.id)
  assert.ok(selected)
  assert.strictEqual(access.catalog()[0], selected)
  assert.equal(selected.baseUrl, 'http://127.0.0.1:41001')
  assert.equal(selected.transport, 'pi-native')
  assert.equal(await access.authStorage.keys.get(provider), firstBearer)
  assert.deepEqual(access.status(), [{ provider, status: 'available' }])

  access.controllerDetached()
  assert.deepEqual(access.status(), [{ provider, status: 'unreachable' }])
  access.controllerAttached()
  assert.deepEqual(access.status(), [{ provider, status: 'unreachable' }])
  await access.configure(configuration(41002, secondBearer))

  assert.strictEqual(access.modelRegistry.find(provider, descriptor.id), access.catalog()[0])
  assert.equal(selected.baseUrl, 'http://127.0.0.1:41002')
  assert.equal(await access.authStorage.keys.get(provider), secondBearer)
  assert.deepEqual(access.status(), [{ provider, status: 'available' }])
  assert.ok(changes >= 5)
  await assert.rejects(
    access.authStorage.credentials.set(provider, { type: 'api_key', key: 'x' }),
    ModelAccessReadOnlyError
  )
})

test('client proxy retries one pre-byte refused request after attach and fresh configure', async (t) => {
  const calls: Array<{ url: string; authorization: string | null }> = []
  const access = createClientProxyModelAccess({
    fetch: async (input, init) => {
      calls.push({
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization')
      })
      if (calls.length === 1) {
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
      }
      return new Response('data: {"type":"done"}\n\n', {
        headers: { 'content-type': 'text/event-stream' }
      })
    }
  })
  t.after(() => access.close())
  const firstBearer = 'c'.repeat(43)
  const secondBearer = 'd'.repeat(43)
  access.controllerAttached()
  await access.configure(configuration(42001, firstBearer))
  access.controllerDetached()

  const pending = access.requestFetch('http://127.0.0.1:42001/v1/pi/stream', {
    method: 'POST',
    body: '{}'
  })
  await new Promise((resolve) => setImmediate(resolve))
  access.controllerAttached()
  await access.configure(configuration(42002, secondBearer))

  assert.match(await (await pending).text(), /done/)
  assert.deepEqual(calls, [
    {
      url: 'http://127.0.0.1:42001/v1/pi/stream',
      authorization: `Bearer ${firstBearer}`
    },
    {
      url: 'http://127.0.0.1:42002/v1/pi/stream',
      authorization: `Bearer ${secondBearer}`
    }
  ])
})

test('client proxy surfaces post-byte loss and cancellation while waiting', async (t) => {
  let pulls = 0
  const access = createClientProxyModelAccess({
    fetch: async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulls += 1
            if (pulls === 1) controller.enqueue(new TextEncoder().encode('data: partial\n\n'))
            else controller.error(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
          }
        })
      )
  })
  t.after(() => access.close())
  access.controllerAttached()
  await access.configure(configuration(43001, 'e'.repeat(43)))
  const response = await access.requestFetch('http://127.0.0.1:43001/v1/pi/stream')
  const reader = response.body!.getReader()
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: partial\n\n')
  access.controllerDetached()
  await assert.rejects(reader.read(), (error) => error instanceof ModelConnectionLostError)

  const waitingAccess = createClientProxyModelAccess({
    fetch: async () => {
      throw Object.assign(new Error('reset'), { code: 'ECONNRESET' })
    }
  })
  t.after(() => waitingAccess.close())
  waitingAccess.controllerAttached()
  await waitingAccess.configure(configuration(43002, 'f'.repeat(43)))
  waitingAccess.controllerDetached()
  const waiting = waitingAccess.requestFetch('http://127.0.0.1:43002/v1/pi/stream')
  await new Promise((resolve) => setImmediate(resolve))
  waitingAccess.cancelWaiting(new ModelAccessWaitCancelledError('grace expired'))
  await assert.rejects(
    waiting,
    (error) => error instanceof ModelAccessWaitCancelledError && error.message === 'grace expired'
  )
})

test('client proxy automatic fallback keeps one history and never saves a manual preference', async (t) => {
  const attempts: string[] = []
  const access = createClientProxyModelAccess({
    fetch: async (_input, init) => {
      const modelId = JSON.parse(String(init?.body)).modelId as string
      attempts.push(modelId)
      return modelId.endsWith('/first')
        ? new Response('model unavailable', { status: 503 })
        : new Response('data: {"type":"done"}\n\n', {
            headers: { 'content-type': 'text/event-stream' }
          })
    }
  })
  t.after(() => access.close())
  access.controllerAttached()
  await access.configure({
    endpoint: 'http://127.0.0.1:44001/v1/pi/stream',
    bearerToken: 'g'.repeat(43),
    models: [
      { ...descriptor, id: 'first', input: [...descriptor.input] },
      { ...descriptor, id: 'second', input: [...descriptor.input] }
    ]
  })
  let selected = access.catalog()[0]!
  const messages: Array<Record<string, unknown>> = []
  let recordedFailure: string | undefined
  const savedManualPreference = `${provider}/manual-model`

  await promptWithAutomaticModelFallback({
    session: {
      get model() {
        return selected
      },
      messages,
      async setModel(next) {
        selected = next
      },
      async prompt(_text, options) {
        const response = await access.requestFetch(access.route!.endpoint, {
          method: 'POST',
          body: JSON.stringify({ modelId: `${selected.provider}/${selected.id}` })
        })
        if (!response.ok) {
          recordedFailure = `${response.status} model unavailable`
          messages.push({ role: 'assistant', stopReason: 'error', options })
        } else {
          messages.push({ role: 'assistant', stopReason: 'stop', options })
        }
      }
    },
    text: 'remote automatic prompt',
    options: {},
    automatic: true,
    isCurrent: () => true,
    recordedFailure: () => recordedFailure,
    clearFailure: () => {
      recordedFailure = undefined
    },
    candidates: async () => [...access.catalog()],
    onSwitch: () => undefined
  })

  assert.deepEqual(attempts, [`${provider}/first`, `${provider}/second`])
  assert.equal(messages.length, 2)
  assert.equal(selected.id, 'second')
  assert.equal(savedManualPreference, `${provider}/manual-model`)
})
