import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import NotebookAiPromptCell, {
  type NotebookAiPromptCellProps
} from '../src/renderer/src/features/analysis/notebook/NotebookAiPromptCell'
import {
  buildNotebookAiContextOptions,
  documentCells
} from '../src/renderer/src/features/analysis/lib/notebookViewModel'
import { filterNotebookAiContextOptions } from '../src/renderer/src/features/analysis/lib/notebookAiContextMentions'
import { parseNotebook } from '../src/shared/notebookDocument'

const document = parseNotebook({
  nbformat: 4,
  nbformat_minor: 5,
  metadata: { language_info: { name: 'python' } },
  cells: [
    {
      id: 'context',
      cell_type: 'code',
      metadata: {},
      source:
        'import pandas as pd\nimport scanpy as sc\nfrom pathlib import Path\nDATA_DIR = "./data"\nthreshold = 0.05\ndf = pd.DataFrame({"gene": ["A"]})',
      outputs: []
    }
  ]
})
const contextOptions = buildNotebookAiContextOptions(documentCells(document))

function renderContextMenu(prompt = '@'): string {
  const props: NotebookAiPromptCellProps = {
    language: 'python',
    codeLanguage: 'python',
    prompt,
    references: [],
    contextOptions,
    modelOptions: [],
    selectedModel: null,
    isGenerating: false,
    onSelect: () => {},
    onPromptChange: () => {},
    onLanguageChange: () => {},
    onModelChange: () => {},
    onReferenceAdd: () => {},
    onPickContextFiles: () => {},
    onSubmit: () => {},
    onAccept: () => {},
    onReject: () => {},
    onCancel: () => {},
    onDragStart: () => {}
  }
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(NotebookAiPromptCell, props)
    )
  )
}

test('notebook context menu groups imports, user variables and dataframes separately', () => {
  const markup = renderContextMenu()
  const headings = [...markup.matchAll(/data-phi-notebook-ai-context-group="([^"]+)"/g)]
  assert.deepEqual(headings.map((match) => match[1]).sort(), ['DataFrame', 'Module', 'Variable'])

  const groups = new Map(
    headings.map((match, index) => [
      match[1],
      markup.slice(match.index, headings[index + 1]?.index ?? markup.length)
    ])
  )
  assert.equal(groups.get('Module')?.match(/data-phi-notebook-ai-context-option=/g)?.length, 3)
  assert.equal(groups.get('Variable')?.match(/data-phi-notebook-ai-context-option=/g)?.length, 2)
  assert.equal(groups.get('DataFrame')?.match(/data-phi-notebook-ai-context-option=/g)?.length, 1)
  for (const name of ['pd', 'sc', 'Path'])
    assert.ok(groups.get('Module')?.includes(`>${name}</span>`))
  for (const name of ['DATA_DIR', 'threshold']) {
    assert.ok(groups.get('Variable')?.includes(`>${name}</span>`))
  }
  assert.ok(groups.get('DataFrame')?.includes('>df</span>'))
})

test('module and dataframe previews use the same category as their list group', () => {
  for (const [query, category] of [
    ['sc', 'Module'],
    ['df', 'DataFrame']
  ]) {
    const markup = renderContextMenu(`@${query}`)
    assert.ok(markup.includes(`data-phi-notebook-ai-context-group="${category}"`))
    assert.ok(new RegExp(`MuiChip-label[^>]*>${category}</span>`).test(markup))
    assert.ok(!markup.includes('data-phi-notebook-ai-context-group="Variable"'))
  }
})

test('category filtering keeps modules out of user variables while names and values remain searchable', () => {
  assert.deepEqual(
    filterNotebookAiContextOptions(contextOptions, 'variable').map((option) => option.name),
    ['DATA_DIR', 'threshold']
  )
  assert.deepEqual(
    filterNotebookAiContextOptions(contextOptions, 'module').map((option) => option.name),
    ['pd', 'sc', 'Path']
  )
  assert.deepEqual(
    filterNotebookAiContextOptions(contextOptions, 'dataframe').map((option) => option.name),
    ['df']
  )
  assert.deepEqual(
    filterNotebookAiContextOptions(contextOptions, 'scanpy').map((option) => option.name),
    ['sc']
  )
  assert.deepEqual(
    filterNotebookAiContextOptions(contextOptions, '0.05').map((option) => option.name),
    ['threshold']
  )
})
