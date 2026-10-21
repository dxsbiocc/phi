import { componentTree } from './helpers/renderComponentTree'
import { setUiLanguage } from '../src/renderer/src/lib/i18n'
import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '@mui/material'
import { createTheme, ThemeProvider } from '@mui/material/styles'

import AppSnackbarCard, {
  AppSnackbarCardContent,
  type SnackbarSeverity
} from '../src/renderer/src/components/AppSnackbarCard'
import { snackbarAutoHideDuration } from '../src/renderer/src/lib/snackbarDuration'

test.beforeEach(() => setUiLanguage('zh-CN'))
test.afterEach(() => setUiLanguage('en'))

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

function descendants(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(descendants)
  if (!isValidElement(node)) return []
  return [node, ...descendants((node.props as { children?: ReactNode }).children)]
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

test('an action renders as an accessible text button and closes after firing', () => {
  const events: string[] = []
  const tree = componentTree(() =>
    AppSnackbarCardContent({
      notice: {
        id: 2,
        severity: 'info',
        message: '后台任务已开始',
        action: {
          label: '查看后台任务',
          onClick: () => events.push('action')
        }
      },
      onClose: () => events.push('close')
    })
  )
  const action = descendants(tree).find(
    (element) =>
      element.type === Button &&
      (element.props as { children?: ReactNode }).children === '查看后台任务'
  )
  assert.ok(action)
  ;(action.props as { onClick: () => void }).onClick()
  assert.deepEqual(events, ['close', 'action'])
})

test('warning and error notices use the requested durations', () => {
  assert.equal(
    snackbarAutoHideDuration({
      id: 1,
      severity: 'success',
      message: 'done',
      action: { label: '查看', onClick: () => undefined }
    }),
    2000
  )
  assert.equal(snackbarAutoHideDuration({ id: 2, severity: 'warning', message: 'check' }), 3000)
  assert.equal(snackbarAutoHideDuration({ id: 3, severity: 'error', message: 'failed' }), 3500)
  assert.equal(
    snackbarAutoHideDuration({
      id: 4,
      severity: 'info',
      message: 'running',
      persistent: true,
      action: { label: '查看', onClick: () => undefined }
    }),
    null
  )
})
