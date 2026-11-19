import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { ChatQueueJobsVersion } from '../src/shared/chatQueueTypes'
import {
  createDurableChat,
  type BoundChatQueueTarget
} from '../src/main/session-runtime/durable-chat'

test('durable chat captures destinations immediately and acknowledges concurrent sends in order', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-durable-chat-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const scope = { conversationId: randomUUID(), projectId: null }
  const sessionDir = join(directory, 'sessions', scope.conversationId)
  await mkdir(sessionDir, { recursive: true })
  await writeFile(join(sessionDir, 'manifest.json'), '{}', { mode: 0o600 })
  const destination: BoundChatQueueTarget = {
    scope,
    sessionKey: scope.conversationId,
    path: `phi-session:${scope.conversationId}`,
    snapshot: { path: undefined, cwd: directory, permissionMode: 'auto' },
    binding: 'a'.repeat(64),
    sessionGeneration: 0,
    workMode: 'auto'
  }
  const firstTarget = Promise.withResolvers<BoundChatQueueTarget>()
  const notifications: ChatQueueJobsVersion[] = []
  const captured: string[] = []
  const confirmed: string[] = []
  const chat = createDurableChat({
    directory: join(directory, 'assistant-inbox'),
    bind: (_, title) => {
      captured.push(title)
      return title === 'first' ? firstTarget.promise : destination
    },
    sessionDirectory: (sessionId) => {
      confirmed.push(sessionId)
      return sessionDir
    },
    scope: () => scope,
    prepare: async () => 'wait',
    capacity: () => 1,
    execute: async () => 'succeeded',
    recoverOutcome: () => 'interrupted',
    changed: () => undefined,
    jobsChanged: (version) => notifications.push(version),
    log: () => undefined
  })
  await chat.start()
  try {
    const empty = await chat.listJobs()
    assert.deepEqual(empty.items, [])
    const target = { path: destination.path, cwd: directory }
    const firstRequestId = randomUUID()
    const first = chat.submit('first', target, firstRequestId)
    const second = chat.submit('second', target, randomUUID())
    assert.deepEqual(captured, ['first', 'second'])
    await new Promise<void>((resolve) => setImmediate(resolve))
    assert.deepEqual(confirmed, [])
    firstTarget.resolve(destination)
    const accepted = await Promise.all([first, second])
    const queued = await chat.list(scope.conversationId)
    assert.deepEqual(
      queued.map((item) => [item.id, item.text]),
      [
        [accepted[0].id, 'first'],
        [accepted[1].id, 'second']
      ]
    )
    const snapshot = await chat.listJobs()
    assert.equal(snapshot.epoch, empty.epoch)
    assert.deepEqual(
      snapshot.items.map(({ id, sessionId, status }) => ({ id, sessionId, status })),
      [
        { id: accepted[0].id, sessionId: scope.conversationId, status: 'queued' },
        { id: accepted[1].id, sessionId: scope.conversationId, status: 'queued' }
      ]
    )
    assert.ok(notifications[0].revision > empty.revision)
    assert.ok(notifications[1].revision > notifications[0].revision)
    assert.equal(notifications[1].revision, snapshot.revision)
    assert.deepEqual(await chat.submit('first', target, firstRequestId), accepted[0])
    assert.equal(notifications.length, 2)
    assert.ok(await chat.cancel(scope.conversationId, accepted[0].id))
    const afterCancel = await chat.listJobs()
    assert.ok(afterCancel.revision > snapshot.revision)
    assert.deepEqual(
      afterCancel.items.map((item) => item.id),
      [accepted[1].id]
    )
    await chat.removeConversation(scope.conversationId)
    const afterRemoval = await chat.listJobs()
    assert.ok(afterRemoval.revision > afterCancel.revision)
    assert.deepEqual(afterRemoval.items, [])
  } finally {
    firstTarget.resolve(destination)
    await chat.shutdown()
  }
})

test('a cancelled predecessor never releases its supplemental prompt to the executor', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'phi-durable-supplement-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const scope = { conversationId: randomUUID(), projectId: null }
  await writeFile(join(directory, 'manifest.json'), '{}', { mode: 0o600 })
  const destination: BoundChatQueueTarget = {
    scope,
    sessionKey: scope.conversationId,
    path: `phi-session:${scope.conversationId}`,
    snapshot: { path: undefined, cwd: directory, permissionMode: 'auto' },
    binding: 'a'.repeat(64),
    sessionGeneration: 0,
    workMode: 'auto'
  }
  const execution: string[] = []
  const invalid = Promise.withResolvers<void>()
  let supplementId: string | undefined
  let capacity = 0
  const chat = createDurableChat({
    directory: join(directory, 'inbox'),
    bind: () => destination,
    supplementTarget: () => destination,
    sessionDirectory: () => directory,
    scope: () => scope,
    prepare: async () => 'ready',
    capacity: () => capacity,
    async execute(entry) {
      execution.push(entry.id)
      return 'failed'
    },
    recoverOutcome: () => 'interrupted',
    changed() {
      if (!supplementId) return
      void chat.list(scope.conversationId).then((items) => {
        if (items.some((item) => item.id === supplementId && item.status === 'failed')) {
          invalid.resolve()
        }
      }, invalid.reject)
    },
    log: invalid.reject
  })
  await chat.start()
  try {
    const target = { path: destination.path, cwd: directory }
    const { id: parentId } = await chat.submit('original', target, randomUUID())
    const [parent] = await chat.taskEntries()
    const supplement = await chat.supplement(
      parent,
      'more details',
      undefined,
      randomUUID(),
      () => undefined
    )
    assert.ok(supplement)
    supplementId = supplement.id
    assert.equal(await chat.cancel(scope.conversationId, parentId), true)
    capacity = 1
    chat.activate()
    await invalid.promise
    assert.deepEqual(execution, [])
  } finally {
    await chat.shutdown()
  }
})
