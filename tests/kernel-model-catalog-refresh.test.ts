import assert from 'node:assert/strict'
import test from 'node:test'

import type { KernelModelAccess } from '../src/kernel/model-access'
import { requireAvailableModel } from '../src/kernel/worker/model-access-handlers'

function access(options: {
  catalog: Array<{ provider: string; id: string }>
  refresh(): Promise<void>
  resolvable?: boolean
}): KernelModelAccess {
  return {
    authStorage: { credentials: { revalidate: async () => undefined } },
    refreshCatalog: options.refresh,
    modelRegistry: {
      refresh: options.refresh,
      find: (provider: string, id: string) =>
        options.resolvable === false
          ? undefined
          : options.catalog.find((model) => model.provider === provider && model.id === id)
    },
    catalog: () => options.catalog,
    status: () => [{ provider: 'fixture', status: 'available' as const }],
    onChange: () => () => undefined,
    close: () => undefined
  } as unknown as KernelModelAccess
}

test('model validation reloads the offline catalog at every selection boundary', async () => {
  const catalog: Array<{ provider: string; id: string }> = []
  let refreshes = 0
  const modelAccess = access({
    catalog,
    refresh: async () => {
      refreshes += 1
      if (catalog.length === 0) catalog.push({ provider: 'fixture', id: 'late-model' })
    }
  } as never)
  await requireAvailableModel(modelAccess, { provider: 'fixture', id: 'late-model' })
  assert.equal(refreshes, 1)
  await requireAvailableModel(modelAccess, { provider: 'fixture', id: 'late-model' })
  assert.equal(refreshes, 2)
})

test('a removed cached model is unavailable after the offline catalog reload', async () => {
  const catalog = [{ provider: 'fixture', id: 'retired-model' }]
  const modelAccess = access({
    catalog,
    refresh: async () => {
      catalog.splice(0, catalog.length, { provider: 'fixture', id: 'replacement-model' })
    }
  })
  await assert.rejects(
    requireAvailableModel(modelAccess, { provider: 'fixture', id: 'retired-model' }),
    (error: { code?: string }) => error.code === 'MODEL_UNAVAILABLE'
  )
  await requireAvailableModel(modelAccess, {
    provider: 'fixture',
    id: 'replacement-model'
  })
})

test('a model still missing after reload, or a failed reload, stays MODEL_UNAVAILABLE', async () => {
  for (const refresh of [
    async () => undefined,
    async () => Promise.reject(new Error('bad yaml'))
  ]) {
    await assert.rejects(
      requireAvailableModel(access({ catalog: [], refresh }), { provider: 'fixture', id: 'x' }),
      (error: { code?: string }) => error.code === 'MODEL_UNAVAILABLE'
    )
  }
})

test('a catalog entry that cannot resolve in the model registry stays MODEL_UNAVAILABLE', async () => {
  const modelAccess = access({
    catalog: [{ provider: 'fixture', id: 'detached-model' }],
    refresh: async () => undefined,
    resolvable: false
  })
  await assert.rejects(
    requireAvailableModel(modelAccess, { provider: 'fixture', id: 'detached-model' }),
    (error: { code?: string }) => error.code === 'MODEL_UNAVAILABLE'
  )
})
