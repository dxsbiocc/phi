import assert from 'node:assert/strict'
import test from 'node:test'

import { notebookAiGeneratedCellsFromResult } from '../src/renderer/src/features/analysis/lib/notebookAiGenerationResult'

const qcExplanation = [
  '## 为什么三个数据集的过滤参数不同',
  '',
  'QC_PARAMS 不是一套任意阈值，而是由 **矩阵含义** 决定哪些指标能当过滤器。GSE151530 / GSE189903 的 `X` 是 10x 原始 UMI counts；GSE229772 的 `X` 已是归一化表达。过滤规则必须跟这个物理量对齐，不能共用一套 count 门槛。'
].join('\n')

test('the reported Markdown response reaches the renderer with the complete explanation', () => {
  const cells = notebookAiGeneratedCellsFromResult(
    {
      language: 'markdown',
      source: JSON.stringify({ cells: [{ language: 'markdown', code: qcExplanation }] })
    },
    'markdown'
  )
  assert.deepEqual(cells, [{ cellType: 'markdown', source: qcExplanation }])
  assert.doesNotMatch(cells.map((cell) => cell.source).join('\n'), /with exit code 1 and/)
})

test('explicit Markdown retains its prose and embedded code example as one Markdown cell', () => {
  const explanation = `${qcExplanation}\n\n例如：\n\n\u0060\u0060\u0060python\nmin_counts = None\n\u0060\u0060\u0060\n\n归一化矩阵不使用原始计数阈值。`
  assert.deepEqual(
    notebookAiGeneratedCellsFromResult(
      { language: 'markdown', source: '', cells: [{ cellType: 'markdown', source: explanation }] },
      'markdown'
    ),
    [{ cellType: 'markdown', source: explanation }]
  )
})

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
