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

test('notebook AI result filters placeholder cells before previewing per-cell approvals', () => {
  const cells = notebookAiGeneratedCellsFromResult(
    {
      language: 'python',
      source: '',
      cells: [
        { cellType: 'code', language: 'python', source: '...\n\n...' },
        { cellType: 'code', language: 'python', source: '# Top 10 up/down at 48 h\n...' },
        { cellType: 'markdown', source: '# Valid summary' },
        { cellType: 'code', language: 'python', source: 'df.head()' }
      ]
    },
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '# Valid summary' },
    { cellType: 'code', source: 'df.head()', language: 'python' }
  ])
})

test('notebook AI result accepts mixed prose around fenced JSON in one R structured cell', () => {
  const cells = notebookAiGeneratedCellsFromResult(
    {
      language: 'r',
      source: '',
      cells: [
        {
          cellType: 'code',
          language: 'r',
          source: [
            'JSON output only, no markdown fences.',
            '',
            '```json',
            JSON.stringify({
              cells: [
                { language: 'markdown', code: '# Top 10 up/down at 48 h' },
                {
                  language: 'r',
                  code: [
                    'library(dplyr)',
                    'top_genes <- results |> arrange(desc(abs(log2FoldChange))) |> head(10)',
                    'top_genes'
                  ].join('\n')
                }
              ]
            }),
            '```',
            '',
            'This is the raw completion payload.'
          ].join('\n')
        }
      ]
    },
    'r'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '# Top 10 up/down at 48 h' },
    {
      cellType: 'code',
      source: [
        'library(dplyr)',
        'top_genes <- results |> arrange(desc(abs(log2FoldChange))) |> head(10)',
        'top_genes'
      ].join('\n'),
      language: 'r'
    }
  ])
})

test('notebook AI result accepts one clear fenced code block with surrounding prose', () => {
  const cells = notebookAiGeneratedCellsFromResult(
    {
      language: 'python',
      source: [
        '下面是替换后的 Cell 20 代码：',
        '',
        '```python',
        'colors = ["#1b9e77", "#d95f02"]',
        'ax = inc_line.plot(color=colors)',
        'ax',
        '```'
      ].join('\n')
    },
    'python'
  )

  assert.deepEqual(cells, [
    {
      cellType: 'code',
      source: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax',
      language: 'python'
    }
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

test('notebook AI result fallback accepts raw code source', () => {
  const cells = notebookAiGeneratedCellsFromResult(
    {
      language: 'python',
      source: 'print("hello")'
    },
    'python'
  )

  assert.deepEqual(cells, [{ cellType: 'code', source: 'print("hello")', language: 'python' }])
})
