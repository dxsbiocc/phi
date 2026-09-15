import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import WindowNavigationControls from '../src/renderer/src/components/WindowNavigationControls'

function renderControls(
  overrides: {
    isSidebarOpen?: boolean
    canGoBack?: boolean
    canGoForward?: boolean
  } = {}
): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(WindowNavigationControls, {
        isSidebarOpen: overrides.isSidebarOpen ?? true,
        onToggleSidebar: () => {},
        canGoBack: overrides.canGoBack ?? false,
        canGoForward: overrides.canGoForward ?? false,
        onGoBack: () => {},
        onGoForward: () => {}
      })
    )
  )
}

test('the sidebar toggle and back/forward buttons are all present', () => {
  const markup = renderControls()

  assert.match(markup, /data-phi-window-navigation-controls="true"/)
  assert.match(markup, /aria-label="收起侧边栏"/)
  assert.match(markup, /data-phi-window-sidebar-toggle-icon="collapse"/)
  assert.match(markup, /aria-label="后退"/)
  assert.match(markup, /aria-label="前进"/)
})

test('back/forward buttons are disabled when there is nowhere to go', () => {
  const markup = renderControls({ canGoBack: false, canGoForward: false })

  const backButton = markup.match(/<button[^>]*aria-label="后退"[^>]*>/)?.[0] ?? ''
  const forwardButton = markup.match(/<button[^>]*aria-label="前进"[^>]*>/)?.[0] ?? ''

  assert.match(backButton, /\bdisabled=""/)
  assert.match(forwardButton, /\bdisabled=""/)
})

test('back/forward buttons enable once there is history to move through', () => {
  const markup = renderControls({ canGoBack: true, canGoForward: true })

  const backButton = markup.match(/<button[^>]*aria-label="后退"[^>]*>/)?.[0] ?? ''
  const forwardButton = markup.match(/<button[^>]*aria-label="前进"[^>]*>/)?.[0] ?? ''

  assert.doesNotMatch(backButton, /\bdisabled\b/)
  assert.doesNotMatch(forwardButton, /\bdisabled\b/)
})

test('the sidebar toggle label flips between collapse/expand based on isSidebarOpen', () => {
  const openMarkup = renderControls({ isSidebarOpen: true })
  const closedMarkup = renderControls({ isSidebarOpen: false })

  assert.match(openMarkup, /aria-label="收起侧边栏"/)
  assert.match(openMarkup, /data-phi-window-sidebar-toggle-icon="collapse"/)
  assert.match(closedMarkup, /aria-label="展开侧边栏"/)
  assert.match(closedMarkup, /data-phi-window-sidebar-toggle-icon="expand"/)
})
