import assert from 'node:assert/strict'
import test from 'node:test'
import { SessionLifecycle, StaleSessionError } from '../src/main/agent/session/session-lifecycle'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve
    reject = innerReject
  })
  return { promise, resolve, reject }
}

test('late stale session creation is rejected and cleaned up without replacing current record', async () => {
  const lifecycle = new SessionLifecycle<{ id: string }>()
  const staleResults: string[] = []
  const first = deferred<{ id: string }>()
  const second = deferred<{ id: string }>()

  const firstRecord = lifecycle.getOrCreate(
    { path: '/tmp/a.json', cwd: '/tmp/a', permissionMode: 'auto' },
    () => first.promise,
    (result) => {
      staleResults.push(result.id)
    }
  )

  assert.equal(firstRecord.generation, 0)
  assert.equal(lifecycle.advance(), firstRecord)

  const secondRecord = lifecycle.getOrCreate(
    { path: '/tmp/b.json', cwd: '/tmp/b', permissionMode: 'ask' },
    () => second.promise,
    (result) => {
      staleResults.push(result.id)
    }
  )

  second.resolve({ id: 'second' })
  assert.deepEqual(await secondRecord.promise, { id: 'second' })
  assert.equal(lifecycle.currentRecord, secondRecord)

  first.resolve({ id: 'first' })
  await assert.rejects(firstRecord.promise, StaleSessionError)
  assert.deepEqual(staleResults, ['first'])
  assert.equal(lifecycle.currentRecord, secondRecord)
})

test('session creation snapshots are copied before async work runs', async () => {
  const lifecycle = new SessionLifecycle<{ cwd: string; path: string | undefined }>()
  const snapshot = { path: undefined, cwd: '/tmp/original', permissionMode: 'auto' }

  const record = lifecycle.getOrCreate(snapshot, async (captured) => ({
    cwd: captured.cwd,
    path: captured.path
  }))
  snapshot.cwd = '/tmp/mutated'
  snapshot.path = '/tmp/mutated.json'

  assert.deepEqual(await record.promise, { cwd: '/tmp/original', path: undefined })
})

test('generation advances invalidate queued work before it can become current', async () => {
  const lifecycle = new SessionLifecycle<{ id: string }>()

  const record = lifecycle.getOrCreate(
    { path: undefined, cwd: '/tmp/a', permissionMode: 'auto' },
    async (_snapshot, generation) => {
      if (!lifecycle.isCurrentGeneration(generation)) {
        throw new StaleSessionError()
      }
      return { id: 'unreachable' }
    }
  )

  lifecycle.advance()

  await assert.rejects(record.promise, StaleSessionError)
  assert.equal(lifecycle.currentRecord, null)
})
