import assert from 'node:assert/strict'
import test from 'node:test'
import {
  sessionDisplayTitle,
  titleFromMessages,
  truncateSessionTitle
} from '../src/renderer/src/lib/sessionTitles'
import { messageContentTitleText } from '../src/shared/sessionTitle'
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

test('session title ignores composer file reference metadata', () => {
  const content = '引用文件：`./data.json`\n分析这个数据'
  const messages: ChatItem[] = [
    { id: 'user-1', role: 'user', content },
    { id: 'assistant-1', role: 'assistant', content: '收到' }
  ]

  assert.equal(messageContentTitleText(content), '分析这个数据')
  assert.equal(titleFromMessages(messages), '分析这个数据')
  assert.equal(sessionDisplayTitle({ ...baseSession, firstMessage: content }), '分析这个数据')
  assert.equal(
    sessionDisplayTitle({
      ...baseSession,
      name: '引用文件：`./data.json`',
      firstMessage: '真正的问题'
    }),
    '真正的问题'
  )
  assert.equal(
    sessionDisplayTitle({ ...baseSession, name: '引用文件：`./data.json`', firstMessage: '' }),
    '新对话'
  )
})

test('session title ignores multiline composer file reference metadata', () => {
  const content = '引用文件：\n- `./data.json`\n- `./metadata.csv`\n画一张汇总图'

  assert.equal(messageContentTitleText(content), '画一张汇总图')
  assert.equal(
    titleFromMessages([
      { id: 'user-1', role: 'user', content },
      { id: 'assistant-1', role: 'assistant', content: '收到' }
    ]),
    '画一张汇总图'
  )
})

test('session title truncates long text with three dots', () => {
  assert.equal(truncateSessionTitle('abcdefghijklmnopqrstuvwxyz', 10), 'abcdefg...')
})
