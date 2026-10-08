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
  overrides: Partial<FeaturedMcpConnector> = {},
  enabled = true,
  authorizing = false,
  updateAvailable = false
): string {
  const names: Record<string, string> = {
    'google-drive': 'Google Drive',
    notion: 'Notion',
    composio: 'Composio Connect',
    linear: 'Linear',
    figma: 'Figma',
    canva: 'Canva',
    biorender: 'BioRender',
    cbioportal: 'cBioPortal',
    gmail: 'Gmail',
    tavily: 'Tavily'
  }
  const oauthAuthorizationOrigin = [
    'notion',
    'composio',
    'linear',
    'figma',
    'canva',
    'biorender',
    'cbioportal'
  ].includes(id)
    ? 'https://auth.example.com'
    : undefined
  const connector: FeaturedMcpConnector = {
    id,
    version: '1.0.0',
    name: names[id] ?? id,
    description: 'Connector description',
    publisher: id === 'google-drive' ? 'Google' : (names[id] ?? id),
    category: '生产力',
    signIn: '需要登录',
    transport: 'http',
    auth: 'oauth',
    url: `https://example.com/${id}`,
    added: installed,
    ...(oauthAuthorizationOrigin ? { oauthAuthorizationOrigin } : {}),
    ...(id === 'tavily'
      ? { apiKey: { header: 'Authorization', obtainUrl: 'https://example.com/key' } }
      : {}),
    ...overrides
  }
  return renderToStaticMarkup(
    createElement(
      ThemeProvider,
      { theme: createTheme() },
      createElement(McpFeaturedConnectorCard, {
        connector,
        installed,
        enabled,
        authorizing,
        updateAvailable,
        authStatus: authenticated ? 'authenticated' : 'unauthenticated',
        busy: false,
        onOpen: () => undefined,
        onAdd: () => undefined,
        onAuthorize: () => undefined,
        onBuildEnvironment: () => undefined
      })
    )
  )
}

test('Notion shows login state independently of whether it was added', () => {
  const connected = render('notion', true, true)
  assert.match(connected, /已登录/)
  assert.match(connected, /aria-label="已添加 Notion"/)
  assert.match(connected, /data-phi-connector-state="added"/)
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

  for (const [id, name] of [
    ['linear', 'Linear'],
    ['figma', 'Figma'],
    ['canva', 'Canva'],
    ['biorender', 'BioRender'],
    ['cbioportal', 'cBioPortal']
  ] as const) {
    const markup = render(id, false, false)
    assert.match(markup, new RegExp(`aria-label="授权登录 ${name}"`))
    assert.doesNotMatch(markup, /授权暂不可用/)
  }
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

test('a configured API key connector remains visibly configured while awaiting verification', () => {
  const configured = render('tavily', true, false)
  assert.match(configured, /已配置/)
  assert.match(configured, /API key 未验证/)
  assert.match(configured, /aria-label="验证 API key Tavily"/)
  assert.doesNotMatch(configured, /aria-label="已添加 Tavily"/)
})

test('a configured disabled OAuth connector does not look enabled after login', () => {
  const disabled = render('notion', true, true, {}, false)
  assert.match(disabled, /已登录/)
  assert.match(disabled, /已停用/)
  assert.doesNotMatch(disabled, /aria-label="已添加 Notion"/)
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

test('authorization in progress shows a waiting indicator instead of an add or completion icon', () => {
  for (const [installed, authenticated, updateAvailable] of [
    [false, false, false],
    [true, true, false],
    [true, true, true]
  ] as const) {
    const markup = render('cbioportal', installed, authenticated, {}, true, true, updateAvailable)
    assert.match(markup, /aria-label="取消授权 cBioPortal"/)
    assert.match(markup, /role="progressbar"/)
    assert.match(markup, /aria-label="等待授权"/)
    assert.doesNotMatch(markup, /aria-label="已添加 cBioPortal"/)
  }
})

test('cBioPortal uses its bundled official website icon', () => {
  const markup = render('cbioportal', false, false)
  assert.match(markup, /cbioportal\.png/)
})
