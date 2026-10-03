import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listConnectorCatalog } from '../src/main/agent/mcp-connectors'
import { filterFeaturedConnectors } from '../src/renderer/src/features/mcp/lib/featuredConnectorFilters'

const installed = new Set(['notion', 'tavily'])
const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-filter-catalog-'))
const connectors = listConnectorCatalog({
  agentDir,
  appVersion: '1.0.0',
  bundledConnectorsDir: join(process.cwd(), 'resources', 'connectors')
})
test.after(() => rmSync(agentDir, { recursive: true, force: true }))

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
