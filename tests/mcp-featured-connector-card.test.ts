import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { ThemeProvider, createTheme } from '@mui/material/styles'
import test from 'node:test'
import type { FeaturedMcpConnector } from '../src/shared/mcpConnectorCatalog'
import { McpFeaturedConnectorCard } from '../src/renderer/src/features/mcp/components/McpFeaturedConnectorCard'
import { cacheResourceIconFixture } from './helpers/resourceIconFixture'

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
  assert.match(connected, /Signed in/)
  assert.match(connected, /aria-label="Added Notion"/)
  assert.match(connected, /data-phi-connector-state="added"/)
  assert.doesNotMatch(connected, /aria-label="Add Notion"/)

  const notAdded = render('notion', false, true)
  assert.match(notAdded, /Signed in/)
  assert.match(notAdded, /aria-label="Add Notion"/)
})

test('a connector awaiting OAuth offers authorization instead of a config-only add', () => {
  const notion = render('notion', false, false)
  assert.match(notion, /aria-label="Sign in to Notion"/)
  assert.doesNotMatch(notion, /aria-label="Add Notion"/)

  const google = render('google-drive', false, false)
  assert.match(google, /Authorization unavailable/)
  assert.doesNotMatch(google, /aria-label="Add Google Drive"/)

  for (const [id, name] of [
    ['linear', 'Linear'],
    ['figma', 'Figma'],
    ['canva', 'Canva'],
    ['biorender', 'BioRender'],
    ['cbioportal', 'cBioPortal']
  ] as const) {
    const markup = render(id, false, false)
    assert.match(markup, new RegExp(`aria-label="Sign in to ${name}"`))
    assert.doesNotMatch(markup, /Authorization unavailable/)
  }
})

test('Composio uses the same independent login and install states', () => {
  const connected = render('composio', true, true)
  assert.match(connected, /Signed in/)
  assert.match(connected, /aria-label="Added Composio Connect"/)
  const notAdded = render('composio', false, false)
  assert.match(notAdded, /Sign-in required/)
  assert.match(notAdded, /aria-label="Sign in to Composio Connect"/)
  assert.doesNotMatch(notAdded, /aria-label="Add Composio Connect"/)
})

test('a saved OAuth connector without authorization is not marked complete', () => {
  const gmail = render('gmail', true, false)
  assert.match(gmail, /Configured, authorization unverified for Gmail/)
  assert.doesNotMatch(gmail, /aria-label="Added Gmail"/)
})

test('API key connectors offer setup before a key is saved and show completion afterward', () => {
  const missingKey = render('tavily', false, false)
  assert.match(missingKey, /API key required/)
  assert.match(missingKey, /aria-label="Configure Tavily"/)
  assert.doesNotMatch(missingKey, /aria-label="Added Tavily"/)

  const connected = render('tavily', true, true)
  assert.match(connected, /Verified/)
  assert.match(connected, /aria-label="Added Tavily"/)
})

test('a configured API key connector remains visibly configured while awaiting verification', () => {
  const configured = render('tavily', true, false)
  assert.match(configured, /Configured/)
  assert.match(configured, /API key unverified/)
  assert.match(configured, /aria-label="Verify API key for Tavily"/)
  assert.doesNotMatch(configured, /aria-label="Added Tavily"/)
})

test('a configured disabled OAuth connector does not look enabled after login', () => {
  const disabled = render('notion', true, true, {}, false)
  assert.match(disabled, /Signed in/)
  assert.match(disabled, /Disabled/)
  assert.doesNotMatch(disabled, /aria-label="Added Notion"/)
})

test('catalog cards expose unavailable and not-built environment states', () => {
  const unavailable = render('notion', false, false, {
    unavailableReason: 'requires app 9.0.0'
  })
  assert.match(unavailable, /Newer Phi required/)
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
  assert.match(pending, /Environment not built/)
  assert.match(pending, /aria-label="Build Local stdio environment"/)
})

test('an authorization restriction is not presented as an app version requirement', () => {
  const markup = render('google-drive', false, false, {
    unavailableReason: '此连接器的目录Authorization unavailable',
    unavailableKind: 'authorization'
  })
  assert.match(markup, /Authorization unavailable/)
  assert.doesNotMatch(markup, /Newer Phi required/)
  assert.match(markup, /Authorization unavailable for Google Drive/)
})

test('authorization in progress shows a waiting indicator instead of an add or completion icon', () => {
  for (const [installed, authenticated, updateAvailable] of [
    [false, false, false],
    [true, true, false],
    [true, true, true]
  ] as const) {
    const markup = render('cbioportal', installed, authenticated, {}, true, true, updateAvailable)
    assert.match(markup, /aria-label="Cancel authorization for cBioPortal"/)
    assert.match(markup, /role="progressbar"/)
    assert.match(markup, /aria-label="Waiting for authorization"/)
    assert.doesNotMatch(markup, /aria-label="Added cBioPortal"/)
  }
})

test('connector cards render resource-owned metadata icons independently of their connector ID', async () => {
  const key = 'catalog-cbioportal-icon'
  await cacheResourceIconFixture(key)
  const markup = render('third-party-catalog-id', false, false, {
    name: 'cBioPortal',
    icon: { key }
  })
  assert.match(markup, /data-phi-resource-icon-key="catalog-cbioportal-icon"/)
  assert.match(markup, /<img[^>]*src="data:image\/png;base64,iVBORw0KGgo="[^>]*alt=""/)
  assert.doesNotMatch(markup, /cbioportal\.png/)

  const missing = render('cbioportal', false, false)
  assert.match(missing, /data-phi-resource-icon="mcp"/)
  assert.doesNotMatch(missing, /<img/)
})

test('a connector that needs a newer Phi shows that note only while it is not added or has an update pending', () => {
  const needsNewer = { unavailableReason: '需要 Phi 1.0.1 或更高版本' }
  assert.match(render('notion', false, false, needsNewer), /Newer Phi required/)
  assert.doesNotMatch(
    render('notion', true, true, needsNewer),
    /Newer Phi required/,
    'an added, working connector is not "unavailable"'
  )
  assert.match(
    render('notion', true, true, needsNewer, true, false, true),
    /Newer Phi required/,
    'an update it cannot take yet is still flagged'
  )
})
