import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as pause } from 'node:timers/promises'
import test, { type TestContext } from 'node:test'

import { createAssistantInbox } from '../src/main/session-runtime/assistant-inbox'
import { createAssistantInboxDispatch } from '../src/main/session-runtime/assistant-inbox-dispatch'

const origin = { conversationId: 'origin', projectId: null }
const peer = { conversationId: 'peer', projectId: 'project' }

async function fixture(t: TestContext): Promise<ReturnType<typeof createAssistantInbox>> {
  const directory = await mkdtemp(join(tmpdir(), 'phi-dispatch-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return createAssistantInbox(directory)
}

async function until(check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000
  while (!(await check())) {
    assert.ok(Date.now() < deadline, 'expected dispatcher state was never reached')
    await pause(5)
  }
}

test('wait never claims the head or delays another chat, and a later wake retains FIFO', async (t) => {
  const inbox = await fixture(t)
  await inbox.submit(origin, 'a', 'first')
  await inbox.submit(origin, 'b', 'second')
  await inbox.submit(peer, 'c', 'parallel')
  const executed: string[] = []
  const errors: unknown[] = []
  let waiting = true
  const dispatcher = createAssistantInboxDispatch({
    inbox,
    prepare: async (entry) =>
      waiting && entry.scope === origin
        ? 'wait'
        : waiting && entry.scope.conversationId === origin.conversationId
          ? 'wait'
          : 'ready',
    capacity: () => 2,
    execute: async (entry) => {
      executed.push(entry.requestId)
      return 'succeeded'
    },
    changed: () => undefined,
    log: (error) => errors.push(error)
  })
  try {
    dispatcher.wake()
    await until(async () => (await inbox.list(peer))[0]?.status === 'succeeded')
    assert.deepEqual(executed, ['c'])
    assert.deepEqual(
      (await inbox.list(origin)).map((entry) => entry.status),
      ['queued', 'queued']
    )
    waiting = false
    dispatcher.wake()
    await until(async () =>
      (await inbox.list(origin)).every((entry) => entry.status === 'succeeded')
    )
    assert.deepEqual(executed, ['c', 'a', 'b'])
    assert.deepEqual(errors, [])
  } finally {
    dispatcher.stop()
    await dispatcher.drained()
  }
})

test('cancelling while preflight is pending does not transfer the attempt to the next item', async (t) => {
  const inbox = await fixture(t)
  const first = await inbox.submit(origin, 'a', 'cancel')
  await inbox.submit(origin, 'b', 'next requires its own preflight')
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  const executed: string[] = []
  const preflight: string[] = []
  const dispatcher = createAssistantInboxDispatch({
    inbox,
    prepare: async (entry) => {
      preflight.push(entry.requestId)
      if (entry.requestId === 'a') {
        entered.resolve()
        await gate.promise
      }
      return 'ready'
    },
    capacity: () => 1,
    execute: async (entry) => {
      executed.push(entry.requestId)
      return 'succeeded'
    },
    changed: () => undefined,
    log: () => undefined
  })
  try {
    dispatcher.wake()
    await entered.promise
    assert.equal(await inbox.cancel(origin, first.id), true)
    dispatcher.wake()
    gate.resolve()
    await until(async () => (await inbox.list(origin))[1]?.status === 'succeeded')
    assert.deepEqual(preflight, ['a', 'b'])
    assert.deepEqual(executed, ['b'])
  } finally {
    gate.resolve()
    dispatcher.stop()
    await dispatcher.drained()
  }
})

test('a claim and shutdown race returns the untouched task to queued', async (t) => {
  const inbox = await fixture(t)
  await inbox.submit(origin, 'a', 'recover after graceful shutdown')
  const gate = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let executions = 0
  const dispatcher = createAssistantInboxDispatch({
    inbox: {
      queued: () => inbox.queued(),
      claim: async (...args) => {
        const result = await inbox.claim(...args)
        entered.resolve()
        await gate.promise
        return result
      },
      settle: (...args) => inbox.settle(...args)
    },
    prepare: async () => 'ready',
    capacity: () => 1,
    execute: async () => {
      executions += 1
      return 'succeeded'
    },
    changed: () => undefined,
    log: () => undefined
  })
  try {
    dispatcher.wake()
    await entered.promise
    dispatcher.stop()
    gate.resolve()
    await dispatcher.drained()
    assert.equal(executions, 0)
    assert.equal((await inbox.list(origin))[0]?.status, 'queued')
    assert.equal(await inbox.recover(), 0)
  } finally {
    gate.resolve()
    dispatcher.stop()
    await dispatcher.drained()
  }
})
