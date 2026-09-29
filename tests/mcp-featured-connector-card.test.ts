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
        onAdd: () => undefined,
        onAuthorize: () => undefined
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

test('a connector awaiting OAuth offers authorization instead of a config-only add', () => {
  const notion = render('notion', false, false)
  assert.match(notion, /aria-label="授权登录 Notion"/)
  assert.doesNotMatch(notion, /aria-label="添加 Notion"/)

  const google = render('google-drive', false, false)
  assert.match(google, /授权暂不可用/)
  assert.doesNotMatch(google, /aria-label="添加 Google Drive"/)
})

test('Composio uses the same independent login and install states', () => {
  const connected = render('composio', true, true)
  assert.match(connected, /已登录/)
  assert.match(connected, /aria-label="已添加 Composio Connect"/)
  const notAdded = render('composio', false, false)
  assert.match(notAdded, /需登录/)
  assert.match(notAdded, /aria-label="授权登录 Composio Connect"/)
  assert.doesNotMatch(notAdded, /aria-label="添加 Composio Connect"/)
})

test('a saved OAuth connector without authorization is not marked complete', () => {
  const gmail = render('gmail', true, false)
  assert.match(gmail, /已配置但未验证授权 Gmail/)
  assert.doesNotMatch(gmail, /aria-label="已添加 Gmail"/)
})

test('API key connectors offer setup before a key is saved and show completion afterward', () => {
  const missingKey = render('tavily', false, false)
  assert.match(missingKey, /需填写 API key/)
  assert.match(missingKey, /aria-label="配置 Tavily"/)
  assert.doesNotMatch(missingKey, /aria-label="已添加 Tavily"/)

  const connected = render('tavily', true, true)
  assert.match(connected, /已验证/)
  assert.match(connected, /aria-label="已添加 Tavily"/)
})
