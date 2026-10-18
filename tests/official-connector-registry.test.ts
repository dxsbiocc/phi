import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { readMcpConfig } from '../src/main/agent/mcp/package-config'
import { installPackages } from '../src/main/agent/packages/installer'
import { isRecord } from '../src/main/agent/packages/installer-utils'
import { fetchOfficialConnectorPackages } from '../src/main/agent/packages/official-connector-client'
import {
  isOfficialConnectorRegistryDirectory,
  officialConnectorRegistryDirectory,
  readOfficialConnectorRegistry,
  syncOfficialConnectorRegistry
} from '../src/main/agent/packages/official-connector-registry'
import { readRegistryManifestAsset } from '../src/main/agent/packages/manifest-assets'
import { mcpVersionDir } from '../src/main/agent/packages/mcp-store'
import { planInstall } from '../src/main/agent/packages/planning'
import { registryKeyId, signRegistryIndex } from '../src/main/agent/packages/signature'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
const icon = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==',
  'base64'
)

function fixture(count = 1): {
  agentDir: string
  requests: string[]
  items: Array<Record<string, unknown>>
  details: Map<string, Record<string, unknown>>
  options: Parameters<typeof syncOfficialConnectorRegistry>[0]
  setOffline: () => void
} {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-official-connectors-'))
  roots.push(agentDir)
  const requests: string[] = []
  const items = Array.from({ length: count }, (_, index) => ({
    id: index === 0 ? 'browser-use' : `connector-${index}`,
    version: '1.0.1',
    category: '科研数据',
    auth: 'header',
    transport: 'http',
    catalogInstallable: true,
    directoryAuthBlocked: false,
    ...(index === 0
      ? { iconUrl: 'https://phi.omicsagent.cn/packages/resources/connectors/browser-use/icon.png' }
      : {}),
    api: 'https://evil.example/api',
    packageUrl: 'https://evil.example/install.tar.gz'
  }))
  const details = new Map<string, Record<string, unknown>>(
    items.map((item) => [
      item.id,
      {
        kind: 'mcp',
        slug: item.id,
        version: item.version,
        category: item.category,
        auth: item.auth,
        transport: item.transport,
        catalogInstallable: true,
        directoryAuthBlocked: false,
        iconUrl: item.iconUrl,
        packageUrl: 'https://evil.example/run.sh',
        package: {
          schemaVersion: 1,
          id: item.id,
          type: 'mcp',
          version: item.version,
          title: item.id,
          summary: 'API connector fixture',
          connector: {
            transport: 'http',
            publisher: 'Fixture',
            category: item.category,
            url: `https://${item.id}.example/mcp`,
            auth: 'header'
          }
        }
      }
    ])
  )
  let offline = false
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push(url)
    if (offline) throw new Error('offline')
    assert.equal(init?.redirect, 'error')
    if (url.startsWith('https://phi.omicsagent.cn/api/mcp?')) {
      const page = Number(new URL(url).searchParams.get('page'))
      return Response.json({
        items: items.slice((page - 1) * 100, page * 100),
        total: items.length,
        page,
        pageSize: 100,
        pageCount: Math.ceil(items.length / 100),
        categories: [{ name: '科研数据', count: items.length }],
        meta: { connectors: items.length, stdioServers: 0 }
      })
    }
    const detail = /^https:\/\/phi\.omicsagent\.cn\/api\/mcp\/([a-z0-9-]+)$/.exec(url)
    if (detail && details.has(detail[1])) return Response.json(details.get(detail[1]))
    if (url === 'https://phi.omicsagent.cn/packages/resources/connectors/browser-use/icon.png')
      return new Response(new Uint8Array(icon))
    return new Response(null, { status: 404 })
  }
  return {
    agentDir,
    requests,
    items,
    details,
    options: { agentDir, fetch: fetcher, forceRefresh: true, timeoutMs: 1000 },
    setOffline: () => {
      offline = true
    }
  }
}

test('cold connector API cache installs version 1.0.1 using only official metadata and icon endpoints', async () => {
  const f = fixture()
  const registry = await syncOfficialConnectorRegistry(f.options)
  assert.equal(registry.label, 'Phi 官网')
  assert.equal(registry.trust, 'imported')
  assert.equal(registry.kind, 'official')
  assert.equal(registry.id, 'phi-packages')
  assert.equal(registry.source, undefined)
  assert.equal(registry.packages[0].version, '1.0.1')
  assert.equal(isOfficialConnectorRegistryDirectory(registry.dir, f.agentDir), true)
  assert.ok(registry.packages[0].iconAsset)
  assert.deepEqual(
    f.requests.sort(),
    [
      'https://phi.omicsagent.cn/api/mcp/browser-use',
      'https://phi.omicsagent.cn/api/mcp?page=1&pageSize=100',
      'https://phi.omicsagent.cn/packages/resources/connectors/browser-use/icon.png'
    ].sort()
  )
  const manifest = readRegistryManifestAsset(registry.dir, registry.packages[0])
  assert.equal(manifest?.type, 'mcp')
  assert.equal(manifest?.version, '1.0.1')
  await installPackages(
    planInstall(registry, { type: 'mcp', id: 'browser-use' }, f.options),
    f.options
  )
  assert.equal(
    existsSync(join(mcpVersionDir('browser-use', '1.0.1', f.agentDir), 'phi-package.yaml')),
    true
  )
  const server = readMcpConfig(f.agentDir).mcpServers?.['browser-use']
  assert.ok(isRecord(server))
  assert.equal(server.url, 'https://browser-use.example/mcp')
  assert.equal(server.enabled, false)
})

test('repeated identical API contents keep the same immutable index hash and memo avoids requests', async () => {
  const f = fixture()
  const first = await syncOfficialConnectorRegistry(f.options)
  const second = await syncOfficialConnectorRegistry({
    ...f.options,
    now: () => new Date('2026-10-17T10:00:00Z')
  })
  assert.equal(second.dir, first.dir)
  assert.equal(second.generatedAt, '1970-01-01T00:00:00.000Z')
  const requestCount = f.requests.length
  assert.equal(
    (
      await syncOfficialConnectorRegistry({
        ...f.options,
        forceRefresh: false,
        now: () => new Date('2026-10-17T10:01:00Z')
      })
    ).dir,
    first.dir
  )
  assert.equal(f.requests.length, requestCount)
})

test('complete 27-item API catalog retains three authorization-restricted connectors and hashes their flags', async () => {
  const f = fixture(27)
  for (const [index, id] of ['gmail', 'google-drive', 'slack'].entries()) {
    const item = f.items[index + 24]
    const previousId = String(item.id)
    const detail = f.details.get(previousId)!
    item.id = id
    item.auth = 'oauth'
    item.directoryAuthBlocked = true
    detail.slug = id
    detail.auth = 'oauth'
    detail.directoryAuthBlocked = true
    const manifest = detail.package as Record<string, unknown>
    manifest.id = id
    ;(manifest.connector as Record<string, unknown>).auth = 'oauth'
    f.details.delete(previousId)
    f.details.set(id, detail)
  }
  const registry = await syncOfficialConnectorRegistry(f.options)
  assert.equal(registry.packages.length, 27)
  assert.equal(registry.source, undefined)
  assert.deepEqual(
    registry.packages.filter((entry) => entry.directoryAuthBlocked).map((entry) => entry.id),
    ['gmail', 'google-drive', 'slack']
  )
  const cached = readOfficialConnectorRegistry(registry.dir, { agentDir: f.agentDir })
  assert.equal(cached.packages.find((entry) => entry.id === 'gmail')?.directoryAuthBlocked, true)
  assert.equal(
    f.requests.some((url) => url.includes('github.com')),
    false
  )
  const gmail = f.items.find((item) => item.id === 'gmail')!
  gmail.directoryAuthBlocked = false
  f.details.get('gmail')!.directoryAuthBlocked = false
  const updated = await syncOfficialConnectorRegistry(f.options)
  assert.notEqual(updated.dir, registry.dir)
  assert.equal(updated.packages.find((entry) => entry.id === 'gmail')?.directoryAuthBlocked, false)
  assert.equal(
    updated.packages.find((entry) => entry.id === 'gmail')?.sha256,
    registry.packages.find((entry) => entry.id === 'gmail')?.sha256
  )
})

test('API version changes create a new generation without mutating the previous package', async () => {
  const f = fixture()
  const first = await syncOfficialConnectorRegistry(f.options)
  f.items[0].version = '1.0.2'
  const detail = f.details.get('browser-use')!
  detail.version = '1.0.2'
  ;(detail.package as Record<string, unknown>).version = '1.0.2'
  const updated = await syncOfficialConnectorRegistry(f.options)
  assert.notEqual(updated.dir, first.dir)
  assert.equal(updated.packages[0].version, '1.0.2')
  assert.equal(
    readOfficialConnectorRegistry(first.dir, { agentDir: f.agentDir }).packages[0].version,
    '1.0.1'
  )
})

test('offline API requests retain only fully verified imported connector cache contents', async () => {
  const f = fixture()
  const first = await syncOfficialConnectorRegistry(f.options)
  f.setOffline()
  const cached = await syncOfficialConnectorRegistry(f.options)
  assert.equal(cached.dir, first.dir)
  assert.equal(cached.status, 'cached')
  assert.equal(cached.trust, 'imported')
  assert.match(cached.notice ?? '', /API 内容缓存/)
  assert.equal(
    f.requests.some((url) => url.includes('github.com')),
    false
  )
})

test('archive corruption is rejected and repaired without losing the stable content generation', async () => {
  const f = fixture()
  const first = await syncOfficialConnectorRegistry(f.options)
  const path = join(first.dir, first.packages[0].archive)
  writeFileSync(path, 'corrupt')
  assert.throws(
    () => readOfficialConnectorRegistry(first.dir, { agentDir: f.agentDir }),
    /mismatch/
  )
  const repaired = await syncOfficialConnectorRegistry(f.options)
  assert.equal(repaired.dir, first.dir)
  assert.equal(
    readOfficialConnectorRegistry(repaired.dir, { agentDir: f.agentDir }).packages.length,
    1
  )
  const outside = join(f.agentDir, 'external-index')
  writeFileSync(outside, readFileSync(join(repaired.dir, 'index.json')))
  rmSync(join(repaired.dir, 'index.json'))
  symlinkSync(outside, join(repaired.dir, 'index.json'))
  assert.throws(
    () => readOfficialConnectorRegistry(repaired.dir, { agentDir: f.agentDir }),
    /symlink/
  )
})

test('cache root symlinks cannot redirect connector writes outside the managed directory', async () => {
  const f = fixture()
  const outside = join(f.agentDir, 'outside')
  mkdirSync(outside)
  const root = officialConnectorRegistryDirectory(f.agentDir)
  mkdirSync(join(root, '..'), { recursive: true })
  symlinkSync(outside, root)
  assert.throws(
    () => readOfficialConnectorRegistry(root, { agentDir: f.agentDir }),
    /symbolic link/
  )
  await assert.rejects(syncOfficialConnectorRegistry(f.options))
  assert.deepEqual(readdirSync(outside), [])
})

test('complete API pagination has bounded detail concurrency and does not select supplied package URLs', async () => {
  const f = fixture(101)
  const transport = f.options!.fetch!
  let active = 0
  let peak = 0
  const payloads = await fetchOfficialConnectorPackages({
    fetch: async (input, init) => {
      if (/\/api\/mcp\//.test(String(input))) {
        active++
        peak = Math.max(peak, active)
        await new Promise((resolve) => setTimeout(resolve, 1))
        try {
          return await transport(input, init)
        } finally {
          active--
        }
      }
      return transport(input, init)
    },
    timeoutMs: 5000
  })
  assert.equal(payloads.length, 101)
  assert.ok(peak <= 4)
  assert.equal(f.requests.filter((url) => url.includes('/api/mcp?')).length, 2)
  assert.ok(f.requests.every((url) => url.startsWith('https://phi.omicsagent.cn/')))
})

test('invalid API list identity, pagination, categories, and external icon sources are rejected', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.items[0].id = '../escape'
    },
    (f: ReturnType<typeof fixture>) => {
      f.items[0].iconUrl = 'https://evil.example/icon.png'
    },
    (f: ReturnType<typeof fixture>) => {
      f.items[0].version = 'not a version'
    },
    (f: ReturnType<typeof fixture>) => {
      f.items[0].category = 'Unknown category'
    }
  ]) {
    const f = fixture()
    mutate(f)
    await assert.rejects(fetchOfficialConnectorPackages(f.options))
    assert.equal(
      f.requests.some((url) => url.startsWith('https://evil')),
      false
    )
  }
  for (const value of [
    { items: [], total: 501, page: 1, pageSize: 100, pageCount: 6 },
    { items: [], total: 1, page: 2, pageSize: 100, pageCount: 1 }
  ])
    await assert.rejects(
      fetchOfficialConnectorPackages({ fetch: async () => Response.json(value) }),
      /分页/
    )
})

test('detail identity mismatches and incomplete dependency payloads never replace a valid API generation', async () => {
  const f = fixture()
  const first = await syncOfficialConnectorRegistry(f.options)
  ;(f.details.get('browser-use')!.package as Record<string, unknown>).version = '1.0.9'
  const cached = await syncOfficialConnectorRegistry(f.options)
  assert.equal(cached.dir, first.dir)
  assert.equal(cached.status, 'cached')
  assert.match(cached.notice ?? '', /不一致/)
})

test('unsupported stdio or dependency-bearing payloads explicitly fall back to the verified signed source', async () => {
  for (const mode of ['stdio', 'dependency'] as const) {
    const f = fixture()
    if (mode === 'stdio') f.items[0].transport = 'stdio'
    else
      (f.details.get('browser-use')!.package as Record<string, unknown>).dependsOn = [
        { id: 'helper-skill', type: 'skill', version: '^1.0.0' }
      ]
    const key = generateKeyPairSync('ed25519')
    const privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const index = Buffer.from(
      JSON.stringify({ schemaVersion: 1, generatedAt: new Date(0).toISOString(), packages: [] })
    )
    const signature = Buffer.from(JSON.stringify(signRegistryIndex(index, privateKey)))
    const transport = f.options!.fetch!
    const result = await syncOfficialConnectorRegistry({
      ...f.options,
      trustedKeys: [{ keyId: registryKeyId(publicKey), publicKey }],
      fetch: async (input, init) => {
        if (String(input).includes('github.com/')) {
          if (String(input).endsWith('/index.json')) return new Response(new Uint8Array(index))
          if (String(input).endsWith('/index.sig.json'))
            return new Response(new Uint8Array(signature))
        }
        return transport(input, init)
      }
    })
    assert.equal(result.trust, 'official')
    assert.match(result.notice ?? '', /签名发布目录/)
    assert.match(result.notice ?? '', mode === 'stdio' ? /stdio/ : /依赖/)
  }
})

test('unresponsive transports and oversized JSON or icon downloads stay bounded', async () => {
  await assert.rejects(
    fetchOfficialConnectorPackages({
      timeoutMs: 5,
      fetch: async () => new Promise<Response>(() => {})
    }),
    /超时/
  )
  await assert.rejects(
    fetchOfficialConnectorPackages({ fetch: async () => new Response(' '.repeat(512 * 1024 + 1)) }),
    /大小限制/
  )
  const f = fixture()
  const transport = f.options!.fetch!
  await assert.rejects(
    fetchOfficialConnectorPackages({
      fetch: async (input, init) =>
        String(input).includes('/icon.png')
          ? new Response(new Uint8Array(256 * 1024 + 1))
          : transport(input, init)
    }),
    /大小限制/
  )
})
