import assert from 'node:assert/strict'
import test from 'node:test'

import { notebookAiGeneratedCellsFromResult } from '../src/renderer/src/features/analysis/lib/notebookAiGenerationResult'

test('notebook AI result fallback parses raw NotebookCellsCompletion JSON source into multiple cells', () => {
  const cells = notebookAiGeneratedCellsFromResult(
    {
      language: 'python',
      source: JSON.stringify({
        cells: [
          { language: 'markdown', code: '## Summary\nUse a greedy choice.' },
          { language: 'python', code: 'def greedy(items):\n    return sorted(items)' }
        ]
      })
    },
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '## Summary\nUse a greedy choice.' },
    { cellType: 'code', source: 'def greedy(items):\n    return sorted(items)', language: 'python' }
  ])
})

test('notebook AI result fallback parses fenced NotebookCellsCompletion JSON source into multiple cells', () => {
  const cells = notebookAiGeneratedCellsFromResult(
    {
      language: 'python',
      source: [
        '```json',
        JSON.stringify({
          cells: [
            { language: 'markdown', code: '## Plan' },
            { language: 'python', code: 'result = df.describe()' }
          ]
        }),
        '```'
      ].join('\n')
    },
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '## Plan' },
    { cellType: 'code', source: 'result = df.describe()', language: 'python' }
  ])
})

test('notebook AI result reparses protocol JSON returned as a generated code cell', () => {
  const cells = notebookAiGeneratedCellsFromResult(
    {
      language: 'python',
      source: '',
      cells: [
        {
          cellType: 'code',
          language: 'json',
          source: [
            '```json',
            JSON.stringify({
              cells: [
                { language: 'markdown', code: '### 收入趋势' },
                { language: 'python', code: 'fig, ax = plt.subplots()\nax' }
              ]
            }),
            '```'
          ].join('\n')
        }
      ]
    },
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '### 收入趋势' },
    { cellType: 'code', source: 'fig, ax = plt.subplots()\nax', language: 'python' }
  ])
})

test('notebook AI result fallback does not insert malformed completion JSON as code', () => {
  const cells = notebookAiGeneratedCellsFromResult(
    {
      language: 'python',
      source: '{"cells":[{"language":"markdown","code":"# Plan"'
    },
    'python'
  )

  assert.deepEqual(cells, [])
})

test('notebook AI result fallback does not insert truncated JSON fences as code', () => {
  const cells = notebookAiGeneratedCellsFromResult(
    {
      language: 'python',
      source: '```json'
    },
    'python'
  )

  assert.deepEqual(cells, [])
})

test('notebook AI result fallback rejects ordinary source instead of guessing a code cell', () => {
  const cells = notebookAiGeneratedCellsFromResult(
    {
      language: 'python',
      source: 'print("hello")'
    },
    'python'
  )

  assert.deepEqual(cells, [])
})
