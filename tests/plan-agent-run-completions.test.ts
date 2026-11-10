import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAgentRunCompletions,
  type AgentRunCompletion
} from '../src/main/agent/plan/execution/agent-run-completions'

function completed(id: string, report = id): AgentRunCompletion {
  return { id, state: 'done', origin: 'host', report }
}

test('deliver resolves an existing waiter and reports that it was consumed', async () => {
  const completions = createAgentRunCompletions()
  const pending = completions.expect('runtime-1', 'run-1')
  assert.equal(completions.deliver('runtime-1', completed('run-1')), true)
  assert.deepEqual(await pending, completed('run-1'))
})

test('a fast completion is cached until expect arrives', async () => {
  const completions = createAgentRunCompletions()
  assert.equal(completions.deliver('runtime-1', completed('run-1')), false)
  assert.deepEqual(await completions.expect('runtime-1', 'run-1'), completed('run-1'))
})

test('the early-completion cache is bounded and expires stale entries', async () => {
  let now = 100
  const completions = createAgentRunCompletions({ maxCached: 2, cacheTtlMs: 10, now: () => now })
  completions.deliver('runtime-1', completed('run-1'))
  completions.deliver('runtime-1', completed('run-2'))
  completions.deliver('runtime-1', completed('run-3'))

  const retained = completions.expect('runtime-1', 'run-2')
  assert.deepEqual(await retained, completed('run-2'))

  now = 111
  completions.deliver('runtime-1', completed('run-4'))
  const expired = completions.expect('runtime-1', 'run-3')
  const abandoned = completions.expect('runtime-1', 'run-1')
  completions.abandonSession('runtime-1', 'session closed')
  assert.equal((await expired).state, 'cancelled')
  assert.equal((await abandoned).state, 'cancelled')
})

test('abandonSession cancels only matching waiters without rejecting', async () => {
  const completions = createAgentRunCompletions()
  const first = completions.expect('runtime-1', 'run-1')
  const second = completions.expect('runtime-2', 'run-2')
  completions.abandonSession('runtime-1', 'disposed')
  assert.deepEqual(await first, {
    id: 'run-1',
    state: 'cancelled',
    origin: 'host',
    error: 'disposed'
  })
  completions.deliver('runtime-2', completed('run-2'))
  assert.equal((await second).state, 'done')
})
