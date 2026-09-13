import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import NotebookAiPromptCell, {
  type NotebookAiPromptCellProps
} from '../src/renderer/src/features/analysis/notebook/NotebookAiPromptCell'

function renderPromptCell(overrides: Partial<NotebookAiPromptCellProps> = {}): string {
  const props: NotebookAiPromptCellProps = {
    language: 'python',
    codeLanguage: 'python',
    prompt: '',
    references: [],
    contextOptions: [],
    isGenerating: false,
    canPickContextFiles: true,
    onSelect: () => {},
    onPromptChange: () => {},
    onLanguageChange: () => {},
    onReferenceAdd: () => {},
    onPickContextFiles: () => {},
    onSubmit: () => {},
    onCancel: () => {},
    onDragStart: () => {},
    ...overrides
  }
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(NotebookAiPromptCell, props)
    )
  )
}

test('the target-language button is a real, clickable control (not a disabled stub)', () => {
  const markup = renderPromptCell()

  assert.match(markup, /aria-label="@ 引用上下文"/)
  const buttonMatch = markup.match(
    /<button[^>]*data-phi-notebook-ai-target-language="python"[^>]*>/
  )
  assert.ok(buttonMatch, 'expected the target-language button to render')
  assert.doesNotMatch(buttonMatch![0], /\bdisabled\b/)
})

test('the target-language button shows Markdown once that target is selected', () => {
  const markup = renderPromptCell({ language: 'markdown', codeLanguage: 'python' })

  assert.match(markup, /data-phi-notebook-ai-target-language="markdown"/)
  assert.match(markup, />Markdown</)
})

test('the target-language button disables while a generation is in flight', () => {
  const markup = renderPromptCell({ isGenerating: true })

  const buttonMatch = markup.match(
    /<button[^>]*data-phi-notebook-ai-target-language="python"[^>]*>/
  )
  assert.ok(buttonMatch)
  assert.match(buttonMatch![0], /\bdisabled=""/)
})

test('the attach-file button is enabled once a file picker handler is available', () => {
  const markup = renderPromptCell({ canPickContextFiles: true })

  const buttonMatch = markup.match(/<button[^>]*aria-label="附加文件"[^>]*>/)
  assert.ok(buttonMatch, 'expected the attach-file button to render')
  assert.doesNotMatch(buttonMatch![0], /\bdisabled\b/)
})

test('the attach-file button stays disabled when no file picker is wired up', () => {
  const markup = renderPromptCell({ canPickContextFiles: false })

  const buttonMatch = markup.match(/<button[^>]*aria-label="附加文件"[^>]*>/)
  assert.ok(buttonMatch)
  assert.match(buttonMatch![0], /\bdisabled=""/)
})

test('the prompt cell stages generated cells inline until the user confirms insertion', () => {
  const markup = renderPromptCell({
    prompt: '写一个贪心算法',
    pendingGeneratedCells: [
      { cellType: 'markdown', source: '# Greedy idea' },
      {
        cellType: 'code',
        source: 'def greedy(items):\n    return sorted(items)',
        language: 'python'
      }
    ],
    confirmationMessage: '确认将 AI 生成内容插入 notebook？\n\n将插入 2 个 cell。'
  })

  assert.match(markup, /data-phi-notebook-ai-staged-insertion="true"/)
  assert.match(markup, /data-phi-notebook-ai-staged-message="true"/)
  assert.match(markup, /确认将 AI 生成内容插入 notebook/)
  assert.match(markup, /data-phi-notebook-ai-staged-cell="markdown"/)
  assert.match(markup, /data-phi-notebook-ai-staged-cell="code"/)
  assert.match(markup, /def greedy/)
  assert.match(markup, />取消</)
  assert.match(markup, />插入并保存</)

  const submitButton = markup.match(/<button[^>]*aria-label="提交 AI 生成"[^>]*>/)
  assert.ok(submitButton)
  assert.match(submitButton![0], /\bdisabled=""/)
})

test('the prompt cell renders AI failures as notebook-style output', () => {
  const markup = renderPromptCell({
    prompt: '写一个贪心算法',
    error: 'AI 没有生成可插入内容，请换一种更具体的描述后重试。',
    errorDetail:
      'AI 没有生成可插入内容。返回片段: 未收到模型返回文本或 data-notebook-cells-completion 结构化结果。'
  })

  assert.match(markup, /data-phi-notebook-ai-error-output="true"/)
  assert.match(markup, /data-phi-notebook-ai-error-summary="true"/)
  assert.match(markup, /data-phi-notebook-output-pre="true"/)
  assert.match(markup, /data-phi-notebook-output-kind="error"/)
  assert.match(markup, /data-phi-notebook-output-copy="true"/)
  assert.match(markup, /data-notebook-cells-completion/)
  assert.doesNotMatch(markup, /Error invoking remote method/)
  assert.doesNotMatch(markup, /analysis:generateNotebookCode/)
  assert.doesNotMatch(markup, /Agent 没/)
})
