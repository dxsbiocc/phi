import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { stringify } from 'yaml'

import { listConnectorCatalog } from '../src/main/agent/mcp-connectors'
import { fetchOfficialConnectorPackages } from '../src/main/agent/packages/official-connector-client'
import { materializeRegistry } from '../src/main/agent/packages/materialize-registry'
import type { LocalRegistry } from '../src/main/agent/packages/installer-types'
import { readRegistry } from '../src/main/agent/packages/registry'
import { MCP_CONNECTOR_OVERVIEW_MAX_LENGTH } from '../src/shared/mcpConnectorCatalog'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

function fixture(): { agentDir: string; registry: (version: string) => LocalRegistry } {
  const root = mkdtempSync(join(tmpdir(), 'phi-mcp-api-source-'))
  roots.push(root)
  return {
    agentDir: join(root, 'agent'),
    registry(version) {
      const source = join(root, `source-${version}`)
      mkdirSync(source)
      writeFileSync(
        join(source, 'phi-package.yaml'),
        stringify({
          schemaVersion: 1,
          id: 'browser-use',
          type: 'mcp',
          version,
          title: 'Browser Use',
          summary: 'Run browser tasks',
          connector: {
            transport: 'http',
            publisher: 'Browser Use',
            category: '生产力',
            homepage: 'https://docs.browser-use.com',
            url: 'https://api.browser-use.com/v3/mcp',
            auth: 'header'
          }
        })
      )
      return materializeRegistry([source], join(root, `registry-${version}`), {
        id: `fixture-${version}`,
        allowedTypes: ['mcp']
      })
    }
  }
}

test('the managed website API source is shown as Phi official with its real unsigned trust', () => {
  const f = fixture()
  const api = {
    ...f.registry('1.0.1'),
    id: 'phi-packages',
    kind: 'official' as const,
    label: 'Phi 官网'
  }
  const user = f.registry('9.0.0')
  const entries = listConnectorCatalog({
    agentDir: f.agentDir,
    appVersion: '0.1.0',
    registries: [user, api]
  })
  assert.equal(entries.length, 1)
  assert.equal(entries[0].version, '1.0.1')
  assert.deepEqual(entries[0].source, {
    kind: 'official',
    label: 'Phi 官网',
    trust: 'imported'
  })
  assert.equal(entries[0].registryDir, api.dir)
})

test('user GitHub sources retain their real upstream provenance', () => {
  const f = fixture()
  const imported = {
    ...f.registry('1.0.0'),
    source: {
      kind: 'github' as const,
      id: 'custom-source',
      repo: 'acme/connectors',
      sha: 'a'.repeat(40)
    }
  }
  const entry = listConnectorCatalog({
    agentDir: f.agentDir,
    appVersion: '0.1.0',
    registries: [imported]
  })[0]
  assert.equal(entry.source?.kind, 'github')
  assert.equal(entry.source?.label, 'GitHub · acme/connectors@aaaaaaa')
  assert.equal(entry.source?.trust, 'imported')
})

test('API entries whose authorization is blocked are hidden from the catalog unless configured', () => {
  const f = fixture()
  const registry = f.registry('1.0.1')
  const indexFile = join(registry.dir, 'index.json')
  const index = JSON.parse(readFileSync(indexFile, 'utf8'))
  index.packages[0].directoryAuthBlocked = true
  writeFileSync(indexFile, JSON.stringify(index))
  const api = {
    ...readRegistry(registry.dir),
    id: 'phi-packages',
    kind: 'official' as const,
    label: 'Phi 官网'
  }
  const entries = listConnectorCatalog({
    agentDir: f.agentDir,
    appVersion: '0.1.0',
    registries: [api]
  })
  assert.equal(entries.length, 0)
})

test('official website catalog entries carry the overview while other sources do not', () => {
  const f = fixture()
  const overview = '### 服务概览\n\n- 使用 **浏览器** 完成任务'
  const registry = f.registry('1.0.1')
  const official = {
    ...registry,
    id: 'phi-packages',
    kind: 'official' as const,
    label: 'Phi 官网',
    packages: registry.packages.map((entry) => ({ ...entry, overview }))
  }
  const [websiteEntry] = listConnectorCatalog({
    agentDir: f.agentDir,
    appVersion: '0.1.0',
    registries: [official]
  })
  assert.equal(websiteEntry.overview, overview)

  const imported = f.registry('1.0.0')
  const [importedEntry] = listConnectorCatalog({
    agentDir: f.agentDir,
    appVersion: '0.1.0',
    registries: [
      { ...imported, packages: imported.packages.map((entry) => ({ ...entry, overview })) }
    ]
  })
  assert.equal(importedEntry.overview, undefined)
})

function connectorApi(overview?: unknown): ReturnType<typeof fetchOfficialConnectorPackages> {
  const origin = 'https://phi.omicsagent.cn'
  const item = {
    id: 'browser-use',
    version: '1.0.1',
    category: '科研数据',
    auth: 'header',
    transport: 'http',
    catalogInstallable: true,
    directoryAuthBlocked: false
  }
  const detail = {
    kind: 'mcp',
    slug: item.id,
    version: item.version,
    category: item.category,
    auth: item.auth,
    transport: item.transport,
    catalogInstallable: true,
    directoryAuthBlocked: false,
    package: {
      schemaVersion: 1,
      id: item.id,
      type: 'mcp',
      version: item.version,
      title: 'Browser Use',
      summary: 'Run browser tasks',
      connector: {
        transport: 'http',
        publisher: 'Fixture',
        category: item.category,
        url: 'https://browser-use.example/mcp',
        auth: 'header'
      }
    },
    ...(overview !== undefined ? { overview } : {})
  }
  return fetchOfficialConnectorPackages({
    timeoutMs: 1000,
    fetch: async (input) => {
      const url = String(input)
      if (url.startsWith(`${origin}/api/mcp?`))
        return Response.json({
          items: [item],
          total: 1,
          page: 1,
          pageSize: 100,
          pageCount: 1,
          categories: [{ name: '科研数据', count: 1 }],
          meta: { connectors: 1, stdioServers: 0 }
        })
      if (url === `${origin}/api/mcp/${item.id}`) return Response.json(detail)
      return new Response(null, { status: 404 })
    }
  })
}

test('official website overview is optional, string-only, trimmed, and capped', async () => {
  const present = await connectorApi('  ### 服务概览\n\n- 使用 **浏览器** 完成任务\n')
  assert.equal(present.packages.length, 1)
  assert.equal(present.packages[0].overview, '### 服务概览\n\n- 使用 **浏览器** 完成任务')
  assert.equal(present.notices.length, 0)

  for (const value of [undefined, null, 42, { text: 'not a string' }]) {
    const absent = await connectorApi(value)
    assert.equal(absent.packages.length, 1)
    assert.equal(absent.packages[0].overview, undefined)
    assert.equal(absent.notices.length, 0)
  }

  const overCap = await connectorApi('概'.repeat(MCP_CONNECTOR_OVERVIEW_MAX_LENGTH + 1))
  assert.equal(overCap.packages.length, 1)
  assert.equal(overCap.packages[0].overview, '概'.repeat(MCP_CONNECTOR_OVERVIEW_MAX_LENGTH))
  assert.equal(overCap.notices.length, 0)
})
