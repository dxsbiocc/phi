import assert from 'node:assert/strict'
import test from 'node:test'

import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import {
  createAgentEventReducerState,
  reduceAgentEventState
} from '../src/renderer/src/lib/agentEventReducer'
import { chatItemFromPhiTimelineEvent } from '../src/renderer/src/lib/chatItems'

test('work mode selection is restored from history and appended by the live reducer', () => {
  setUiLanguage('zh-CN')
  const event = {
    type: 'work_mode_selected',
    eventId: 'mode-1',
    execute: true,
    reason: '任务可拆成多个独立步骤',
    createdAt: '2026-10-24T00:00:00.000Z'
  }

  const restored = chatItemFromPhiTimelineEvent(event)
  assert.equal(restored?.role, 'warning')
  assert.ok(restored?.role === 'warning')
  assert.equal(restored.content, '智能体选择了：规划并执行 — 任务可拆成多个独立步骤')

  const live = reduceAgentEventState(createAgentEventReducerState(), event)
  assert.equal(live.messages.length, 1)
  assert.equal(live.messages[0]?.role, 'warning')
  assert.ok(live.messages[0]?.role === 'warning')
  assert.equal(live.messages[0].content, restored.content)
})
