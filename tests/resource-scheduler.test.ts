import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as nextTurn } from 'node:timers/promises'

import {
  createResourceAdmission,
  type ExecutionResource
} from '../src/main/agent/resource-admission'
import { createResourceScheduler } from '../src/main/agent/resource-scheduler'

function file(access: ExecutionResource['access'], ...segments: string[]): ExecutionResource {
  return { namespace: 'local-filesystem', segments, access }
}

const read = (...segments: string[]): ExecutionResource => file('shared', ...segments)
const write = (...segments: string[]): ExecutionResource => file('exclusive', ...segments)

test('a rejected multi-resource reservation leaves no partial ownership', () => {
  const admission = createResourceAdmission()
  const first = admission.reserve('first', [write('project', 'target')])
  assert.ok(first)
  assert.equal(
    admission.reserve('blocked', [write('elsewhere'), read('project', 'target', 'file')]),
    null
  )
  const independent = admission.reserve('independent', [write('elsewhere')])
  assert.ok(independent)
  independent()
  first()
})

test('a stale release cannot free a later reservation with the same owner', () => {
  const admission = createResourceAdmission()
  const previous = admission.reserve('worker', [write('old')])
  assert.ok(previous)
  assert.equal(admission.reserve('worker', []), null)
  previous()
  const current = admission.reserve('worker', [write('current')])
  assert.ok(current)
  previous()
  assert.equal(admission.reserve('observer', [read('current')]), null)
  current()
  assert.equal(admission.conflicts([read('current')]), false)
})

test('a granted reservation retains a snapshot of the original claim', () => {
  const admission = createResourceAdmission()
  const segments = ['original']
  const claim = { namespace: 'local-filesystem', segments, access: 'exclusive' as const }
  const release = admission.reserve('worker', [claim])
  assert.ok(release)
  segments[0] = 'changed'
  claim.namespace = 'changed'
  assert.equal(admission.conflicts([read('original', 'nested')]), true)
  assert.equal(admission.conflicts([read('changed')]), false)
  release()
})

test('same-resource reads and independent writes can overlap', async () => {
  const scheduler = createResourceScheduler()
  const finish = Promise.withResolvers<void>()
  const started: string[] = []
  const enqueue = (name: string, resource: ExecutionResource): Promise<string> =>
    scheduler.run([resource], undefined, async () => {
      started.push(name)
      await finish.promise
      return name
    })
  const operations = [
    enqueue('reader A', read('project', 'file')),
    enqueue('reader B', read('project', 'file')),
    enqueue('different target', write('project', 'file-other')),
    enqueue('different host', { ...write('project', 'file'), namespace: 'other-host' })
  ]
  try {
    await nextTurn()
    assert.deepEqual(started, ['reader A', 'reader B', 'different target', 'different host'])
  } finally {
    finish.resolve()
    await Promise.all(operations)
  }
})

test('later readers cannot starve a waiting writer, but independent work can pass', async () => {
  const scheduler = createResourceScheduler()
  const finishRead = Promise.withResolvers<void>()
  const finishWrite = Promise.withResolvers<void>()
  const started: string[] = []
  const active = scheduler.run([read('project', 'nested')], undefined, () => finishRead.promise)
  const writer = scheduler.run([write('project')], undefined, () => {
    started.push('writer')
    return finishWrite.promise
  })
  const laterReader = scheduler.run([read('project', 'unrelated-child')], undefined, () => {
    started.push('later reader')
  })
  const independent = scheduler.run([write('other-project')], undefined, () => {
    started.push('independent')
  })
  try {
    await nextTurn()
    assert.deepEqual(started, ['independent'])
    finishRead.resolve()
    await nextTurn()
    assert.deepEqual(started, ['independent', 'writer'])
  } finally {
    finishRead.resolve()
    finishWrite.resolve()
    await Promise.all([active, writer, laterReader, independent])
  }
  assert.deepEqual(started, ['independent', 'writer', 'later reader'])
})

test('a waiting operation keeps the original resource set after caller mutation', async () => {
  const scheduler = createResourceScheduler()
  const finish = Promise.withResolvers<void>()
  const active = scheduler.run([write('original')], undefined, () => finish.promise)
  const segments = ['original']
  const claims: ExecutionResource[] = [{ ...write(), segments }]
  const started: string[] = []
  const waiting = scheduler.run(claims, undefined, () => {
    started.push('waiting')
  })
  segments[0] = 'changed'
  claims.length = 0
  const independent = scheduler.run([write('changed')], undefined, () => {
    started.push('independent')
  })
  try {
    await nextTurn()
    assert.deepEqual(started, ['independent'])
  } finally {
    finish.resolve()
    await Promise.all([active, waiting, independent])
  }
  assert.deepEqual(started, ['independent', 'waiting'])
})

test('cancelling queued work immediately unblocks its compatible follower without invoking it', async () => {
  const scheduler = createResourceScheduler()
  const finish = Promise.withResolvers<void>()
  const stop = new AbortController()
  const active = scheduler.run([read('project')], undefined, () => finish.promise)
  let wrote = false
  const queued = scheduler.run([write('project')], stop.signal, () => {
    wrote = true
  })
  const reason = new Error('cancel queued write')
  const rejected = assert.rejects(queued, (error) => error === reason)
  let followerRan = false
  const follower = scheduler.run([read('project')], undefined, () => {
    followerRan = true
  })
  try {
    await nextTurn()
    assert.equal(followerRan, false)
    stop.abort(reason)
    await nextTurn()
    assert.equal(followerRan, true)
    await rejected
    assert.equal(wrote, false)
  } finally {
    stop.abort(reason)
    finish.resolve()
    await Promise.allSettled([active, queued, follower, rejected])
  }
})

test('running cancellation keeps its claim until execution settles', async () => {
  const scheduler = createResourceScheduler()
  const finish = Promise.withResolvers<void>()
  const running = Promise.withResolvers<void>()
  const stop = new AbortController()
  const resource = write('output')
  const active = scheduler.run([resource], stop.signal, async () => {
    running.resolve()
    await finish.promise
    stop.signal.throwIfAborted()
  })
  const reason = new Error('cancel running write')
  const rejected = assert.rejects(active, (error) => error === reason)
  let followerRan = false
  const follower = scheduler.run([resource], undefined, () => {
    followerRan = true
  })
  try {
    await running.promise
    stop.abort(reason)
    await nextTurn()
    assert.equal(followerRan, false)
    finish.resolve()
    await rejected
    await follower
    assert.equal(followerRan, true)
  } finally {
    stop.abort(reason)
    finish.resolve()
    await Promise.allSettled([active, follower, rejected])
  }
})

test('aborting after reservation but before invocation does not strand the resource', async () => {
  const scheduler = createResourceScheduler()
  const stop = new AbortController()
  let ran = false
  const first = scheduler.run([write('output')], stop.signal, () => {
    ran = true
  })
  const rejected = assert.rejects(first, { name: 'AbortError' })
  stop.abort()
  const next = scheduler.run([write('output')], undefined, () => 'released')
  await rejected
  assert.equal(ran, false)
  assert.equal(await next, 'released')
})

test('synchronous throws and rejected executions each release the claim for the next operation', async () => {
  const scheduler = createResourceScheduler()
  const claim = [write('output')]
  const sync = scheduler.run(claim, undefined, () => {
    throw new Error('sync failure')
  })
  const asyncFailure = scheduler.run(claim, undefined, () =>
    Promise.reject(new Error('async failure'))
  )
  const next = scheduler.run(claim, undefined, () => 'released')
  await Promise.all([
    assert.rejects(sync, { message: 'sync failure' }),
    assert.rejects(asyncFailure, { message: 'async failure' })
  ])
  assert.equal(await next, 'released')
})

test('queue notifications only report blocked operations and observer failures cannot strand them', async () => {
  const scheduler = createResourceScheduler()
  const finish = Promise.withResolvers<void>()
  const claims = [write('output')]
  let notifications = 0
  const active = scheduler.run(
    claims,
    undefined,
    () => finish.promise,
    () => {
      notifications++
    }
  )
  const blocked = scheduler.run(
    claims,
    undefined,
    () => 'released',
    () => {
      notifications++
      throw new Error('observer unavailable')
    }
  )
  try {
    assert.equal(notifications, 1)
  } finally {
    finish.resolve()
    await Promise.all([active, blocked])
  }
  assert.equal(await blocked, 'released')
})
