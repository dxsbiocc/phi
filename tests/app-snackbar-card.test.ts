import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createTheme, ThemeProvider } from '@mui/material/styles'

import AppSnackbarCard, {
  type SnackbarSeverity
} from '../src/renderer/src/components/AppSnackbarCard'

function render(severity: SnackbarSeverity, message: string): string {
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(AppSnackbarCard, {
        notice: { id: 1, severity, message },
        onClose: () => undefined
      })
    )
  )
}

const LABELS: Record<SnackbarSeverity, string> = {
  success: '成功',
  error: '错误',
  warning: '警告',
  info: '提示'
}

for (const severity of Object.keys(LABELS) as SnackbarSeverity[]) {
  test(`${severity}: the message sits beside the icon with no separate title line`, () => {
    const markup = render(severity, '已安装并启用「anndata」')
    assert.ok(markup.includes('已安装并启用「anndata」'))
    // The severity is still announced, but not as visible text above the message.
    assert.ok(markup.includes(`aria-label="${LABELS[severity]}"`))
    assert.ok(!markup.includes(`>${LABELS[severity]}<`))
    assert.ok(markup.includes('aria-label="关闭通知"'))
  })
}

test('errors and warnings are announced as alerts, the rest as status', () => {
  assert.ok(render('error', 'x').includes('role="alert"'))
  assert.ok(render('warning', 'x').includes('role="alert"'))
  assert.ok(render('success', 'x').includes('role="status"'))
})

test('the card is compact', () => {
  const markup = render('success', 'x')
  const minHeight = /min-height:(\d+)px/.exec(markup)?.[1]
  assert.ok(minHeight && Number(minHeight) <= 48, `min-height was ${minHeight}`)
})
