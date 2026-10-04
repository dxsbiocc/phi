import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { WorkspaceSidePanel } from '../src/renderer/src/components/WorkspaceSidePanel'
import { toggleWorkspaceSidePanelMode } from '../src/renderer/src/lib/workspaceSidePanelMode'

function renderPanel(mode: 'jobs' | 'terminal' | 'browser'): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(
        WorkspaceSidePanel,
        { width: 340, mode },
        createElement('div', { 'data-testid': `${mode}-content` }, `${mode} content`)
      )
    )
  )
}

test('each right-side button opens its panel and closes it on a second click', () => {
  for (const mode of ['jobs', 'terminal', 'browser'] as const) {
    assert.equal(toggleWorkspaceSidePanelMode(null, mode), mode)
    assert.equal(toggleWorkspaceSidePanelMode(mode, mode), null)
  }
})

test('a different right-side button switches the visible panel', () => {
  assert.equal(toggleWorkspaceSidePanelMode('jobs', 'terminal'), 'terminal')
  assert.equal(toggleWorkspaceSidePanelMode('terminal', 'browser'), 'browser')
  assert.equal(toggleWorkspaceSidePanelMode('browser', 'jobs'), 'jobs')
})

test('terminal mode renders feature content instead of the placeholder card', () => {
  const markup = renderPanel('terminal')

  assert.match(markup, /data-phi-workspace-side-panel-mode="terminal"/)
  assert.match(markup, /data-testid="terminal-content"/)
  assert.doesNotMatch(markup, /data-phi-workspace-side-panel-tool-card/)
})

test('jobs and browser modes continue to render their feature content', () => {
  assert.match(renderPanel('jobs'), /data-testid="jobs-content"/)
  assert.match(renderPanel('browser'), /data-testid="browser-content"/)
})
