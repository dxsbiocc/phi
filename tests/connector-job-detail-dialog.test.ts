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
import { ConnectorJobSetupGuide } from '../src/renderer/src/features/jobs/components/ConnectorJobSetupGuide'
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

function inspectTree<T>(build: () => T): T {
  let result!: T
  renderToStaticMarkup(
    createElement(function InspectTree() {
      result = build()
      return null
    })
  )
  return result
}

test('connector job detail dialog renders complete failure fields and copy payload', () => {
  const failed = setup()
  const content = inspectTree(() =>
    ConnectorJobDetailContent({
      setup: failed,
      nowMs: Date.parse('2026-10-11T08:02:00.000Z'),
      copied: false,
      onCopy: () => undefined,
      onClose: () => undefined,
      onRetry: () => undefined
    })
  )
  const markup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, content)
  )
  assert.equal(typeof ConnectorJobDetailDialog, 'function')
  assert.match(markup, /Connector Details/)
  assert.match(markup, /QQ 邮箱/)
  assert.match(markup, /Failed/)
  assert.match(markup, /bun x --bun qq-email-mcp@0\.1\.1/)
  assert.match(markup, /--stdio/)
  assert.match(markup, /MCP subprocess closed stdout before responding/)
  assert.match(markup, /Config not found, run init first/)
  assert.match(markup, /01:05/)

  const payload = buildConnectorJobDetailText(failed, Date.parse('2026-10-11T08:02:00.000Z'))
  assert.match(payload, /^Connector name: QQ 邮箱/m)
  assert.match(payload, /^Status: Failed/m)
  assert.match(payload, /Command:\nbun x --bun qq-email-mcp@0\.1\.1\n--stdio/)
  assert.match(payload, /^Duration: 01:05/m)
  assert.match(payload, /Error:\nMCP subprocess closed stdout before responding/)
  assert.match(payload, /Process output:\nConfig not found, run init first/)

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
  const readyContent = inspectTree(() =>
    ConnectorJobDetailContent({
      setup: ready,
      nowMs: Date.parse('2026-10-11T08:02:00.000Z'),
      copied: false,
      onCopy: () => undefined,
      onClose: () => undefined,
      onRetry: () => undefined
    })
  )
  const readyMarkup = renderToStaticMarkup(
    createElement(ThemeProvider, { theme: createTheme() }, readyContent)
  )
  assert.match(readyMarkup, /Completed/)
  assert.match(readyMarkup, /No process output/)
  assert.match(readyMarkup, /send_mail, list_mail/)
  assert.ok(
    findElement(
      readyContent,
      (element) => (element.props as { children?: ReactNode }).children === 'Copy details'
    )
  )
  assert.equal(
    findElement(
      readyContent,
      (element) => (element.props as { children?: ReactNode }).children === 'Retry'
    ),
    undefined
  )

  const failedContent = inspectTree(() =>
    ConnectorJobDetailContent({
      setup: setup(),
      nowMs: Date.parse('2026-10-11T08:02:00.000Z'),
      copied: true,
      onCopy: () => undefined,
      onClose: () => undefined,
      onRetry: () => undefined
    })
  )
  for (const label of ['Copied', 'Retry', 'Close']) {
    assert.ok(
      findElement(
        failedContent,
        (element) => (element.props as { children?: ReactNode }).children === label
      )
    )
  }
  for (const error of ['已取消', 'Cancelled']) {
    const cancelledContent = inspectTree(() =>
      ConnectorJobDetailContent({
        setup: setup({ error, failureKind: 'needs-setup' }),
        nowMs: 0,
        copied: false,
        onCopy: () => undefined,
        onClose: () => undefined,
        onRetry: () => undefined
      })
    )
    const cancelledMarkup = renderToStaticMarkup(
      createElement(ThemeProvider, { theme: createTheme() }, cancelledContent)
    )
    assert.match(cancelledMarkup, /Cancelled/)
    assert.doesNotMatch(cancelledMarkup, /Connector setup guide/)
  }
  assert.equal(connectorJobStartedAtLabel(setup({ startedAt: undefined })), 'Unknown')
  assert.equal(connectorJobToolsLabel(ready), 'send_mail, list_mail')
  assert.equal(connectorJobToolsLabel({ ...ready, toolNames: [] }), 'No tools found')
  assert.match(
    buildConnectorJobDetailText(
      { ...ready, startedAt: undefined, summary: undefined, error: undefined, detail: undefined },
      Date.parse('2026-10-11T08:02:00.000Z')
    ),
    /Started at: Unknown[\s\S]*Error:\nNo errors[\s\S]*Process output:\nNo process output/
  )
})

test('failed connector guide offers Agent and manual setup without executing commands', () => {
  const events: string[] = []
  const failed = setup({
    failureKind: 'needs-setup',
    failureReason: 'Configuration file not found',
    setupHint: {
      readmeUrl: 'https://github.com/example/mail/blob/main/README.md',
      commands: ['npx -y qq-email-mcp init']
    }
  })
  const guide = inspectTree(() =>
    ConnectorJobSetupGuide({
      setup: failed,
      retrying: false,
      onOpenAgent: (prompt) => events.push(`agent:${prompt}`),
      onCopyCommand: (command) => events.push(`copy:${command}`),
      onOpenTerminal: (command) => events.push(`terminal:${command}`),
      onRetry: () => events.push('retry')
    })
  )
  const markup = renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, guide))
  assert.match(markup, /Next steps/)
  assert.match(markup, /Ask Agent to set up/)
  assert.match(markup, /Set up manually/)
  assert.match(markup, /npx -y qq-email-mcp init/)
  assert.match(markup, /Copy command/)
  assert.match(markup, /Open in Terminal/)
  assert.match(markup, /Setup complete, retry/)
  assert.match(markup, /target="_blank"/)

  for (const label of [
    'Ask Agent to set up',
    'Copy command',
    'Open in Terminal',
    'Setup complete, retry'
  ]) {
    const button = findElement(
      guide,
      (element) => (element.props as { children?: ReactNode }).children === label
    )
    assert.ok(button, `missing ${label}`)
    ;(button.props as { onClick: () => void }).onClick()
  }
  assert.match(events[0] ?? '', /^agent:[\s\S]*QQ 邮箱/)
  assert.deepEqual(events.slice(1), [
    'copy:npx -y qq-email-mcp init',
    'terminal:npx -y qq-email-mcp init',
    'retry'
  ])
})

test('generic failures use the Agent investigation title and manual fallback', () => {
  const guide = inspectTree(() =>
    ConnectorJobSetupGuide({
      setup: setup({ failureKind: 'generic', setupHint: undefined }),
      retrying: false,
      onOpenAgent: () => undefined,
      onCopyCommand: () => undefined,
      onOpenTerminal: () => undefined,
      onRetry: () => undefined
    })
  )
  const markup = renderToStaticMarkup(createElement(ThemeProvider, { theme: createTheme() }, guide))
  assert.match(markup, /Ask Agent to investigate/)
  assert.match(markup, /Run the setup command from the service documentation/)
  assert.doesNotMatch(markup, /Copy command|Open in Terminal|View README/)
})
