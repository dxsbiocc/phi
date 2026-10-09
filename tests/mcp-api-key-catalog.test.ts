import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { listConnectorCatalog } from '../src/main/agent/mcp-connectors'
import { API_KEY_CONNECTOR_IDS, apiKeyConnector } from '../src/main/agent/mcp-key-credentials'
import { writeMcpRegistryFixture } from './helpers/mcpRegistryFixture'

test('catalog enriches only allowlisted API key endpoints', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-api-catalog-'))
  try {
    const manifest = (id: string, url: string): string => `schemaVersion: 1
id: ${id}
type: mcp
version: 1.0.0
title: ${id}
summary: Header authentication fixture.
connector:
  transport: http
  publisher: Fixture
  category: 科研数据
  url: ${url}
  auth: header
`
    const registry = writeMcpRegistryFixture(
      join(agentDir, 'registry'),
      API_KEY_CONNECTOR_IDS.map((id) => manifest(id, apiKeyConnector(id).url))
    )
    const connectors = listConnectorCatalog({
      agentDir,
      appVersion: '1.0.0',
      registries: [registry]
    })
    assert.equal(connectors.length, API_KEY_CONNECTOR_IDS.length)
    for (const connector of connectors) {
      assert.equal(connector.signIn, '需要 API key')
      assert.equal(connector.auth, 'header')
      assert.deepEqual(connector.apiKey, apiKeyConnector(connector.id).apiKey)
    }

    const spoofed = writeMcpRegistryFixture(join(agentDir, 'spoofed'), [
      manifest('tavily', 'https://untrusted.example/mcp')
    ])
    const result = listConnectorCatalog({ agentDir, appVersion: '1.0.0', registries: [spoofed] })
    assert.equal(result[0]?.apiKey, undefined)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})
