import assert from 'node:assert/strict'
import test from 'node:test'
import {
  localNotebookCompletionOptions,
  mergedNotebookCompletionOptions,
  notebookCompletionRange
} from '../src/renderer/src/features/analysis/lib/notebookCompletions'

test('localNotebookCompletionOptions includes language keywords and cell symbols', () => {
  const options = localNotebookCompletionOptions({
    source: 'import pandas as pd\ndata_frame = pd.DataFrame()\ndata_frame.head()',
    language: 'python'
  })
  const labels = options.map((option) => option.label)

  assert.ok(labels.includes('import'))
  assert.ok(labels.includes('data_frame'))
  assert.ok(labels.includes('DataFrame'))
})

test('mergedNotebookCompletionOptions prioritizes kernel matches and de-duplicates local symbols', () => {
  const options = mergedNotebookCompletionOptions({
    kernel: {
      matches: ['DataFrame', 'date_range'],
      cursorStart: 3,
      cursorEnd: 5,
      metadata: {},
      status: 'ok'
    },
    local: [
      { label: 'DataFrame', type: 'variable', detail: 'notebook cell' },
      { label: 'dataset', type: 'variable', detail: 'notebook cell' }
    ]
  })

  assert.deepEqual(
    options.map((option) => option.label),
    ['DataFrame', 'date_range', 'dataset']
  )
  assert.equal(options[0].detail, 'kernel')
})

test('mergedNotebookCompletionOptions labels static Python package completions', () => {
  const options = mergedNotebookCompletionOptions({
    kernel: {
      matches: ['pandas'],
      cursorStart: 7,
      cursorEnd: 10,
      metadata: { phiCompletionSource: 'python-package' },
      status: 'ok'
    },
    local: []
  })

  assert.equal(options[0].label, 'pandas')
  assert.equal(options[0].type, 'namespace')
  assert.equal(options[0].detail, 'Python package')
})

test('notebookCompletionRange uses kernel replacement spans when available', () => {
  assert.deepEqual(
    notebookCompletionRange({
      kernel: {
        matches: ['head'],
        cursorStart: 3,
        cursorEnd: 6,
        metadata: {},
        status: 'ok'
      },
      tokenStart: 4,
      cursorPosition: 6,
      sourceLength: 10
    }),
    { from: 3, to: 6 }
  )
})
