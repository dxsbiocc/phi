import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listConnectorCatalog } from '../src/main/agent/mcp-connectors'

test('registry catalog enriches official API key packages without putting secrets in manifests', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-api-catalog-'))
  try {
    const connectors = listConnectorCatalog({
      agentDir,
      appVersion: '1.0.0',
      bundledConnectorsDir: join(process.cwd(), 'resources', 'connectors')
    })
    for (const connector of connectors) {
      if (!connector.apiKey) continue
      assert.equal(connector.signIn, '需要 API key')
      assert.equal(connector.auth, 'header')
      assert.ok(connector.apiKey.obtainUrl.startsWith('https://'), connector.id)
      assert.ok(
        connector.apiKey.header === 'Authorization' ||
          connector.apiKey.header === 'x-browser-use-api-key'
      )
    }
    assert.deepEqual(
      connectors
        .filter((connector) => connector.apiKey)
        .map((connector) => connector.id)
        .sort(),
      ['browser-use', 'firecrawl', 'serpapi', 'tavily']
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})
