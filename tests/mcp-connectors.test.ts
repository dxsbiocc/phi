import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  addRemoteMcpConnector,
  isInjectedMcpServer,
  listConnectorCatalog,
  mcpOAuthAuthorizationOrigin,
  readCustomRemoteMcpConnector,
  readRemoteMcpOAuthCredentials,
  removeRemoteMcpConnector,
  setMcpConnectorEnabled
} from '../src/main/agent/mcp-connectors'
import type { RemoteMcpConnectorOptions } from '../src/shared/mcpConnectorCatalog'
import { writeMcpRegistryFixture } from './helpers/mcpRegistryFixture'

test('connector catalog uses explicit registries, selects the newest version, and preserves version requirements', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-registry-catalog-'))
  try {
    assert.deepEqual(listConnectorCatalog({ agentDir, appVersion: '1.0.0' }), [])
    const manifest = (version: string): string => `schemaVersion: 1
id: catalog-fixture
type: mcp
version: ${version}
title: Catalog fixture
summary: Explicit registry fixture.
minAppVersion: 2.0.0
connector:
  transport: http
  publisher: Fixture
  category: 科研数据
  url: https://fixture.example/mcp
  auth: none
`
    const registry = writeMcpRegistryFixture(join(agentDir, 'registry'), [
      manifest('1.0.0'),
      manifest('1.1.0')
    ])
    const connectors = listConnectorCatalog({
      agentDir,
      appVersion: '1.0.0',
      registries: [registry]
    })
    assert.equal(connectors.length, 1)
    assert.equal(connectors[0].version, '1.1.0')
    assert.equal(connectors[0].signIn, '无需登录')
    assert.equal(connectors[0].added, false)
    assert.equal(connectors[0].unavailableReason, '需要 Phi 2.0.0 或更高版本')
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('cBioPortal OAuth is restricted to the official database MCP endpoint', () => {
  assert.equal(
    mcpOAuthAuthorizationOrigin('cbioportal', 'https://mcp.cbioportal.org/db/mcp'),
    'https://mcp.cbioportal.org'
  )
  for (const url of [
    'https://other.example/db/mcp',
    'https://mcp.cbioportal.org/navigator/mcp',
    'https://user:pass@mcp.cbioportal.org/db/mcp'
  ]) {
    assert.equal(mcpOAuthAuthorizationOrigin('cbioportal', url), undefined)
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

test('custom OAuth credentials are normalized, stored privately, and excluded from catalog summaries', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-custom-oauth-'))
  const path = join(agentDir, 'mcp.json')
  const url = 'https://mcp.cbioportal.org/db/mcp'
  try {
    writeFileSync(
      path,
      JSON.stringify({ settings: { keep: true }, mcpServers: { local: { command: 'existing' } } })
    )
    const options = {
      oauth: { clientId: '  private-client  ', clientSecret: '  private-secret  ' }
    }
    addRemoteMcpConnector('cbioportal', url, agentDir, options)
    const config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(config.mcpServers.cbioportal, {
      type: 'http',
      url,
      enabled: true,
      oauth: { clientId: 'private-client', clientSecret: 'private-secret' }
    })
    assert.deepEqual(config.settings, { keep: true })
    assert.deepEqual(config.mcpServers.local, { command: 'existing' })
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.deepEqual(
      readRemoteMcpOAuthCredentials('cbioportal', url, agentDir),
      config.mcpServers.cbioportal.oauth
    )
    const catalog = JSON.stringify(
      listConnectorCatalog({
        agentDir,
        appVersion: '1.0.0',
        registries: [
          writeMcpRegistryFixture(join(agentDir, 'registry'), [
            'schemaVersion: 1\nid: cbioportal\ntype: mcp\nversion: 1.0.0\ntitle: OAuth fixture\nsummary: Credential redaction fixture.\nconnector:\n  transport: http\n  publisher: Fixture\n  category: 健康与生命科学\n  url: https://mcp.cbioportal.org/db/mcp\n  auth: oauth\n'
          ])
        ]
      })
    )
    assert.ok(catalog.includes('cbioportal'))
    assert.equal(catalog.includes('private-client'), false)
    assert.equal(catalog.includes('private-secret'), false)
    addRemoteMcpConnector('cbioportal', url, agentDir, options)
    addRemoteMcpConnector('cbioportal', url, agentDir)
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), config)
    assert.throws(
      () =>
        addRemoteMcpConnector('cbioportal', url, agentDir, {
          oauth: { clientId: 'different-client' }
        }),
      /不同认证信息/
    )
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), config)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('OAuth setup accepts an ID without secret and omits empty optional fields', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-custom-oauth-'))
  const path = join(agentDir, 'mcp.json')
  try {
    addRemoteMcpConnector('public-client', 'https://example.test/mcp', agentDir, {
      oauth: { clientId: 'client', clientSecret: ' ' }
    })
    addRemoteMcpConnector('no-auth', 'https://public.test/mcp', agentDir, {
      oauth: { clientId: ' ', clientSecret: '' }
    })
    const config = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(config.mcpServers['public-client'].oauth, { clientId: 'client' })
    assert.deepEqual(config.mcpServers['no-auth'], {
      type: 'http',
      url: 'https://public.test/mcp',
      enabled: true
    })
    assert.throws(
      () =>
        addRemoteMcpConnector('no-auth', 'https://public.test/mcp', agentDir, {
          oauth: { clientId: 'client' }
        }),
      /不同认证信息/
    )
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).mcpServers['no-auth'].oauth, undefined)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('invalid OAuth setup is rejected before writing, without echoing the credential', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-custom-oauth-'))
  try {
    const invalid: unknown[] = [
      null,
      [],
      'private-value',
      { header: 'private-value' },
      { oauth: null },
      { oauth: [] },
      { oauth: 'private-value' },
      { oauth: { scope: 'private-value' } },
      { oauth: { clientId: 123 } },
      { oauth: { clientSecret: true } },
      { oauth: { clientId: null } },
      { oauth: { clientId: ' ', clientSecret: 'private-value' } },
      { oauth: { clientId: 'private-value\n' } },
      { oauth: { clientId: 'private-value\r' } },
      { oauth: { clientId: 'private-value\u0000' } },
      { oauth: { clientId: 'client', clientSecret: 'private-value\n' } },
      { oauth: { clientId: 'x'.repeat(1025) } },
      { oauth: { clientId: 'client', clientSecret: 'x'.repeat(4097) } },
      { expectedOAuth: 'private-value' },
      { expectedOAuth: { clientId: 123 } },
      { expectedOAuth: { clientId: 'client', clientSecret: 'private-value\n' } },
      { expectedOAuth: { clientSecret: 'private-value' } },
      { expectedOAuth: { clientId: 'client', scope: 'private-value' } }
    ]
    for (const options of invalid) {
      assert.throws(
        () =>
          addRemoteMcpConnector(
            'custom',
            'https://example.test/mcp',
            agentDir,
            options as RemoteMcpConnectorOptions
          ),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal(error.message.includes('private-value'), false)
          return /OAuth|认证设置/.test(error.message)
        }
      )
      assert.equal(existsSync(join(agentDir, 'mcp.json')), false)
    }
    assert.throws(
      () =>
        addRemoteMcpConnector('tavily', 'https://mcp.tavily.com/mcp', agentDir, {
          oauth: { clientId: 'client' }
        }),
      /使用 API key/
    )
    assert.equal(existsSync(join(agentDir, 'mcp.json')), false)
    addRemoteMcpConnector('tavily', 'https://mcp.tavily.com/mcp', agentDir)
    assert.equal(
      JSON.parse(readFileSync(join(agentDir, 'mcp.json'), 'utf8')).mcpServers.tavily.enabled,
      false
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('featured login selects only matching saved OAuth endpoints and rejects ambiguous aliases', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-custom-oauth-'))
  const url = 'https://mcp.cbioportal.org/db/mcp'
  try {
    addRemoteMcpConnector('my-cbioportal', url, agentDir, { oauth: { clientId: 'alias-client' } })
    addRemoteMcpConnector('unrelated', 'https://other.test/mcp', agentDir, {
      oauth: { clientId: 'other-client' }
    })
    assert.deepEqual(readRemoteMcpOAuthCredentials('cbioportal', url, agentDir), {
      clientId: 'alias-client'
    })
    assert.equal(
      readRemoteMcpOAuthCredentials('cbioportal', 'https://unconfigured.test/mcp', agentDir),
      undefined
    )
    addRemoteMcpConnector('second-cbioportal', url, agentDir, {
      oauth: { clientId: 'second-client' }
    })
    assert.throws(
      () => readRemoteMcpOAuthCredentials('cbioportal', url, agentDir),
      /多个 OAuth 配置/
    )
    assert.deepEqual(readRemoteMcpOAuthCredentials('my-cbioportal', url, agentDir), {
      clientId: 'alias-client'
    })
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('custom authorization reads only the exact saved HTTP entry with an OAuth client ID', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-custom-auth-'))
  const url = 'https://example.test/mcp'
  try {
    addRemoteMcpConnector('custom', url, agentDir, {
      oauth: { clientId: 'client', clientSecret: 'secret' }
    })
    assert.deepEqual(readCustomRemoteMcpConnector(' custom ', agentDir), {
      name: 'custom',
      url,
      oauth: { clientId: 'client', clientSecret: 'secret' }
    })
    assert.throws(() => readCustomRemoteMcpConnector('missing', agentDir), /已保存/)
    for (const entry of [
      { type: 'http', url },
      { type: 'http', url, oauth: { clientSecret: 'secret' } },
      { type: 'http', url, oauth: { clientId: 'client' }, phiPackage: 'custom' },
      { type: 'http', url, oauth: { clientId: 'client' }, command: 'exec' },
      { type: 'http', url, oauth: { clientId: 'client' }, auth: { type: 'apikey' } },
      { type: 'stdio', command: 'exec', oauth: { clientId: 'client' } }
    ]) {
      writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { custom: entry } }))
      assert.throws(() => readCustomRemoteMcpConnector('custom', agentDir), /自定义|Client ID/)
    }
    addRemoteMcpConnector('tavily', 'https://mcp.tavily.com/mcp', agentDir)
    assert.throws(() => readCustomRemoteMcpConnector('tavily', agentDir), /自定义/)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('an optimistic add retry can correct OAuth credentials and clear them without changing other fields', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-oauth-retry-'))
  const path = join(agentDir, 'mcp.json')
  const url = 'https://example.test/mcp'
  try {
    const first = { clientId: 'first-id', clientSecret: 'bad-secret' }
    const corrected = { clientId: 'correct-id', clientSecret: 'correct-secret' }
    addRemoteMcpConnector('custom', url, agentDir, { oauth: first })
    const config = JSON.parse(readFileSync(path, 'utf8'))
    config.settings = { keep: true }
    config.disabledServers = ['custom']
    config.mcpServers.other = { command: 'other-server' }
    config.mcpServers.custom = {
      ...config.mcpServers.custom,
      enabled: false,
      timeout: 30000,
      headers: { 'X-Custom': 'keep' }
    }
    writeFileSync(path, JSON.stringify(config))

    addRemoteMcpConnector('custom', url, agentDir, { oauth: corrected, expectedOAuth: first })
    const updated = JSON.parse(readFileSync(path, 'utf8'))
    assert.deepEqual(updated, {
      ...config,
      mcpServers: {
        ...config.mcpServers,
        custom: { ...config.mcpServers.custom, oauth: corrected }
      }
    })
    assert.equal(statSync(path).mode & 0o777, 0o600)
    assert.throws(
      () => addRemoteMcpConnector('custom', url, agentDir, { oauth: first }),
      /不同认证信息/
    )

    addRemoteMcpConnector('custom', url, agentDir, { expectedOAuth: corrected })
    const cleared = JSON.parse(readFileSync(path, 'utf8'))
    const expectedCustom = { ...config.mcpServers.custom }
    delete expectedCustom.oauth
    assert.deepEqual(cleared, {
      ...config,
      mcpServers: { ...config.mcpServers, custom: expectedCustom }
    })
    addRemoteMcpConnector('custom', url, agentDir, { oauth: corrected, expectedOAuth: null })
    assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), updated)
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})

test('OAuth add retry rejects stale guards, missing entries, package entries and changed URLs', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-oauth-retry-'))
  const path = join(agentDir, 'mcp.json')
  const url = 'https://example.test/mcp'
  const first = { clientId: 'first-id', clientSecret: 'first-secret' }
  const next = { clientId: 'next-id', clientSecret: 'next-secret' }
  try {
    assert.throws(
      () => addRemoteMcpConnector('custom', url, agentDir, { oauth: next, expectedOAuth: null }),
      /配置已变化/
    )
    assert.equal(existsSync(path), false)
    for (const entry of [
      { type: 'http', url, enabled: true, oauth: next },
      { type: 'http', url, enabled: true, oauth: { ...first, scope: 'changed' } },
      { type: 'http', url: 'https://changed.test/mcp', enabled: true, oauth: first },
      { type: 'http', url, enabled: true, oauth: first, phiPackage: 'custom' },
      { type: 'http', url, enabled: true, oauth: first, command: 'exec' },
      { type: 'http', url, enabled: true, oauth: first, auth: { type: 'apikey' } }
    ]) {
      writeFileSync(path, JSON.stringify({ mcpServers: { custom: entry } }))
      const before = readFileSync(path, 'utf8')
      assert.throws(
        () => addRemoteMcpConnector('custom', url, agentDir, { oauth: next, expectedOAuth: first }),
        /配置已变化/
      )
      assert.equal(readFileSync(path, 'utf8'), before)
    }
    writeFileSync(
      path,
      JSON.stringify({ mcpServers: { custom: { type: 'http', url, oauth: first } } })
    )
    assert.throws(
      () => addRemoteMcpConnector('custom', url, agentDir, { oauth: next, expectedOAuth: null }),
      /配置已变化/
    )
    addRemoteMcpConnector('tavily', 'https://mcp.tavily.com/mcp', agentDir)
    assert.throws(
      () =>
        addRemoteMcpConnector('tavily', 'https://mcp.tavily.com/mcp', agentDir, {
          expectedOAuth: null
        }),
      /配置已变化/
    )
  } finally {
    rmSync(agentDir, { recursive: true, force: true })
  }
})
