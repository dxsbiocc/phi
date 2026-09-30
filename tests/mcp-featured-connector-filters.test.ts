import assert from 'node:assert/strict'
import test from 'node:test'
import { featuredMcpConnectors } from '../src/shared/mcpConnectorCatalog'
import { filterFeaturedConnectors } from '../src/renderer/src/features/mcp/lib/featuredConnectorFilters'

const installed = new Set(['notion', 'tavily'])

test('category browse can filter by sign-in and added state, then sort added first', () => {
  const results = filterFeaturedConnectors(featuredMcpConnectors, {
    category: '生产力',
    query: '',
    signIn: '需要登录',
    install: 'all',
    sort: 'added',
    isInstalled: (connector) => installed.has(connector.id)
  })
  assert.deepEqual(
    results.map((connector) => connector.id),
    ['notion', 'google-drive', 'composio', 'linear']
  )
})

test('a search still looks across categories and honors the API key filter', () => {
  const results = filterFeaturedConnectors(featuredMcpConnectors, {
    category: '设计创作',
    query: '搜索',
    signIn: '需要 API key',
    install: 'not-added',
    sort: 'name',
    isInstalled: (connector) => installed.has(connector.id)
  })
  assert.deepEqual(
    results.map((connector) => connector.id),
    ['firecrawl', 'serpapi']
  )
})
