import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildNotebookCodeGenerationPrompt,
  notebookCellPromptContext,
  notebookContextReferencePrompt,
  notebookGenerationEmptyResultMessage,
  parseFinalGeneratedNotebookCompletion,
  parseGeneratedNotebookCells,
  parseGeneratedNotebookCompletion,
  parseGeneratedNotebookCompletionSnapshot
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

test('notebook AI generation parser accepts ipynb-style source arrays', () => {
  const cells = parseGeneratedNotebookCells(
    JSON.stringify({
      cells: [
        {
          cell_type: 'code',
          source: ['def greedy(items):\n', '    return sorted(items)\n'],
          language: 'python'
        }
      ]
    }),
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'code', source: 'def greedy(items):\n    return sorted(items)', language: 'python' }
  ])
})

test('notebook AI generation parser accepts fenced NotebookCellsCompletion JSON', () => {
  const cells = parseGeneratedNotebookCells(
    [
      '```json',
      JSON.stringify({
        cells: [
          { language: 'markdown', code: '## Plan' },
          { language: 'python', code: 'result = df.describe()' }
        ]
      }),
      '```'
    ].join('\n'),
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '## Plan' },
    { cellType: 'code', source: 'result = df.describe()', language: 'python' }
  ])
})

test('notebook AI generation parser accepts marimo notebook completion data parts', () => {
  const cells = parseGeneratedNotebookCompletion(
    {
      type: 'data-notebook-cells-completion',
      data: {
        cells: [
          { language: 'markdown', code: '## Plan' },
          { language: 'python', code: 'def greedy(items):\n    return sorted(items)' }
        ]
      }
    },
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '## Plan' },
    {
      cellType: 'code',
      source: 'def greedy(items):\n    return sorted(items)',
      language: 'python'
    }
  ])
})

test('notebook AI generation parser accepts marimo single-cell completion data parts', () => {
  const cells = parseGeneratedNotebookCompletion(
    {
      type: 'data-cell-completion',
      data: {
        code: 'def greedy(items):\n    return sorted(items)'
      }
    },
    'python'
  )

  assert.deepEqual(cells, [
    {
      cellType: 'code',
      source: 'def greedy(items):\n    return sorted(items)',
      language: 'python'
    }
  ])
})

test('notebook AI generation snapshot parser rejects ordinary assistant prose', () => {
  const cells = parseGeneratedNotebookCompletionSnapshot(
    {
      role: 'assistant',
      content: [
        {
          type: 'text',
          text: 'Here is a notebook cell:\nprint("hello")'
        }
      ]
    },
    'python'
  )

  assert.deepEqual(cells, [])
})

test('notebook AI generation snapshot parser stages complete cells from partial JSON', () => {
  const cells = parseGeneratedNotebookCompletionSnapshot(
    [
      '{"cells":[',
      '{"language":"markdown","code":"## Summary"},',
      '{"language":"python","code":"result = df.describe()"'
    ].join(''),
    'python'
  )

  assert.deepEqual(cells, [{ cellType: 'markdown', source: '## Summary' }])
})

test('notebook AI generation final parser rejects partial JSON snapshots', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    [
      '{"cells":[',
      '{"language":"markdown","code":"## Summary"},',
      '{"language":"python","code":"result = df.describe()"'
    ].join(''),
    'python'
  )

  assert.deepEqual(cells, [])
})

test('notebook AI generation parser rejects unfinished markdown heading cells', () => {
  assert.deepEqual(
    parseGeneratedNotebookCompletionSnapshot(
      '{"cells":[{"language":"markdown","code":"##"}]}',
      'python'
    ),
    []
  )
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

test('notebook AI generation parser turns a complete markdown answer into markdown and code cells', () => {
  const cells = parseGeneratedNotebookCells(
    [
      '## Greedy algorithm',
      '',
      'A greedy algorithm repeatedly makes the locally best choice.',
      '',
      '```python',
      'def greedy_select(items):',
      '    return sorted(items)',
      '```',
      '',
      'Run it on a small input:',
      '',
      '```python',
      'greedy_select([3, 1, 2])',
      '```'
    ].join('\n'),
    'python'
  )

  assert.deepEqual(cells, [
    {
      cellType: 'markdown',
      source: '## Greedy algorithm\n\nA greedy algorithm repeatedly makes the locally best choice.'
    },
    {
      cellType: 'code',
      source: 'def greedy_select(items):\n    return sorted(items)',
      language: 'python'
    },
    { cellType: 'markdown', source: 'Run it on a small input:' },
    { cellType: 'code', source: 'greedy_select([3, 1, 2])', language: 'python' }
  ])
})

test('notebook AI generation parser treats plain prose as markdown instead of Python code', () => {
  const cells = parseGeneratedNotebookCells('这个数据集包含三列，可以先检查缺失值。', 'python')

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '这个数据集包含三列，可以先检查缺失值。' }
  ])
})

test('notebook AI generation parser rejects schema-planning prose instead of inserting code', () => {
  const cells = parseGeneratedNotebookCells(
    [
      '用户要求写一个贪婪算法，并且要返回符合 marimo 的 NotebookCellsCompletion schema 的 JSON 对象。',
      '',
      '我应该：',
      '1. 提供一个 markdown 单元格解释贪婪算法',
      '2. 提供一个 Python 单元格实现贪婪算法',
      '',
      '规则要求：',
      '- 返回 JSON: {"cells":[{"language":"...","code":"..."},...]}',
      '- 不要对话式回答'
    ].join('\n'),
    'python'
  )

  assert.deepEqual(cells, [])
})

test('notebook AI generation parser rejects malformed NotebookCellsCompletion JSON instead of inserting it as code', () => {
  const cells = parseGeneratedNotebookCells(
    '{"cells":[{"language":"markdown","code":"# Plan"',
    'python'
  )

  assert.deepEqual(cells, [])
})

test('notebook AI generation parser rejects truncated JSON fences instead of inserting them as code', () => {
  assert.deepEqual(parseGeneratedNotebookCells('```json', 'python'), [])
  assert.deepEqual(
    parseGeneratedNotebookCells(
      '```json\n{"cells":[{"language":"markdown","code":"# Plan"',
      'python'
    ),
    []
  )
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
  assert.match(prompt, /NotebookCellsCompletion pattern/)
  assert.match(prompt, /Return exactly one JSON object/)
  assert.match(prompt, /\{"cells":\[/)
  assert.match(prompt, /Do not wrap the JSON in markdown fences/)
  assert.match(prompt, /Do not include prose outside JSON/)
  assert.match(prompt, /prefer multiple cells: a short markdown cell/)
  assert.match(
    prompt,
    /Do not collapse markdown explanation and executable code into one code cell/
  )
  assert.match(prompt, /df = pd\.read_csv/)
  assert.match(prompt, /@df 总结一下这个数据/)
})

test('notebook AI generation empty result message includes a diagnostic preview', () => {
  const message = notebookGenerationEmptyResultMessage('I cannot help with that.')

  assert.match(message, /AI 没有生成可插入内容/)
  assert.match(message, /返回片段: I cannot help/)
  assert.doesNotMatch(message, /Agent 没/)
})
