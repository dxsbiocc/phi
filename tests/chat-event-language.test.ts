import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import {
  chatItemFromPhiTimelineEvent,
  chatItemsFromSessionMessages
} from '../src/renderer/src/lib/chatItems'
import {
  createAgentEventReducerState,
  reduceAgentEventState
} from '../src/renderer/src/lib/agentEventReducer'
import {
  formatInputFileReferences,
  formatInputFileReferenceTarget,
  formatPromptAgentReference,
  parseInputFileReferences,
  parseInputInvocationReferences
} from '../src/renderer/src/lib/inputReferences'
import { messageContentTitleText } from '../src/shared/sessionTitle'
import type { FileTreeEntry } from '../src/renderer/src/types'

afterEach(() => setUiLanguage('en'))

function notice(
  event: Parameters<typeof chatItemFromPhiTimelineEvent>[0]
): NonNullable<ReturnType<typeof chatItemFromPhiTimelineEvent>> & { content: string } {
  const item = chatItemFromPhiTimelineEvent(event)
  assert.ok(item && 'content' in item)
  return item
}

test('generated timeline notices update en→zh→en on the same restored items', () => {
  const events = [
    { source: 'phi', type: 'run_interrupted', eventId: 'interrupted', reason: 'app_restarted' },
    { source: 'phi', type: 'run_failed', eventId: 'failed' },
    { source: 'phi', type: 'context_compacted', eventId: 'compacted' },
    {
      source: 'phi',
      type: 'context_maintenance_notice',
      eventId: 'images',
      noticeLevel: 'warning',
      noticeText: 'dropped 2 attached images'
    },
    { source: 'phi', type: 'context_compaction_failed', eventId: 'compact-failed' },
    { source: 'phi', type: 'model_fallback', eventId: 'fallback' }
  ]
  const original = JSON.stringify(events)
  setUiLanguage('en')
  const restored = chatItemsFromSessionMessages(events)
  const items = restored.map((item) => {
    assert.ok('content' in item)
    return item
  })
  const english = items.map((item) => item.content)
  assert.match(english[0], /app restarted/)
  assert.match(english[1], /run failed/)
  assert.match(english[3], /2 historical images/)
  assert.match(english[5], /Previous model request failed. Trying Available model/)
  setUiLanguage('zh-CN')
  assert.match(items[0].content, /应用重启/)
  assert.match(items[1].content, /运行失败/)
  assert.match(items[3].content, /2 张历史图片/)
  assert.match(items[5].content, /旧模型 请求失败/)
  setUiLanguage('en')
  assert.deepEqual(
    items.map((item) => item.content),
    english
  )
  assert.equal(JSON.stringify(events), original)
  assert.deepEqual(
    items.map((item) => item.id),
    events.map((event) => event.eventId)
  )
})

test('raw service errors, maintenance details and historical user content remain original', () => {
  const failed = notice({ type: 'run_failed', errorMessage: '服务返回的原始诊断' })
  const maintenance = notice({
    type: 'context_maintenance_notice',
    noticeLevel: 'error',
    noticeText: '原始 SDK 说明'
  })
  const items = chatItemsFromSessionMessages([
    { source: 'phi', type: 'user_message', eventId: 'u', content: '运行失败。' },
    { source: 'phi', type: 'assistant_message_finalized', eventId: 'a', content: '上下文已压缩' }
  ])
  for (const language of ['en', 'zh-CN', 'en'] as const) {
    setUiLanguage(language)
    assert.equal(failed.content, '服务返回的原始诊断')
    assert.ok(maintenance.content.endsWith('原始 SDK 说明'))
    assert.ok('content' in items[0] && items[0].content === '运行失败。')
    assert.ok('content' in items[1] && items[1].content === '上下文已压缩')
  }
})

test('live reducer warnings and fallback errors follow the interface without changing run identity', () => {
  setUiLanguage('en')
  let state = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'project_parallel_warning',
    activeCount: 3
  })
  state = reduceAgentEventState(state, { type: 'auto_compaction_end', aborted: true })
  state = reduceAgentEventState(state, {
    type: 'message_end',
    runId: 'run-original',
    message: { role: 'assistant', stopReason: 'error' }
  })
  const items = state.messages.map((item) => {
    assert.ok('content' in item)
    return item
  })
  const english = items.map((item) => item.content)
  assert.match(english[0], /3 other conversations/)
  assert.match(english[1], /Context compaction failed: Cancelled/)
  assert.equal(english[2], 'Request failed')
  setUiLanguage('zh-CN')
  assert.match(items[0].content, /还有 3 个会话/)
  assert.match(items[1].content, /上下文压缩失败：已取消/)
  assert.equal(items[2].content, '请求失败')
  setUiLanguage('en')
  assert.deepEqual(
    items.map((item) => item.content),
    english
  )
  assert.equal(items[2].runId, 'run-original')
})

test('new file references are localized while both persisted syntaxes parse without rewriting the draft', () => {
  const english = 'Referenced files:`/work/实验.csv`\nKeep my exact draft  '
  const chinese = '引用文件：`/work/实验.csv`\n保留我的草稿  '
  const entry = {
    path: '/work/实验.csv',
    displayPath: '/work/实验.csv',
    kind: 'file'
  } as FileTreeEntry
  for (const language of ['en', 'zh-CN', 'en'] as const) {
    setUiLanguage(language)
    const prefix = language === 'en' ? 'Referenced files:' : '引用文件：'
    assert.equal(formatInputFileReferences(['/work/实验.csv']), `${prefix}\`/work/实验.csv\``)
    assert.equal(formatInputFileReferenceTarget(entry), `${prefix}\`/work/实验.csv\``)
    assert.deepEqual(parseInputFileReferences(english), {
      references: ['/work/实验.csv'],
      body: 'Keep my exact draft  '
    })
    assert.deepEqual(parseInputFileReferences(chinese), {
      references: ['/work/实验.csv'],
      body: '保留我的草稿  '
    })
    assert.equal(messageContentTitleText(english), 'Keep my exact draft')
    assert.equal(messageContentTitleText(chinese), '保留我的草稿')
  }
  assert.equal(english, 'Referenced files:`/work/实验.csv`\nKeep my exact draft  ')
})

test('generated agent references follow locale but existing slash and Chinese tokens remain exact', () => {
  const agent = { name: 'Reviewer', source: 'phi-agent' as const, trigger: '调用智能体：Reviewer' }
  for (const language of ['en', 'zh-CN', 'en'] as const) {
    setUiLanguage(language)
    assert.equal(
      formatPromptAgentReference(agent),
      language === 'en' ? '/agent:Reviewer' : '调用智能体：Reviewer'
    )
    for (const token of ['/agent:Reviewer', '调用智能体：Reviewer', '/prompts:Reviewer']) {
      const parsed = parseInputInvocationReferences(`${token}\nKeep this draft  `, [], [agent])
      assert.equal(parsed.references[0].text, token)
      assert.equal(parsed.body, 'Keep this draft  ')
    }
  }
  assert.equal(agent.trigger, '调用智能体：Reviewer')
})
