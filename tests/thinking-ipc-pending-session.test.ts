import assert from 'node:assert/strict'
import test from 'node:test'

import { readCurrentThinkingLevel } from '../src/main/agent/session/current-session-reads'
import { SessionLifecycle } from '../src/main/agent/session/session-lifecycle'
import type { CreateAgentSessionResult } from '../src/main/agent/runtime/runtime-adapter'

type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const read = (lifecycle: SessionLifecycle<CreateAgentSessionResult>): Promise<ThinkingLevel> =>
  readCurrentThinkingLevel(
    () => lifecycle,
    () => 'low' as ThinkingLevel
  )

const snapshot = { path: '/sessions/remote.jsonl', cwd: '/remote/project', permissionMode: 'auto' }

test('reading the thinking level does not wait for a session that is still being created', async () => {
  const lifecycle = new SessionLifecycle<CreateAgentSessionResult>()
  // A remote session stays pending for the SSH connection and any kernel upload.
  lifecycle.getOrCreate(snapshot, () => new Promise<CreateAgentSessionResult>(() => undefined))

  const outcome = await Promise.race([
    read(lifecycle),
    new Promise((resolve) => setImmediate(() => setImmediate(() => resolve('still waiting'))))
  ])

  assert.equal(outcome, 'low')
})

test('a session with no record reads the stored level', async () => {
  assert.equal(await read(new SessionLifecycle<CreateAgentSessionResult>()), 'low')
})

test('a ready session still reports its own thinking level', async () => {
  const lifecycle = new SessionLifecycle<CreateAgentSessionResult>()
  const record = lifecycle.getOrCreate(snapshot, async () => {
    return { session: { thinkingLevel: 'xhigh' } } as unknown as CreateAgentSessionResult
  })
  await record.promise

  assert.equal(await read(lifecycle), 'xhigh')
})
