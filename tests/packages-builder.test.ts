import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

import {
  buildRegistry,
  type RegistryIndex,
  type RegistryIndexEntry
} from '../scripts/packages/build-registry'
import { parseTarGz, type TarEntry } from '../src/main/agent/packages/archive'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function temporaryRepository(): string {
  const root = mkdtempSync(join(tmpdir(), 'phi-package-builder-'))
  roots.push(root)
  execFileSync('git', ['init', '--quiet'], { cwd: root })
  return root
}

function write(path: string, content: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, content)
}

function writeSkill(
  root: string,
  options: {
    name?: string
    description?: string
    metadataVersion?: string
  } = {}
): string {
  const name = options.name ?? 'alpha-skill'
  const description = options.description ?? 'Alpha skill fixture.'
  const dir = join(root, 'resources', 'skills', name)
  const frontmatter = {
    name,
    description,
    phi: { environment: 'phi:python@1' },
    ...(options.metadataVersion
      ? { metadata: { version: options.metadataVersion, author: 'Phi tests' } }
      : {})
  }
  write(join(dir, 'SKILL.md'), `---\n${stringifyYaml(frontmatter)}---\n\n# ${name}\n`)
  write(join(dir, 'scripts', 'run.py'), `print(${JSON.stringify(name)})\n`)
  return dir
}

function writePlugin(root: string): string {
  const dir = join(root, 'resources', 'plugins', 'demo-plugin')
  write(
    join(dir, 'phi-package.yaml'),
    stringifyYaml({
      schemaVersion: 1,
      id: 'demo-plugin',
      type: 'plugin',
      version: '1.4.0',
      title: 'Demo plugin',
      summary: 'Plugin fixture for the local registry.',
      minAppVersion: '0.9.0',
      requires: { coreTools: ['skill_run', 'env_request'] },
      dependsOn: [{ id: 'alpha-skill', type: 'skill', version: '^2.0.0' }],
      toolPrefix: 'demo',
      components: { skills: ['skills/demo-helper'] }
    })
  )
  write(
    join(dir, 'skills', 'demo-helper', 'SKILL.md'),
    `---
name: demo-helper
description: Skill nested in the demo plugin.
---

# Demo helper
`
  )
  return dir
}

function trackResources(root: string): void {
  execFileSync('git', ['add', 'resources'], { cwd: root })
}

function build(root: string, outName = 'registry'): RegistryIndex {
  return buildRegistry({
    repoRoot: root,
    outDir: join(root, outName),
    generatedAt: '2026-10-02T00:00:00.000Z'
  })
}

function registryEntry(
  index: RegistryIndex,
  type: 'skill' | 'plugin',
  id: string
): RegistryIndexEntry {
  const entry = index.packages.find((candidate) => candidate.type === type && candidate.id === id)
  assert.ok(entry, `missing ${type}:${id} registry entry`)
  return entry
}

function archiveEntries(root: string, outName: string, entry: RegistryIndexEntry): TarEntry[] {
  return parseTarGz(readFileSync(join(root, outName, entry.archive)))
}

function archiveFile(entries: TarEntry[], path: string): Buffer {
  const entry = entries.find((candidate) => candidate.path === path)
  assert.ok(entry, `missing archive entry ${path}`)
  assert.equal(entry.type, 'file')
  return entry.data
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

test('generates a skill manifest and exact files.json from tracked files only', () => {
  const root = temporaryRepository()
  const description = 'D'.repeat(340)
  const skillDir = writeSkill(root, {
    description,
    metadataVersion: '2.3.4'
  })
  trackResources(root)
  // check-resources deliberately permits this untracked macOS file, but it must not ship.
  write(join(skillDir, '.DS_Store'), 'untracked noise\n')

  const index = build(root)
  const entry = registryEntry(index, 'skill', 'alpha-skill')
  const entries = archiveEntries(root, 'registry', entry)

  assert.deepEqual(
    entries.map((item) => item.path),
    ['SKILL.md', 'files.json', 'phi-package.yaml', 'scripts/run.py']
  )
  const manifest = parseYaml(archiveFile(entries, 'phi-package.yaml').toString('utf8')) as Record<
    string,
    unknown
  >
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    id: 'alpha-skill',
    type: 'skill',
    version: '2.3.4',
    title: 'alpha-skill',
    summary: description.slice(0, 300),
    files: 'files.json'
  })

  const filesDocument = JSON.parse(archiveFile(entries, 'files.json').toString('utf8')) as {
    version: number
    files: Array<{ path: string; sha256: string; size: number }>
  }
  assert.equal(filesDocument.version, 1)
  assert.deepEqual(
    filesDocument.files.map((file) => file.path),
    ['SKILL.md', 'phi-package.yaml', 'scripts/run.py']
  )
  for (const listed of filesDocument.files) {
    const data = archiveFile(entries, listed.path)
    assert.equal(listed.size, data.length, listed.path)
    assert.equal(listed.sha256, sha256(data), listed.path)
  }
  assert.equal(
    filesDocument.files.some((file) => file.path === 'files.json'),
    false
  )
  assert.equal(
    entries.some((item) => item.path === '.DS_Store'),
    false
  )
})

test('falls back to version 1.0.0 when skill metadata.version is not semver', () => {
  const root = temporaryRepository()
  writeSkill(root, { name: 'fallback-skill', metadataVersion: '1.3' })
  trackResources(root)

  const index = build(root)
  const entry = registryEntry(index, 'skill', 'fallback-skill')
  const manifest = parseYaml(
    archiveFile(archiveEntries(root, 'registry', entry), 'phi-package.yaml').toString('utf8')
  ) as Record<string, unknown>

  assert.equal(entry.version, '1.0.0')
  assert.equal(manifest.version, '1.0.0')
})

test('round-trips tracked paths longer than the legacy tar name field', () => {
  const root = temporaryRepository()
  const skillDir = writeSkill(root)
  const longPath = `references/${'nested/'.repeat(14)}guide.md`
  assert(Buffer.byteLength(longPath) > 100)
  write(join(skillDir, longPath), '# Long path\n')
  trackResources(root)

  const index = build(root)
  const entry = registryEntry(index, 'skill', 'alpha-skill')
  assert(archiveEntries(root, 'registry', entry).some((item) => item.path === longPath))
})

test('rejects an ordinary untracked file under resources', () => {
  const root = temporaryRepository()
  const skillDir = writeSkill(root)
  trackResources(root)
  write(join(skillDir, 'notes.tmp'), 'not tracked\n')

  assert.throws(
    () => build(root),
    /untracked files under resources are not allowed: resources\/skills\/alpha-skill\/notes\.tmp/
  )
})

test('rejects every tracked run-leftover category', async (context) => {
  const leftovers = [
    '.nextflow/cache',
    '.nextflow.log',
    'work/run.txt',
    'results/result.txt',
    'scripts/__pycache__/cache.pyc',
    '.DS_Store'
  ]

  for (const relativePath of leftovers) {
    await context.test(relativePath, () => {
      const root = temporaryRepository()
      const skillDir = writeSkill(root)
      write(join(skillDir, relativePath), 'leftover\n')
      trackResources(root)

      assert.throws(
        () => build(root),
        (error: unknown) =>
          error instanceof Error &&
          error.message.includes('run leftover is not allowed') &&
          error.message.includes(relativePath)
      )
    })
  }
})

test('produces byte-identical archives and digests across builds', () => {
  const root = temporaryRepository()
  writeSkill(root, { metadataVersion: '2.3.4' })
  writePlugin(root)
  trackResources(root)

  const first = build(root, 'registry-one')
  const second = build(root, 'registry-two')

  assert.deepEqual(first, second)
  for (const firstEntry of first.packages) {
    const secondEntry = registryEntry(second, firstEntry.type, firstEntry.id)
    const firstArchive = readFileSync(join(root, 'registry-one', firstEntry.archive))
    const secondArchive = readFileSync(join(root, 'registry-two', secondEntry.archive))
    assert.deepEqual(firstArchive, secondArchive, firstEntry.archive)
    assert.equal(firstEntry.sha256, secondEntry.sha256)
    assert.equal(firstEntry.sha256, sha256(firstArchive))
    assert.equal(firstEntry.size, firstArchive.length)
  }
  assert.deepEqual(
    readFileSync(join(root, 'registry-one', 'index.json')),
    readFileSync(join(root, 'registry-two', 'index.json'))
  )
})

test('writes sorted registry entries with required and propagated index fields', () => {
  const root = temporaryRepository()
  writeSkill(root, { metadataVersion: '2.3.4' })
  writePlugin(root)
  trackResources(root)

  const index = build(root)
  const plugin = registryEntry(index, 'plugin', 'demo-plugin')
  const skill = registryEntry(index, 'skill', 'alpha-skill')

  assert.equal(index.schemaVersion, 1)
  assert.equal(index.generatedAt, '2026-10-02T00:00:00.000Z')
  assert.deepEqual(
    index.packages.map((entry) => `${entry.type}:${entry.id}@${entry.version}`),
    ['plugin:demo-plugin@1.4.0', 'skill:alpha-skill@2.3.4']
  )
  assert.deepEqual(
    {
      id: plugin.id,
      type: plugin.type,
      version: plugin.version,
      title: plugin.title,
      summary: plugin.summary,
      archive: plugin.archive,
      minAppVersion: plugin.minAppVersion,
      dependsOn: plugin.dependsOn,
      requires: plugin.requires
    },
    {
      id: 'demo-plugin',
      type: 'plugin',
      version: '1.4.0',
      title: 'Demo plugin',
      summary: 'Plugin fixture for the local registry.',
      archive: 'plugin-demo-plugin-1.4.0.tar.gz',
      minAppVersion: '0.9.0',
      dependsOn: [{ id: 'alpha-skill', type: 'skill', version: '^2.0.0' }],
      requires: { coreTools: ['skill_run', 'env_request'] }
    }
  )
  assert.deepEqual(skill.dependsOn, [])
  assert.equal(skill.archive, 'skill-alpha-skill-2.3.4.tar.gz')
  for (const entry of index.packages) {
    const archive = readFileSync(join(root, 'registry', entry.archive))
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
    assert.equal(entry.sha256, sha256(archive))
    assert.equal(entry.size, archive.length)
  }

  const published = JSON.parse(readFileSync(join(root, 'registry', 'index.json'), 'utf8'))
  assert.deepEqual(published, index)
})
