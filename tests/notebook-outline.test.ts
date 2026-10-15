import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import NotebookScrollProgressRail from '../src/renderer/src/features/analysis/notebook/NotebookScrollProgressRail'
import {
  documentCells,
  notebookOutline
} from '../src/renderer/src/features/analysis/lib/notebookViewModel'
import { parseNotebook } from '../src/shared/notebookDocument'

function renderOutline(source: string): string {
  const document = parseNotebook({
    nbformat: 4,
    nbformat_minor: 5,
    metadata: {},
    cells: [{ id: 'headings', cell_type: 'markdown', metadata: {}, source }]
  })
  const outline = notebookOutline(documentCells(document))
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(NotebookScrollProgressRail, {
        outline,
        activeId: outline[0]?.id ?? null,
        onSelect: () => {}
      })
    )
  )
}

test('numbered outline headings keep literal numbering without list layout or extra indentation', () => {
  const markup = renderOutline(
    '# 按 GSE 编号合并单细胞数据并做质控\n## 1. 环境与路径\n## 7. 质控\n### 7.1 质控阈值（按图微调）\n## 8) 检查输出'
  )

  assert.equal(/<(?:ol|ul|li)(?:\s|>)/.test(markup), false, 'headings must not become lists')
  for (const title of ['1. 环境与路径', '7. 质控', '7.1 质控阈值（按图微调）', '8) 检查输出']) {
    assert.ok(markup.includes(`>${title}</span>`), `expected literal heading: ${title}`)
  }
  assert.equal(markup.match(/data-phi-notebook-outline-item="true"/g)?.length, 5)
})

test('outline titles keep inline Markdown without interpreting heading text as blocks', () => {
  const markup = renderOutline(
    '# **Summary**\n## 1. *环境*与 `path`\n### [7.1 质控](./qc.md)\n#### > 引用标题\n##### - 检查输出\n###### ![结果图](./plot.png)'
  )

  assert.equal(
    /<(?:ol|ul|li|blockquote|h[1-6]|p|a|img)(?:\s|>)/.test(markup),
    false,
    'heading content must stay inline'
  )
  assert.match(markup, /<strong>Summary<\/strong>/)
  assert.match(markup, /1\. <em>环境<\/em>与/)
  assert.match(markup, /<code[^>]*>path<\/code>/)
  assert.match(markup, /<span[^>]*>7\.1 质控<\/span>/)
  assert.match(markup, /&gt; 引用标题/)
  assert.match(markup, />- 检查输出<\/span>/)
  assert.match(markup, /<span[^>]*>结果图<\/span>/)
})
