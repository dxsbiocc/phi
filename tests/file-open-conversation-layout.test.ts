import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { CompanionChatToggle } from '../src/renderer/src/features/chat/components/CompanionChatToggle'
import { sidebarStateForFileOpenConversationLayout } from '../src/renderer/src/features/chat/lib/fileOpenConversationLayout'

test('file-open conversation layout maps to a deterministic sidebar destination', () => {
  assert.deepEqual(sidebarStateForFileOpenConversationLayout('sidebar'), {
    isSidebarOpen: true,
    workspaceSidebarMode: 'conversations'
  })
  assert.deepEqual(sidebarStateForFileOpenConversationLayout('tab'), {
    isSidebarOpen: true,
    workspaceSidebarMode: 'files'
  })
})

test('companion chat actions expose both layout directions without relying on drag', () => {
  const sidebarMarkup = renderToStaticMarkup(
    createElement(CompanionChatToggle, { destination: 'sidebar', onToggle: () => undefined })
  )
  const tabMarkup = renderToStaticMarkup(
    createElement(CompanionChatToggle, { destination: 'tab', onToggle: () => undefined })
  )

  assert.match(sidebarMarkup, /data-phi-companion-chat-destination="sidebar"/)
  assert.match(sidebarMarkup, /aria-label="移到左侧边栏"/)
  assert.match(tabMarkup, /data-phi-companion-chat-destination="tab"/)
  assert.match(tabMarkup, /aria-label="放回标签区"/)
})
