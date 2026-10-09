import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import type { LocalRegistry } from '../../src/main/agent/packages/installer-types'
import { listConnectorCatalog } from '../../src/main/agent/mcp-connectors'
import { findResourceIcon, readResourceIcon } from '../../src/main/agent/resource-icons'
import { mcpConnectorCategories } from '../../src/shared/mcpConnectorCatalog'
import { packageContentPath } from '../helpers/packageContent'
import { writeMcpRegistryFixture } from '../helpers/mcpRegistryFixture'

function publicConnectorRegistry(root: string): LocalRegistry {
  const connectors = packageContentPath('connectors')
  return writeMcpRegistryFixture(
    root,
    readdirSync(connectors, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => readFileSync(join(connectors, entry.name, 'phi-package.yaml'), 'utf8'))
  )
}

test('curated connector directory has distinct HTTPS services in every group', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-catalog-'))
  try {
    const connectors = listConnectorCatalog({
      agentDir,
      appVersion: '1.0.0',
      registries: [publicConnectorRegistry(join(agentDir, 'registry'))]
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
    const cbioportal = connectors.find((connector) => connector.id === 'cbioportal')
    assert.equal(cbioportal?.url, 'https://mcp.cbioportal.org/db/mcp')
    assert.equal(cbioportal?.category, '健康与生命科学')
    assert.equal(cbioportal?.auth, 'oauth')
    assert.equal(cbioportal?.signIn, '需要登录')
    assert.equal(cbioportal?.oauthAuthorizationOrigin, 'https://mcp.cbioportal.org')
    assert.equal(cbioportal?.added, false)
    assert.deepEqual(
      connectors
        .filter((connector) => connector.oauthAuthorizationOrigin)
        .map((connector) => [connector.id, connector.oauthAuthorizationOrigin] as const)
        .sort(([left], [right]) => left.localeCompare(right)),
      [
        ['biorender', 'https://mcp.services.biorender.com'],
        ['canva', 'https://mcp.canva.com'],
        ['cbioportal', 'https://mcp.cbioportal.org'],
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

test('registry catalog enriches official API key packages without putting secrets in manifests', () => {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-mcp-api-catalog-'))
  try {
    const connectors = listConnectorCatalog({
      agentDir,
      appVersion: '1.0.0',
      registries: [publicConnectorRegistry(join(agentDir, 'registry'))]
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

test('supplied public connector logos resolve safely and optional logos retain the fallback', () => {
  const connectors = packageContentPath('connectors')
  const directories = readdirSync(connectors, { withFileTypes: true }).filter((entry) =>
    entry.isDirectory()
  )
  assert.ok(directories.length > 0)
  let checked = 0
  for (const directory of directories) {
    const root = join(connectors, directory.name)
    const hasLogo = readdirSync(root).some((name) => /^icon\.(svg|png|webp|jpg|jpeg)$/.test(name))
    const icon = findResourceIcon(root)
    if (!hasLogo) {
      assert.equal(icon, undefined, directory.name)
      continue
    }
    assert.ok(icon, directory.name)
    checked += 1
    assert.match(
      readResourceIcon(icon.key) ?? '',
      /^data:image\/(svg\+xml|png|jpeg|webp);base64,/,
      directory.name
    )
  }
  assert.ok(checked > 0, 'the source must exercise actual supplied logos')
})
