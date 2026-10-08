import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { stringify as stringifyYaml } from 'yaml'
import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import {
  importOfflinePackage,
  listInstalledPackages,
  previewOfflinePackageImport,
  type LocalRegistry,
  type RegistryPackageEntry
} from '../src/main/agent/packages/installer'

const roots: string[] = []

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function sandbox(): { root: string; agentDir: string; registryDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'phi-offline-import-'))
  roots.push(root)
  const agentDir = join(root, 'agent')
  const registryDir = join(root, 'registry')
  mkdirSync(registryDir, { recursive: true })
  return { root, agentDir, registryDir }
}

function digest(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function skillArchive(
  dir: string,
  id: string,
  options: {
    dependsOn?: Array<{ id: string; type: 'skill'; version: string }>
    corruptSkillHash?: boolean
    extraEntries?: Array<{ path: string; data: Buffer }>
  } = {}
): { path: string; entry: RegistryPackageEntry } {
  const manifest = Buffer.from(
    stringifyYaml({
      schemaVersion: 1,
      id,
      type: 'skill',
      version: '1.0.0',
      title: id,
      summary: `${id} package.`,
      ...(options.dependsOn ? { dependsOn: options.dependsOn } : {}),
      files: 'files.json'
    })
  )
  const skill = Buffer.from(`---\nname: ${id}\ndescription: ${id} package.\n---\n# ${id}\n`)
  const listedSkill = options.corruptSkillHash ? Buffer.from('different') : skill
  const filesJson = Buffer.from(
    `${JSON.stringify(
      {
        version: 1,
        files: [
          { path: 'SKILL.md', sha256: digest(listedSkill), size: listedSkill.length },
          { path: 'phi-package.yaml', sha256: digest(manifest), size: manifest.length }
        ]
      },
      null,
      2
    )}\n`
  )
  const archive = createDeterministicTarGz([
    { path: 'SKILL.md', data: skill },
    { path: 'files.json', data: filesJson },
    { path: 'phi-package.yaml', data: manifest },
    ...(options.extraEntries ?? [])
  ])
  const archiveName = `skill-${id}-1.0.0.tar.gz`
  const path = join(dir, archiveName)
  writeFileSync(path, archive)
  return {
    path,
    entry: {
      id,
      type: 'skill',
      version: '1.0.0',
      title: id,
      summary: `${id} package.`,
      archive: archiveName,
      sha256: digest(archive),
      size: archive.length,
      dependsOn: options.dependsOn ?? []
    }
  }
}

test('previews and installs a valid archive with imported trust', async () => {
  const fixture = sandbox()
  const archive = skillArchive(fixture.root, 'offline-skill')

  const preview = previewOfflinePackageImport(archive.path, { agentDir: fixture.agentDir })
  assert.equal(preview.plan.root.id, 'offline-skill')
  assert.equal(preview.plan.registry.trust, 'imported')

  await importOfflinePackage(archive.path, { agentDir: fixture.agentDir })
  const installed = listInstalledPackages({ agentDir: fixture.agentDir })
  assert.equal(installed[0]?.trust, 'imported')
  assert.equal(installed[0]?.registry, archive.path)
})

test('rejects an archive whose files.json does not match its contents', () => {
  const fixture = sandbox()
  const archive = skillArchive(fixture.root, 'bad-files', { corruptSkillHash: true })
  assert.throws(
    () => previewOfflinePackageImport(archive.path, { agentDir: fixture.agentDir }),
    /files\.json/
  )
})

test('rejects archive traversal before extraction', () => {
  const fixture = sandbox()
  const archive = skillArchive(fixture.root, 'unsafe-skill', {
    extraEntries: [{ path: '../escape.txt', data: Buffer.from('no') }]
  })
  assert.throws(
    () => previewOfflinePackageImport(archive.path, { agentDir: fixture.agentDir }),
    /不安全的软件包路径/
  )
})

test('refuses an offline package with a missing dependency', () => {
  const fixture = sandbox()
  const archive = skillArchive(fixture.root, 'needs-helper', {
    dependsOn: [{ id: 'helper-skill', type: 'skill', version: '^1.0.0' }]
  })
  assert.throws(
    () => previewOfflinePackageImport(archive.path, { agentDir: fixture.agentDir }),
    /无法解析软件包依赖/
  )
})

test('resolves an offline package dependency from a known registry', async () => {
  const fixture = sandbox()
  const dependency = skillArchive(fixture.registryDir, 'helper-skill')
  const root = skillArchive(fixture.root, 'needs-helper', {
    dependsOn: [{ id: 'helper-skill', type: 'skill', version: '^1.0.0' }]
  })
  const registry: LocalRegistry = {
    id: fixture.registryDir,
    dir: fixture.registryDir,
    trust: 'official',
    schemaVersion: 1,
    generatedAt: '2026-10-02T00:00:00.000Z',
    packages: [dependency.entry]
  }

  const preview = previewOfflinePackageImport(root.path, {
    agentDir: fixture.agentDir,
    registries: [registry]
  })
  assert.deepEqual(
    preview.plan.packages.map((entry) => [entry.id, entry.installedBy]),
    [
      ['helper-skill', 'dependency'],
      ['needs-helper', 'user']
    ]
  )

  await importOfflinePackage(root.path, {
    agentDir: fixture.agentDir,
    registries: [registry]
  })
  assert.deepEqual(
    listInstalledPackages({ agentDir: fixture.agentDir }).map((entry) => entry.id),
    ['helper-skill', 'needs-helper']
  )
  const installed = listInstalledPackages({ agentDir: fixture.agentDir })
  assert.equal(installed.find((entry) => entry.id === 'helper-skill')?.trust, 'official')
  assert.equal(installed.find((entry) => entry.id === 'needs-helper')?.trust, 'imported')
  assert.equal(
    readFileSync(
      join(fixture.agentDir, 'packages', 'skill', 'helper-skill', '1.0.0', '.source.json'),
      'utf8'
    ).includes('"trust": "official"'),
    true
  )
})

test('copies only the dependency closure from known registries and cleans its staging', async () => {
  const fixture = sandbox()
  const dependency = skillArchive(fixture.registryDir, 'helper-skill')
  const root = skillArchive(fixture.root, 'needs-helper', {
    dependsOn: [{ id: 'helper-skill', type: 'skill', version: '^1.0.0' }]
  })
  // Unrelated entries whose archives do not exist: copying any of them would throw.
  const unrelated: RegistryPackageEntry[] = Array.from({ length: 20 }, (_, index) => ({
    ...dependency.entry,
    id: `unrelated-${index}`,
    title: `unrelated-${index}`,
    archive: `skill-unrelated-${index}-1.0.0.tar.gz`
  }))
  const registry: LocalRegistry = {
    id: fixture.registryDir,
    dir: fixture.registryDir,
    trust: 'official',
    schemaVersion: 1,
    generatedAt: '2026-10-02T00:00:00.000Z',
    packages: [dependency.entry, ...unrelated]
  }

  await importOfflinePackage(root.path, { agentDir: fixture.agentDir, registries: [registry] })

  assert.deepEqual(
    listInstalledPackages({ agentDir: fixture.agentDir }).map((entry) => entry.id),
    ['helper-skill', 'needs-helper']
  )
  assert.deepEqual(readdirSync(join(fixture.agentDir, '.staging')), [])
})

test('preview needs only dependency metadata and import prepares selected archives on demand', async () => {
  const fixture = sandbox()
  const dependency = skillArchive(fixture.registryDir, 'remote-helper')
  const bytes = readFileSync(dependency.path)
  rmSync(dependency.path)
  const root = skillArchive(fixture.root, 'offline-root', {
    dependsOn: [{ id: 'remote-helper', type: 'skill', version: '^1.0.0' }]
  })
  const source: LocalRegistry = {
    id: 'phi-packages',
    dir: fixture.registryDir,
    trust: 'official',
    schemaVersion: 1,
    generatedAt: '2026-10-08T00:00:00Z',
    packages: [dependency.entry]
  }
  let preparations = 0
  const options = {
    agentDir: fixture.agentDir,
    registries: [source],
    preparePackage: async (registry: LocalRegistry, entry: RegistryPackageEntry): Promise<void> => {
      preparations += 1
      assert.equal(registry.id, source.id)
      assert.equal(entry.id, 'remote-helper')
      writeFileSync(dependency.path, bytes)
    }
  }
  const preview = previewOfflinePackageImport(root.path, options)
  assert.deepEqual(
    preview.plan.packages.map((entry) => entry.id),
    ['remote-helper', 'offline-root']
  )
  assert.equal(preparations, 0)
  await importOfflinePackage(root.path, options)
  assert.equal(preparations, 1)
  assert.deepEqual(
    listInstalledPackages({ agentDir: fixture.agentDir }).map((entry) => entry.id),
    ['offline-root', 'remote-helper']
  )
})
