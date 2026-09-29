import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'
import { featuredMcpConnectors } from '../src/shared/mcpConnectorCatalog'
import { McpFeaturedConnectorCard } from '../src/renderer/src/features/mcp/components/McpFeaturedConnectorCard'

function render(id: string, installed: boolean, authenticated: boolean): string {
  const connector = featuredMcpConnectors.find((entry) => entry.id === id)
  assert.ok(connector)
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
        onAdd: () => undefined
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
