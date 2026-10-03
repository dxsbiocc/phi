import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  clearFeaturedMcpApiKey,
  featuredApiKeyMcpConfig,
  featuredMcpApiKeyStatus,
  isFeaturedMcpApiKeyInstalled,
  readFeaturedMcpApiKey,
  setFeaturedMcpApiKey
} from '../src/main/agent/mcp-key-credentials'
import {
  addRemoteMcpConnector,
  disableFeaturedApiKeyAutoDiscovery
} from '../src/main/agent/mcp-connectors'
import {
  isCredentialStorageAvailable,
  type SafeStorageLike
} from '../src/main/agent/credentials/credential-store'

const safeStorage: SafeStorageLike = {
  isEncryptionAvailable: () => true,
  encryptString: (value) => Buffer.from(`encrypted:${value.split('').reverse().join('')}`),
  decryptString: (value) => {
    const encoded = value.toString()
    if (!encoded.startsWith('encrypted:')) throw new Error('invalid ciphertext')
    return encoded.slice('encrypted:'.length).split('').reverse().join('')
  }
}

test('fixed MCP keys stay encrypted on disk and are never accepted for other IDs', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-keys-'))
  try {
    setFeaturedMcpApiKey('tavily', 'tvly-test-secret', agentDir, safeStorage)
    const credentialPath = join(agentDir, 'db-connectors', 'api-credentials.json')
    const stored = readFileSync(credentialPath, 'utf8')
    assert.equal(stored.includes('tvly-test-secret'), false)
    assert.equal(statSync(credentialPath).mode & 0o777, 0o600)
    assert.equal(featuredMcpApiKeyStatus('tavily', agentDir, safeStorage), true)
    assert.equal(readFeaturedMcpApiKey('tavily', agentDir, safeStorage), 'tvly-test-secret')
    assert.throws(() => setFeaturedMcpApiKey('notion', 'secret', agentDir, safeStorage), /不支持/)
    assert.throws(
      () => setFeaturedMcpApiKey('tavily', 'bad\nheader', agentDir, safeStorage),
      /格式/
    )
    clearFeaturedMcpApiKey('tavily', agentDir)
    assert.equal(featuredMcpApiKeyStatus('tavily', agentDir, safeStorage), false)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('Linux basic_text storage is rejected even when encryption reports available', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-keys-'))
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const weakStorage = { ...safeStorage, getSelectedStorageBackend: () => 'basic_text' }
  try {
    Object.defineProperty(process, 'platform', { ...platform, value: 'linux' })
    assert.equal(isCredentialStorageAvailable(weakStorage), false)
    assert.throws(
      () => setFeaturedMcpApiKey('tavily', 'tvly-test-secret', agentDir, weakStorage),
      /不支持加密存储/
    )
  } finally {
    Object.defineProperty(process, 'platform', platform)
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('API-key MCP entries are disabled on disk and require exact installed configuration', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-keys-'))
  const path = join(agentDir, 'mcp.json')
  try {
    addRemoteMcpConnector('tavily', 'https://mcp.tavily.com/mcp', agentDir)
    let config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(config.mcpServers.tavily, {
      type: 'http',
      url: 'https://mcp.tavily.com/mcp',
      enabled: false
    })
    assert.equal(isFeaturedMcpApiKeyInstalled('tavily', agentDir), true)
    assert.throws(
      () => addRemoteMcpConnector('serpapi', 'https://example.com/mcp', agentDir),
      /官方地址/
    )

    config.mcpServers.tavily.enabled = true
    writeFileSync(path, JSON.stringify(config))
    assert.equal(isFeaturedMcpApiKeyInstalled('tavily', agentDir), false)
    disableFeaturedApiKeyAutoDiscovery(agentDir)
    config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(config.mcpServers.tavily, {
      type: 'http',
      url: 'https://mcp.tavily.com/mcp',
      enabled: false
    })
    config.mcpServers.tavily.headers = { Authorization: 'manual-value' }
    writeFileSync(path, JSON.stringify(config))
    assert.equal(isFeaturedMcpApiKeyInstalled('tavily', agentDir), false)
    disableFeaturedApiKeyAutoDiscovery(agentDir)
    config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(config.mcpServers.tavily.headers, { Authorization: 'manual-value' })
    assert.throws(
      () => addRemoteMcpConnector('tavily', 'https://mcp.tavily.com/mcp', agentDir),
      /自定义 MCP 配置/
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('API-key HTTP config keeps headers in memory and pins them to the endpoint origin', () => {
  assert.deepEqual(featuredApiKeyMcpConfig('serpapi', 'serp-secret'), {
    type: 'http',
    url: 'https://mcp.serpapi.com/mcp',
    headers: { Authorization: 'Bearer serp-secret' },
    headerPolicy: 'origin-locked',
    timeout: 10_000
  })
  assert.deepEqual(featuredApiKeyMcpConfig('browser-use', 'bu-secret').headers, {
    'x-browser-use-api-key': 'bu-secret'
  })
})
