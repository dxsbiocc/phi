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
    modelOptions: [],
    selectedModel: null,
    isGenerating: false,
    canPickContextFiles: true,
    onSelect: () => {},
    onPromptChange: () => {},
    onLanguageChange: () => {},
    onModelChange: () => {},
    onReferenceAdd: () => {},
    onPickContextFiles: () => {},
    onSubmit: () => {},
    onAccept: () => {},
    onReject: () => {},
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

test('notebook AI leaves task navigation to the notebook toolbar in every generation state', () => {
  for (const state of [
    {},
    { isGenerating: true },
    { hasStagedCells: true },
    { error: '模型暂时不可用' }
  ]) {
    const markup = renderPromptCell(state)
    assert.doesNotMatch(markup, /data-phi-notebook-ai-view-job/)
    assert.doesNotMatch(markup, /查看任务/)
  }
})

test('the wide notebook AI prompt points to the top-right task entry before and during a request', () => {
  const idle = renderPromptCell()
  const running = renderPromptCell({ isGenerating: true })
  for (const markup of [idle, running]) {
    assert.ok(markup.includes('data-phi-notebook-ai-background-job-hint="true"'))
    assert.ok(markup.includes('右上角「后台任务」'))
  }
  assert.ok(running.includes('生成进度可在右上角「后台任务」查看。'))
})

test('the wide prompt retains language and model labels in single accessible selectors', () => {
  const markup = renderPromptCell({
    selectedModel: { providerId: 'openai', modelId: 'gpt-test', name: 'GPT Test' }
  })

  assert.match(markup, /data-phi-notebook-ai-prompt-shell="true"/)
  assert.match(markup, /data-phi-notebook-ai-compact-controls="false"/)
  assert.match(markup, /data-phi-notebook-ai-target-language-compact="false"/)
  assert.match(markup, /data-phi-notebook-ai-model-selector-compact="false"/)
  assert.match(markup, /aria-label="选择生成语言：Python"/)
  assert.match(markup, />Python</)
  assert.match(markup, />GPT Test</)
  assert.equal((markup.match(/aria-label="选择模型"/g) ?? []).length, 1)
})

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

test('the prompt cell exposes refactor mode for selected-cell AI edits', () => {
  const markup = renderPromptCell({
    mode: 'refactor',
    prompt: '让这个 cell 更清晰'
  })

  assert.match(markup, /data-phi-notebook-ai-mode="refactor"/)
  assert.match(markup, /placeholder="Refactor selected cell with AI, @ to include context"/)
})

test('the target-language button disables while a generation is in flight', () => {
  const markup = renderPromptCell({ isGenerating: true })

  const buttonMatch = markup.match(
    /<button[^>]*data-phi-notebook-ai-target-language="python"[^>]*>/
  )
  assert.ok(buttonMatch)
  assert.match(buttonMatch![0], /\bdisabled=""/)
})

test('the prompt cell keeps model status out of the lower text area', () => {
  const markup = renderPromptCell({
    prompt: '写一个贪心算法',
    isGenerating: true,
    modelOptions: [
      {
        providerId: 'openai',
        modelId: 'gpt-test',
        name: 'GPT Test',
        thinkingLevels: ['high']
      }
    ],
    selectedModel: {
      providerId: 'openai',
      modelId: 'gpt-test',
      name: 'GPT Test',
      thinkingLevels: ['high']
    }
  })

  assert.doesNotMatch(markup, /data-phi-notebook-ai-generation-status="true"/)
  assert.doesNotMatch(markup, /正在调用 Agent 生成代码/)
  assert.doesNotMatch(markup, /将使用此模型生成代码/)
  assert.doesNotMatch(markup, /思考 high/)
  assert.match(markup, /data-phi-notebook-ai-model-selector="true"/)
  assert.match(markup, /GPT Test/)
})

test('the prompt cell shows an inline spinner while generation is in flight', () => {
  const markup = renderPromptCell({ prompt: '写一个贪心算法', isGenerating: true })

  assert.match(markup, /data-phi-notebook-ai-generation-spinner="true"/)
  assert.match(markup, /aria-label="正在生成代码"/)
})

test('the prompt cell exposes a model selection button', () => {
  const markup = renderPromptCell({
    prompt: '写一个贪心算法',
    modelOptions: [
      {
        providerId: 'openai',
        modelId: 'gpt-test',
        name: 'GPT Test',
        thinkingLevels: ['high']
      }
    ],
    selectedModel: {
      providerId: 'openai',
      modelId: 'gpt-test',
      name: 'GPT Test',
      thinkingLevels: ['high']
    }
  })

  assert.match(markup, /data-phi-notebook-ai-model-selector="true"/)
  assert.match(markup, /aria-label="选择模型"/)
  assert.match(markup, /GPT Test/)
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

test('the prompt cell does not render generated preview cells inside itself', () => {
  const markup = renderPromptCell({ prompt: '写一个贪心算法' })

  assert.doesNotMatch(markup, /data-phi-notebook-ai-staged-actions/)
  assert.doesNotMatch(markup, /data-phi-notebook-ai-staged-accept/)
  assert.doesNotMatch(markup, /data-phi-notebook-ai-staged-reject/)
  assert.doesNotMatch(markup, /data-phi-notebook-ai-preview-cells/)
  assert.doesNotMatch(markup, /data-phi-notebook-cell-provisional/)

  const submitButton = markup.match(/<button[^>]*aria-label="提交 AI 生成"[^>]*>/)
  assert.ok(submitButton)
  assert.doesNotMatch(submitButton![0], /\bdisabled\b/)
})

test('the prompt cell can still accept or reject a preview by keyboard state', () => {
  const markup = renderPromptCell({
    prompt: '画各国收入折线图',
    hasStagedCells: true
  })

  assert.match(markup, /重新生成预览/)
  assert.doesNotMatch(markup, /data-phi-notebook-ai-preview-accept/)
  assert.doesNotMatch(markup, /data-phi-notebook-ai-preview-reject/)
})

test('the prompt cell renders AI failures like chat provider errors', () => {
  const markup = renderPromptCell({
    prompt: '写一个贪心算法',
    error: 'AI 没有生成可插入内容，请换一种更具体的描述后重试。',
    errorDetail:
      'AI 没有生成可插入内容。返回片段: 未收到模型返回文本或 data-notebook-cells-completion 结构化结果。'
  })

  assert.match(markup, /data-phi-notebook-ai-error-output="true"/)
  assert.match(markup, /data-phi-notebook-ai-error-alert="true"/)
  assert.match(markup, /data-phi-notebook-ai-error-summary="true"/)
  assert.match(markup, /data-phi-notebook-ai-error-description="true"/)
  assert.doesNotMatch(markup, /data-phi-notebook-output-pre="true"/)
  assert.doesNotMatch(markup, /data-phi-notebook-output-kind="error"/)
  assert.doesNotMatch(markup, /data-phi-notebook-output-copy="true"/)
  assert.match(markup, /data-notebook-cells-completion/)
  assert.doesNotMatch(markup, /Error invoking remote method/)
  assert.doesNotMatch(markup, /analysis:generateNotebookCode/)
  assert.doesNotMatch(markup, /Agent 没/)
})

test('the prompt cell does not repeat equivalent AI failure text', () => {
  const markup = renderPromptCell({
    prompt: '写一个贪心算法',
    error: 'AI 没有生成可插入内容，请换一种更具体的描述后重试。',
    errorDetail: 'AI 没有生成可插入内容，请换一种更具体的描述后重试。'
  })

  assert.match(markup, /data-phi-notebook-ai-error-output="true"/)
  assert.match(markup, /data-phi-notebook-ai-error-alert="true"/)
  assert.doesNotMatch(markup, /data-phi-notebook-ai-error-summary="true"/)
})

test('the prompt cell maps provider billing errors to the chat-style alert title', () => {
  const markup = renderPromptCell({
    prompt: '写一个贪心算法',
    error: '402 Insufficient Balance',
    errorDetail:
      '402 Insufficient Balance\nInsufficient Balance (type=unknown_error param=invalid_request_error)'
  })

  assert.match(markup, /data-phi-notebook-ai-error-alert="true"/)
  assert.match(markup, /账户余额不足/)
  assert.doesNotMatch(markup, /data-phi-notebook-output-kind="error"/)
})
