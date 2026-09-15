import assert from 'node:assert/strict'
import test from 'node:test'
import { Fragment, createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'

import {
  acceptStagedNotebookCell,
  notebookAiPreviewCellIds,
  notebookCellsWithAiPreview,
  rejectStagedNotebookCell,
  stageGeneratedNotebookCells,
  type NotebookAiPromptDraft
} from '../src/renderer/src/features/analysis/lib/notebookAiPromptDraft'
import type { CanvasCell } from '../src/renderer/src/features/analysis/lib/notebookViewModel'
import NotebookAiPreviewActions from '../src/renderer/src/features/analysis/notebook/NotebookAiPreviewActions'
import NotebookCell from '../src/renderer/src/features/analysis/notebook/NotebookCell'
import { parseNotebook } from '../src/shared/notebookDocument'

const baseCell: CanvasCell = {
  id: 'cell-1',
  count: null,
  type: 'code',
  language: 'python',
  state: 'idle',
  source: 'df.head()',
  outputs: []
}

const document = parseNotebook({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: {},
  cells: [
    {
      id: 'cell-1',
      cell_type: 'code',
      execution_count: null,
      metadata: {},
      outputs: [],
      source: 'df.head()'
    }
  ]
})

const generatedCells = [
  {
    cellType: 'markdown' as const,
    source: '## 折线图：各国'
  },
  {
    cellType: 'code' as const,
    language: 'python',
    source: 'fig, ax = plt.subplots()\nincome_by_country.T.plot(ax=ax)'
  }
]

function createDraft(overrides: Partial<NotebookAiPromptDraft> = {}): NotebookAiPromptDraft {
  const draft: NotebookAiPromptDraft = {
    id: 'preview-run',
    mode: 'insert',
    afterCellId: 'cell-1',
    targetCellId: null,
    prompt: '画各国收入折线图',
    language: 'python',
    model: null,
    references: [],
    stagedCells: [],
    isGenerating: false,
    error: null,
    errorDetail: null,
    ...overrides
  }
  return {
    ...draft,
    stagedCells:
      overrides.stagedCells ?? stageGeneratedNotebookCells(document, draft, generatedCells)
  }
}

const draft = createDraft()

function renderWithTheme(element: React.ReactElement): string {
  return renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))
}

test('AI preview cells are inserted into the notebook cell sequence', () => {
  const cells = notebookCellsWithAiPreview([baseCell], draft, 'python')

  assert.equal(cells.length, 3)
  assert.equal(cells[0].id, 'cell-1')
  assert.equal(cells[1].type, 'markdown')
  assert.equal(cells[1].source, '## 折线图：各国')
  assert.equal(cells[2].type, 'code')
  assert.equal(cells[2].language, 'python')
  assert.equal(cells[2].source, 'fig, ax = plt.subplots()\nincome_by_country.T.plot(ax=ax)')
  assert.deepEqual(notebookAiPreviewCellIds(draft), [
    'preview-run:preview-0',
    'preview-run:preview-1'
  ])
})

test('AI preview cells are not inserted while generation is still streaming', () => {
  const generatingDraft = createDraft({ isGenerating: true })
  const cells = notebookCellsWithAiPreview([baseCell], generatingDraft, 'python')

  assert.deepEqual(cells, [baseCell])
  assert.deepEqual(notebookAiPreviewCellIds(generatingDraft), [
    'preview-run:preview-0',
    'preview-run:preview-1'
  ])
})

test('AI refactor preview visually replaces the target cell with generated cells', () => {
  const refactorDraft = createDraft({
    mode: 'refactor',
    afterCellId: 'cell-1',
    targetCellId: 'cell-1'
  })

  const cells = notebookCellsWithAiPreview([baseCell], refactorDraft, 'python')

  assert.equal(cells.length, 2)
  assert.equal(cells[0].type, 'markdown')
  assert.equal(cells[1].type, 'code')
  assert.notEqual(cells[0].id, 'cell-1')
})

test('accepting one AI preview cell writes only that cell and keeps remaining preview order', () => {
  const { document: nextDocument, draft: nextDraft } = acceptStagedNotebookCell(
    document,
    draft,
    'preview-run:preview-1'
  )

  assert.deepEqual(
    nextDocument.cells.map((cell) => cell.source),
    ['df.head()', 'fig, ax = plt.subplots()\nincome_by_country.T.plot(ax=ax)']
  )
  assert.ok(nextDraft)
  assert.deepEqual(notebookAiPreviewCellIds(nextDraft), ['preview-run:preview-0'])

  const displayCells = notebookCellsWithAiPreview(
    nextDocument.cells.map((cell): CanvasCell => ({
      id: cell.id,
      count: cell.executionCount,
      type: cell.cellType === 'raw' ? 'code' : cell.cellType,
      language: cell.cellType === 'code' ? 'python' : undefined,
      state: 'idle',
      source: cell.source,
      outputs: []
    })),
    nextDraft,
    'python'
  )
  assert.deepEqual(
    displayCells.map((cell) => cell.source),
    ['df.head()', '## 折线图：各国', 'fig, ax = plt.subplots()\nincome_by_country.T.plot(ax=ax)']
  )
})

test('accepting one refactor preview cell replaces the target once and keeps remaining previews around it', () => {
  const refactorDraft = createDraft({
    mode: 'refactor',
    afterCellId: 'cell-1',
    targetCellId: 'cell-1'
  })
  const { document: nextDocument, draft: nextDraft } = acceptStagedNotebookCell(
    document,
    refactorDraft,
    'preview-run:preview-1'
  )

  assert.deepEqual(
    nextDocument.cells.map((cell) => cell.id),
    ['cell-1']
  )
  assert.deepEqual(
    nextDocument.cells.map((cell) => cell.source),
    ['fig, ax = plt.subplots()\nincome_by_country.T.plot(ax=ax)']
  )
  assert.ok(nextDraft)
  assert.equal(nextDraft.mode, 'insert')
  assert.equal(nextDraft.targetCellId, null)

  const cells = notebookCellsWithAiPreview(
    [
      {
        ...baseCell,
        source: nextDocument.cells[0].source
      }
    ],
    nextDraft,
    'python'
  )
  assert.deepEqual(
    cells.map((cell) => cell.source),
    ['## 折线图：各国', 'fig, ax = plt.subplots()\nincome_by_country.T.plot(ax=ax)']
  )
})

test('rejecting one AI preview cell removes only that cell and reconnects the preview chain', () => {
  const nextDraft = rejectStagedNotebookCell(draft, 'preview-run:preview-0')

  assert.ok(nextDraft)
  assert.deepEqual(notebookAiPreviewCellIds(nextDraft), ['preview-run:preview-1'])
  const cells = notebookCellsWithAiPreview([baseCell], nextDraft, 'python')
  assert.deepEqual(
    cells.map((cell) => cell.source),
    ['df.head()', 'fig, ax = plt.subplots()\nincome_by_country.T.plot(ax=ax)']
  )
})

test('AI preview cells render through the normal NotebookCell surface', () => {
  const [, markdownCell, codeCell] = notebookCellsWithAiPreview([baseCell], draft, 'python')
  const markup = renderWithTheme(
    createElement(
      Fragment,
      null,
      createElement(NotebookCell, { cell: markdownCell, provisional: true }),
      createElement(NotebookCell, { cell: codeCell, provisional: true })
    )
  )

  assert.equal(markup.match(/data-phi-notebook-cell-provisional="true"/g)?.length, 2)
  assert.match(markup, /data-phi-notebook-cell-surface="markdown-rendered"/)
  assert.match(markup, /data-phi-notebook-markdown="rendered"/)
  assert.match(markup, /data-phi-notebook-code="highlighted"/)
  assert.match(markup, /data-phi-syntax-language="python"/)
  assert.match(markup, /income_by_country/)
  assert.doesNotMatch(markup, /data-phi-notebook-ai-prompt-cell/)
  assert.doesNotMatch(markup, /data-phi-notebook-ai-preview-cells/)
})

test('AI preview exposes accept and reject actions only after generation finishes', () => {
  const completeMarkup = renderWithTheme(
    createElement(NotebookAiPreviewActions, {
      isGenerating: false,
      onAccept: () => {},
      onReject: () => {}
    })
  )
  const generatingMarkup = renderWithTheme(
    createElement(NotebookAiPreviewActions, {
      isGenerating: true,
      onAccept: () => {},
      onReject: () => {}
    })
  )

  assert.match(completeMarkup, /data-phi-notebook-ai-preview-actions="true"/)
  assert.match(completeMarkup, /data-phi-notebook-ai-preview-accept="true"/)
  assert.match(completeMarkup, /data-phi-notebook-ai-preview-reject="true"/)
  assert.match(completeMarkup, /aria-label="接受 AI 生成内容"/)
  assert.match(completeMarkup, /aria-label="拒绝 AI 生成内容"/)
  assert.match(completeMarkup, />Accept</)
  assert.match(completeMarkup, />Reject</)

  assert.match(generatingMarkup, /data-phi-notebook-ai-preview-generating="true"/)
  assert.doesNotMatch(generatingMarkup, /data-phi-notebook-ai-preview-accept="true"/)
  assert.doesNotMatch(generatingMarkup, /data-phi-notebook-ai-preview-reject="true"/)
})
