import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  addRemoteMcpConnector,
  isInjectedMcpServer,
  listConnectorCatalog,
  removeRemoteMcpConnector,
  setMcpConnectorEnabled
} from '../src/main/agent/mcp-connectors'
import { mcpConnectorCategories } from '../src/shared/mcpConnectorCatalog'

test('curated connector directory has distinct HTTPS services in every group', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-catalog-'))
  try {
    const connectors = listConnectorCatalog({
      agentDir,
      appVersion: '1.0.0',
      bundledConnectorsDir: join(process.cwd(), 'resources', 'connectors')
    })
    const ids = connectors.map((connector) => connector.id)
    const urls = connectors.map((connector) => connector.url).filter((url) => url !== undefined)
    assert.equal(new Set(ids).size, ids.length)
    assert.equal(new Set(urls).size, urls.length)
    assert.ok(urls.every((url) => url.startsWith('https://')))
    assert.ok(connectors.every((connector) => mcpConnectorCategories.includes(connector.category)))
    assert.deepEqual(
      connectors
        .filter((connector) => connector.signIn === '无需登录')
        .map((connector) => connector.id)
        .sort(),
      ['biorxiv', 'clinical-trials', 'open-targets', 'pubmed']
    )
    assert.equal(
      connectors.find((connector) => connector.id === 'open-targets')?.url,
      'https://mcp.platform.opentargets.org/mcp'
    )
    const composio = connectors.find((connector) => connector.id === 'composio')
    assert.equal(composio?.url, 'https://connect.composio.dev/mcp')
    assert.equal(composio?.oauthAuthorizationOrigin, 'https://connect.composio.dev')
    assert.deepEqual(
      connectors
        .filter((connector) => connector.oauthAuthorizationOrigin)
        .map((connector) => [connector.id, connector.oauthAuthorizationOrigin] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
      [
        ['biorender', 'https://mcp.services.biorender.com'],
        ['canva', 'https://mcp.canva.com'],
        ['composio', 'https://connect.composio.dev'],
        ['figma', 'https://www.figma.com'],
        ['linear', 'https://mcp.linear.app'],
        ['notion', 'https://mcp.notion.com']
      ]
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
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

test('connector switch disables a server without turning an API key entry on', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-connectors-'))
  const path = join(agentDir, 'mcp.json')
  try {
    writeFileSync(
      path,
      JSON.stringify({
        settings: { keep: true },
        mcpServers: {
          notion: { type: 'http', url: 'https://mcp.notion.com/mcp', enabled: true },
          tavily: { type: 'http', url: 'https://mcp.tavily.com/mcp', enabled: false },
          local: { command: 'existing-server', enabled: false }
        }
      })
    )

    setMcpConnectorEnabled('notion', false, path, agentDir)
    let config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(config.disabledServers, ['notion'])
    assert.equal(config.mcpServers.notion.enabled, false)
    assert.equal(isInjectedMcpServer('notion', config.mcpServers.notion, true), false)
    assert.deepEqual(config.settings, { keep: true })

    setMcpConnectorEnabled('tavily', false, path, agentDir)
    config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(config.disabledServers, ['notion', 'tavily'])
    assert.equal(config.mcpServers.tavily.enabled, false)

    setMcpConnectorEnabled('tavily', true, path, agentDir)
    setMcpConnectorEnabled('local', true, path, agentDir)
    config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(config.disabledServers, ['notion'])
    assert.equal(config.mcpServers.tavily.enabled, false)
    assert.equal(isInjectedMcpServer('tavily', config.mcpServers.tavily, false), true)
    assert.equal(isInjectedMcpServer('tavily', config.mcpServers.tavily, true), false)
    assert.equal(config.mcpServers.local.enabled, true)
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
