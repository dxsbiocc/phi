import assert from 'node:assert/strict'
import test from 'node:test'
import { messagesForUserRetry, messagesForUserRetryTarget } from '../src/renderer/src/lib/chatRetry'
import type { ChatItem } from '../src/renderer/src/types'

test('messagesForUserRetry clears failed output after the retried user message', () => {
  const messages: ChatItem[] = [
    { id: 'user-1', role: 'user', content: 'first' },
    { id: 'assistant-1', role: 'assistant', content: 'done' },
    { id: 'user-2', role: 'user', content: 'retry me' },
    {
      id: 'run-started',
      role: 'run',
      event: 'started',
      runId: 'run-2',
      createdAt: '2026-09-18T00:00:00.000Z'
    },
    {
      id: 'run-failed',
      role: 'run',
      event: 'failed',
      runId: 'run-2',
      createdAt: '2026-09-18T00:00:01.000Z'
    },
    { id: 'error-2', role: 'error', content: '余额不足', runId: 'run-2' }
  ]

  assert.deepEqual(
    messagesForUserRetry(messages, 'user-2').map((message) => message.id),
    ['user-1', 'assistant-1', 'user-2']
  )
})

test('messagesForUserRetry leaves messages unchanged when the user message is missing', () => {
  const messages: ChatItem[] = [{ id: 'user-1', role: 'user', content: 'first' }]

  assert.equal(messagesForUserRetry(messages, 'missing'), messages)
})

test('messagesForUserRetryTarget can retry restored messages by content', () => {
  const messages: ChatItem[] = [
    { id: 'user-1', role: 'user', content: 'same' },
    { id: 'assistant-1', role: 'assistant', content: 'old' },
    { id: 'user-2', role: 'user', content: 'same' },
    { id: 'error-2', role: 'error', content: 'failed' }
  ]

  assert.deepEqual(
    messagesForUserRetryTarget(messages, { content: 'same' }).map((message) => message.id),
    ['user-1', 'assistant-1', 'user-2']
  )
})
