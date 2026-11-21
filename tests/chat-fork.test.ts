import assert from 'node:assert/strict'
import test from 'node:test'
import { forkUserMessageIdByAssistant } from '../src/renderer/src/lib/chatFork'
import type { ChatItem } from '../src/renderer/src/types'

test('assistant fork actions use the user message that started their turn', () => {
  const messages: ChatItem[] = [
    { id: 'assistant-0', role: 'assistant', content: 'no user turn' },
    { id: 'user-1', role: 'user', content: 'first question' },
    { id: 'assistant-1', role: 'assistant', content: 'first answer' },
    { id: 'assistant-1-follow-up', role: 'assistant', content: 'more detail' },
    { id: 'user-2', role: 'user', content: 'second question' },
    { id: 'assistant-2', role: 'assistant', content: 'second answer' }
  ]

  const anchors = forkUserMessageIdByAssistant(messages)

  assert.equal(anchors.has('assistant-0'), false)
  assert.equal(anchors.get('assistant-1'), 'user-1')
  assert.equal(anchors.get('assistant-1-follow-up'), 'user-1')
  assert.equal(anchors.get('assistant-2'), 'user-2')
})
