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

test('a model added to models.yml after kernel start is found after one offline reload', async () => {
  const catalog: Array<{ provider: string; id: string }> = []
  const strategies: unknown[] = []
  const modelAccess = access({
    catalog,
    refresh: async (...args: unknown[]) => {
      strategies.push(args[0])
      catalog.push({ provider: 'fixture', id: 'late-model' })
    }
  } as never)
  await requireAvailableModel(modelAccess, { provider: 'fixture', id: 'late-model' })
  assert.deepEqual(strategies, ['offline'])
  await requireAvailableModel(modelAccess, { provider: 'fixture', id: 'late-model' })
  assert.deepEqual(strategies, ['offline'], 'a catalog hit does not reload again')
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
