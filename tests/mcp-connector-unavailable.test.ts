import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'

import { McpFeaturedConnectorDetails } from '../src/renderer/src/features/mcp/components/McpFeaturedConnectorDetails'
import type { FeaturedMcpConnector } from '../src/shared/mcpConnectorCatalog'

const UNAVAILABLE = '需要 Phi 1.0.1 或更高版本'

function render(options: {
  configured: boolean
  enabled?: boolean
  updateAvailable?: boolean
  unavailableReason?: string
  unavailableKind?: FeaturedMcpConnector['unavailableKind']
}): string {
  const connector = {
    id: 'biomcp',
    version: '1.1.0',
    name: 'BioMCP',
    description: '生物医学检索',
    publisher: 'GenomOncology',
    category: '健康与生命科学',
    signIn: '本地服务',
    transport: 'stdio',
    command: 'biomcp',
    args: ['serve'],
    added: options.configured,
    unavailableKind: options.unavailableKind,
    ...(options.unavailableReason ? { unavailableReason: options.unavailableReason } : {})
  } as unknown as FeaturedMcpConnector
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpFeaturedConnectorDetails, {
        connector,
        server: options.configured
          ? {
              id: '/mcp.json:biomcp',
              name: 'biomcp',
              packageId: 'biomcp',
              managed: true,
              enabled: options.enabled ?? true,
              status: 'configured' as const
            }
          : undefined,
        authStatus: 'authenticated',
        busy: false,
        toolNames: [],
        toolsLoading: false,
        toolsError: null,
        updateAvailable: options.updateAvailable ?? false,
        onAdd: () => undefined,
        onRemove: () => undefined,
        onAuthorize: () => undefined,
        onApiKey: () => undefined,
        onRetry: () => undefined,
        onEnabledChange: () => undefined
      })
    )
  )
}

test('a connector that is not added yet and needs a newer Phi cannot be added', () => {
  const markup = render({ configured: false, unavailableReason: UNAVAILABLE })
  assert.match(markup, /Newer Phi required/)
  assert.doesNotMatch(markup, />Remove</)
})

test('authorization restrictions explain why adding or updating is unavailable', () => {
  for (const configured of [false, true]) {
    const markup = render({
      configured,
      updateAvailable: configured,
      unavailableReason: '此连接器的目录Authorization unavailable',
      unavailableKind: 'authorization'
    })
    assert.match(markup, /Authorization unavailable/)
    assert.doesNotMatch(markup, /Newer Phi required/)
    if (configured) assert.match(markup, />Remove</)
  }
})

test('an added connector can always be removed, even when the catalog version needs a newer Phi', () => {
  const markup = render({ configured: true, unavailableReason: UNAVAILABLE })
  assert.match(markup, />Remove</)
  assert.doesNotMatch(markup, /Newer Phi required/, 'it already works, so it is not "unavailable"')
})

test('a pending update that needs a newer Phi is stated as such next to the remove button', () => {
  const markup = render({
    configured: true,
    updateAvailable: true,
    unavailableReason: UNAVAILABLE
  })
  assert.match(markup, />Remove</)
  assert.match(markup, /Update requires a newer Phi/)
  assert.doesNotMatch(markup, />Update</)
})

test('an added connector with an update it can take still offers update and remove', () => {
  const markup = render({ configured: true, updateAvailable: true })
  assert.match(markup, />Update</)
  assert.match(markup, />Remove</)
})

test('a switched-off connector that is already added can be switched back on despite the version note', () => {
  const markup = render({ configured: true, enabled: false, unavailableReason: UNAVAILABLE })
  const button = /<button[^>]*>Enable<\/button>/.exec(markup)?.[0]
  assert.ok(button, 'the enable button is shown')
  assert.doesNotMatch(button, /disabled/)
})
