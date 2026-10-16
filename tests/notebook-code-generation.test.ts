import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildNotebookCodeGenerationRepairPrompt,
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

test('notebook AI generation parser accepts marimo data parts nested in assistant content', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    {
      role: 'assistant',
      content: [
        {
          type: 'data-notebook-cells-completion',
          data: {
            cells: [
              { language: 'markdown', code: '#### 配色更新' },
              { language: 'python', code: 'ax = inc_line.plot(color=["#1b9e77", "#d95f02"])' }
            ]
          }
        }
      ]
    },
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '#### 配色更新' },
    {
      cellType: 'code',
      source: 'ax = inc_line.plot(color=["#1b9e77", "#d95f02"])',
      language: 'python'
    }
  ])
})

test('notebook AI generation parser accepts provider text nested in delta objects', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    {
      type: 'message_delta',
      delta: {
        content: [
          {
            type: 'output_text',
            text: [
              '下面是替换后的 Cell 20 代码：',
              '',
              '```python',
              'colors = ["#1b9e77", "#d95f02"]',
              'ax = inc_line.plot(color=colors)',
              'ax',
              '```'
            ].join('\n')
          }
        ]
      }
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

test('notebook AI generation parser accepts structured data nested in provider delta objects', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    {
      type: 'message_delta',
      delta: {
        type: 'data-notebook-cells-completion',
        data: {
          cells: [
            { language: 'markdown', code: '#### 配色更新' },
            {
              language: 'python',
              code: 'ax = inc_line.plot(color=["#1b9e77", "#d95f02"])'
            }
          ]
        }
      }
    },
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '#### 配色更新' },
    {
      cellType: 'code',
      source: 'ax = inc_line.plot(color=["#1b9e77", "#d95f02"])',
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

test('notebook AI generation parser rejects standalone ellipsis placeholder lines', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    JSON.stringify({
      cells: [
        { language: 'python', code: '...\n\n...' },
        { language: 'python', code: '# Top 10 up/down at 48 h\n...' },
        { language: 'python', code: 'df.head()' }
      ]
    }),
    'python'
  )

  assert.deepEqual(cells, [{ cellType: 'code', source: 'df.head()', language: 'python' }])
})

test('notebook AI generation parser accepts embedded fenced JSON in a structured code cell', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    {
      cells: [
        {
          cellType: 'code',
          language: 'python',
          source: [
            "I'll use `['#004488', '#DDAA33']` as the new color pair.",
            '',
            'JSON output only, no markdown fences.',
            '',
            "Let's construct:",
            '',
            '```json',
            JSON.stringify({
              cells: [
                { language: 'markdown', code: '#### 配色更新' },
                {
                  language: 'python',
                  code: 'inc_line = inc.groupby(["Country", "Year"])["Income"].mean().unstack()'
                }
              ]
            }),
            '```',
            '',
            "This looks good. It's raw JSON, no fences."
          ].join('\n')
        }
      ]
    },
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '#### 配色更新' },
    {
      cellType: 'code',
      source: 'inc_line = inc.groupby(["Country", "Year"])["Income"].mean().unstack()',
      language: 'python'
    }
  ])
})

test('notebook AI generation parser splits a single fenced Python block in a structured code cell', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    {
      cells: [
        {
          cellType: 'code',
          language: 'python',
          source: ['```python', 'summary = df.describe()', 'summary', '```'].join('\n')
        }
      ]
    },
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'code', source: 'summary = df.describe()\nsummary', language: 'python' }
  ])
})

test('notebook AI generation parser accepts one clear fenced code block with surrounding prose', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    {
      cells: [
        {
          cellType: 'code',
          language: 'python',
          source: [
            'Here is the updated cell code:',
            '',
            '```python',
            'colors = ["#004488", "#DDAA33"]',
            'ax = inc_line.plot(color=colors)',
            '```',
            '',
            'This changes the chart palette.'
          ].join('\n')
        }
      ]
    },
    'python'
  )

  assert.deepEqual(cells, [
    {
      cellType: 'code',
      source: 'colors = ["#004488", "#DDAA33"]\nax = inc_line.plot(color=colors)',
      language: 'python'
    }
  ])
})

test('notebook AI generation parser rejects structured run transcripts around ordinary fences', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    {
      cells: [
        {
          cellType: 'code',
          language: 'python',
          source: [
            'I need to inspect the dataframe first.',
            '',
            '```python',
            'df.head()',
            '```',
            '',
            'Now I can construct the answer.'
          ].join('\n')
        }
      ]
    },
    'python'
  )

  assert.deepEqual(cells, [])
})

test('notebook AI generation parser accepts exact markdown and code fences as insertable cells', () => {
  const cells = parseGeneratedNotebookCells(
    [
      '```markdown',
      'Here is a quick summary cell.',
      '```',
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

test('notebook AI generation parser rejects non-schema markdown answers', () => {
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

  assert.deepEqual(cells, [])
})

test('notebook AI generation final parser accepts prose around a fenced NotebookCellsCompletion JSON block', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    [
      '可以，下面是可插入的 notebook cells:',
      '',
      '```json',
      JSON.stringify({
        cells: [
          { language: 'markdown', code: '#### 配色更新' },
          {
            language: 'python',
            code: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax'
          }
        ]
      }),
      '```'
    ].join('\n'),
    'python'
  )

  assert.deepEqual(cells, [
    { cellType: 'markdown', source: '#### 配色更新' },
    {
      cellType: 'code',
      source: 'colors = ["#1b9e77", "#d95f02"]\nax = inc_line.plot(color=colors)\nax',
      language: 'python'
    }
  ])
})

test('notebook AI generation final parser accepts prose around one fenced Python block', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    [
      '下面是替换后的 Cell 20 代码：',
      '',
      '```python',
      'colors = ["#1b9e77", "#d95f02"]',
      'ax = inc_line.plot(color=colors)',
      'ax',
      '```'
    ].join('\n'),
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

test('notebook AI generation final parser accepts raw Python code as a fallback', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    [
      'colors = ["#1b9e77", "#d95f02"]',
      'ax = inc_line.plot(color=colors)',
      'ax.set_title("Mean Income by Country and Century")',
      'ax'
    ].join('\n'),
    'python'
  )

  assert.deepEqual(cells, [
    {
      cellType: 'code',
      source: [
        'colors = ["#1b9e77", "#d95f02"]',
        'ax = inc_line.plot(color=colors)',
        'ax.set_title("Mean Income by Country and Century")',
        'ax'
      ].join('\n'),
      language: 'python'
    }
  ])
})

test('notebook AI generation final parser accepts raw R code as a fallback', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    [
      'colors <- c("#1b9e77", "#d95f02")',
      'plot(inc_line, col = colors)',
      'legend("topright", legend = colnames(inc_line), col = colors, lty = 1)'
    ].join('\n'),
    'r'
  )

  assert.deepEqual(cells, [
    {
      cellType: 'code',
      source: [
        'colors <- c("#1b9e77", "#d95f02")',
        'plot(inc_line, col = colors)',
        'legend("topright", legend = colnames(inc_line), col = colors, lty = 1)'
      ].join('\n'),
      language: 'r'
    }
  ])
})

test('notebook AI generation final parser rejects the diagnostic fragment from a failed tool', () => {
  for (const language of ['markdown', 'python']) {
    assert.deepEqual(parseFinalGeneratedNotebookCompletion('with exit code 1 and', language), [])
  }
})

test('notebook AI generation final parser keeps an explicitly typed markdown cell as markdown', () => {
  const sources = [
    'with different thresholds, each dataset keeps the relevant observations.',
    '## 为什么三个数据集的过滤参数不同\n\nQC_PARAMS 不是三套任意阈值，而是由 **矩阵含义** 决定哪些指标能当过滤器。GSE151530 / GSE189903 的 `X` 是 10x 原始 UMI counts；GSE229772 的 `X` 已是归一化表达。',
    'Inspect the following example:\n\n```python\nprint("example")\n```'
  ]
  for (const source of sources) {
    for (const cell of [
      { language: 'markdown', code: source },
      { cellType: 'markdown', source },
      { cell_type: 'markdown', source: [source] },
      { type: 'markdown', code: source }
    ]) {
      assert.deepEqual(parseFinalGeneratedNotebookCompletion({ cells: [cell] }, 'python'), [
        { cellType: 'markdown', source }
      ])
    }
  }
})

test('notebook AI generation final parser honors explicit cell languages under a markdown target', () => {
  const cells = [
    { language: 'markdown', code: '## Summary' },
    { language: 'python', code: 'print("example")' },
    { language: 'r', code: 'plot(values)' }
  ]
  for (const completion of [{ cells }, JSON.stringify({ cells })]) {
    assert.deepEqual(parseFinalGeneratedNotebookCompletion(completion, 'markdown'), [
      { cellType: 'markdown', source: '## Summary' },
      { cellType: 'code', source: 'print("example")', language: 'python' },
      { cellType: 'code', source: 'plot(values)', language: 'r' }
    ])
  }
})

test('notebook AI generation parsers do not unwrap reasoning or tool output as completion content', () => {
  const cells = [{ language: 'markdown', code: '## Only an internal example' }]
  for (const parse of [
    parseFinalGeneratedNotebookCompletion,
    parseGeneratedNotebookCompletionSnapshot
  ]) {
    for (const type of ['thinking', 'reasoning', 'tool_result', 'tool_call', 'error']) {
      assert.deepEqual(parse({ type, content: JSON.stringify({ cells }) }, 'python'), [])
      assert.deepEqual(
        parse(
          { type, data: { type: 'data-notebook-cells-completion', data: { cells } } },
          'python'
        ),
        []
      )
    }
    assert.deepEqual(parse({ role: 'tool', content: JSON.stringify({ cells }) }, 'python'), [])
  }
})

test('notebook AI generation raw fallback does not turn a markdown request into executable code', () => {
  assert.deepEqual(parseFinalGeneratedNotebookCompletion('print("example")', 'markdown'), [])
})

test('notebook AI generation raw Python fallback requires complete control-flow headers', () => {
  for (const source of [
    'if the command failed',
    'for a better result',
    'while the agent is working',
    'def the problem first',
    'class the samples separately'
  ]) {
    assert.deepEqual(parseFinalGeneratedNotebookCompletion(source, 'python'), [])
  }

  for (const source of [
    'with open("data.csv") as handle:\n    rows = handle.readlines()',
    'if value > 1:\n    print(value)',
    'for value in values:\n    print(value)',
    'def summarize(values):\n    return sum(values)',
    'class Summary:\n    count = 1'
  ]) {
    assert.deepEqual(parseFinalGeneratedNotebookCompletion(source, 'python'), [
      { cellType: 'code', source, language: 'python' }
    ])
  }
})

test('notebook AI generation raw fallback retains R control flow and SQL statements', () => {
  const examples = [
    { language: 'r', source: 'if (length(values) > 0) {\n  print(mean(values))\n}' },
    { language: 'sql', source: 'SELECT name, count(*) FROM samples GROUP BY name;' },
    {
      language: 'sql',
      source: 'WITH summary AS (SELECT name FROM samples)\nSELECT * FROM summary;'
    }
  ]
  for (const { language, source } of examples) {
    assert.deepEqual(parseFinalGeneratedNotebookCompletion(source, language), [
      { cellType: 'code', source, language }
    ])
  }
})

test('notebook AI generation final parser still rejects ordinary prose', () => {
  const cells = parseFinalGeneratedNotebookCompletion('这个图可以使用更高对比度的配色。', 'python')

  assert.deepEqual(cells, [])
})

test('notebook AI generation parser rejects plain prose instead of guessing a markdown cell', () => {
  const cells = parseGeneratedNotebookCells('这个数据集包含三列，可以先检查缺失值。', 'python')

  assert.deepEqual(cells, [])
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

test('notebook AI generation final parser rejects Chinese generation transcript text', () => {
  const cells = parseFinalGeneratedNotebookCompletion(
    {
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          text: [
            '最安全的是使用 matplotlib 的 `tab10` 中差异大的颜色。',
            '',
            '我提供一个 markdown 解释 + 修改后的 code cell。',
            '',
            '等等，实际上 Cell 20 有两条线，所以两条线需要区分明显。',
            '',
            '返回 JSON，包含两个 cells: markdown + python。'
          ].join('\n')
        }
      ]
    },
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

test('notebook AI generation repair prompt preserves the marimo completion contract', () => {
  const prompt = buildNotebookCodeGenerationRepairPrompt({
    language: 'python',
    notebookPath: 'notebooks/example.ipynb',
    insertionIndex: 20,
    references: [],
    userPrompt: '@cell-20 这个图片使用其他配色',
    nearbyContext: 'Cell 20 [code]\n```\nax.plot(color=["#0072B2", "#E69F00"])\n```',
    otherCellContext: '(none)',
    invalidOutput: [
      '最安全的是使用 matplotlib 的 tab10 中差异大的颜色。',
      '我提供一个 markdown 解释 + 修改后的 code cell。',
      '返回 JSON，包含两个 cells: markdown + python。'
    ].join('\n')
  })

  assert.match(prompt, /marimo NotebookCellsCompletion/)
  assert.match(prompt, /Return exactly one JSON object/)
  assert.match(prompt, /\{"cells":\[/)
  assert.match(prompt, /Invalid previous model output/)
  assert.match(prompt, /@cell-20 这个图片使用其他配色/)
  assert.match(prompt, /raw runnable python code/)
  assert.match(prompt, /Do not include prose outside JSON/)
})

test('notebook AI generation empty result message includes a diagnostic preview', () => {
  const message = notebookGenerationEmptyResultMessage('I cannot help with that.')

  assert.match(message, /AI 没有生成可插入内容/)
  assert.match(message, /返回片段: I cannot help/)
  assert.doesNotMatch(message, /Agent 没/)
})
