import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import AnalysisView, { type AnalysisViewProps } from '../src/renderer/src/components/AnalysisView'

function renderAnalysisView(props: AnalysisViewProps = {}): string {
  const theme = createTheme()
  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme }, createElement(AnalysisView, props))
  )
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

test('analysis view renders project notebook registry entries', () => {
  const markup = renderAnalysisView({
    initialLeftPanel: 'notebooks',
    notebookRegistry: {
      projectCwd: '/project',
      projectName: 'Demo',
      notebooks: [
        {
          path: '/project/notebooks/real.ipynb',
          relativePath: 'notebooks/real.ipynb',
          name: 'real.ipynb',
          directory: 'notebooks',
          bytes: 2048,
          modifiedAt: '2026-09-09T00:00:00.000Z'
        }
      ],
      truncated: false,
      initialized: true
    }
  })

  assert.match(markup, /Demo/)
  assert.match(markup, /notebooks\/real\.ipynb/)
  assert.match(markup, /2 KB/)
})

test('analysis view renders notebook registry empty and loading states', () => {
  const empty = renderAnalysisView({
    initialLeftPanel: 'notebooks',
    notebookRegistry: {
      projectCwd: '/project',
      projectName: 'Empty',
      notebooks: [],
      truncated: false,
      initialized: false
    },
    onInitializeProjectAnalysis: () => undefined
  })
  const loading = renderAnalysisView({
    initialLeftPanel: 'notebooks',
    notebookRegistry: null,
    isLoadingNotebooks: true
  })

  assert.match(empty, /当前项目还没有 notebook/)
  assert.match(empty, /初始化分析目录/)
  assert.match(loading, /正在扫描 notebooks/)
})
