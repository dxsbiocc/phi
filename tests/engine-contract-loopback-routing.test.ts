import assert from 'node:assert/strict'
import test from 'node:test'

import { selectLoopbackReplyIndex, type ModelReply } from './engine-contract/loopback-model'

const messages = (text: string): Array<Record<string, unknown>> => [{ role: 'user', content: text }]

test('an untagged queue head preserves legacy FIFO even when a later tag matches', () => {
  const replies: ModelReply[] = [
    { tool: { name: 'write', args: { path: 'core-tools.txt' } } },
    { match: 'Plan this work', tool: { name: 'propose_plan_steps', args: {} } }
  ]

  assert.equal(selectLoopbackReplyIndex(replies, messages('Plan this work')), 0)
})

test('tagged concurrent parent and child replies route by transcript', () => {
  const replies: ModelReply[] = [
    { match: 'Current step: read-a', text: 'read A' },
    { match: 'Current step: read-b', text: 'read B' },
    { match: 'Plan this work', text: 'parent' }
  ]

  assert.equal(selectLoopbackReplyIndex(replies, messages('Plan this work')), 2)
  assert.equal(selectLoopbackReplyIndex(replies, messages('Current step: read-b')), 1)
})
