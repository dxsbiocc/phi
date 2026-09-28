import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { addRemoteMcpConnector, removeRemoteMcpConnector } from '../src/main/agent/mcp-connectors'
import { featuredMcpConnectors, mcpConnectorCategories } from '../src/shared/mcpConnectorCatalog'

test('curated connector directory has distinct HTTPS services in every group', () => {
  const ids = featuredMcpConnectors.map((connector) => connector.id)
  const urls = featuredMcpConnectors.map((connector) => connector.url)
  assert.equal(new Set(ids).size, ids.length)
  assert.equal(new Set(urls).size, urls.length)
  assert.ok(urls.every((url) => url.startsWith('https://')))
  for (const category of mcpConnectorCategories) {
    assert.ok(
      featuredMcpConnectors.filter((connector) => connector.category === category).length >= 2,
      category
    )
  }
  assert.deepEqual(
    featuredMcpConnectors
      .filter((connector) => connector.signIn === '无需登录')
      .map((connector) => connector.id),
    ['pubmed', 'biorxiv', 'clinical-trials']
  )
})

test('remote MCP connectors preserve unrelated configuration and remove only matching entries', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-connectors-'))
  const path = join(agentDir, 'mcp.json')
  try {
    writeFileSync(
      path,
      JSON.stringify({
        settings: { keep: true },
        mcpServers: { local: { command: 'existing-server', args: ['--stdio'] } }
      })
    )

    addRemoteMcpConnector('pubmed', 'https://pubmed.mcp.claude.com/mcp', agentDir)
    let config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(config.settings, { keep: true })
    assert.deepEqual(config.mcpServers.local, {
      command: 'existing-server',
      args: ['--stdio']
    })
    assert.deepEqual(config.mcpServers.pubmed, {
      type: 'http',
      url: 'https://pubmed.mcp.claude.com/mcp',
      enabled: true
    })

    assert.throws(
      () => removeRemoteMcpConnector('pubmed', 'https://other.example/mcp', agentDir),
      /配置已变化/
    )
    removeRemoteMcpConnector('pubmed', 'https://pubmed.mcp.claude.com/mcp', agentDir)
    config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(Object.keys(config.mcpServers), ['local'])
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('remote MCP connector input rejects unsafe URLs and name collisions', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-connectors-'))
  try {
    assert.throws(
      () => addRemoteMcpConnector('pubmed', 'http://example.com/mcp', agentDir),
      /HTTPS/
    )
    assert.throws(
      () => addRemoteMcpConnector('pubmed', 'https://user:pass@example.com/mcp', agentDir),
      /HTTPS/
    )
    assert.throws(
      () => addRemoteMcpConnector('../other', 'https://example.com/mcp', agentDir),
      /名称/
    )
    addRemoteMcpConnector('pubmed', 'https://pubmed.mcp.claude.com/mcp', agentDir)
    assert.throws(
      () => addRemoteMcpConnector('pubmed', 'https://other.example/mcp', agentDir),
      /已有/
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})
