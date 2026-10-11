import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveCuratedResourceIcon } from '../src/main/agent/curated-icons'
import { withConnectorMetadata } from '../src/main/agent/mcp-server-view'
import type { McpServerSummary } from '../src/main/agent/resources'
import type { FeaturedMcpConnector } from '../src/shared/mcpConnectorCatalog'

const REAL_LOGO = { key: 'real-notion-logo' }

function server(overrides: Partial<McpServerSummary> = {}): McpServerSummary {
  return { id: '/mcp.json:notion', name: 'notion', status: 'configured', ...overrides }
}

function connector(overrides: Partial<FeaturedMcpConnector> = {}): FeaturedMcpConnector {
  return {
    id: 'notion',
    version: '1.0.0',
    name: 'Notion',
    description: '',
    publisher: 'Notion',
    category: '生产力',
    signIn: '',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    ...overrides
  } as FeaturedMcpConnector
}

test('a connector keeps the logo the catalog ships; a generated icon never replaces it', () => {
  const [merged] = withConnectorMetadata(
    [server({ packageId: 'notion' })],
    [connector({ icon: REAL_LOGO })]
  )
  assert.deepEqual(merged.icon, REAL_LOGO)
  assert.equal(merged.title, 'Notion')
  assert.equal(merged.category, '生产力')
  assert.equal(merged.connectorId, 'notion')
})

test('the icon an installed connector already has wins over the catalog logo', () => {
  const own = { key: 'installed-own-icon' }
  const [merged] = withConnectorMetadata(
    [server({ packageId: 'notion', icon: own })],
    [connector({ icon: REAL_LOGO })]
  )
  assert.deepEqual(merged.icon, own)
})

test('a connector with no icon anywhere gets a stable generated one', () => {
  const [matched] = withConnectorMetadata([server({ packageId: 'notion' })], [connector()])
  assert.deepEqual(matched.icon, resolveCuratedResourceIcon('mcp', 'notion'))
  const [custom] = withConnectorMetadata(
    [server({ id: '/mcp.json:mine', name: 'mine', url: 'https://example.com/mcp' })],
    [connector()]
  )
  assert.ok(custom.icon, 'a custom connector also gets one')
  assert.deepEqual(
    withConnectorMetadata(
      [server({ id: '/mcp.json:mine', name: 'mine', url: 'https://example.com/mcp' })],
      [connector()]
    )[0].icon,
    custom.icon
  )
})

test('matching also works by url', () => {
  const [merged] = withConnectorMetadata(
    [server({ url: 'https://mcp.notion.com/mcp' })],
    [connector({ icon: REAL_LOGO })]
  )
  assert.equal(merged.connectorId, 'notion')
  assert.deepEqual(merged.icon, REAL_LOGO)
})
