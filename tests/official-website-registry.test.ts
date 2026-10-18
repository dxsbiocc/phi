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

import {
  createDeterministicTarGz,
  parseTarGz,
  type ArchiveFile
} from '../src/main/agent/packages/archive'
import {
  readContentRegistry,
  prepareContentPackageInstall
} from '../src/main/agent/packages/content-source'
import { installPackages } from '../src/main/agent/packages/installer'
import { sha256 } from '../src/main/agent/packages/installer-utils'
import { materializeRegistry } from '../src/main/agent/packages/materialize-registry'
import { officialRegistryDirectory } from '../src/main/agent/packages/official-registry'
import {
  isOfficialWebsiteRegistryDirectory,
  officialWebsiteRegistryDirectory,
  readOfficialWebsiteRegistry,
  syncPreferredOfficialRegistry
} from '../src/main/agent/packages/official-website-registry'
import { planInstall } from '../src/main/agent/packages/planning'
import { readKnownRegistries } from '../src/main/agent/packages/registries'
import { registryKeyId, signRegistryIndex } from '../src/main/agent/packages/signature'
import { skillVersionDir } from '../src/main/agent/packages/store'

const roots: string[] = []
test.after(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })))
const oldCommit = 'a'.repeat(40)
const newCommit = 'b'.repeat(40)
const generatedAt = '2026-10-16T22:15:03.918Z'

function skillFiles(id: string, version = '1.1'): ArchiveFile[] {
  return [
    {
      path: `resources/skills/${id}/SKILL.md`,
      data: Buffer.from(
        `---\nname: ${id}\ndescription: Complete ${id} skill.\nmetadata:\n  version: '${version}'\nphi:\n  environment: phi:python@1\n---\n# Skill\nRead references/guide.md and scripts/helper.py.\n`
      )
    },
    { path: `resources/skills/${id}/references/guide.md`, data: Buffer.from('Complete reference') },
    {
      path: `resources/skills/${id}/scripts/helper.py`,
      data: Buffer.from('print("never execute on download")')
    },
    { path: `resources/skills/${id}/assets/example.json`, data: Buffer.from('{"complete":true}') }
  ]
}

function fixture(skillCount = 17): {
  agentDir: string
  requests: string[]
  snapshots: Map<string, ArchiveFile[]>
  catalog: {
    commit: string
    counts: { skills: number }
    generatedAt: string
    repo?: string
    skillGroups?: Array<{ id: string; label: string; count: number }>
  }
  options: Parameters<typeof syncPreferredOfficialRegistry>[0]
  setOffline: () => void
} {
  const agentDir = mkdtempSync(join(tmpdir(), 'phi-website-registry-'))
  roots.push(agentDir)
  const requests: string[] = []
  const catalog = { commit: oldCommit, counts: { skills: skillCount }, generatedAt }
  const snapshots = new Map<string, ArchiveFile[]>([
    [
      oldCommit,
      Array.from({ length: skillCount }, (_, index) => skillFiles(`skill-${index}`)).flat()
    ]
  ])
  let offline = false
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    requests.push(url)
    assert.equal(init?.redirect, 'error')
    if (offline) throw new Error('offline')
    if (url === 'https://phi.omicsagent.cn/api/catalog') return Response.json(catalog)
    const match =
      /^https:\/\/codeload.github.com\/dxsbiocc\/phi-packages\/tar.gz\/([a-f0-9]{40})$/.exec(url)
    const files = match && snapshots.get(match[1])
    if (files && match) {
      const archive = createDeterministicTarGz(
        files.map((file) => ({ ...file, path: `phi-packages-${match[1]}/${file.path}` }))
      )
      return new Response(new Uint8Array(archive))
    }
    return new Response(null, { status: 404 })
  }
  return {
    agentDir,
    requests,
    snapshots,
    catalog,
    options: { agentDir, fetch: fetcher, forceRefresh: true, timeoutMs: 1000 },
    setOffline: () => {
      offline = true
    }
  }
}

test('website commit changes replace old 14-skill metadata with 17 complete installable skill packages', async () => {
  const f = fixture(14)
  const old = await syncPreferredOfficialRegistry(f.options)
  assert.equal(old.packages.length, 14)
  f.catalog.commit = newCommit
  f.catalog.counts.skills = 17
  f.catalog.repo = 'evil/repository'
  f.snapshots.set(newCommit, [
    ...Array.from({ length: 16 }, (_, index) => skillFiles(`skill-${index}`)).flat(),
    ...skillFiles('create-workflow', '1.3')
  ])
  const registry = await syncPreferredOfficialRegistry(f.options)
  assert.equal(registry.packages.length, 17)
  assert.equal(registry.label, 'Phi 官网')
  assert.equal(registry.kind, 'official')
  assert.equal(registry.trust, 'imported')
  assert.equal(registry.id, 'phi-packages')
  assert.equal(registry.source?.sha, newCommit)
  assert.equal(registry.source?.repo, 'dxsbiocc/phi-packages')
  assert.notEqual(registry.dir, old.dir)
  assert.equal(readOfficialWebsiteRegistry(old.dir, f.options).packages.length, 14)
  const entry = registry.packages.find((item) => item.id === 'create-workflow')!
  assert.equal(entry.version, '1.3.0')
  const archive = readFileSync(join(registry.dir, entry.archive))
  assert.equal(sha256(archive), entry.sha256)
  assert.equal(archive.length, entry.size)
  const files = parseTarGz(archive).filter((file) => file.type === 'file')
  for (const path of [
    'SKILL.md',
    'references/guide.md',
    'scripts/helper.py',
    'assets/example.json',
    'phi-package.yaml',
    'files.json'
  ]) {
    assert.ok(
      files.some((file) => file.path === path),
      path
    )
  }
  assert.ok(
    f.requests.every(
      (url) =>
        url === 'https://phi.omicsagent.cn/api/catalog' ||
        /^https:\/\/codeload.github.com\/dxsbiocc\/phi-packages\/tar.gz\/[a-f0-9]{40}$/.test(url)
    )
  )
  assert.equal(
    (await prepareContentPackageInstall(registry, { type: 'skill', id: entry.id }, f.options)).dir,
    registry.dir
  )
  await installPackages(
    planInstall(registry, { type: 'skill', id: entry.id }, f.options),
    f.options
  )
  const installed = skillVersionDir(entry.id, '1.3.0', f.agentDir)
  assert.equal(
    readFileSync(join(installed, 'references', 'guide.md'), 'utf8'),
    'Complete reference'
  )
  assert.equal(readFileSync(join(installed, 'assets', 'example.json'), 'utf8'), '{"complete":true}')
  assert.equal(existsSync(join(installed, 'scripts', 'helper.py')), true)
})

test('official identifiers and old signed generation paths resolve preferred website content without adding user sources', async () => {
  const f = fixture(1)
  const registry = await readContentRegistry('phi-packages', f.options)
  const reread = await readContentRegistry(registry.dir, f.options)
  const legacy = await readContentRegistry(
    join(officialRegistryDirectory(f.agentDir), 'generations', 'c'.repeat(64)),
    f.options
  )
  assert.equal(reread.dir, registry.dir)
  assert.equal(legacy.dir, registry.dir)
  assert.equal(isOfficialWebsiteRegistryDirectory(registry.dir, f.agentDir), true)
  assert.equal(isOfficialWebsiteRegistryDirectory(join(registry.dir, 'nested'), f.agentDir), false)
  assert.deepEqual(readKnownRegistries(f.agentDir).registries, [])
})

test('offline requests use only a fully validated immutable website cache', async () => {
  const f = fixture(1)
  const original = await syncPreferredOfficialRegistry(f.options)
  f.setOffline()
  const cached = await syncPreferredOfficialRegistry(f.options)
  assert.equal(cached.status, 'cached')
  assert.equal(cached.dir, original.dir)
  assert.equal(cached.trust, 'imported')
  assert.match(cached.notice ?? '', /verified website cache/)
})

test('failed replacement leaves the previous pointer and complete generation unchanged', async () => {
  const f = fixture(1)
  const original = await syncPreferredOfficialRegistry(f.options)
  const pointer = join(officialWebsiteRegistryDirectory(f.agentDir), 'current.json')
  const before = readFileSync(pointer, 'utf8')
  f.catalog.commit = newCommit
  f.catalog.counts.skills = 2
  f.snapshots.set(newCommit, skillFiles('only-one'))
  const cached = await syncPreferredOfficialRegistry(f.options)
  assert.equal(cached.dir, original.dir)
  assert.equal(readFileSync(pointer, 'utf8'), before)
  assert.match(cached.notice ?? '', /Skill count/)
})

test('archive corruption and index symlinks are rejected before cached installation', async () => {
  const f = fixture(1)
  const registry = await syncPreferredOfficialRegistry(f.options)
  const archive = join(registry.dir, registry.packages[0].archive)
  writeFileSync(archive, 'corrupt')
  assert.throws(() => readOfficialWebsiteRegistry(registry.dir, f.options), /mismatch/)
  const repaired = await syncPreferredOfficialRegistry(f.options)
  assert.equal(repaired.dir, registry.dir)
  assert.equal(readOfficialWebsiteRegistry(repaired.dir, f.options).packages.length, 1)
  const index = join(repaired.dir, 'index.json')
  const outside = join(f.agentDir, 'outside.json')
  writeFileSync(outside, readFileSync(index))
  rmSync(index)
  symlinkSync(outside, index)
  assert.throws(() => readOfficialWebsiteRegistry(repaired.dir, f.options), /symlink/)
})

test('managed website directory symlinks never read or write outside the cache root', async () => {
  const f = fixture(1)
  const outside = join(f.agentDir, 'outside')
  mkdirSync(outside)
  const root = officialWebsiteRegistryDirectory(f.agentDir)
  mkdirSync(join(root, '..'), { recursive: true })
  symlinkSync(outside, root)
  assert.throws(() => readOfficialWebsiteRegistry(root, f.options), /symbolic link/)
  await assert.rejects(syncPreferredOfficialRegistry(f.options))
  assert.equal(existsSync(join(outside, 'current.json')), false)
})

test('snapshot staging symlinks are rejected before any write outside the managed cache', async () => {
  const f = fixture(1)
  const root = officialWebsiteRegistryDirectory(f.agentDir)
  const snapshots = join(root, 'snapshots')
  const outside = join(f.agentDir, 'outside-staging')
  mkdirSync(snapshots, { recursive: true })
  mkdirSync(outside)
  symlinkSync(outside, join(snapshots, '.staging'))
  let externalWritesObserved = false
  const fetcher = f.options?.fetch
  assert.ok(fetcher)
  await assert.rejects(
    syncPreferredOfficialRegistry({
      ...f.options,
      fetch: async (input, init) => {
        externalWritesObserved ||= readdirSync(outside).length > 0
        return fetcher(input, init)
      }
    })
  )
  assert.equal(externalWritesObserved, false)
  assert.deepEqual(readdirSync(outside), [])
  assert.equal(
    f.requests.some((url) => url.includes('codeload.github.com')),
    false
  )
  assert.equal(existsSync(join(root, 'current.json')), false)
})

test('invalid optional packages are isolated while all official skills remain available', async () => {
  const f = fixture(1)
  f.snapshots.get(oldCommit)!.push({
    path: 'resources/plugins/broken-plugin/phi-package.yaml',
    data: Buffer.from('not: a package')
  })
  const registry = await syncPreferredOfficialRegistry(f.options)
  assert.equal(registry.packages.filter((entry) => entry.type === 'skill').length, 1)
  assert.match(registry.notice ?? '', /broken-plugin/)
  assert.equal(readOfficialWebsiteRegistry(registry.dir, f.options).notice, registry.notice)
})

test('unavailable classification API falls back to signature-verified release metadata with an explicit notice', async () => {
  const f = fixture(1)
  const key = generateKeyPairSync('ed25519')
  const privateKey = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKey = key.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  const index = Buffer.from(JSON.stringify({ schemaVersion: 1, generatedAt, packages: [] }))
  const signature = Buffer.from(JSON.stringify(signRegistryIndex(index, privateKey)))
  const requests: string[] = []
  const registry = await syncPreferredOfficialRegistry({
    ...f.options,
    trustedKeys: [{ keyId: registryKeyId(publicKey), publicKey }],
    fetch: async (input) => {
      const url = String(input)
      requests.push(url)
      if (url === 'https://phi.omicsagent.cn/api/catalog')
        return Response.json({
          ...f.catalog,
          skillGroups: [
            { id: 'all', label: 'All', count: 1 },
            { id: 'custom', label: 'Custom', count: 1 }
          ]
        })
      if (url.includes('/api/skills?')) return new Response(null, { status: 503 })
      if (url.endsWith('/index.json')) return new Response(new Uint8Array(index))
      if (url.endsWith('/index.sig.json')) return new Response(new Uint8Array(signature))
      return new Response(null, { status: 404 })
    }
  })
  assert.equal(registry.trust, 'official')
  assert.match(registry.notice ?? '', /signed release catalog/)
  assert.ok(
    requests.some((url) =>
      url.startsWith('https://github.com/dxsbiocc/phi-packages/releases/download/catalog-v1/')
    )
  )
})

test('invalid catalog commits never select an arbitrary repository or archive URL', async () => {
  const f = fixture(1)
  f.catalog.commit = '../evil'
  await assert.rejects(syncPreferredOfficialRegistry(f.options))
  assert.equal(
    f.requests.some((url) => url.includes('codeload.github.com')),
    false
  )
})

test('existing skill package manifests retain their declared identity with short version normalization', async () => {
  const f = fixture(1)
  f.snapshots.get(oldCommit)!.push({
    path: 'resources/skills/skill-0/phi-package.yaml',
    data: Buffer.from(
      'schemaVersion: 1\nid: skill-0\ntype: skill\nversion: 1.2\ntitle: Declared skill\nsummary: Declared summary\n'
    )
  })
  const registry = await syncPreferredOfficialRegistry(f.options)
  assert.equal(registry.packages[0].version, '1.2.0')
  assert.equal(registry.packages[0].title, 'Declared skill')
  const files = parseTarGz(readFileSync(join(registry.dir, registry.packages[0].archive)))
  assert.match(
    files.find((file) => file.path === 'phi-package.yaml')!.data.toString(),
    /version: 1.2.0/
  )
})

test('malformed or oversized website catalog metadata never publishes a partial current generation', async () => {
  for (const response of [
    Response.json({ commit: oldCommit, generatedAt, counts: { skills: -1 } }),
    Response.json({ commit: oldCommit, generatedAt: 'invalid', counts: { skills: 1 } }),
    new Response(' '.repeat(256 * 1024 + 1))
  ]) {
    const f = fixture(1)
    await assert.rejects(
      syncPreferredOfficialRegistry({
        ...f.options,
        fetch: async (input) =>
          String(input) === 'https://phi.omicsagent.cn/api/catalog'
            ? response
            : new Response(null, { status: 404 })
      })
    )
    assert.equal(
      existsSync(join(officialWebsiteRegistryDirectory(f.agentDir), 'current.json')),
      false
    )
  }
})

test('mixed grouped website skills keep leaf identities, category paths, and independent full resources', async () => {
  const f = fixture(3)
  const groupedFiles = skillFiles('grouped-skill').map((file) => ({
    ...file,
    path: file.path.replace('resources/skills/', 'resources/skills/analysis/rnaseq/')
  }))
  const explicitFiles = skillFiles('explicit-skill').map((file) => ({
    ...file,
    path: file.path.replace('resources/skills/', 'resources/skills/biology/'),
    data: file.path.endsWith('/SKILL.md')
      ? Buffer.from(
          file.data.toString().replace('metadata:\n', 'metadata:\n  category: Curated RNA\n')
        )
      : file.data
  }))
  f.snapshots.set(oldCommit, [
    ...skillFiles('flat-skill'),
    ...groupedFiles,
    ...explicitFiles,
    { path: 'resources/skills/analysis/README.md', data: Buffer.from('Group documentation') },
    {
      path: 'resources/skills/analysis/rnaseq/grouped-skill/references/nested/SKILL.md',
      data: Buffer.from(
        '---\nname: embedded-example\ndescription: A resource, not a skill\n---\n# Reference\n'
      )
    }
  ])
  const registry = await syncPreferredOfficialRegistry(f.options)
  assert.deepEqual(
    registry.packages.map((entry) => [entry.id, entry.category]),
    [
      ['explicit-skill', 'Curated RNA'],
      ['flat-skill', undefined],
      ['grouped-skill', 'analysis/rnaseq']
    ]
  )
  const grouped = registry.packages.find((entry) => entry.id === 'grouped-skill')!
  const files = parseTarGz(readFileSync(join(registry.dir, grouped.archive)))
  assert.equal(
    files.some((file) => file.path === 'references/nested/SKILL.md'),
    true
  )
  assert.equal(
    files.some((file) => /flat-skill|explicit-skill/.test(file.path)),
    false
  )
  assert.equal(
    files.some((file) => file.path === 'README.md'),
    false
  )
  await installPackages(
    planInstall(registry, { type: 'skill', id: grouped.id }, f.options),
    f.options
  )
  const installed = skillVersionDir(grouped.id, grouped.version, f.agentDir)
  assert.equal(readFileSync(join(installed, 'references/guide.md'), 'utf8'), 'Complete reference')
  assert.equal(existsSync(join(installed, 'references/nested/SKILL.md')), true)
})

test('duplicate grouped skill ids are rejected explicitly before any generation is published', async () => {
  const f = fixture(2)
  f.snapshots.set(
    oldCommit,
    ['first', 'second'].flatMap((group) =>
      skillFiles('same-skill').map((file) => ({
        ...file,
        path: file.path.replace('resources/skills/', `resources/skills/${group}/`)
      }))
    )
  )
  await assert.rejects(syncPreferredOfficialRegistry(f.options))
  assert.equal(
    existsSync(join(officialWebsiteRegistryDirectory(f.agentDir), 'current.json')),
    false
  )
})

test('same-commit API skill grouping refreshes immutable metadata without downloading or changing archives', async () => {
  const f = fixture(1)
  const original = await syncPreferredOfficialRegistry(f.options)
  const originalArchive = original.packages[0]
  const transport = f.options!.fetch!
  const options = {
    ...f.options,
    fetch: (async (input, init) => {
      if (String(input).startsWith('https://phi.omicsagent.cn/api/skills?')) {
        const selected = f.catalog.skillGroups!.find((group) => group.id === 'science')!
        return Response.json({
          items: [{ id: 'skill-0', group: selected.id, groupLabel: selected.label }],
          total: 1,
          page: 1,
          pageSize: 100,
          pageCount: 1,
          groups: f.catalog.skillGroups!.filter((group) => group.id !== 'all')
        })
      }
      return transport(input, init)
    }) as typeof fetch
  }
  f.catalog.skillGroups = [
    { id: 'all', label: '全部', count: 1 },
    { id: 'science', label: '科学分析', count: 1 },
    { id: 'empty', label: '空组', count: 0 }
  ]
  const grouped = await syncPreferredOfficialRegistry(options)
  assert.equal(grouped.packages[0].group, 'science')
  assert.equal(grouped.packages[0].groupLabel, '科学分析')
  assert.equal(grouped.packages[0].groupOrder, 1)
  assert.equal(grouped.packages[0].category, '科学分析')
  assert.deepEqual(grouped.skillGroups, f.catalog.skillGroups)
  assert.notEqual(grouped.dir, original.dir)
  f.catalog.skillGroups = [
    f.catalog.skillGroups[0],
    f.catalog.skillGroups[2],
    { ...f.catalog.skillGroups[1], label: '科学计算' }
  ]
  const renamed = await syncPreferredOfficialRegistry(options)
  assert.equal(renamed.packages[0].groupLabel, '科学计算')
  assert.equal(renamed.packages[0].groupOrder, 2)
  assert.notEqual(renamed.dir, grouped.dir)
  assert.equal(renamed.packages[0].sha256, originalArchive.sha256)
  assert.equal(renamed.packages[0].size, originalArchive.size)
  assert.equal(f.requests.filter((url) => url.includes('codeload.github.com')).length, 1)
  const unchanged = await syncPreferredOfficialRegistry(options)
  assert.equal(unchanged.dir, renamed.dir)
  f.catalog.generatedAt = '2026-10-17T04:15:05.147Z'
  const retimed = await syncPreferredOfficialRegistry(options)
  assert.equal(retimed.generatedAt, f.catalog.generatedAt)
  assert.notEqual(retimed.dir, renamed.dir)
  assert.equal(retimed.packages[0].sha256, originalArchive.sha256)
  assert.equal(f.requests.filter((url) => url.includes('codeload.github.com')).length, 1)
  const invalid = await syncPreferredOfficialRegistry({
    ...options,
    fetch: async (input, init) =>
      String(input).includes('/api/skills?')
        ? Response.json({ items: [], groups: [], total: 1, page: 1, pageSize: 100, pageCount: 1 })
        : transport(input, init)
  })
  assert.equal(invalid.dir, retimed.dir)
  assert.equal(invalid.status, 'cached')
  assert.match(invalid.notice ?? '', /Skill group/)
  const offline = await syncPreferredOfficialRegistry({
    ...options,
    fetch: async (input, init) =>
      String(input).includes('/api/skills?')
        ? Promise.reject(new Error('group API offline'))
        : transport(input, init)
  })
  assert.equal(offline.dir, retimed.dir)
  assert.equal(offline.status, 'cached')
  assert.equal(offline.packages[0].groupLabel, '科学计算')
  assert.match(offline.notice ?? '', /verified website cache/)
})

test('general registry materialization requires explicit consent to include non-MCP types', () => {
  const f = fixture(1)
  const source = join(f.agentDir, 'source')
  mkdirSync(source)
  writeFileSync(
    join(source, 'SKILL.md'),
    '---\nname: skill-test\ndescription: fixture\n---\n# Test\n'
  )
  writeFileSync(
    join(source, 'phi-package.yaml'),
    'schemaVersion: 1\nid: skill-test\ntype: skill\nversion: 1.0.0\ntitle: Test\nsummary: fixture\n'
  )
  assert.throws(
    () => materializeRegistry([source], join(f.agentDir, 'default'), { id: 'test' }),
    /not an MCP package/
  )
  assert.equal(
    materializeRegistry([source], join(f.agentDir, 'opt-in'), {
      id: 'test',
      allowedTypes: ['skill']
    }).packages[0].type,
    'skill'
  )
})
