import assert from 'node:assert/strict'
import test from 'node:test'
import { featuredMcpConnectors } from '../src/shared/mcpConnectorCatalog'

test('every featured connector has an introduction and API key entries use official HTTPS links', () => {
  for (const connector of featuredMcpConnectors) {
    assert.ok(connector.overview.length >= 40, connector.id)
    if (!connector.apiKey) continue
    assert.equal(connector.signIn, '需要 API key')
    assert.ok(connector.apiKey.obtainUrl.startsWith('https://'), connector.id)
    assert.ok(
      connector.apiKey.header === 'Authorization' ||
        connector.apiKey.header === 'x-browser-use-api-key'
    )
  }
  assert.deepEqual(
    featuredMcpConnectors.filter((connector) => connector.apiKey).map((connector) => connector.id),
    ['tavily', 'serpapi', 'firecrawl', 'browser-use']
  )
  assert.match(
    featuredMcpConnectors.find((connector) => connector.id === 'open-targets')?.overview ?? '',
    /靶点与疾病.*GWAS.*QTL.*可信集/
  )
})
