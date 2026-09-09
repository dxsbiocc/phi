import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import AnalysisView, { type AnalysisViewProps } from '../src/renderer/src/components/AnalysisView'
import { parseNotebook } from '../src/shared/notebookDocument'

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

test('analysis view renders an opened notebook document', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {
      kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' },
      language_info: { name: 'python' }
    },
    cells: [
      { id: 'intro', cell_type: 'markdown', metadata: {}, source: '# Real notebook\n' },
      {
        id: 'code',
        cell_type: 'code',
        execution_count: 1,
        metadata: {},
        outputs: [{ output_type: 'stream', name: 'stdout', text: ['done\n'] }],
        source: 'real = 1'
      }
    ]
  })
  const markup = renderAnalysisView({
    notebookFile: {
      path: '/project/notebooks/real.ipynb',
      relativePath: 'notebooks/real.ipynb',
      name: 'real.ipynb',
      bytes: 512,
      modifiedAt: '2026-09-09T00:00:00.000Z',
      savedRevision: document.revision,
      document
    }
  })

  assert.match(markup, /notebooks\/real\.ipynb/)
  assert.match(markup, /Real notebook/)
  assert.match(markup, /real = 1/)
  assert.match(markup, /done/)
  assert.match(markup, /Saved/)
})

test('analysis view renders local kernel diagnostics', () => {
  const markup = renderAnalysisView({
    kernelDiagnostics: {
      jupyterServer: { available: true, command: 'jupyter', version: '2.14.0' },
      kernels: [
        {
          name: 'python3',
          displayName: 'Python 3',
          language: 'python',
          rawLanguage: 'python'
        }
      ],
      preferredKernelName: 'python3',
      hasPythonKernel: true,
      hasRKernel: false,
      messages: ['未检测到 R kernel。']
    }
  })

  assert.match(markup, /Kernel diagnostics/)
  assert.match(markup, /Jupyter 2\.14\.0/)
  assert.match(markup, /Python kernel/)
  assert.match(markup, /R missing/)
  assert.match(markup, /未检测到 R kernel/)
})
