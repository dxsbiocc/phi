import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'
import type { FeaturedMcpConnector } from '../src/shared/mcpConnectorCatalog'
import { McpFeaturedConnectorCard } from '../src/renderer/src/features/mcp/components/McpFeaturedConnectorCard'

function render(
  id: string,
  installed: boolean,
  authenticated: boolean,
  overrides: Partial<FeaturedMcpConnector> = {}
): string {
  const connector: FeaturedMcpConnector = {
    id,
    version: '1.0.0',
    name: id === 'google-drive' ? 'Google Drive' : 'Notion',
    description: 'Connector description',
    publisher: id === 'google-drive' ? 'Google' : 'Notion',
    category: '生产力',
    signIn: '需要登录',
    transport: 'http',
    auth: 'oauth',
    url: `https://example.com/${id}`,
    added: installed,
    ...overrides
  }
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpFeaturedConnectorCard, {
        connector,
        installed,
        authStatus: authenticated ? 'authenticated' : 'unauthenticated',
        busy: false,
        onOpen: () => undefined,
        onAdd: () => undefined,
        onBuildEnvironment: () => undefined
      })
    )
  )
}

test('Notion shows login state independently of whether it was added', () => {
  const connected = render('notion', true, true)
  assert.match(connected, /已登录/)
  assert.match(connected, /aria-label="已添加 Notion"/)
  assert.doesNotMatch(connected, /aria-label="添加 Notion"/)

  const notAdded = render('notion', false, true)
  assert.match(notAdded, /已登录/)
  assert.match(notAdded, /aria-label="添加 Notion"/)
})

test('connectors needing sign-in still show an add action', () => {
  const google = render('google-drive', false, false)
  assert.match(google, /需登录/)
  assert.match(google, /aria-label="添加 Google Drive"/)
  assert.doesNotMatch(google, /暂未支持授权/)
})

test('catalog cards expose unavailable and not-built environment states', () => {
  const unavailable = render('notion', false, false, {
    unavailableReason: 'requires app 9.0.0'
  })
  assert.match(unavailable, /需要新版 Phi/)
  assert.match(unavailable, /Mui-disabled/)

  const pending = render('local-stdio', false, false, {
    name: 'Local stdio',
    transport: 'stdio',
    auth: undefined,
    url: undefined,
    environment: './environment.yml',
    command: './server',
    signIn: '无需登录',
    environmentState: 'not-built'
  })
  assert.match(pending, /环境未构建/)
  assert.match(pending, /aria-label="构建 Local stdio 环境"/)
})
