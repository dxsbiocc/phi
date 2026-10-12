import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Button } from '@mui/material'
import { createTheme, ThemeProvider } from '@mui/material/styles'

import type { LocalMcpConnectorRequest } from '../src/shared/mcpConnectorCatalog'
import { McpLocalConnectConfirmDialog } from '../src/renderer/src/features/mcp/components/McpLocalConnectConfirmDialog'

const hostRequest: LocalMcpConnectorRequest = {
  name: 'fixture',
  runtime: { kind: 'host' },
  command: '/usr/bin/true',
  args: ['--stdio'],
  env: {}
}

function descendants(node: ReactNode): ReactElement[] {
  if (Array.isArray(node)) return node.flatMap(descendants)
  if (!isValidElement(node)) return []
  return [node, ...descendants((node.props as { children?: ReactNode }).children)]
}

test('local connector confirmation shows exact launch details without environment values', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpLocalConnectConfirmDialog, {
        open: true,
        submitting: false,
        request: {
          name: 'literature',
          runtime: { kind: 'environment', ref: 'phi:python@1' },
          command: 'uvx',
          args: ['--from', 'value with spaces'],
          env: { LOG_LEVEL: 'secret-info', FEATURE_FLAG: 'secret-enabled' },
          cwd: '/tmp/literature'
        },
        runtimes: [{ ref: 'phi:python@1', label: 'Python 1' }],
        disablePortal: true,
        onCancel: () => undefined,
        onConfirm: () => undefined
      })
    )
  )

  assert.match(markup, /确认添加本地连接器/)
  assert.match(markup, /aria-labelledby="mcp-local-connect-confirm-title"/)
  assert.match(markup, /aria-describedby="mcp-local-connect-confirm-description"/)
  assert.match(markup, /运行位置/)
  assert.match(markup, /Python 1/)
  assert.match(markup, /argv\[0\] = &quot;uvx&quot;/)
  assert.match(markup, /argv\[2\] = &quot;value with spaces&quot;/)
  assert.match(markup, /LOG_LEVEL/)
  assert.match(markup, /FEATURE_FLAG/)
  assert.doesNotMatch(markup, /secret-info|secret-enabled/)
  assert.match(markup, /\/tmp\/literature/)
  assert.match(markup, /确认后将在后台启动并验证，界面不会被锁住；进度见后台任务。/)
  assert.match(markup, /首次运行需要下载依赖，可能需要几分钟。/)
})

test('local connector confirmation exposes cancel and one-shot confirm actions', () => {
  let cancels = 0
  let confirms = 0
  const tree = McpLocalConnectConfirmDialog({
    open: true,
    submitting: false,
    request: hostRequest,
    runtimes: [],
    onCancel: () => {
      cancels += 1
    },
    onConfirm: () => {
      confirms += 1
    }
  })
  const buttons = descendants(tree).filter((element) => element.type === Button)
  assert.equal(buttons.length, 2)

  for (const button of buttons) {
    ;(button.props as { onClick: () => void }).onClick()
  }
  assert.equal(cancels, 1)
  assert.equal(confirms, 1)
})

test('local connector confirmation disables both actions while submitting', () => {
  const markup = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpLocalConnectConfirmDialog, {
        open: true,
        submitting: true,
        request: hostRequest,
        runtimes: [],
        disablePortal: true,
        onCancel: () => undefined,
        onConfirm: () => undefined
      })
    )
  )
  assert.match(markup, /正在提交…/)
  assert.equal((markup.match(/disabled=""/g) ?? []).length, 2)
})

test('local connector confirmation repeats the host and Bun safety warnings', () => {
  const renderRequest = (request: LocalMcpConnectorRequest): string =>
    renderToStaticMarkup(
      createElement(
        ThemeProvider,
        { theme: createTheme() },
        createElement(McpLocalConnectConfirmDialog, {
          open: true,
          submitting: false,
          request,
          runtimes: [],
          disablePortal: true,
          onCancel: () => undefined,
          onConfirm: () => undefined
        })
      )
    )

  assert.match(renderRequest(hostRequest), /将直接在本机运行，不使用 Phi 隔离环境/)
  assert.match(
    renderRequest({
      ...hostRequest,
      runtime: { kind: 'bun' },
      command: 'x',
      args: ['--bun', 'fixture@1.0.0']
    }),
    /由 Phi 内置 Bun 以 Node 兼容模式运行；个别依赖可能不兼容。.*版本不锁定。/s
  )
})
