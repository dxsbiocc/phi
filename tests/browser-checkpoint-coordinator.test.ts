import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BrowserCheckpointCoordinator,
  type BrowserCheckpointPersistenceError
} from '../src/main/browser/browser-checkpoint-coordinator'
import type {
  BrowserCheckpoint,
  BrowserCheckpointStore
} from '../src/main/browser/browser-checkpoints'
import { canonicalizeBrowserCheckpoint } from '../src/main/browser/browser-checkpoints'

class MemoryCheckpointStore implements BrowserCheckpointStore {
  saveAttempts = 0
  removeAttempts = 0
  saveError: Error | null = null
  removeError: Error | null = null

  constructor(public value: BrowserCheckpoint | null = null) {}

  load(): BrowserCheckpoint | null {
    return this.value ? structuredClone(this.value) : null
  }

  save(_sessionId: string, checkpoint: BrowserCheckpoint): void {
    this.saveAttempts += 1
    if (this.saveError) throw this.saveError
    this.value = structuredClone(checkpoint)
  }

  remove(): void {
    this.removeAttempts += 1
    if (this.removeError) throw this.removeError
    this.value = null
  }
}

const checkpoint: BrowserCheckpoint = {
  schemaVersion: 1,
  tabs: [{ id: 'tab-1', title: 'First', url: 'https://first.test/' }],
  activeTabId: 'tab-1'
}

const emptyCheckpoint: BrowserCheckpoint = {
  schemaVersion: 1,
  tabs: [],
  activeTabId: null
}

test('coordinator suppresses error storms and retries after metadata changes or flush', () => {
  const store = new MemoryCheckpointStore()
  store.saveError = new Error('raw write failure')
  const errors: string[] = []
  const coordinator = new BrowserCheckpointCoordinator({
    sessionId: 'session-1',
    store,
    onError: (error) => errors.push(JSON.stringify(error))
  })
  coordinator.persist(checkpoint)
  coordinator.persist(checkpoint)
  assert.equal(store.saveAttempts, 1)
  assert.equal(errors.length, 1)

  const changed = structuredClone(checkpoint)
  changed.tabs[0].title = 'Changed'
  coordinator.persist(changed)
  assert.equal(store.saveAttempts, 2)
  assert.equal(errors.length, 2)

  store.saveError = null
  coordinator.flush()
  assert.equal(store.saveAttempts, 3)
  coordinator.persist(changed)
  assert.equal(store.saveAttempts, 3)
  assert.equal(
    errors.some((error) => error.includes('raw write failure')),
    false
  )
})

test('coordinator retries a failed removal during final flush', () => {
  const store = new MemoryCheckpointStore(checkpoint)
  const coordinator = new BrowserCheckpointCoordinator({ sessionId: 'session-1', store })
  assert.deepEqual(coordinator.load(), checkpoint)
  store.removeError = new Error('temporary remove failure')
  coordinator.persist(emptyCheckpoint)
  coordinator.persist(emptyCheckpoint)
  assert.equal(store.removeAttempts, 1)
  store.removeError = null
  coordinator.flush()
  assert.equal(store.removeAttempts, 2)

  const fresh = new BrowserCheckpointCoordinator({ sessionId: 'session-1', store })
  assert.equal(fresh.load(), null)
})

test('coordinator final flush throws a safe error when persistence remains unavailable', () => {
  const store = new MemoryCheckpointStore(checkpoint)
  const coordinator = new BrowserCheckpointCoordinator({ sessionId: 'session-1', store })
  coordinator.load()
  store.removeError = new Error('raw permanent removal secret')
  coordinator.persist(emptyCheckpoint)

  assert.throws(
    () => coordinator.flush(),
    (error: BrowserCheckpointPersistenceError) =>
      error.message === 'Browser checkpoint could not be saved' &&
      !error.message.includes('raw permanent removal secret')
  )
  assert.equal(store.removeAttempts, 2)
})

test('canonicalization rejects unbounded metadata before signature or store access', () => {
  const oversized = {
    schemaVersion: 1,
    tabs: [{ id: 'tab-1', title: 'x'.repeat(100_000), url: 'https://example.test/' }],
    activeTabId: 'tab-1'
  }
  assert.throws(() => canonicalizeBrowserCheckpoint(oversized), /Invalid browser checkpoint/)

  const store = new MemoryCheckpointStore()
  const errors: string[] = []
  const coordinator = new BrowserCheckpointCoordinator({
    sessionId: 'session-1',
    store,
    onError: (error) => errors.push(JSON.stringify(error))
  })
  coordinator.persist(oversized as BrowserCheckpoint)
  coordinator.persist(oversized as BrowserCheckpoint)

  assert.equal(store.saveAttempts, 0)
  assert.equal(store.removeAttempts, 0)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].includes('x'.repeat(100)), false)
})
