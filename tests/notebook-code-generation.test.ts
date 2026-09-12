import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildNotebookCodeGenerationPrompt,
  notebookCellPromptContext,
  notebookContextReferencePrompt,
  notebookGenerationEmptyResultMessage,
  parseGeneratedNotebookCells
} from '../src/main/agent/notebook/notebook-code-generation'
import { parseNotebook } from '../src/shared/notebookDocument'

test('notebook AI generation parser accepts marimo-style code fields and unwraps markdown wrappers', () => {
  const cells = parseGeneratedNotebookCells(
    JSON.stringify({
      cells: [
        { type: 'markdown', code: 'mo.md("""# Summary\nUse the dataframe below.""")' },
        { type: 'code', code: 'df.describe()', language: 'python' }
      ]
    }),
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '# Summary\nUse the dataframe below.' },
    { cellType: 'code', source: 'df.describe()', language: 'python' }
  ])
})

test('notebook AI generation parser splits markdown and code fences into insertable cells', () => {
  const cells = parseGeneratedNotebookCells(
    [
      'Here is a quick summary cell.',
      '',
      '```python',
      'summary = df.describe()',
      'summary',
      '```',
      '',
      '```markdown',
      'The table above summarizes the numeric columns.',
      '```'
    ].join('\n'),
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: 'Here is a quick summary cell.' },
    { cellType: 'code', source: 'summary = df.describe()\nsummary', language: 'python' },
    { cellType: 'markdown', source: 'The table above summarizes the numeric columns.' }
  ])
})

test('notebook AI generation parser treats plain prose as markdown instead of Python code', () => {
  const cells = parseGeneratedNotebookCells('这个数据集包含三列，可以先检查缺失值。', 'python')

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '这个数据集包含三列，可以先检查缺失值。' }
  ])
})

test('notebook AI generation prompt includes selected references and notebook context', () => {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [
      {
        id: 'setup',
        cell_type: 'code',
        execution_count: null,
        metadata: {},
        outputs: [],
        source: ['import pandas as pd\n', 'df = pd.read_csv("data.csv")\n']
      }
    ]
  })
  const context = notebookCellPromptContext(document, 'setup')
  const references = [
    {
      id: 'df',
      kind: 'dataframe' as const,
      name: 'df',
      detail: 'active dataframe',
      cellId: 'setup',
      preview: {
        shape: '100 rows x 3 columns',
        columns: [
          { name: 'age', type: 'int64' },
          { name: 'group', type: 'object' }
        ],
        output: 'age group\n1   A'
      }
    }
  ]
  const referencePrompt = notebookContextReferencePrompt(references)
  const prompt = buildNotebookCodeGenerationPrompt({
    language: 'python',
    notebookPath: 'notebooks/example.ipynb',
    insertionIndex: context.insertionIndex,
    references,
    userPrompt: '@df 总结一下这个数据',
    nearbyContext: context.nearbyContext,
    otherCellContext: context.otherCellContext
  })

  assert.match(referencePrompt, /@dataframe:\/\/df/)
  assert.match(referencePrompt, /100 rows x 3 columns/)
  assert.match(prompt, /marimo-style notebook generation pattern/)
  assert.match(prompt, /Return only a JSON object/)
  assert.match(prompt, /df = pd\.read_csv/)
  assert.match(prompt, /@df 总结一下这个数据/)
})

test('notebook AI generation empty result message includes a diagnostic preview', () => {
  assert.match(
    notebookGenerationEmptyResultMessage('I cannot help with that.'),
    /返回片段: I cannot help/
  )
})
