import assert from 'node:assert/strict'
import test, { afterEach } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ChatBubble } from '../src/renderer/src/components/chat/ChatBubble'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { chatItemFromPhiTimelineEvent } from '../src/renderer/src/lib/chatItems'
import type { ChatMessage } from '../src/renderer/src/types'

afterEach(() => setUiLanguage('en'))

function render(message: ChatMessage): string {
  return renderToStaticMarkup(
    createElement(ChatBubble, {
      message,
      onGoSettings: () => undefined,
      onOpenBackgroundJobs: () => undefined
    })
  )
}

test('warning notices render as a collapsed row with a localized title', () => {
  const item = chatItemFromPhiTimelineEvent({
    type: 'mcp_servers_skipped',
    eventId: 'm1',
    skippedMcpServers: [{ name: 'github', reason: 'connect_failed' }]
  })
  assert.ok(item && 'content' in item)
  setUiLanguage('en')
  const en = render(item as ChatMessage)
  assert.match(en, /role="button"/)
  assert.match(en, /aria-expanded="false"/)
  assert.match(en, /data-notice-level="warning"/)
  assert.match(en, /Some connectors are unavailable/)
  assert.doesNotMatch(en, /Connectors not enabled for this conversation/)
  setUiLanguage('zh-CN')
  assert.match(render(item as ChatMessage), /部分连接器未启用/)
})

test('error notices keep the failure in the one-line title and hide the detail', () => {
  const item = chatItemFromPhiTimelineEvent({
    type: 'run_failed',
    eventId: 'f1',
    runId: 'r1',
    errorMessage: 'MCP discovery failed'
  })
  assert.ok(item && 'content' in item)
  setUiLanguage('en')
  const html = render(item as ChatMessage)
  assert.match(html, /data-notice-level="error"/)
  assert.match(html, /Request failed/)
  assert.match(html, /MCP discovery failed/)
  assert.doesNotMatch(html, /Original error/)
})

test('model migration is an info-level notice', () => {
  const item = chatItemFromPhiTimelineEvent({ type: 'model_selection_migrated', eventId: 'x' })
  assert.ok(item && 'content' in item)
  assert.match(render(item as ChatMessage), /data-notice-level="info"/)
})
