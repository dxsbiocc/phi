import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ModelAvailabilityController,
  availabilityTarget
} from '../src/renderer/src/features/settings/lib/modelAvailabilityController'
import type {
  ModelAvailabilityChange,
  ModelAvailabilitySnapshot
} from '../src/shared/modelAvailabilityTypes'

const initial: ModelAvailabilitySnapshot = {
  disabledProviders: [],
  disabledModels: [],
  models: [
    {
      providerId: 'openai',
      modelId: 'chat',
      name: 'Chat',
      kind: 'chat',
      configured: true,
      enabled: true
    },
    {
      providerId: 'typesafe',
      modelId: 'jev',
      name: 'JEV',
      kind: 'decision',
      configured: true,
      enabled: true
    }
  ]
}
function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  return {
    promise: new Promise((done, fail) => {
      resolve = done
      reject = fail
    }),
    resolve: (value) => resolve(value),
    reject: (error) => reject(error)
  }
}
function fixture(): {
  controller: ModelAvailabilityController
  writes: Array<{
    change: ModelAvailabilityChange
    result: ReturnType<typeof deferred<ModelAvailabilitySnapshot>>
  }>
  reads: Array<ReturnType<typeof deferred<ModelAvailabilitySnapshot>>>
  events: string[]
  dispose: () => void
} {
  const writes: Array<{
    change: ModelAvailabilityChange
    result: ReturnType<typeof deferred<ModelAvailabilitySnapshot>>
  }> = []
  const reads: Array<ReturnType<typeof deferred<ModelAvailabilitySnapshot>>> = []
  const events: string[] = []
  const controller = new ModelAvailabilityController(
    {
      getModelAvailability: () => {
        const result = deferred<ModelAvailabilitySnapshot>()
        reads.push(result)
        return result.promise
      },
      setModelEnabled: (change) => {
        const result = deferred<ModelAvailabilitySnapshot>()
        writes.push({ change, result })
        return result.promise
      }
    },
    () => events.push('acknowledged')
  )
  return { controller, writes, reads, events, dispose: controller.mount() }
}
async function load(app: ReturnType<typeof fixture>): Promise<void> {
  const pending = app.controller.refresh()
  app.reads.at(-1)!.resolve(initial)
  await pending
}

test('failed availability writes keep confirmed checked values and do not send refresh events', async () => {
  const app = fixture()
  await load(app)
  const change = { providerId: 'typesafe', enabled: false }
  const pending = app.controller.change(change)
  assert.deepEqual(app.controller.getSnapshot().snapshot, initial)
  assert.deepEqual(app.controller.getSnapshot().pending, [availabilityTarget(change)])
  await app.controller.change(change)
  assert.equal(app.writes.length, 1, 'repeat clicks for the pending target are ignored')
  app.writes[0].result.reject(new Error('settings read-only'))
  await pending
  assert.deepEqual(app.controller.getSnapshot().snapshot, initial)
  assert.equal(
    app.controller.getSnapshot().errors[availabilityTarget(change)],
    'settings read-only'
  )
  assert.deepEqual(app.controller.getSnapshot().pending, [])
  assert.deepEqual(app.events, [])
})

test('different model and provider switches can save concurrently without stale responses reverting either target', async () => {
  const app = fixture()
  await load(app)
  const provider = app.controller.change({ providerId: 'typesafe', enabled: false })
  const model = app.controller.change({ providerId: 'openai', modelId: 'chat', enabled: false })
  app.writes[1].result.resolve({
    ...initial,
    disabledModels: [{ providerId: 'openai', modelId: 'chat' }]
  })
  await model
  app.writes[0].result.resolve({ ...initial, disabledProviders: ['typesafe'] })
  await provider
  assert.deepEqual(app.controller.getSnapshot().snapshot?.disabledProviders, ['typesafe'])
  assert.deepEqual(app.controller.getSnapshot().snapshot?.disabledModels, [
    { providerId: 'openai', modelId: 'chat' }
  ])
  assert.ok(app.controller.getSnapshot().snapshot?.models.every((item) => !item.enabled))
  assert.equal(app.events.length, 2)
})

test('provider auth/catalog refresh queued during a toggle runs after the last pending response', async () => {
  const app = fixture()
  await load(app)
  const pending = app.controller.change({ providerId: 'typesafe', enabled: false })
  await app.controller.refresh()
  assert.equal(app.reads.length, 1)
  app.writes[0].result.resolve({ ...initial, disabledProviders: ['typesafe'] })
  await pending
  assert.equal(app.reads.length, 2)
  const added = { ...initial.models[0], providerId: 'new-provider', modelId: 'new-model' }
  app.reads[1].resolve({
    ...initial,
    disabledProviders: ['typesafe'],
    models: [...initial.models, added]
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(app.controller.getSnapshot().snapshot?.models.at(-1)?.modelId, 'new-model')
  assert.deepEqual(app.controller.getSnapshot().snapshot?.disabledProviders, ['typesafe'])
})

test('an old directory read and a save from an unmounted owner cannot overwrite current state', async () => {
  const app = fixture()
  await load(app)
  const oldRead = app.controller.refresh()
  const pending = app.controller.change({ providerId: 'typesafe', enabled: false })
  app.reads[1].resolve({ ...initial, models: [] })
  await oldRead
  assert.equal(app.controller.getSnapshot().snapshot?.models.length, 2)
  app.dispose()
  app.controller.mount()
  const newRead = app.controller.refresh()
  app.reads[2].resolve({ ...initial, models: [initial.models[0]] })
  await newRead
  app.writes[0].result.resolve({ ...initial, disabledProviders: ['typesafe'] })
  await pending
  assert.equal(app.controller.getSnapshot().snapshot?.models.length, 1)
  assert.equal(app.events.length, 1, 'persisted writes still notify the current model picker')
})
