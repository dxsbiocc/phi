import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { HomeView } from '../src/renderer/src/features/home/HomeView'

function renderHomeView(): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(HomeView, {
        sessions: [],
        lastClosedSessionPath: null,
        onNewChat: () => undefined,
        onShowProjects: () => undefined,
        onOpenSession: () => undefined
      })
    )
  )
}

test('home entry cards respond to their content width without collapsing card text', () => {
  const markup = renderHomeView()

  assert.match(markup, /grid-template-columns:repeat\(auto-fit,\s*minmax\(240px,\s*1fr\)\)/)
  assert.doesNotMatch(markup, /@media \(min-width:600px\)/)
  assert.equal(markup.match(/home-card-text/g)?.length, 2)
  assert.match(markup, /min-width:0;word-break:normal/)
})
