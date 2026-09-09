import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearNotebookCellOutput,
  createNotebookCell,
  deleteNotebookCell,
  insertNotebookCell,
  moveNotebookCell,
  parseNotebook,
  serializeNotebook,
  updateNotebookCell
} from '../src/shared/notebookDocument'

const pythonNotebook = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: 'python3', display_name: 'Python 3' },
    phi: { activeCellId: 'cell-code' }
  },
  cells: [
    {
      id: 'cell-markdown',
      cell_type: 'markdown',
      metadata: { tags: ['intro'] },
      source: ['# QC\n', 'Load counts.'],
      custom_cell_key: { keep: true }
    },
    {
      id: 'cell-code',
      cell_type: 'code',
      metadata: { trusted: true },
      execution_count: 3,
      source: 'import pandas as pd\ncounts.head()',
      outputs: [
        {
          output_type: 'stream',
          name: 'stdout',
          text: ['done\n'],
          custom_output_key: 'kept'
        },
        {
          output_type: 'display_data',
          data: { 'image/png': 'abc', 'text/plain': '<Figure size>' },
          metadata: { needs_background: 'light' }
        }
      ]
    }
  ],
  top_level_extension: { preserved: true }
}

const rNotebook = {
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {
    kernelspec: { name: 'ir', display_name: 'R' }
  },
  cells: [
    {
      id: 'r-code',
      cell_type: 'code',
      metadata: {},
      execution_count: 1,
      source: ['library(tibble)\n', 'tibble(x = 1:3)'],
      outputs: [
        {
          output_type: 'execute_result',
          execution_count: 1,
          data: { 'text/plain': ['# A tibble: 3 x 1\n', '      x\n'] },
          metadata: {}
        }
      ]
    }
  ]
}

test('parseNotebook normalizes Python notebook cells and preserves extensions', () => {
  const document = parseNotebook(pythonNotebook)

  assert.equal(document.nbformat, 4)
  assert.equal(document.nbformatMinor, 5)
  assert.deepEqual(document.metadata.phi, { activeCellId: 'cell-code' })
  assert.deepEqual(document.extra.top_level_extension, { preserved: true })
  assert.equal(document.cells[0].source, '# QC\nLoad counts.')
  assert.deepEqual(document.cells[0].extra.custom_cell_key, pythonNotebook.cells[0].custom_cell_key)
  assert.equal(document.cells[1].outputs[0].text, 'done\n')
  assert.equal(document.cells[1].outputs[0].extra.custom_output_key, 'kept')
  assert.match(document.revision, /^nb-[0-9a-f]{8}$/)
  assert.match(document.cells[1].contentHash, /^nb-[0-9a-f]{8}$/)
})

test('serializeNotebook round-trips standard R notebook data', () => {
  const document = parseNotebook(rNotebook)
  const serialized = serializeNotebook(document)

  assert.equal(serialized.nbformat, 4)
  assert.equal(serialized.nbformat_minor, 5)
  assert.deepEqual(serialized.metadata, rNotebook.metadata)
  assert.deepEqual(serialized.cells, [
    {
      id: 'r-code',
      cell_type: 'code',
      metadata: {},
      source: ['library(tibble)\n', 'tibble(x = 1:3)'],
      execution_count: 1,
      outputs: [
        {
          output_type: 'execute_result',
          data: { 'text/plain': ['# A tibble: 3 x 1\n', '      x\n'] },
          metadata: {},
          execution_count: 1
        }
      ]
    }
  ])
})

test('parseNotebook supplies stable unique ids for older or duplicated cells', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 4,
    metadata: {},
    cells: [
      { cell_type: 'code', source: 'x = 1', metadata: {}, execution_count: null, outputs: [] },
      { id: 'same', cell_type: 'markdown', source: 'A', metadata: {} },
      { id: 'same', cell_type: 'markdown', source: 'B', metadata: {} }
    ]
  })

  assert.deepEqual(
    document.cells.map((cell) => cell.id),
    ['phi-cell-1', 'same', 'same-2']
  )
})

test('notebook mutation helpers update cells immutably and revise the document', () => {
  const document = parseNotebook(pythonNotebook)
  const inserted = insertNotebookCell(document, 1, {
    id: 'notes',
    cellType: 'markdown',
    source: 'Review mitochondrial percentage.'
  })
  const updated = updateNotebookCell(inserted, 'notes', { source: 'Review ribosomal percentage.' })
  const moved = moveNotebookCell(updated, 'notes', 0)
  const cleared = clearNotebookCellOutput(moved, 'cell-code')
  const deleted = deleteNotebookCell(cleared, 'cell-markdown')

  assert.equal(document.cells.length, 2)
  assert.deepEqual(
    inserted.cells.map((cell) => cell.id),
    ['cell-markdown', 'notes', 'cell-code']
  )
  assert.equal(updated.cells[1].source, 'Review ribosomal percentage.')
  assert.deepEqual(
    moved.cells.map((cell) => cell.id),
    ['notes', 'cell-markdown', 'cell-code']
  )
  assert.equal(cleared.cells[2].executionCount, null)
  assert.deepEqual(cleared.cells[2].outputs, [])
  assert.deepEqual(
    deleted.cells.map((cell) => cell.id),
    ['notes', 'cell-code']
  )
  assert.notEqual(inserted.revision, document.revision)
  assert.notEqual(updated.cells[1].contentHash, inserted.cells[1].contentHash)
})

test('createNotebookCell clears code-only fields when converting to markdown', () => {
  const document = insertNotebookCell(
    parseNotebook({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [] }),
    0,
    {
      id: 'analysis',
      cellType: 'code',
      source: 'x = 1',
      executionCount: 1,
      outputs: [{ outputType: 'stream', data: {}, metadata: {}, text: 'x\n', extra: {} }]
    }
  )
  const standaloneCell = createNotebookCell({
    id: 'analysis',
    cellType: 'code',
    source: 'x = 2'
  })
  const updated = updateNotebookCell(document, 'analysis', {
    cellType: 'markdown',
    source: 'A note'
  })

  assert.equal(standaloneCell.id, 'analysis')
  assert.equal(updated.cells[0].cellType, 'markdown')
  assert.equal(updated.cells[0].executionCount, null)
  assert.deepEqual(updated.cells[0].outputs, [])
})

test('parseNotebook rejects non-notebook inputs', () => {
  assert.throws(() => parseNotebook(null), /Notebook must be a JSON object/)
  assert.throws(
    () => parseNotebook({ nbformat: 4, metadata: {}, cells: {} }),
    /cells must be an array/
  )
})
