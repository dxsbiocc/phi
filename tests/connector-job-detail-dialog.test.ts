import assert from 'node:assert/strict'
import { Children, createElement, isValidElement, type ReactElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'

import type { McpConnectorSetupProgress } from '../src/shared/mcpConnectorCatalog'
import {
  ConnectorJobDetailContent,
  ConnectorJobDetailDialog
} from '../src/renderer/src/features/jobs/components/ConnectorJobDetailDialog'
import {
  buildConnectorJobDetailText,
  connectorJobStartedAtLabel,
  connectorJobToolsLabel
} from '../src/renderer/src/features/jobs/lib/connectorJobDetails'

function setup(overrides: Partial<McpConnectorSetupProgress> = {}): McpConnectorSetupProgress {
  return {
    id: 'mail',
    kind: 'local-stdio',
    title: 'QQ 邮箱',
    summary: 'bun x --bun qq-email-mcp@0.1.1\n--stdio',
    startedAt: '2026-10-11T08:00:00.000Z',
    phase: 'failed',
    revision: 2,
    updatedAt: '2026-10-11T08:01:05.000Z',
    error: 'MCP subprocess closed stdout before responding',
    detail: 'Config not found, run init first',
    ...overrides
  }
}

function findElement(
  node: ReactNode,
  predicate: (element: ReactElement) => boolean
): ReactElement | undefined {
  if (!isValidElement(node)) return undefined
  if (predicate(node)) return node
  for (const child of Children.toArray((node.props as { children?: ReactNode }).children)) {
    const found = findElement(child, predicate)
    if (found) return found
  }
  return undefined
}

test('connector job detail dialog renders complete failure fields and copy payload', () => {
  const failed = setup()
  const content = ConnectorJobDetailContent({
    setup: failed,
    nowMs: Date.parse('2026-10-11T08:02:00.000Z'),
    copied: false,
    onCopy: () => undefined,
    onClose: () => undefined,
    onRetry: () => undefined
  })
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, content)
  )
  assert.equal(typeof ConnectorJobDetailDialog, 'function')
  assert.match(markup, /连接器详情/)
  assert.match(markup, /QQ 邮箱/)
  assert.match(markup, /失败/)
  assert.match(markup, /bun x --bun qq-email-mcp@0\.1\.1/)
  assert.match(markup, /--stdio/)
  assert.match(markup, /MCP subprocess closed stdout before responding/)
  assert.match(markup, /Config not found, run init first/)
  assert.match(markup, /01:05/)

  const payload = buildConnectorJobDetailText(failed, Date.parse('2026-10-11T08:02:00.000Z'))
  assert.match(payload, /^连接器名称：QQ 邮箱/m)
  assert.match(payload, /^状态：失败/m)
  assert.match(payload, /命令：\nbun x --bun qq-email-mcp@0\.1\.1\n--stdio/)
  assert.match(payload, /^耗时：01:05/m)
  assert.match(payload, /错误：\nMCP subprocess closed stdout before responding/)
  assert.match(payload, /进程输出：\nConfig not found, run init first/)

  const dialogShell = renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(ConnectorJobDetailDialog, {
        open: true,
        setup: failed,
        onClose: () => undefined,
        onRetry: () => undefined,
        nowMs: Date.parse('2026-10-11T08:02:00.000Z')
      })
    )
  )
  assert.match(dialogShell, /MuiDialog-root/)
})

test('connector detail shows empty output, successful tools, and retry only for failures', () => {
  const ready = setup({
    phase: 'ready',
    error: undefined,
    detail: undefined,
    toolNames: ['send_mail', 'list_mail']
  })
  const readyContent = ConnectorJobDetailContent({
    setup: ready,
    nowMs: Date.parse('2026-10-11T08:02:00.000Z'),
    copied: false,
    onCopy: () => undefined,
    onClose: () => undefined,
    onRetry: () => undefined
  })
  const readyMarkup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, readyContent)
  )
  assert.match(readyMarkup, /已完成/)
  assert.match(readyMarkup, /没有进程输出/)
  assert.match(readyMarkup, /send_mail、list_mail/)
  assert.ok(
    findElement(
      readyContent,
      (element) => (element.props as { children?: ReactNode }).children === '复制详情'
    )
  )
  assert.equal(
    findElement(
      readyContent,
      (element) => (element.props as { children?: ReactNode }).children === '重试'
    ),
    undefined
  )

  const failedContent = ConnectorJobDetailContent({
    setup: setup(),
    nowMs: Date.parse('2026-10-11T08:02:00.000Z'),
    copied: true,
    onCopy: () => undefined,
    onClose: () => undefined,
    onRetry: () => undefined
  })
  for (const label of ['已复制', '重试', '关闭']) {
    assert.ok(
      findElement(
        failedContent,
        (element) => (element.props as { children?: ReactNode }).children === label
      )
    )
  }
  assert.equal(connectorJobStartedAtLabel(setup({ startedAt: undefined })), '未知')
  assert.equal(connectorJobToolsLabel(ready), 'send_mail、list_mail')
  assert.equal(connectorJobToolsLabel({ ...ready, toolNames: [] }), '没有发现工具')
  assert.match(
    buildConnectorJobDetailText(
      { ...ready, startedAt: undefined, summary: undefined, error: undefined, detail: undefined },
      Date.parse('2026-10-11T08:02:00.000Z')
    ),
    /开始时间：未知[\s\S]*错误：\n没有错误[\s\S]*进程输出：\n没有进程输出/
  )
})
