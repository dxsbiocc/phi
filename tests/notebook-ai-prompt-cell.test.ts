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
