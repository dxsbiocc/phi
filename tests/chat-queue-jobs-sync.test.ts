import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import type { ChatQueueJobsSnapshot, ChatQueueJobsVersion } from '../src/shared/chatQueueTypes'
import { createChatQueueJobsSync } from '../src/renderer/src/features/jobs/lib/chatQueueJobsSync'

function snapshot(
  revision: number,
  status: 'queued' | 'running' = 'queued',
  epoch = 'process-a'
): ChatQueueJobsSnapshot {
  return {
    epoch,
    revision,
    items: [
      {
        id: 'one',
        sessionId: 'origin',
        sessionPath: 'phi-session:origin',
        preview: 'one',
        status,
        imageCount: 0,
        timestamp: '2026-11-19T00:00:00.000Z'
      }
    ]
  }
}

function fixture(): {
  sync: ReturnType<typeof createChatQueueJobsSync>
  reads: Array<PromiseWithResolvers<ChatQueueJobsSnapshot>>
  publications: ChatQueueJobsSnapshot[]
  handlers: Array<(version: ChatQueueJobsVersion) => void>
  errors: unknown[]
  countUnsubscribes: () => number
} {
  const reads: Array<PromiseWithResolvers<ChatQueueJobsSnapshot>> = []
  const publications: ChatQueueJobsSnapshot[] = []
  const handlers: Array<(version: ChatQueueJobsVersion) => void> = []
  const errors: unknown[] = []
  let count = 0
  const sync = createChatQueueJobsSync({
    read() {
      assert.ok(handlers.length > 0, 'subscribe before requesting the initial snapshot')
      const request = Promise.withResolvers<ChatQueueJobsSnapshot>()
      reads.push(request)
      return request.promise
    },
    listen(handler) {
      handlers.push(handler)
      return () => {
        count += 1
      }
    },
    publish: (value) => {
      publications.push(value)
    },
    onError: (error) => {
      errors.push(error)
    }
  })
  return { sync, reads, publications, handlers, errors, countUnsubscribes: () => count }
}

test('a burst of version notices discards an older in-flight reply and triggers one pull', async () => {
  const f = fixture()
  const stop = f.sync.start()
  await setImmediate()
  f.handlers[0]({ epoch: 'process-a', revision: 2 })
  f.handlers[0]({ epoch: 'process-a', revision: 5 })
  f.handlers[0]({ epoch: 'process-a', revision: 3 })
  f.reads[0].resolve(snapshot(1))
  await setImmediate()
  assert.deepEqual(f.publications, [])
  assert.equal(f.reads.length, 2)
  f.reads[1].resolve(snapshot(5, 'running'))
  await setImmediate()
  assert.deepEqual(f.publications, [snapshot(5, 'running')])
  f.handlers[0]({ epoch: 'process-a', revision: 4 })
  await setImmediate()
  assert.equal(f.reads.length, 2)
  stop()
})

test('polling recovers a skipped notice, including an equal-revision durable snapshot', async () => {
  const f = fixture()
  const stop = f.sync.start()
  await setImmediate()
  f.reads[0].resolve(snapshot(1))
  await setImmediate()
  const refresh = f.sync.refresh()
  await setImmediate()
  f.reads[1].resolve(snapshot(1, 'running'))
  await refresh
  assert.deepEqual(f.publications, [snapshot(1), snapshot(1, 'running')])
  stop()
})

test('re-subscription always pulls and cannot receive state or events from its old generation', async () => {
  const f = fixture()
  const firstStop = f.sync.start()
  await setImmediate()
  firstStop()
  firstStop()
  const secondStop = f.sync.start()
  await setImmediate()
  assert.equal(f.reads.length, 2)
  f.handlers[0]({ epoch: 'process-a', revision: 100 })
  f.reads[0].resolve(snapshot(100))
  f.reads[1].resolve(snapshot(2, 'running'))
  await setImmediate()
  assert.deepEqual(f.publications, [snapshot(2, 'running')])
  assert.equal(f.reads.length, 2)
  secondStop()
  assert.equal(f.countUnsubscribes(), 2)
})

test('an epoch change while reading fences the prior process reply', async () => {
  const f = fixture()
  const stop = f.sync.start()
  await setImmediate()
  f.reads[0].resolve(snapshot(12))
  await setImmediate()
  const interrupted = f.sync.refresh()
  await setImmediate()
  f.handlers[0]({ epoch: 'process-b', revision: 0 })
  f.reads[1].resolve(snapshot(13))
  await setImmediate()
  assert.equal(f.reads.length, 3)
  assert.deepEqual(f.publications, [snapshot(12)])
  f.reads[2].resolve(snapshot(20, 'running'))
  await interrupted
  assert.deepEqual(f.publications, [snapshot(12)])
  assert.equal(f.reads.length, 3)
  const retry = f.sync.refresh()
  await setImmediate()
  f.reads[3].resolve(snapshot(0, 'running', 'process-b'))
  await retry
  assert.deepEqual(f.publications, [snapshot(12), snapshot(0, 'running', 'process-b')])
  stop()
})

test('a pull can discover a second restart without an event from the latest process', async () => {
  const f = fixture()
  const stop = f.sync.start()
  await setImmediate()
  f.reads[0].resolve(snapshot(10))
  await setImmediate()
  f.handlers[0]({ epoch: 'process-b', revision: 1 })
  await setImmediate()
  f.reads[1].resolve(snapshot(0, 'queued', 'process-c'))
  await setImmediate()
  assert.deepEqual(f.publications, [snapshot(10), snapshot(0, 'queued', 'process-c')])
  f.handlers[0]({ epoch: 'process-b', revision: 99 })
  await setImmediate()
  assert.equal(f.reads.length, 2)
  stop()
})

test('a manual refresh after an action pulls again if the read was already in flight', async () => {
  const f = fixture()
  const stop = f.sync.start()
  await setImmediate()
  const refreshed = f.sync.refresh()
  f.reads[0].resolve(snapshot(1))
  await setImmediate()
  assert.equal(f.reads.length, 2)
  f.reads[1].resolve(snapshot(2, 'running'))
  await refreshed
  assert.deepEqual(f.publications, [snapshot(1), snapshot(2, 'running')])
  stop()
})

test('a notice arriving during a failed read still gets one trailing read', async () => {
  const f = fixture()
  const stop = f.sync.start()
  await setImmediate()
  f.handlers[0]({ epoch: 'process-a', revision: 5 })
  f.reads[0].reject(new Error('late IPC failure'))
  await setImmediate()
  assert.equal(f.reads.length, 2)
  assert.equal(f.errors.length, 1)
  f.reads[1].resolve(snapshot(5))
  await setImmediate()
  assert.deepEqual(f.publications, [snapshot(5)])
  stop()
})

test('failed pulls retain the last good data and wait for a subsequent signal', async () => {
  const f = fixture()
  const stop = f.sync.start()
  await setImmediate()
  f.reads[0].resolve(snapshot(1))
  await setImmediate()
  const refresh = f.sync.refresh()
  await setImmediate()
  const failure = new Error('IPC rejected its read')
  f.reads[1].reject(failure)
  await refresh
  await setImmediate()
  assert.deepEqual(f.errors, [failure])
  assert.deepEqual(f.publications, [snapshot(1)])
  assert.equal(f.reads.length, 2)
  f.handlers[0]({ epoch: 'process-a', revision: 3 })
  await setImmediate()
  f.reads[2].resolve(snapshot(3, 'running'))
  await setImmediate()
  assert.deepEqual(f.publications, [snapshot(1), snapshot(3, 'running')])
  stop()
})
