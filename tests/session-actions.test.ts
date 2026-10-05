import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { SessionRow } from '../src/renderer/src/components/session-sidebar/SessionRow'
import { editableSessionTitle, sessionTitle } from '../src/renderer/src/lib/sessionSidebarShared'
import type { SessionSummary } from '../src/renderer/src/types'

const session: SessionSummary = {
  id: 'session-a',
  path: 'session-a',
  created: '2026-09-06T00:00:00.000Z',
  modified: '2026-09-06T00:00:00.000Z',
  messageCount: 1,
  firstMessage: '测试模型是否可用',
  status: 'idle',
  unreadKind: null
}

test('conversation actions have a separate menu trigger beside the row', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(SessionRow, {
        session,
        isActive: false,
        nowMs: Date.now(),
        onSelect: () => undefined,
        onRename: () => undefined,
        onDelete: () => undefined
      })
    )
  )
  const rowSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/session-sidebar/SessionRow.tsx'),
    'utf8'
  )

  assert.match(markup, /data-phi-session-row-shell="true"/)
  assert.match(markup, /aria-label="更多会话操作"/)
  assert.doesNotMatch(markup, /aria-label="重命名"|aria-label="删除"/)
  assert.ok(
    rowSource.indexOf('className="session-actions"') > rowSource.indexOf('</ListItemButton>')
  )
  assert.match(rowSource, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/)
  const triggerStyles = rowSource
    .split('const sessionActionButtonSx = {')[1]
    ?.split('const sessionMenuItemSx')[0]
  assert.ok(triggerStyles)
  assert.doesNotMatch(triggerStyles, /border:|borderColor:|background\.paper|action\.selected/)
})

test('rename dialog edits the full title while the sidebar stays concise', () => {
  const longName = '长标题'.repeat(40)
  const namedSession = { ...session, name: longName }
  const dialogSource = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/features/session-actions/SessionRenamePanel.tsx'),
    'utf8'
  )

  assert.equal(editableSessionTitle(namedSession), longName)
  assert.notEqual(sessionTitle(namedSession), longName)
  assert.match(dialogSource, /data-phi-session-rename-dialog="true"/)
  assert.match(dialogSource, /aria-label="新的对话标题"/)
})
