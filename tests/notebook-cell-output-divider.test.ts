import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import NotebookCell from '../src/renderer/src/features/analysis/notebook/NotebookCell'
import type { CanvasCell } from '../src/renderer/src/features/analysis/lib/notebookViewModel'

function renderCell(cell: CanvasCell): string {
  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(NotebookCell, { cell }))
  )
}

test('a code cell with output has exactly one seam between code and output, not a doubled line', () => {
  // NotebookOutputArea already draws its own top border as the code/output
  // divider -- a plain <Divider /> rendered right before it used to stack a
  // second <hr> hairline directly against it.
  const cell: CanvasCell = {
    id: 'cell-1',
    count: 1,
    type: 'code',
    language: 'python',
    state: 'idle',
    source: '1 + 1',
    outputs: [
      {
        outputType: 'execute_result',
        data: { 'text/plain': '2' },
        metadata: {},
        extra: {}
      }
    ]
  }

  const markup = renderCell(cell)
  const outputAreaIndex = markup.indexOf('data-phi-notebook-output="area"')
  assert.ok(outputAreaIndex >= 0, 'expected the output area to render')

  // No stray <hr> immediately ahead of the output area -- NotebookOutputArea
  // supplies the seam itself via its own top-border style, not a markup tag.
  const precedingMarkup = markup.slice(0, outputAreaIndex)
  const lastOpenTag = precedingMarkup.lastIndexOf('<')
  assert.ok(!precedingMarkup.slice(lastOpenTag).startsWith('<hr'))
})

test('a code cell with no output renders no divider at all', () => {
  const cell: CanvasCell = {
    id: 'cell-2',
    count: null,
    type: 'code',
    language: 'python',
    state: 'idle',
    source: 'x = 1',
    outputs: []
  }

  const markup = renderCell(cell)

  assert.doesNotMatch(markup, /data-phi-notebook-output="area"/)
})
