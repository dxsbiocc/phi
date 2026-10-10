import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import WindowNavigationControls from '../src/renderer/src/components/WindowNavigationControls'

function renderControls(
  overrides: {
    isSidebarOpen?: boolean
  } = {}
): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WindowNavigationControls, {
        isSidebarOpen: overrides.isSidebarOpen ?? true,
        onToggleSidebar: () => {},
        onOpenSessionSearch: () => {}
      })
    )
  )
}

test('window controls contain the sidebar toggle and session search only', () => {
  const markup = renderControls()

  assert.match(markup, /data-phi-window-navigation-controls="true"/)
  assert.match(markup, /aria-label="收起侧边栏"/)
  assert.match(markup, /data-phi-window-sidebar-toggle-icon="collapse"/)
  assert.match(markup, /aria-label="查找会话"/)
  assert.ok(markup.indexOf('aria-label="收起侧边栏"') < markup.indexOf('aria-label="查找会话"'))
  assert.doesNotMatch(markup, /aria-label="后退"|aria-label="前进"/)
})

test('the sidebar toggle label flips between collapse/expand based on isSidebarOpen', () => {
  const openMarkup = renderControls({ isSidebarOpen: true })
  const closedMarkup = renderControls({ isSidebarOpen: false })

  assert.match(openMarkup, /aria-label="收起侧边栏"/)
  assert.match(openMarkup, /data-phi-window-sidebar-toggle-icon="collapse"/)
  assert.match(closedMarkup, /aria-label="展开侧边栏"/)
  assert.match(closedMarkup, /data-phi-window-sidebar-toggle-icon="expand"/)
})

test('the window sidebar toggle uses the shared collapse/expand sidebar icons', () => {
  const source = readFileSync(
    resolve(process.cwd(), 'src/renderer/src/components/WindowNavigationControls.tsx'),
    'utf8'
  )

  assert.match(source, /GoSidebarCollapse/)
  assert.match(source, /GoSidebarExpand/)
  assert.doesNotMatch(source, /TbLayoutSidebar/)
})
