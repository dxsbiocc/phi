import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OfficeDocumentOperationQueue } from '../src/main/agent/office/office-operation-queue'

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('an aborted owner leaves the queue immediately before its operation starts', async () => {
  const queue = new OfficeDocumentOperationQueue()
  const blocker = deferred()
  const started = deferred()
  let queuedStarts = 0
  const first = queue.run(async () => {
    started.resolve()
    await blocker.promise
  })
  await started.promise

  const controller = new AbortController()
  const queued = queue.run(
    async () => {
      queuedStarts += 1
    },
    { owner: 'run-a', signal: controller.signal }
  )
  controller.abort()

  try {
    await assert.rejects(
      Promise.race([
        queued,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('queued cancellation did not settle')), 50)
        )
      ]),
      { code: 'operation_cancelled' }
    )
    assert.equal(queuedStarts, 0)
  } finally {
    blocker.resolve()
    await Promise.allSettled([first, queued])
  }
})

test('cancelling one queued owner does not stop the next owner', async () => {
  const queue = new OfficeDocumentOperationQueue()
  const blocker = deferred()
  const started = deferred()
  const order: string[] = []
  const first = queue.run(async () => {
    order.push('blocker')
    started.resolve()
    await blocker.promise
  })
  await started.promise

  const cancelled = new AbortController()
  const ownerA = queue.run(
    async () => {
      order.push('run-a')
    },
    { owner: 'run-a', signal: cancelled.signal }
  )
  const ownerB = queue.run(
    async () => {
      order.push('run-b')
      return 'done'
    },
    { owner: 'run-b', signal: new AbortController().signal }
  )
  cancelled.abort()

  await assert.rejects(ownerA, { code: 'operation_cancelled' })
  blocker.resolve()
  assert.equal(await ownerB, 'done')
  await first
  assert.deepEqual(order, ['blocker', 'run-b'])
  assert.equal(queue.idle, true)
})

test('whole-queue cancellation still aborts the active operation and rejects later work', async () => {
  const queue = new OfficeDocumentOperationQueue()
  const started = deferred()
  const active = queue.run(
    (signal) =>
      new Promise<void>((_resolve, reject) => {
        started.resolve()
        signal.addEventListener('abort', () => reject(new Error('active aborted')), { once: true })
      })
  )
  await started.promise

  queue.cancel()

  await assert.rejects(active, /active aborted/u)
  await assert.rejects(
    queue.run(async () => undefined),
    { code: 'workbook_busy' }
  )
  await queue.drain()
  assert.equal(queue.idle, true)
})
