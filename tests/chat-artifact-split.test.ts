import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import {
  ChatArtifactSplit,
  ChatArtifactSplitSurface
} from '../src/renderer/src/features/chat/components/ChatArtifactSplit'
import {
  CHAT_ARTIFACT_SPLIT_DEFAULT_RATIO,
  CHAT_ARTIFACT_SPLIT_KEYBOARD_STEP,
  CHAT_ARTIFACT_SPLIT_LEFT_MIN_PX,
  CHAT_ARTIFACT_SPLIT_RIGHT_MIN_PX,
  CHAT_ARTIFACT_SPLIT_SEPARATOR_PX,
  CHAT_ARTIFACT_SPLIT_STORAGE_KEY,
  clampChatArtifactSplitRatio,
  chatArtifactSplitWidths,
  keyboardAdjustedChatArtifactSplitRatio,
  readChatArtifactSplitRatio,
  sidebarHostsCurrentConversation,
  shouldEnableOfficeChatSplit,
  writeChatArtifactSplitRatio
} from '../src/renderer/src/features/chat/lib/chatArtifactSplit'

test('chat artifact split clamps both panes to their minimum widths', () => {
  const containerWidth = 1_000
  const availableWidth = containerWidth - CHAT_ARTIFACT_SPLIT_SEPARATOR_PX

  assert.equal(
    clampChatArtifactSplitRatio(0.1, containerWidth),
    CHAT_ARTIFACT_SPLIT_LEFT_MIN_PX / availableWidth
  )
  assert.equal(
    clampChatArtifactSplitRatio(0.95, containerWidth),
    1 - CHAT_ARTIFACT_SPLIT_RIGHT_MIN_PX / availableWidth
  )
  assert.equal(clampChatArtifactSplitRatio(0.6, containerWidth), 0.6)
})

test('chat artifact split shrinks proportionally without horizontal overflow', () => {
  const containerWidth = 600
  const widths = chatArtifactSplitWidths(0.8, containerWidth)

  assert.equal(widths.left + CHAT_ARTIFACT_SPLIT_SEPARATOR_PX + widths.right, containerWidth)
  assert.ok(widths.left > 0)
  assert.ok(widths.right > 0)
  assert.ok(
    Math.abs(
      widths.left / widths.right -
        CHAT_ARTIFACT_SPLIT_LEFT_MIN_PX / CHAT_ARTIFACT_SPLIT_RIGHT_MIN_PX
    ) < 1e-10
  )
})

test('chat artifact split persists a valid UI ratio', () => {
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string): string | null => values.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      values.set(key, value)
    }
  }

  assert.equal(readChatArtifactSplitRatio(storage), CHAT_ARTIFACT_SPLIT_DEFAULT_RATIO)
  assert.equal(writeChatArtifactSplitRatio(storage, 0.61), true)
  assert.equal(values.get(CHAT_ARTIFACT_SPLIT_STORAGE_KEY), '0.61')
  assert.equal(readChatArtifactSplitRatio(storage), 0.61)
})

test('chat artifact split falls back when storage is dirty or unavailable', () => {
  for (const dirtyValue of ['not-a-number', '1.2', '-0.2', '']) {
    assert.equal(
      readChatArtifactSplitRatio({ getItem: () => dirtyValue }),
      CHAT_ARTIFACT_SPLIT_DEFAULT_RATIO
    )
  }
  assert.equal(
    readChatArtifactSplitRatio({
      getItem: () => {
        throw new Error('storage unavailable')
      }
    }),
    CHAT_ARTIFACT_SPLIT_DEFAULT_RATIO
  )
  assert.equal(
    writeChatArtifactSplitRatio(
      {
        setItem: () => {
          throw new Error('storage unavailable')
        }
      },
      0.6
    ),
    false
  )
})

test('chat artifact split keyboard arrows step and clamp the separator', () => {
  assert.equal(
    keyboardAdjustedChatArtifactSplitRatio(0.6, 'ArrowLeft', 1_000),
    0.6 - CHAT_ARTIFACT_SPLIT_KEYBOARD_STEP
  )
  assert.equal(
    keyboardAdjustedChatArtifactSplitRatio(0.6, 'ArrowRight', 1_000),
    0.6 + CHAT_ARTIFACT_SPLIT_KEYBOARD_STEP
  )
  assert.equal(keyboardAdjustedChatArtifactSplitRatio(0.6, 'Enter', 1_000), 0.6)
  assert.equal(
    keyboardAdjustedChatArtifactSplitRatio(0.1, 'ArrowLeft', 1_000),
    clampChatArtifactSplitRatio(0.1, 1_000)
  )
})

test('App enables the chat split only for the active Office-routed document tab', () => {
  const xlsxInput = {
    officeEnabled: true,
    activeTabKind: 'file',
    activeTabPath: '/project/report.xlsx',
    previewPath: '/project/report.xlsx'
  } as const

  assert.equal(shouldEnableOfficeChatSplit(xlsxInput), true)
  assert.equal(
    shouldEnableOfficeChatSplit({
      ...xlsxInput,
      activeTabPath: '/project/report.DOCX',
      previewPath: '/project/report.DOCX'
    }),
    true
  )
  assert.equal(
    shouldEnableOfficeChatSplit({
      ...xlsxInput,
      activeTabPath: '/project/report.PPTX',
      previewPath: '/project/report.PPTX'
    }),
    true
  )
  assert.equal(shouldEnableOfficeChatSplit({ ...xlsxInput, officeEnabled: false }), false)
  assert.equal(
    shouldEnableOfficeChatSplit({
      ...xlsxInput,
      activeTabPath: '/project/report.csv',
      previewPath: '/project/report.csv'
    }),
    false
  )
  assert.equal(
    shouldEnableOfficeChatSplit({ ...xlsxInput, previewPath: '/project/other.xlsx' }),
    false
  )
  assert.equal(shouldEnableOfficeChatSplit({ ...xlsxInput, activeTabKind: 'directory' }), false)
  assert.equal(
    shouldEnableOfficeChatSplit({ ...xlsxInput, currentConversationInSidebar: true }),
    false
  )
})

test('the sidebar hosts the current conversation only in its visible conversation mode', () => {
  const conversationMode = {
    activeView: 'analysis',
    isSidebarOpen: true,
    workspaceSidebarMode: 'conversations'
  } as const

  assert.equal(sidebarHostsCurrentConversation(conversationMode), true)
  assert.equal(
    sidebarHostsCurrentConversation({ ...conversationMode, workspaceSidebarMode: 'files' }),
    false
  )
  assert.equal(sidebarHostsCurrentConversation({ ...conversationMode, activeView: 'chat' }), false)
  assert.equal(
    sidebarHostsCurrentConversation({ ...conversationMode, isSidebarOpen: false }),
    false
  )
})

test('chat artifact split renders chat and artifact with an accessible separator', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ChatArtifactSplit,
      {
        enabled: true,
        artifact: createElement('div', { 'data-testid': 'artifact' }, 'artifact')
      },
      createElement('div', { 'data-testid': 'chat' }, 'chat')
    )
  )

  assert.match(markup, /data-testid="chat"/)
  assert.match(markup, /data-testid="artifact"/)
  assert.match(markup, /role="separator"/)
  assert.match(markup, /aria-orientation="vertical"/)
  assert.match(markup, /aria-valuenow="56"/)
  assert.match(markup, /data-phi-webview-drag-overlay="true"/)
  assert.match(markup, /data-phi-chat-artifact-dragging="false"/)
})

test('chat artifact split leaves the original chat path alone when disabled', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ChatArtifactSplit,
      {
        enabled: false,
        artifact: createElement('div', { 'data-testid': 'artifact' }, 'artifact')
      },
      createElement('div', { 'data-testid': 'chat' }, 'chat')
    )
  )

  assert.match(markup, /data-testid="chat"/)
  assert.doesNotMatch(markup, /data-testid="artifact"/)
  assert.doesNotMatch(markup, /role="separator"/)
})

test('chat artifact split surface blocks the webview while dragging', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ChatArtifactSplitSurface,
      {
        artifact: createElement('div', { 'data-testid': 'artifact' }, 'artifact'),
        ratioPercent: 56,
        widths: null,
        isDragging: true,
        onStartDrag: () => undefined,
        onSeparatorKeyDown: () => undefined
      },
      createElement('div', { 'data-testid': 'chat' }, 'chat')
    )
  )

  assert.match(markup, /data-phi-chat-artifact-dragging="true"/)
  assert.match(markup, /data-phi-webview-drag-overlay="true"/)
  assert.match(markup, /display:block/)
  assert.match(markup, /pointer-events:none/)
})
