import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import AnalysisView from '../src/renderer/src/components/AnalysisView'

function renderAnalysisView(): string {
  const theme = createTheme()
  return renderToStaticMarkup(createElement(ThemeProvider, { theme }, createElement(AnalysisView)))
}

test('analysis view renders the first-phase notebook shell', () => {
  const markup = renderAnalysisView()

  assert.match(markup, /本地 notebook workbench/)
  assert.match(markup, /notebooks\/exploration\.ipynb/)
  assert.match(markup, /Python 3\.11/)
  assert.match(markup, /Files/)
  assert.match(markup, /Variables/)
  assert.match(markup, /Artifacts/)
  assert.match(markup, /Data Preview/)
  assert.match(markup, /Agent transaction/)
})
