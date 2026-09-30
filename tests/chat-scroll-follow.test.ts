import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldCommitChatRowHeight,
  shouldFollowLatestContent
} from '../src/renderer/src/lib/chatScrollFollow'

test('a reader away from the latest message does not follow streamed output', () => {
  assert.equal(
    shouldFollowLatestContent({
      stuckToBottom: false,
      replacedMessages: false,
      userSubmittedMessage: false
    }),
    false
  )
})

test('following the tail, switching conversations, or sending a message scrolls to the latest content', () => {
  assert.equal(
    shouldFollowLatestContent({
      stuckToBottom: true,
      replacedMessages: false,
      userSubmittedMessage: false
    }),
    true
  )
  assert.equal(
    shouldFollowLatestContent({
      stuckToBottom: false,
      replacedMessages: true,
      userSubmittedMessage: false
    }),
    true
  )
  assert.equal(
    shouldFollowLatestContent({
      stuckToBottom: false,
      replacedMessages: false,
      userSubmittedMessage: true
    }),
    true
  )
})

test('row heights are stored only for virtualized rows inside the window', () => {
  assert.equal(
    shouldCommitChatRowHeight({ virtualizationEnabled: false, rowInWindow: true }),
    false
  )
  assert.equal(
    shouldCommitChatRowHeight({ virtualizationEnabled: true, rowInWindow: false }),
    false
  )
  assert.equal(shouldCommitChatRowHeight({ virtualizationEnabled: true, rowInWindow: true }), true)
})
