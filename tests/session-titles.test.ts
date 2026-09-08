import assert from 'node:assert/strict'
import test from 'node:test'
import {
  sessionDisplayTitle,
  titleFromMessages,
  truncateSessionTitle
} from '../src/renderer/src/lib/sessionTitles'
import type { ChatItem, SessionSummary } from '../src/renderer/src/types'

const baseSession: SessionSummary = {
  path: 'session-a',
  id: 'session-a',
  created: '2026-09-06T00:00:00.000Z',
  modified: '2026-09-06T00:00:00.000Z',
  messageCount: 1,
  firstMessage: '你是谁',
  status: 'idle',
  unreadKind: null
}

test('session title prefers explicit session name over first message', () => {
  assert.equal(sessionDisplayTitle({ ...baseSession, name: '手动标题' }), '手动标题')
})

test('session title falls back to the first user message', () => {
  const messages: ChatItem[] = [
    { id: 'user-1', role: 'user', content: '你是谁' },
    { id: 'assistant-1', role: 'assistant', content: '我是 Phi' }
  ]

  assert.equal(titleFromMessages(messages), '你是谁')
})

test('session title truncates long text with three dots', () => {
  assert.equal(truncateSessionTitle('abcdefghijklmnopqrstuvwxyz', 10), 'abcdefg...')
})
