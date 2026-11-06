import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import { prepareContentPackageInstall } from '../src/main/agent/packages/content-source'
import { sha256 } from '../src/main/agent/packages/installer-utils'
import { readPackageArchive } from '../src/main/agent/packages/package-archive'
import { OFFICIAL_REGISTRY_BASE_URL } from '../src/main/agent/packages/official-registry'
import {
  officialWebsiteRegistryDirectory,
  syncPreferredOfficialRegistry
} from '../src/main/agent/packages/official-website-registry'
import type { RegistryPackageEntry } from '../src/main/agent/packages/installer-types'
import { registryKeyId, signRegistryIndex } from '../src/main/agent/packages/signature'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))

const baseUrl = 'https://example.test/api/registry/'
const generatedAt = '2026-11-06T00:00:00.000Z'

interface WebsiteFixture {
  agentDir: string
  assets: Map<string, Buffer>
  requests: string[]
  entries: RegistryPackageEntry[]
  options: NonNullable<Parameters<typeof syncPreferredOfficialRegistry>[0]>
  setIndex: (entries: unknown[], nextGeneratedAt?: string) => void
}

function packageEntry(
  id: string,
  options: {
    version?: string
    dependsOn?: RegistryPackageEntry['dependsOn']
    icon?: Buffer
  } = {}
): { entry: RegistryPackageEntry; assets: Map<string, Buffer> } {
  const version = options.version ?? '1.0.0'
  const archive = `skill-${id}-${version}.tar.gz`
  const archiveBytes = createDeterministicTarGz([
    {
      path: 'SKILL.md',
      data: Buffer.from(`---\nname: ${id}\ndescription: ${id} fixture\n---\n# ${id}\n`)
    }
  ])
  const assets = new Map<string, Buffer>([[archive, archiveBytes]])
  const iconAsset = options.icon
    ? {
        path: `icons/skill-${id}-${version}.svg`,
        sha256: sha256(options.icon),
        size: options.icon.length
      }
    : undefined
  if (iconAsset && options.icon) assets.set(iconAsset.path, options.icon)
  return {
    entry: {
      id,
      type: 'skill',
      version,
      title: id,
      summary: `${id} fixture`,
      archive,
      sha256: sha256(archiveBytes),
      size: archiveBytes.length,
      dependsOn: options.dependsOn ?? [],
      ...(iconAsset ? { iconAsset } : {})
    },
    assets
  }
}

function connectorEntry(id: string): { entry: RegistryPackageEntry; assets: Map<string, Buffer> } {
  const version = '1.0.0'
  const manifest = Buffer.from(
    `schemaVersion: 1\nid: ${id}\ntype: mcp\nversion: ${version}\ntitle: ${id}\nsummary: ${id} fixture\nconnector:\n  transport: http\n  publisher: Phi\n  category: 科研数据\n  homepage: https://example.test\n  url: https://example.test/mcp\n  auth: none\n`
  )
  const archive = `mcp-${id}-${version}.tar.gz`
  const archiveBytes = createDeterministicTarGz([{ path: 'phi-package.yaml', data: manifest }])
  const manifestAsset = {
    path: `manifests/mcp-${id}-${version}.yaml`,
    sha256: sha256(manifest),
    size: manifest.length
  }
  return {
    entry: {
      id,
      type: 'mcp',
      version,
      title: id,
      summary: `${id} fixture`,
      archive,
      sha256: sha256(archiveBytes),
      size: archiveBytes.length,
      dependsOn: [],
      manifestAsset
    },
    assets: new Map([
      [archive, archiveBytes],
      [manifestAsset.path, manifest]
    ])
  }
}

function fixture(packages: ReturnType<typeof packageEntry>[]): WebsiteFixture {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-website-registry-'))
  roots.push(agentDir)
  const requests: string[] = []
  const assets = new Map(packages.flatMap((item) => [...item.assets]))
  const entries = packages.map((item) => item.entry)
  const setIndex = (nextEntries: unknown[], nextGeneratedAt = generatedAt): void => {
    assets.set(
      'index.json',
      Buffer.from(
        JSON.stringify({ schemaVersion: 1, generatedAt: nextGeneratedAt, packages: nextEntries })
      )
    )
  }
  setIndex(entries)
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push(url)
    assert.equal(init?.redirect, 'error')
    if (url === 'https://phi.omicsagent.cn/api/catalog') {
      return Response.json({
        commit: 'a'.repeat(40),
        generatedAt,
        counts: { skills: entries.length }
      })
    }
    const prefix = new URL(baseUrl).href
    if (url.startsWith(prefix)) {
      const bytes = assets.get(url.slice(prefix.length))
      return bytes
        ? new Response(new Uint8Array(bytes), { status: 200 })
        : new Response(null, { status: 404 })
    }
    return new Response(null, { status: 404 })
  }
  return {
    agentDir,
    assets,
    requests,
    entries,
    options: { agentDir, baseUrl, fetch: fetcher, forceRefresh: true, timeoutMs: 1000 },
    setIndex
  }
}

test('website sync downloads the index and small assets without downloading archives', async () => {
  const icon = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>'
  )
  const f = fixture([packageEntry('visible-skill', { icon })])

  const registry = await syncPreferredOfficialRegistry(f.options)

  assert.equal(registry.packages.length, 1)
  assert.equal(registry.trust, 'imported')
  assert.deepEqual(
    f.requests.filter((url) => url.startsWith(baseUrl)),
    [`${baseUrl}index.json`, `${baseUrl}icons/skill-visible-skill-1.0.0.svg`]
  )
  assert.equal(
    f.requests.some((url) => url.endsWith('.tar.gz')),
    false
  )
})

test('unchanged refresh reuses cached icons and manifests without downloading them again', async () => {
  const icon = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>'
  )
  const skill = packageEntry('cached-icon', { icon })
  const connector = connectorEntry('cached-manifest')
  const f = fixture([skill, connector])
  const first = await syncPreferredOfficialRegistry(f.options)
  assert.deepEqual(
    first.packages.map((entry) => entry.id),
    ['cached-icon', 'cached-manifest']
  )
  f.requests.length = 0

  await syncPreferredOfficialRegistry(f.options)

  assert.deepEqual(
    [...f.requests].sort(),
    [`${baseUrl}index.json`, 'https://phi.omicsagent.cn/api/catalog'].sort()
  )
})

test('install preparation downloads only the selected package and its dependency closure', async () => {
  const dependency = packageEntry('dependency')
  const selected = packageEntry('selected', {
    dependsOn: [{ type: 'skill', id: dependency.entry.id, version: '^1.0.0' }]
  })
  const unused = packageEntry('unused')
  const f = fixture([selected, dependency, unused])
  const registry = await syncPreferredOfficialRegistry(f.options)
  f.requests.length = 0

  const prepared = await prepareContentPackageInstall(
    registry,
    { type: 'skill', id: selected.entry.id },
    { ...f.options, appVersion: '1.0.0' }
  )

  assert.equal(prepared.dir, registry.dir)
  assert.deepEqual(
    f.requests.filter((url) => url.endsWith('.tar.gz')).sort(),
    [`${baseUrl}${dependency.entry.archive}`, `${baseUrl}${selected.entry.archive}`].sort()
  )
  assert.equal(existsSync(join(registry.dir, selected.entry.archive)), true)
  assert.equal(existsSync(join(registry.dir, dependency.entry.archive)), true)
  assert.equal(existsSync(join(registry.dir, unused.entry.archive)), false)
})

test('concurrent package inspection downloads one missing website archive once', async () => {
  const selected = packageEntry('inspectable')
  const f = fixture([selected])
  const registry = await syncPreferredOfficialRegistry(f.options)
  f.requests.length = 0

  const [first, second] = await Promise.all([
    readPackageArchive(registry, selected.entry, f.options),
    readPackageArchive(registry, selected.entry, f.options)
  ])

  assert.equal(sha256(first), selected.entry.sha256)
  assert.deepEqual(second, first)
  assert.deepEqual(f.requests, [`${baseUrl}${selected.entry.archive}`])
})

test('refresh carries unchanged archives forward and downloads only the changed version once', async () => {
  const unchanged = packageEntry('unchanged')
  const changedV1 = packageEntry('changed')
  const f = fixture([unchanged, changedV1])
  const first = await syncPreferredOfficialRegistry(f.options)
  await prepareContentPackageInstall(
    first,
    { type: 'skill', id: unchanged.entry.id },
    { ...f.options, appVersion: '1.0.0' }
  )
  await prepareContentPackageInstall(
    first,
    { type: 'skill', id: changedV1.entry.id },
    { ...f.options, appVersion: '1.0.0' }
  )

  const changedV2 = packageEntry('changed', { version: '2.0.0' })
  for (const [path, bytes] of changedV2.assets) f.assets.set(path, bytes)
  f.setIndex([unchanged.entry, changedV2.entry], '2026-11-06T01:00:00.000Z')
  const refreshed = await syncPreferredOfficialRegistry(f.options)
  assert.notEqual(refreshed.dir, first.dir)
  f.requests.length = 0

  await prepareContentPackageInstall(
    refreshed,
    { type: 'skill', id: unchanged.entry.id },
    { ...f.options, appVersion: '1.0.0' }
  )
  await prepareContentPackageInstall(
    refreshed,
    { type: 'skill', id: changedV2.entry.id },
    { ...f.options, appVersion: '1.0.0' }
  )
  await prepareContentPackageInstall(
    refreshed,
    { type: 'skill', id: changedV2.entry.id },
    { ...f.options, appVersion: '1.0.0' }
  )

  assert.deepEqual(f.requests, [`${baseUrl}${changedV2.entry.archive}`])
})

test('publish retains two generations and safely removes abandoned cache directories', async () => {
  const selected = packageEntry('retained')
  const f = fixture([selected])
  const first = await syncPreferredOfficialRegistry(f.options)
  f.setIndex([selected.entry], '2026-11-06T01:00:00.000Z')
  const second = await syncPreferredOfficialRegistry(f.options)
  const root = officialWebsiteRegistryDirectory(f.agentDir)
  const abandonedStaging = join(root, 'staging-abandoned')
  const abandonedCorrupt = join(root, 'corrupt-abandoned')
  mkdirSync(abandonedStaging)
  mkdirSync(abandonedCorrupt)

  const outside = mkdtempSync(join(tmpdir(), 'phi-website-outside-'))
  roots.push(outside)
  const sentinel = join(outside, 'keep.txt')
  writeFileSync(sentinel, 'keep')
  symlinkSync(outside, join(root, 'staging-outside-link'))

  f.setIndex([selected.entry], '2026-11-06T02:00:00.000Z')
  const third = await syncPreferredOfficialRegistry(f.options)
  const unrelatedGeneration = join(root, 'generations', 'd'.repeat(64))
  mkdirSync(unrelatedGeneration)
  utimesSync(unrelatedGeneration, new Date('2030-01-01'), new Date('2030-01-01'))
  const unchanged = await syncPreferredOfficialRegistry(f.options)

  assert.equal(unchanged.dir, third.dir)
  assert.deepEqual(
    readdirSync(join(root, 'generations')).sort(),
    [basename(second.dir), basename(third.dir)].sort()
  )
  assert.equal(existsSync(first.dir), false)
  assert.equal(existsSync(abandonedStaging), false)
  assert.equal(existsSync(abandonedCorrupt), false)
  assert.equal(existsSync(sentinel), true)
})

test('malformed entries and packages that depend on them are skipped with notices', async () => {
  const valid = packageEntry('valid')
  const dependent = packageEntry('dependent', {
    dependsOn: [{ type: 'skill', id: 'broken-id', version: '^1.0.0' }]
  })
  const f = fixture([valid, dependent])
  f.setIndex([
    valid.entry,
    { ...valid.entry, id: '../broken-id', archive: 'broken.tar.gz' },
    dependent.entry
  ])

  const registry = await syncPreferredOfficialRegistry(f.options)

  assert.deepEqual(
    registry.packages.map((entry) => entry.id),
    ['valid']
  )
  assert.match(registry.notice ?? '', /packages\[1\] skipped/)
  assert.match(registry.notice ?? '', /skill:dependent@1\.0\.0 skipped: missing dependency/)
})

test('catalog classification failure does not prevent publishing the website registry', async () => {
  const f = fixture([packageEntry('available')])
  const transport = f.options.fetch!

  const registry = await syncPreferredOfficialRegistry({
    ...f.options,
    fetch: async (input, init) =>
      String(input) === 'https://phi.omicsagent.cn/api/catalog'
        ? new Response(null, { status: 503 })
        : transport(input, init)
  })

  assert.equal(registry.status, 'ready')
  assert.equal(registry.label, 'Phi 官网')
  assert.deepEqual(
    registry.packages.map((entry) => entry.id),
    ['available']
  )
})

test('failed icons are removed individually while failed manifests remove only their package', async () => {
  const icon = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg"><rect width="8" height="8"/></svg>'
  )
  const skill = packageEntry('no-icon', { icon })
  const connector = connectorEntry('broken-manifest')
  const f = fixture([skill, connector])
  f.assets.delete(skill.entry.iconAsset!.path)
  f.assets.delete(connector.entry.manifestAsset!.path)

  const registry = await syncPreferredOfficialRegistry(f.options)

  assert.deepEqual(
    registry.packages.map((entry) => entry.id),
    ['no-icon']
  )
  assert.equal(registry.packages[0].iconAsset, undefined)
  assert.match(registry.notice ?? '', /no-icon.*icon skipped/)
  assert.match(registry.notice ?? '', /broken-manifest.*manifest/)
})

test('invalid icon metadata is removed while MCP entries without manifests are skipped', async () => {
  const skill = packageEntry('invalid-icon')
  const connector = connectorEntry('missing-manifest')
  const f = fixture([skill, connector])
  f.setIndex([
    {
      ...skill.entry,
      iconAsset: { path: 'icons/not-an-image.txt', sha256: 'bad', size: 1 }
    },
    { ...connector.entry, manifestAsset: undefined }
  ])

  const registry = await syncPreferredOfficialRegistry(f.options)

  assert.deepEqual(
    registry.packages.map((entry) => entry.id),
    ['invalid-icon']
  )
  assert.equal(registry.packages[0].iconAsset, undefined)
  assert.match(registry.notice ?? '', /invalid-icon.*icon skipped/)
  assert.match(registry.notice ?? '', /missing-manifest.*manifest/)
})

test('index failure falls back to the website cache before the signed release', async () => {
  const f = fixture([packageEntry('cached')])
  const original = await syncPreferredOfficialRegistry(f.options)

  const cached = await syncPreferredOfficialRegistry({
    ...f.options,
    forceRefresh: true,
    fetch: async () => {
      throw new Error('offline')
    }
  })

  assert.equal(cached.dir, original.dir)
  assert.equal(cached.status, 'cached')
  assert.match(cached.notice ?? '', /verified website cache/)
})

test('index failure without a website cache falls back to the signed release source', async () => {
  const keyPair = generateKeyPairSync('ed25519')
  const privateKey = keyPair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKey = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const officialIndex = Buffer.from(JSON.stringify({ schemaVersion: 1, generatedAt, packages: [] }))
  const officialSignature = Buffer.from(
    JSON.stringify(signRegistryIndex(officialIndex, privateKey))
  )
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-website-fallback-'))
  roots.push(agentDir)
  const requests: string[] = []
  const websiteBase = 'https://fallback.test/api/registry/'
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url === `${websiteBase}index.json`) return new Response('{broken')
    if (url === `${OFFICIAL_REGISTRY_BASE_URL}index.json`) {
      return new Response(new Uint8Array(officialIndex))
    }
    if (url === `${OFFICIAL_REGISTRY_BASE_URL}index.sig.json`) {
      return new Response(new Uint8Array(officialSignature))
    }
    return new Response(null, { status: 503 })
  }

  const registry = await syncPreferredOfficialRegistry({
    agentDir,
    baseUrl: websiteBase,
    fetch: fetcher,
    trustedKeys: [{ keyId: registryKeyId(publicKey), publicKey }],
    forceRefresh: true,
    timeoutMs: 1000
  })

  assert.equal(registry.trust, 'official')
  assert.match(registry.notice ?? '', /signed release catalog/)
  assert.ok(requests.includes(`${OFFICIAL_REGISTRY_BASE_URL}index.sig.json`))
})
