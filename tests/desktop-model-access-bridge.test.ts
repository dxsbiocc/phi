import assert from 'node:assert/strict'
import test from 'node:test'

import { KernelClientError } from '../src/main/agent/engine/kernel-client'
import {
  createDesktopModelAccessOwner,
  type DesktopModelAccessBridge
} from '../src/main/agent/engine/kernel-host/desktop-model-access'
import {
  DESKTOP_MODEL_ACCESS_WORKER_METHODS,
  ModelAccessBrokerError
} from '../src/main/agent/engine/kernel-host/model-access-broker'
import type { OmpRequestOptions } from '../src/main/agent/engine/omp-bridge'

test('desktop model access proxies credential snapshots and refreshes to the Bun worker', async () => {
  const credential = {
    id: 7,
    provider: 'fixture',
    credential: { type: 'api_key' as const, key: 'fixture-key' },
    identityKey: null
  }
  const calls: Array<{ method: string; params: unknown; signal?: AbortSignal }> = []
  const bridge: DesktopModelAccessBridge = {
    async request<T>(
      method: string,
      params?: unknown,
      options: OmpRequestOptions = {}
    ): Promise<T> {
      calls.push({ method, params, signal: options.signal })
      return (
        method === DESKTOP_MODEL_ACCESS_WORKER_METHODS.credentials
          ? { credentials: [credential] }
          : { ok: true, credential }
      ) as T
    }
  }
  const owner = createDesktopModelAccessOwner('/private/agent', bridge)
  const controller = new AbortController()

  assert.deepEqual(await owner.broker.credentials({ provider: 'fixture' }), {
    credentials: [credential]
  })
  assert.deepEqual(
    await owner.broker.refresh(
      { credentialId: 7, reason: 'auth-recovery' },
      { signal: controller.signal }
    ),
    credential
  )
  assert.deepEqual(calls, [
    {
      method: DESKTOP_MODEL_ACCESS_WORKER_METHODS.credentials,
      params: { agentDir: '/private/agent', provider: 'fixture' },
      signal: undefined
    },
    {
      method: DESKTOP_MODEL_ACCESS_WORKER_METHODS.refresh,
      params: { agentDir: '/private/agent', credentialId: 7, reason: 'auth-recovery' },
      signal: controller.signal
    }
  ])
})

test('desktop model access fails closed for one dead worker generation and recovers on the next', async () => {
  let generation = 0
  const bridge: DesktopModelAccessBridge = {
    async request<T>(): Promise<T> {
      generation += 1
      if (generation === 1) throw new Error('worker exited')
      return { credentials: [] } as T
    }
  }
  const owner = createDesktopModelAccessOwner('/private/agent', bridge)

  await assert.rejects(Promise.resolve(owner.broker.credentials({})), (error) => {
    assert.ok(error instanceof KernelClientError)
    assert.equal(error.code, 'CAPABILITY_UNAVAILABLE')
    assert.deepEqual(error.detail, { reason: 'desktop_credential_broker_disconnected' })
    return true
  })
  assert.deepEqual(await owner.broker.credentials({}), { credentials: [] })
  assert.equal(generation, 2)
})

test('desktop model access preserves worker refresh failures without exposing transport errors', async () => {
  const bridge: DesktopModelAccessBridge = {
    async request<T>(): Promise<T> {
      return { ok: false, code: 'REFRESH_FAILED' } as T
    }
  }
  const owner = createDesktopModelAccessOwner('/private/agent', bridge)
  await assert.rejects(owner.broker.refresh({ credentialId: 9 }), (error) => {
    assert.ok(error instanceof ModelAccessBrokerError)
    assert.equal(error.code, 'REFRESH_FAILED')
    return true
  })
})
