import assert from 'node:assert/strict'
import test from 'node:test'
import type { FeaturedMcpConnector, McpConnectorCategory } from '../src/shared/mcpConnectorCatalog'
import { filterFeaturedConnectors } from '../src/renderer/src/features/mcp/lib/featuredConnectorFilters'

const installed = new Set(['notion', 'tavily'])
function connector(
  id: string,
  name: string,
  category: McpConnectorCategory,
  signIn: string,
  description = ''
): FeaturedMcpConnector {
  return {
    id,
    name,
    category,
    signIn,
    description,
    publisher: 'Fixture',
    version: '1.0.0',
    transport: 'http',
    added: false
  }
}
const connectors = [
  connector('composio', 'Composio', '生产力', '需要登录'),
  connector('google-drive', 'Google Drive', '生产力', '需要登录'),
  connector('linear', 'Linear', '生产力', '需要登录'),
  connector('notion', 'Notion', '生产力', '需要登录'),
  connector('firecrawl', 'Firecrawl', '科研数据', '需要 API key', '搜索网页'),
  connector('serpapi', 'SerpApi', '科研数据', '需要 API key', '搜索结果'),
  connector('tavily', 'Tavily', '科研数据', '需要 API key', '搜索内容'),
  connector('public', 'Public', '科研数据', '无需登录', '搜索公共数据')
]

test('category browse can filter by sign-in and added state, then sort added first', () => {
  const results = filterFeaturedConnectors(connectors, {
    category: '生产力',
    query: '',
    signIn: '需要登录',
    install: 'all',
    sort: 'added',
    isInstalled: (connector) => installed.has(connector.id)
  })
  assert.deepEqual(
    results.map((connector) => connector.id),
    ['notion', 'composio', 'google-drive', 'linear']
  )
})

test('a search still looks across categories and honors the API key filter', () => {
  const results = filterFeaturedConnectors(connectors, {
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
