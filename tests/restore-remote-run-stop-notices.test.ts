import assert from 'node:assert/strict'
import test from 'node:test'
import { chatItemsFromSessionMessages } from '../src/renderer/src/lib/chatItems'
import { restoreRemoteRunStopNotices } from '../src/renderer/src/features/chat/lib/restoreRemoteRunStopNotices'

test('a persisted takeover notice joins a cached conversation without dropping live text', () => {
  const cached = [
    {
      id: 'old',
      role: 'assistant' as const,
      content: 'old reply',
      createdAt: '2026-10-23T08:00:00Z'
    },
    {
      id: 'live',
      role: 'assistant' as const,
      content: 'live reply',
      createdAt: '2026-10-23T08:14:00Z'
    }
  ]
  const persisted = chatItemsFromSessionMessages([
    {
      source: 'phi',
      type: 'assistant_message_finalized',
      eventId: 'old',
      content: 'old reply',
      createdAt: '2026-10-23T08:00:00Z'
    },
    {
      source: 'phi',
      type: 'remote_run_stopped',
      eventId: 'takeover',
      createdAt: '2026-10-23T08:13:52Z'
    }
  ])

  const restored = restoreRemoteRunStopNotices(cached, persisted)
  assert.deepEqual(
    restored.map((item) => item.id),
    ['old', 'takeover', 'live']
  )
  assert.equal(restored[1].role, 'warning')
  assert.equal(restoreRemoteRunStopNotices(restored, persisted), restored)
})
