import { componentTree } from './helpers/renderComponentTree'
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

  assert.match(markup, /Confirm local Connector/)
  assert.match(markup, /aria-labelledby="mcp-local-connect-confirm-title"/)
  assert.match(markup, /aria-describedby="mcp-local-connect-confirm-description"/)
  assert.match(markup, /Runtime/)
  assert.match(markup, /Python 1/)
  assert.match(markup, /argv\[0\] = &quot;uvx&quot;/)
  assert.match(markup, /argv\[2\] = &quot;value with spaces&quot;/)
  assert.match(markup, /LOG_LEVEL/)
  assert.match(markup, /FEATURE_FLAG/)
  assert.doesNotMatch(markup, /secret-info|secret-enabled/)
  assert.match(markup, /\/tmp\/literature/)
  assert.match(markup, /After confirmation, startup and verification run in the background./)
  assert.match(markup, /The first run downloads dependencies and may take a few minutes./)
})

test('local connector confirmation exposes cancel and one-shot confirm actions', () => {
  let cancels = 0
  let confirms = 0
  const tree = componentTree(() =>
    McpLocalConnectConfirmDialog({
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
  )
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
  assert.match(markup, /Submitting…/)
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

  assert.match(
    renderRequest(hostRequest),
    /Runs directly on this device without a Phi isolated environment/
  )
  assert.match(
    renderRequest({
      ...hostRequest,
      runtime: { kind: 'bun' },
      command: 'x',
      args: ['--bun', 'fixture@1.0.0']
    }),
    /Runs with Phi&#x27;s bundled Bun in Node compatibility mode; some dependencies may be incompatible\..*without locking versions\./s
  )
})
