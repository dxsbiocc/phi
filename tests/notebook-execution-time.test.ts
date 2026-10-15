import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import NotebookCell from '../src/renderer/src/features/analysis/notebook/NotebookCell'
import {
  documentCells,
  type CanvasCell
} from '../src/renderer/src/features/analysis/lib/notebookViewModel'
import { parseNotebook, serializeNotebook } from '../src/shared/notebookDocument'

const completedAt = new Date(2026, 9, 15, 9, 5, 7, 123).toISOString()
const document = parseNotebook({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      id: 'timed-cell',
      cell_type: 'code',
      metadata: { phi: { executionCompletedAt: completedAt, executionDurationMs: 1530 } },
      source: 'print("done")',
      execution_count: 1,
      outputs: [{ output_type: 'stream', name: 'stdout', text: 'done', metadata: {} }]
    }
  ]
})

function renderCell(cell: CanvasCell): string {
  return renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, createElement(NotebookCell, { cell }))
  )
}

test('saved completion time appears above output in local yyyy-mm-dd hh:mm:ss format', () => {
  const restored = parseNotebook(serializeNotebook(document))
  const [cell] = documentCells(restored)
  const markup = renderCell(cell)
  const sourceIndex = markup.indexOf('data-phi-notebook-code="highlighted"')
  const areaIndex = markup.indexOf('data-phi-notebook-output="area"')
  const timeIndex = markup.indexOf('data-phi-notebook-cell-execution-completed-at=')
  const outputIndex = markup.indexOf('data-phi-notebook-output-pre="true"')

  assert.ok(/<time\b/.test(markup), 'expected a completion timestamp')
  assert.ok(markup.includes(`dateTime="${completedAt}"`))
  assert.match(markup, />2026-10-15 09:05:07<\/time>/)
  assert.ok(sourceIndex >= 0 && areaIndex > sourceIndex)
  assert.ok(timeIndex > areaIndex && outputIndex > timeIndex)
})

test('a completed cell with no output still shows its completion time', () => {
  const [cell] = documentCells(document)
  const markup = renderCell({ ...cell, outputs: [] })

  assert.ok(markup.includes('data-phi-notebook-cell-execution-completed-at='))
  assert.match(markup, />2026-10-15 09:05:07<\/time>/)
})

test('error output has a completion time while re-running hides the previous completion time', () => {
  const [cell] = documentCells(document)
  const failed: CanvasCell = {
    ...cell,
    state: 'error',
    outputs: [
      {
        outputType: 'error',
        ename: 'ExecutionError',
        evalue: 'lost connection',
        data: {},
        metadata: {},
        extra: {}
      }
    ]
  }
  assert.ok(renderCell(failed).includes('data-phi-notebook-cell-execution-completed-at='))
  assert.doesNotMatch(
    renderCell({ ...failed, state: 'running' }),
    /data-phi-notebook-cell-execution-completed-at=/
  )
})

test('missing and invalid historical times never show an invented completion time', () => {
  for (const value of [undefined, 'invalid-date', '', 42]) {
    const restored = parseNotebook({
      ...serializeNotebook(document),
      cells: [
        {
          id: 'no-time',
          cell_type: 'code',
          source: '1 + 1',
          outputs: [],
          metadata: { phi: value === undefined ? {} : { executionCompletedAt: value } }
        }
      ]
    })
    assert.doesNotMatch(renderCell(documentCells(restored)[0]), /<time\b/)
  }
})
