import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import { analysisCopy } from '../src/renderer/src/features/analysis/lib/analysisUiCopy'
import AnalysisView from '../src/renderer/src/features/analysis/AnalysisView'
import FilePreviewPanel from '../src/renderer/src/features/file-preview/FilePreviewPanel'
import MarkdownContent from '../src/renderer/src/components/MarkdownContent'
import NotebookPreOutput from '../src/renderer/src/features/analysis/notebook/NotebookPreOutput'
import {
  kernelAvailabilityColor,
  kernelAvailabilityLabel,
  notebookSessionStateLabel
} from '../src/renderer/src/features/analysis/lib/notebookViewModel'
import {
  notebookAiEmptyGenerationMessage,
  notebookAiPromptError
} from '../src/renderer/src/features/analysis/lib/notebookAiErrors'

const render = (element: React.ReactElement): string =>
  renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, element))

afterEach(() => setUiLanguage('en'))

test('Jupyter start prompt uses the selected language and names the remote execution boundary', () => {
  setUiLanguage('en')
  assert.equal(analysisCopy.startJupyterForCellAction, 'Start Jupyter')
  assert.match(analysisCopy.startJupyterForCellRemoteNote, /server.*local fallback/u)
  setUiLanguage('zh-CN')
  assert.equal(analysisCopy.startJupyterForCellAction, '启动 Jupyter')
  assert.match(analysisCopy.startJupyterForCellRemoteNote, /服务器.*不会回退到本机/u)
})

test('analysis controls follow both interface languages without changing notebook identity', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    const markup = render(createElement(AnalysisView))
    assert.ok(markup.includes(language === 'en' ? 'No notebook selected' : '尚未选择 notebook'))
    assert.ok(markup.includes(language === 'en' ? 'Resize analysis sidebar' : '调整分析侧栏宽度'))
    assert.ok(markup.includes(language === 'en' ? 'Generate code with AI' : 'AI 生成代码'))
    assert.match(markup, /data-phi-notebook-insert-action="code"/)
  }
})

test('file preview and Markdown controls translate while preserving user content and paths', () => {
  const content = 'const 中文变量 = "User content"'
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    const markup = render(
      createElement(FilePreviewPanel, {
        state: {
          status: 'ready',
          file: {
            path: '/project/中文.ts',
            name: '中文.ts',
            displayPath: '中文.ts',
            rootPath: '/project',
            rootLabel: 'project',
            kind: 'text',
            mimeType: 'text/plain',
            content,
            bytes: 42,
            previewBytes: 42,
            truncated: false
          }
        },
        onOpenFile: () => undefined,
        onOpenDefaultPath: () => undefined,
        onRevealPath: () => undefined,
        onListDirectory: async () => ({
          path: '/project',
          name: 'project',
          displayPath: 'project',
          rootPath: '/project',
          rootLabel: 'project',
          entries: [],
          truncated: false
        })
      })
    )
    assert.ok(
      markup.includes(language === 'en' ? 'aria-label="File preview"' : 'aria-label="文件预览"')
    )
    assert.match(markup, /中文\.ts/)
    assert.match(markup, /中文变量/)
    assert.match(markup, /User content/)
    const markdown = render(createElement(MarkdownContent, { text: '```\n用户代码\n```' }))
    assert.ok(markdown.includes(language === 'en' ? '>Copy<' : '>复制<'))
    assert.match(markdown, /用户代码/)
  }
})

test('folded notebook output and known failure summaries resolve language on each read', () => {
  const output = Array.from({ length: 200 }, (_, i) => `用户输出 ${i}`).join('\n')
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    const markup = render(createElement(NotebookPreOutput, { kind: 'text/plain', text: output }))
    assert.ok(
      markup.includes(language === 'en' ? 'Output folded: 200 lines' : '输出已折叠：200 行')
    )
    assert.match(markup, /用户输出 0/)
    assert.equal(
      notebookAiPromptError(new Error('AI 没有生成可插入内容')).message,
      notebookAiEmptyGenerationMessage()
    )
    assert.ok(
      notebookAiEmptyGenerationMessage().includes(
        language === 'en' ? 'AI did not generate' : 'AI 没有生成'
      )
    )
    assert.equal(
      notebookAiPromptError(new Error('external diagnostic 123')).detail,
      'external diagnostic 123'
    )
  }
})

test('localized kernel labels retain their status colors', () => {
  for (const language of ['en', 'zh-CN'] as const) {
    setUiLanguage(language)
    const failed = kernelAvailabilityLabel(null, null, false, 'external diagnostic')
    assert.equal(kernelAvailabilityColor(failed), 'error')
    assert.equal(
      kernelAvailabilityColor('Python 3 · ' + (language === 'en' ? 'not started' : '未启动')),
      'primary'
    )
    assert.equal(
      notebookSessionStateLabel(null),
      language === 'en' ? 'Kernel disconnected' : 'Kernel 已断开'
    )
  }
})
