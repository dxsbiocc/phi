import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  getCachedOfficialRegistry,
  officialRegistryDirectory,
  prepareOfficialPackageInstall,
  syncOfficialRegistry
} from '../src/main/agent/packages/official-registry'
import { readRegistryManifestAsset } from '../src/main/agent/packages/manifest-assets'
import { registryKeyId, signRegistryIndex } from '../src/main/agent/packages/signature'
import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import { planInstall } from '../src/main/agent/packages/planning'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
const keyPair = generateKeyPairSync('ed25519')
const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
const trustedKeys = [{ keyId: registryKeyId(publicKey), publicKey }]
const baseUrl = 'https://example.test/catalog/'
const digest = (data: Buffer): string => createHash('sha256').update(data).digest('hex')

function fixture(): {
  agentDir: string
  requests: string[]
  assets: Map<string, Buffer>
  options: Parameters<typeof syncOfficialRegistry>[0]
} {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-official-source-'))
  roots.push(agentDir)
  const assets = new Map<string, Buffer>()
  const requests: string[] = []
  const connector = Buffer.from(
    `schemaVersion: 1\nid: demo-connector\ntype: mcp\nversion: 1.0.0\ntitle: Demo\nsummary: Demo connector\nconnector:\n  transport: http\n  publisher: Phi\n  category: 科研数据\n  homepage: https://example.test\n  url: https://example.test/mcp\n  auth: none\n`
  )
  const icon = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>'
  )
  const entries = [
    {
      id: 'demo-connector',
      type: 'mcp',
      dependsOn: [{ id: 'helper-skill', type: 'skill', version: '^1.0.0' }],
      manifestAsset: {
        path: 'mcp-demo-connector-1.0.0.yaml',
        sha256: digest(connector),
        size: connector.length
      },
      iconAsset: { path: 'mcp-demo-connector-1.0.0.svg', sha256: digest(icon), size: icon.length }
    },
    { id: 'helper-skill', type: 'skill', dependsOn: [] },
    { id: 'unused-skill', type: 'skill', dependsOn: [] }
  ].map((entry) => {
    const archive = `${entry.type}-${entry.id}-1.0.0.tar.gz`
    const data =
      entry.type === 'mcp'
        ? createDeterministicTarGz([{ path: 'phi-package.yaml', data: connector }])
        : createDeterministicTarGz([
            {
              path: 'SKILL.md',
              data: Buffer.from(
                `---\nname: ${entry.id}\ndescription: fixture\nphi:\n  environment: phi:python@1\n---\n# Fixture\n`
              )
            }
          ])
    assets.set(archive, data)
    return {
      ...entry,
      version: '1.0.0',
      title: entry.id,
      summary: entry.id,
      archive,
      sha256: digest(data),
      size: data.length
    }
  })
  const index = Buffer.from(
    JSON.stringify({ schemaVersion: 1, generatedAt: '2026-10-08T00:00:00Z', packages: entries })
  )
  assets.set('index.json', index)
  assets.set('index.sig.json', Buffer.from(JSON.stringify(signRegistryIndex(index, privateKey))))
  assets.set('mcp-demo-connector-1.0.0.yaml', connector)
  assets.set('mcp-demo-connector-1.0.0.svg', icon)
  const fetcher: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname.split('/').at(-1)!
    requests.push(path)
    const data = assets.get(path)
    return data
      ? new Response(new Uint8Array(data), { status: 200 })
      : new Response(null, { status: 404 })
  }
  return { agentDir, assets, requests, options: { agentDir, baseUrl, trustedKeys, fetch: fetcher } }
}

test('catalog sync verifies signed metadata and icons without downloading archives', async () => {
  const f = fixture()
  const registry = await syncOfficialRegistry(f.options)
  assert.equal(registry.id, 'phi-packages')
  assert.equal(registry.trust, 'official')
  assert.equal(registry.packages.length, 3)
  assert.ok(registry.dir.startsWith(join(officialRegistryDirectory(f.agentDir), 'generations')))
  assert.deepEqual(f.requests.sort(), [
    'index.json',
    'index.sig.json',
    'mcp-demo-connector-1.0.0.svg',
    'mcp-demo-connector-1.0.0.yaml'
  ])
  assert.equal(readRegistryManifestAsset(registry.dir, registry.packages[0])?.id, 'demo-connector')
  assert.equal(getCachedOfficialRegistry({ agentDir: f.agentDir, trustedKeys })?.dir, registry.dir)
})

test('installation downloads only selected dependency closure and reuses verified archives', async () => {
  const f = fixture()
  const registry = await syncOfficialRegistry(f.options)
  f.requests.length = 0
  assert.deepEqual(
    planInstall(
      registry,
      { type: 'mcp', id: 'demo-connector' },
      { agentDir: f.agentDir, appVersion: '1.0.0' }
    ).environments,
    []
  )
  await prepareOfficialPackageInstall(
    registry,
    { type: 'mcp', id: 'demo-connector' },
    { ...f.options, appVersion: '1.0.0' }
  )
  assert.deepEqual(f.requests.sort(), [
    'mcp-demo-connector-1.0.0.tar.gz',
    'skill-helper-skill-1.0.0.tar.gz'
  ])
  assert.deepEqual(
    planInstall(
      registry,
      { type: 'mcp', id: 'demo-connector' },
      { agentDir: f.agentDir, appVersion: '1.0.0' }
    ).environments,
    ['phi:python@1']
  )
  f.requests.length = 0
  await prepareOfficialPackageInstall(
    registry,
    { type: 'mcp', id: 'demo-connector' },
    { ...f.options, appVersion: '1.0.0' }
  )
  assert.deepEqual(f.requests, [])
  assert.equal(existsSync(join(registry.dir, 'skill-unused-skill-1.0.0.tar.gz')), false)
})

test('offline use requires a verified current generation', async () => {
  const f = fixture()
  const registry = await syncOfficialRegistry(f.options)
  const offline: typeof fetch = async () => {
    throw new Error('offline')
  }
  assert.equal(
    (await syncOfficialRegistry({ ...f.options, fetch: offline, forceRefresh: true })).dir,
    registry.dir
  )
  writeFileSync(join(registry.dir, 'index.json'), '{}')
  assert.equal(getCachedOfficialRegistry({ agentDir: f.agentDir, trustedKeys }), undefined)
  await assert.rejects(
    syncOfficialRegistry({ ...f.options, fetch: offline, forceRefresh: true }),
    /offline/
  )
})

test('unknown signing keys never activate a cache or gain official trust', async () => {
  const f = fixture()
  await assert.rejects(syncOfficialRegistry({ ...f.options, trustedKeys: [] }), /trust|签名|信任/i)
  assert.equal(getCachedOfficialRegistry({ agentDir: f.agentDir, trustedKeys }), undefined)
})

test('sidecar corruption cannot replace the active generation', async () => {
  const f = fixture()
  const first = await syncOfficialRegistry(f.options)
  const original = JSON.parse(f.assets.get('index.json')!.toString())
  original.generatedAt = '2026-10-09T00:00:00Z'
  const next = Buffer.from(JSON.stringify(original))
  f.assets.set('index.json', next)
  f.assets.set('index.sig.json', Buffer.from(JSON.stringify(signRegistryIndex(next, privateKey))))
  f.assets.set('mcp-demo-connector-1.0.0.svg', Buffer.from('tampered'))
  assert.equal((await syncOfficialRegistry({ ...f.options, forceRefresh: true })).dir, first.dir)
  assert.equal(getCachedOfficialRegistry({ agentDir: f.agentDir, trustedKeys })?.dir, first.dir)
})

test('a corrupted or oversized archive is never materialized for installation', async () => {
  const f = fixture()
  const registry = await syncOfficialRegistry(f.options)
  f.assets.set('mcp-demo-connector-1.0.0.tar.gz', Buffer.from('bad'))
  await assert.rejects(
    prepareOfficialPackageInstall(
      registry,
      { type: 'mcp', id: 'demo-connector' },
      { ...f.options, appVersion: '1.0.0' }
    ),
    /size|校验|大小|checksum/i
  )
  assert.equal(existsSync(join(registry.dir, 'mcp-demo-connector-1.0.0.tar.gz')), false)
})

test('cache symlinks cannot redirect registry writes outside the managed root', async () => {
  const f = fixture()
  const outside = mkdtempSync(join(tmpdir(), 'phi-official-outside-'))
  roots.push(outside)
  mkdirSync(join(f.agentDir, 'cache', 'registries'), { recursive: true })
  symlinkSync(outside, officialRegistryDirectory(f.agentDir))
  await assert.rejects(syncOfficialRegistry(f.options), /symbolic|symlink|符号/i)
  assert.equal(existsSync(join(outside, 'current.json')), false)
})

test('cached metadata symlinks and path traversal are rejected', async () => {
  const f = fixture()
  const registry = await syncOfficialRegistry(f.options)
  const path = join(registry.dir, 'mcp-demo-connector-1.0.0.yaml')
  const data = readFileSync(path)
  const outside = join(f.agentDir, 'outside.yaml')
  writeFileSync(outside, data)
  rmSync(path)
  symlinkSync(outside, path)
  assert.equal(getCachedOfficialRegistry({ agentDir: f.agentDir, trustedKeys }), undefined)
  const value = JSON.parse(f.assets.get('index.json')!.toString())
  value.packages[0].archive = '../escape.tar.gz'
  const index = Buffer.from(JSON.stringify(value))
  f.assets.set('index.json', index)
  f.assets.set('index.sig.json', Buffer.from(JSON.stringify(signRegistryIndex(index, privateKey))))
  await assert.rejects(syncOfficialRegistry(f.options), /path|路径/i)
})

test('simultaneous and repeated catalog calls reuse one verified refresh', async () => {
  const f = fixture()
  const [left, right] = await Promise.all([
    syncOfficialRegistry(f.options),
    syncOfficialRegistry(f.options)
  ])
  assert.equal(left.dir, right.dir)
  assert.equal(f.requests.filter((path) => path === 'index.json').length, 1)
  f.requests.length = 0
  await syncOfficialRegistry(f.options)
  assert.deepEqual(f.requests, [])
  await syncOfficialRegistry({ ...f.options, forceRefresh: true })
  assert.deepEqual(f.requests.sort(), ['index.json', 'index.sig.json'])
})

test('a valid refresh repairs corrupted managed metadata without accepting corrupt cache', async () => {
  const f = fixture()
  const first = await syncOfficialRegistry(f.options)
  writeFileSync(join(first.dir, 'mcp-demo-connector-1.0.0.yaml'), 'damaged')
  assert.equal(getCachedOfficialRegistry({ agentDir: f.agentDir, trustedKeys }), undefined)
  const repaired = await syncOfficialRegistry({ ...f.options, forceRefresh: true })
  assert.equal(repaired.dir, first.dir)
  assert.equal(readRegistryManifestAsset(repaired.dir, repaired.packages[0])?.id, 'demo-connector')
})

test('unresponsive transport times out without activating a partial generation', async () => {
  const f = fixture()
  const stalled: typeof fetch = async () => new Promise<Response>(() => {})
  await assert.rejects(
    syncOfficialRegistry({ ...f.options, fetch: stalled, timeoutMs: 10 }),
    /timed out/
  )
  assert.equal(getCachedOfficialRegistry({ agentDir: f.agentDir, trustedKeys }), undefined)
})

test('offline catalog reads share a failed refresh window without marking cache ready', async () => {
  const f = fixture()
  let time = Date.parse('2026-10-08T00:00:00Z')
  const now = (): Date => new Date(time)
  const first = await syncOfficialRegistry({ ...f.options, now })
  time += 1000
  let requests = 0
  const stalled: typeof fetch = async () => {
    requests += 1
    return new Promise<Response>(() => {})
  }
  const options = { ...f.options, now, fetch: stalled, timeoutMs: 10 }
  const offline = await syncOfficialRegistry({ ...options, forceRefresh: true })
  const second = await syncOfficialRegistry(options)
  assert.equal(
    requests,
    2,
    'the index/signature timeout should happen once across sequential reads'
  )
  for (const cached of [offline, second]) {
    assert.equal(cached.dir, first.dir)
    assert.equal(cached.status, 'cached')
    assert.match(cached.notice ?? '', /离线/)
  }
  await syncOfficialRegistry({ ...options, forceRefresh: true })
  assert.equal(requests, 4, 'explicit refresh bypasses the failed-attempt window')
  time += 60_000
  await syncOfficialRegistry(options)
  assert.equal(requests, 6, 'the short failure window permits the next timed retry')
  writeFileSync(join(first.dir, 'index.json'), '{}')
  await assert.rejects(syncOfficialRegistry(options), /timed out/)
  assert.equal(
    requests,
    6,
    'a cached retry still verifies the current generation and rejects corruption'
  )
})

test('no-cache failures retain their error briefly and allow timed or explicit retries', async () => {
  const f = fixture()
  let time = Date.parse('2026-10-08T00:00:00Z')
  let requests = 0
  const stalled: typeof fetch = async () => {
    requests += 1
    return new Promise<Response>(() => {})
  }
  const options = { ...f.options, now: () => new Date(time), fetch: stalled, timeoutMs: 10 }
  await assert.rejects(syncOfficialRegistry(options), /timed out/)
  await assert.rejects(syncOfficialRegistry(options), /timed out/)
  assert.equal(requests, 2)
  time += 60_000
  await assert.rejects(syncOfficialRegistry(options), /timed out/)
  assert.equal(requests, 4)
  f.assets.set('index.sig.json', Buffer.from('{}'))
  await assert.rejects(
    syncOfficialRegistry({ ...f.options, now: options.now, forceRefresh: true }),
    /签名|signature|sig\.json/
  )
  assert.equal(getCachedOfficialRegistry({ agentDir: f.agentDir, trustedKeys }), undefined)
})
