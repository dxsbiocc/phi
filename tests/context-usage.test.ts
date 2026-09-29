import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { ContextUsageIndicator } from '../src/renderer/src/features/chat/components/ContextUsageIndicator'
import { ContextUsageBreakdownPanel } from '../src/renderer/src/features/chat/components/ContextUsageBreakdownPanel'
import { contextUsageCategories } from '../src/renderer/src/features/chat/lib/contextUsageBreakdown'
import { contextUsagePresentation } from '../src/renderer/src/features/chat/lib/contextUsagePresentation'

test('context usage displays the active model capacity without guessing when unavailable', () => {
  assert.deepEqual(contextUsagePresentation(null, false), {
    label: '上下文暂不可用',
    detail: '当前会话或模型尚未提供上下文容量',
    progress: null
  })
  assert.deepEqual(
    contextUsagePresentation({ tokens: 24000, contextWindow: 200000, percent: 12 }, false),
    {
      label: '24K / 200K (12%)',
      detail: '已用 24K / 200K tokens',
      progress: 12
    }
  )
  assert.equal(
    contextUsagePresentation({ tokens: 120000, contextWindow: 100000, percent: 120 }, false)
      .progress,
    100
  )
})

test('composer indicator has an accessible percentage and unavailable state', () => {
  const render = (usage: Parameters<typeof ContextUsageIndicator>[0]['usage']): string =>
    renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(ContextUsageIndicator, { usage, loading: false })
      )
    )

  assert.match(render(null), /上下文暂不可用/)
  const known = render({ tokens: 24000, contextWindow: 200000, percent: 12 })
  assert.match(known, /24K \/ 200K \(12%\)/)
  assert.match(known, /data-phi-context-usage="available"/)
  assert.match(known, /aria-label="上下文用量：24K \/ 200K \(12%\)，点击查看详情"/)
  assert.match(known, /aria-haspopup="dialog"/)
  assert.match(known, /aria-valuenow="12"/)
  assert.doesNotMatch(known, /LinearProgress|压缩上下文|FiPieChart/)
})

test('context breakdown highlights the largest category and draws proportional segments', () => {
  const usage = {
    tokens: 10000,
    contextWindow: 20000,
    percent: 50,
    categories: [
      { id: 'systemPrompt' as const, tokens: 500 },
      { id: 'toolDefinitions' as const, tokens: 1500 },
      { id: 'systemContext' as const, tokens: 1000 },
      { id: 'skills' as const, tokens: 2000 },
      { id: 'conversation' as const, tokens: 5000 }
    ]
  }
  assert.deepEqual(
    contextUsageCategories(usage).map((category) => category.id),
    ['conversation', 'skills', 'toolDefinitions', 'systemContext', 'systemPrompt']
  )

  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ContextUsageBreakdownPanel, { usage, loading: false })
    )
  )
  assert.match(markup, /50% 已使用/)
  assert.match(markup, /10K \/ 20K tokens/)
  assert.match(markup, /data-phi-context-segment="conversation"/)
  assert.match(markup, /data-phi-context-category="conversation"[\s\S]*对话 · 最多/)
  assert.match(markup, /5K · 25\.0%/)
  assert.match(markup, /未使用容量/)
  assert.match(markup, /title="未使用容量包含自动压缩预留"/)
  assert.ok(
    markup.indexOf('data-phi-context-category="conversation"') <
      markup.indexOf('data-phi-context-category="skills"')
  )
})

test('MCP breakdown distinguishes current window occupancy from deferred schema cost', () => {
  const usage = {
    tokens: 10000,
    contextWindow: 20000,
    percent: 50,
    deferredMcpTokens: 8000,
    categories: [
      { id: 'systemPrompt' as const, tokens: 500 },
      { id: 'systemTools' as const, tokens: 1200 },
      { id: 'mcpTools' as const, tokens: 300 },
      { id: 'systemContext' as const, tokens: 1000 },
      { id: 'skills' as const, tokens: 2000 },
      { id: 'conversation' as const, tokens: 5000 }
    ]
  }
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ContextUsageBreakdownPanel, { usage, loading: false })
    )
  )
  assert.match(markup, /data-phi-context-category="mcpTools"[\s\S]*MCP 工具/)
  assert.match(markup, /300 · 1\.5%/)
  assert.match(markup, /data-phi-context-deferred-mcp="true"[\s\S]*8K · —/)
  assert.match(markup, /title="完整 schema 的潜在开销，不计入当前用量；目录提示可能计入系统上下文"/)
  assert.doesNotMatch(markup, /未注入 MCP 是完整 schema 的潜在开销/)
})

test('context breakdown names unavailable category data without guessing values', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ContextUsageBreakdownPanel, {
        usage: { tokens: 10000, contextWindow: 20000, percent: 50 },
        loading: false
      })
    )
  )
  assert.match(markup, /分类数据暂不可用/)
  assert.doesNotMatch(markup, /data-phi-context-category=/)
})

test('context breakdown offers a close action for the clicked popover', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ContextUsageBreakdownPanel, {
        usage: null,
        loading: false,
        onClose: () => undefined
      })
    )
  )
  assert.match(markup, /aria-label="关闭上下文详情"/)
})
