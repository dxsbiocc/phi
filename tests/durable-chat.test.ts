import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

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
    log: () => undefined
  })
  await chat.start()
  try {
    const target = { path: destination.path, cwd: directory }
    const first = chat.submit('first', target, randomUUID())
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
  } finally {
    firstTarget.resolve(destination)
    await chat.shutdown()
  }
})
