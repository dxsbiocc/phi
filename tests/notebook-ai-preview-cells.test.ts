import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import ts from 'typescript'
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
import { notebookAiGeneratedCellsFromResult } from '../src/renderer/src/features/analysis/lib/notebookAiGenerationResult'
import {
  notebookAiEmptyGenerationMessage,
  notebookAiPromptError
} from '../src/renderer/src/features/analysis/lib/notebookAiErrors'
import { notebookPromptContextReferences } from '../src/renderer/src/features/analysis/lib/notebookPromptReferences'
import type {
  AnalysisNotebookCodeGenerationProgress,
  AnalysisNotebookCodeGenerationResult
} from '../src/renderer/src/types'

// Execute the callback registered by the real Canvas effect, so this protects
// the running-request gate as well as the preview projection below.
const canvasSource = ts.createSourceFile(
  'NotebookCanvas.tsx',
  readFileSync('src/renderer/src/features/analysis/notebook/NotebookCanvas.tsx', 'utf8'),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX
)

function generationProgressEffect(): string {
  let effect: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'useEffect' &&
      node.arguments[0]?.getText(canvasSource).includes('onNotebookCodeGenerationProgress')
    ) {
      effect = node.arguments[0]
    }
    ts.forEachChild(node, visit)
  }
  visit(canvasSource)
  assert.ok(effect, 'Canvas must subscribe to Notebook generation progress')
  return ts.transpileModule(`(${effect.getText(canvasSource)})()`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
}

const progressScript = generationProgressEffect()

function canvasVariable(name: string): string {
  let expression: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && node.name.getText(canvasSource) === name) {
      expression = node.initializer
    }
    ts.forEachChild(node, visit)
  }
  visit(canvasSource)
  assert.ok(expression, `Canvas must define ${name}`)
  return ts.transpileModule(`(${expression.getText(canvasSource)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
}

function progressHarness(initialDraft: NotebookAiPromptDraft | null): {
  current: () => NotebookAiPromptDraft | null
  submit: () => Promise<void>
  cancel: () => void
  complete: (result: AnalysisNotebookCodeGenerationResult) => void
  fail: (error: unknown) => void
  send: (
    overrides?: Partial<AnalysisNotebookCodeGenerationProgress>
  ) => NotebookAiPromptDraft | null
} {
  let current = initialDraft
  let onProgress: ((progress: AnalysisNotebookCodeGenerationProgress) => void) | undefined
  let complete: ((result: AnalysisNotebookCodeGenerationResult) => void) | undefined
  let fail: ((error: unknown) => void) | undefined
  const generation = new Promise<AnalysisNotebookCodeGenerationResult>((resolve, reject) => {
    complete = resolve
    fail = reject
  })
  const unsubscribe = (): void => {}
  const context = {
    aiPromptDraft: initialDraft,
    aiContextOptions: [],
    draftDocument: document,
    notebookFile: { path: '/project/analysis.ipynb', relativePath: 'analysis.ipynb' },
    stageGeneratedNotebookCells,
    notebookAiGeneratedCellsFromResult,
    notebookAiEmptyGenerationMessage,
    notebookAiPromptError,
    notebookPromptContextReferences,
    onGenerateNotebookCode: () => generation,
    onNotebookCodeGenerationProgress: (callback: typeof onProgress) => {
      onProgress = callback
      return unsubscribe
    },
    setAiPromptDraft: (update: typeof current | ((draft: typeof current) => typeof current)) => {
      current = typeof update === 'function' ? update(current) : update
    }
  }
  const cleanup = runInNewContext(progressScript, context)
  assert.equal(cleanup, unsubscribe)
  assert.ok(onProgress)
  return {
    current: () => current,
    submit: runInNewContext(canvasVariable('submitAiPrompt'), context) as () => Promise<void>,
    cancel: runInNewContext(canvasVariable('closeAiPrompt'), context) as () => void,
    complete: (result: AnalysisNotebookCodeGenerationResult) => complete!(result),
    fail: (error: unknown) => fail!(error),
    send: (overrides: Partial<AnalysisNotebookCodeGenerationProgress> = {}) => {
      onProgress!({
        requestId: 'preview-run',
        path: '/project/analysis.ipynb',
        relativePath: 'analysis.ipynb',
        source: 'streamed response',
        language: 'python',
        cells: generatedCells,
        ...overrides
      })
      return current
    }
  }
}

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

test('AI preview cells include streamed Markdown and code in notebook order while generating', () => {
  const generatingDraft = createDraft({ isGenerating: true })
  const cells = notebookCellsWithAiPreview([baseCell], generatingDraft, 'python')

  assert.deepEqual(
    cells.map((cell) => cell.type),
    ['code', 'markdown', 'code']
  )
  assert.deepEqual(
    cells.map((cell) => cell.source),
    [baseCell.source, ...generatedCells.map((cell) => cell.source)]
  )
  assert.deepEqual(notebookAiPreviewCellIds(generatingDraft), [
    'preview-run:preview-0',
    'preview-run:preview-1'
  ])
})

test('the real Canvas progress handler stages a matching running request', () => {
  const running = createDraft({ isGenerating: true, stagedCells: [] })
  const next = progressHarness(running).send()

  assert.ok(next)
  assert.equal(next.isGenerating, true)
  assert.deepEqual(
    Array.from(next.stagedCells, (cell) => cell.source),
    generatedCells.map((cell) => cell.source)
  )
})

test('Canvas ignores progress from another request or notebook and after generation finishes', () => {
  for (const draft of [null, createDraft({ isGenerating: false })]) {
    assert.equal(progressHarness(draft).send(), draft)
  }
  const running = createDraft({ isGenerating: true, stagedCells: [] })
  for (const progress of [
    { requestId: 'older-request' },
    { path: '/project/other.ipynb', relativePath: 'other.ipynb' },
    { path: '/another-project/analysis.ipynb', relativePath: 'analysis.ipynb' },
    { cells: [] }
  ]) {
    assert.equal(progressHarness(running).send(progress), running)
  }
})

test('Canvas uses the absolute notebook path and only falls back when it is absent', () => {
  const running = createDraft({ isGenerating: true, stagedCells: [] })
  assert.equal(
    progressHarness(running).send({ relativePath: 'renamed/analysis.ipynb' })?.stagedCells.length,
    2
  )
  assert.equal(progressHarness(running).send({ path: '' })?.stagedCells.length, 2)
  assert.equal(progressHarness(running).send({ path: '', relativePath: 'other.ipynb' }), running)
})

test('streaming Canvas progress replaces preview contents with stable IDs in source order', () => {
  const harness = progressHarness(createDraft({ isGenerating: true, stagedCells: [] }))
  const partial = harness.send({ cells: [{ cellType: 'markdown', source: '## 折线图' }] })
  assert.ok(partial)
  assert.deepEqual(
    Array.from(partial.stagedCells, (cell) => cell.previewId),
    ['preview-run:preview-0']
  )

  const updated = harness.send()
  assert.ok(updated)
  assert.deepEqual(
    Array.from(updated.stagedCells, (cell) => cell.previewId),
    ['preview-run:preview-0', 'preview-run:preview-1']
  )
  assert.deepEqual(
    notebookCellsWithAiPreview([baseCell], updated, 'python').map((cell) => cell.source),
    [baseCell.source, ...generatedCells.map((cell) => cell.source)]
  )
  assert.deepEqual(
    document.cells.map((cell) => cell.source),
    [baseCell.source]
  )
})

test('Canvas completion keeps one copy of each streamed preview and closes the progress gate', async () => {
  const harness = progressHarness(createDraft({ stagedCells: [] }))
  const pending = harness.submit()
  const running = harness.send()
  assert.ok(running?.isGenerating)
  const previewIds = Array.from(running.stagedCells, (cell) => cell.previewId)

  harness.complete({ source: 'final response', language: 'python', cells: generatedCells })
  await pending
  const completed = harness.current()
  assert.ok(completed)
  assert.equal(completed.isGenerating, false)
  assert.deepEqual(
    Array.from(completed.stagedCells, (cell) => cell.previewId),
    previewIds
  )
  assert.deepEqual(
    notebookCellsWithAiPreview([baseCell], completed, 'python').map((cell) => cell.source),
    [baseCell.source, ...generatedCells.map((cell) => cell.source)]
  )
  assert.equal(
    harness.send({ cells: [{ cellType: 'markdown', source: 'late update' }] }),
    completed
  )
  assert.deepEqual(
    document.cells.map((cell) => cell.source),
    [baseCell.source]
  )
})

test('Canvas failure removes streamed refactor previews and restores the original cell', async () => {
  const harness = progressHarness(
    createDraft({
      mode: 'refactor',
      targetCellId: baseCell.id,
      stagedCells: []
    })
  )
  const pending = harness.submit()
  const running = harness.send()
  assert.ok(running)
  assert.deepEqual(
    notebookCellsWithAiPreview([baseCell], running, 'python').map((cell) => cell.type),
    ['markdown', 'code']
  )

  harness.fail(new Error('模型连接中断'))
  await pending
  const failed = harness.current()
  assert.ok(failed)
  assert.equal(failed.isGenerating, false)
  assert.equal(failed.error, '模型连接中断')
  assert.equal(failed.stagedCells.length, 0)
  assert.deepEqual(notebookCellsWithAiPreview([baseCell], failed, 'python'), [baseCell])
})

test('closing a generating prompt prevents late progress or completion from restoring previews', async () => {
  const harness = progressHarness(createDraft({ stagedCells: [] }))
  const pending = harness.submit()
  assert.equal(harness.send()?.stagedCells.length, 2)
  harness.cancel()
  assert.equal(harness.send(), null)
  harness.complete({ source: 'final response', language: 'python', cells: generatedCells })
  await pending
  assert.equal(harness.current(), null)
  assert.deepEqual(
    document.cells.map((cell) => cell.source),
    [baseCell.source]
  )
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
