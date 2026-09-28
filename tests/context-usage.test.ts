import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material'
import { ContextUsageIndicator } from '../src/renderer/src/features/chat/components/ContextUsageIndicator'
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
  assert.match(known, /上下文窗口/)
  assert.match(known, /24K \/ 200K \(12%\)/)
  assert.match(known, /24K \/ 200K tokens/)
  assert.match(known, /data-phi-context-usage="available"/)
  assert.match(known, /aria-label="上下文容量使用率"/)
})

test('manual compaction action shows a disabled in-progress state', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ContextUsageIndicator, {
        usage: { tokens: 24000, contextWindow: 200000, percent: 12 },
        loading: false,
        compacting: true,
        onCompact: () => undefined
      })
    )
  )

  assert.match(markup, /data-phi-context-compact-action="true"/)
  assert.match(markup, /正在压缩/)
  assert.match(markup, /disabled=""/)
})
