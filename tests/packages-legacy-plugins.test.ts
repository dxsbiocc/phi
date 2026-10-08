import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
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
import { dirname, join } from 'node:path'
import test from 'node:test'
import { stringify as stringifyYaml } from 'yaml'

import { createDeterministicTarGz } from '../src/main/agent/packages/archive'
import {
  listInstalledPackages,
  packagesAvailableForPlanning
} from '../src/main/agent/packages/installed'
import { sha256 } from '../src/main/agent/packages/installer-utils'
import { readRegistry } from '../src/main/agent/packages/registry'
import { registryKeyId, signRegistryIndex } from '../src/main/agent/packages/signature'
import { applyPackageUpdate, listPackageUpdates } from '../src/main/agent/packages/updates'
import { installPlugin, listInstalledPlugins } from '../src/main/agent/plugins/loader'
import { setEnabled } from '../src/main/agent/enablement'

function write(path: string, value: string | Buffer): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, value)
}

function pluginFiles(id: string, version: string): Array<{ path: string; data: Buffer }> {
  return [
    {
      path: 'phi-package.yaml',
      data: Buffer.from(
        stringifyYaml({
          schemaVersion: 1,
          id,
          type: 'plugin',
          version,
          title: id,
          summary: `${id} fixture.`,
          toolPrefix: id === 'office' ? 'officepy' : 'viz',
          components: { skills: [`skills/${id}-skill`] }
        })
      )
    },
    {
      path: `skills/${id}-skill/SKILL.md`,
      data: Buffer.from(`---\nname: ${id}-skill\ndescription: ${id} fixture.\n---\n# Fixture\n`)
    }
  ]
}

function legacyPlugin(
  root: string,
  id: string,
  version: string,
  source: 'bundled' | 'local' = 'bundled'
): string {
  const dir = join(root, 'sources', id)
  for (const file of pluginFiles(id, version)) write(join(dir, file.path), file.data)
  const result = installPlugin(dir, {
    agentDir: join(root, 'agent'),
    runtimeRoot: join(root, 'runtime'),
    source
  })
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.ok(result.plugin)
  assert.equal(existsSync(join(result.plugin.dir, '.source.json')), false)
  return result.plugin.dir
}

function signedUpgrade(root: string): ReturnType<typeof readRegistry> {
  const dir = join(root, 'official')
  const files = pluginFiles('visualization', '1.0.3')
  const manifest = {
    version: 1,
    files: files.map(({ path, data }) => ({ path, sha256: sha256(data), size: data.length }))
  }
  const archive = createDeterministicTarGz([
    ...files,
    { path: 'files.json', data: Buffer.from(JSON.stringify(manifest)) }
  ])
  const archiveName = 'plugin-visualization-1.0.3.tar.gz'
  write(join(dir, archiveName), archive)
  const index = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      generatedAt: '2026-10-08T00:00:00Z',
      packages: [
        {
          id: 'visualization',
          type: 'plugin',
          version: '1.0.3',
          title: 'visualization',
          summary: 'visualization fixture.',
          archive: archiveName,
          sha256: sha256(archive),
          size: archive.length,
          dependsOn: []
        }
      ]
    })
  )
  const keys = generateKeyPairSync('ed25519')
  const privateKey = keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
  const publicKey = keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()
  write(join(dir, 'index.json'), index)
  write(join(dir, 'index.sig.json'), JSON.stringify(signRegistryIndex(index, privateKey)))
  const registry = readRegistry(dir, {
    trustedKeys: [{ keyId: registryKeyId(publicKey), publicKey }]
  })
  assert.equal(registry.trust, 'official')
  return { ...registry, id: 'phi-packages' }
}

test('legacy bundled plugins remain visible and upgrade through the signed official lifecycle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-legacy-plugin-'))
  try {
    const agentDir = join(root, 'agent')
    const oldVisualization = legacyPlugin(root, 'visualization', '1.0.2')
    const officeDir = legacyPlugin(root, 'office', '1.0.1')
    setEnabled('plugin:visualization', false, { agentDir })
    const officeManifest = readFileSync(join(officeDir, 'phi-package.yaml'))
    assert.equal(listInstalledPlugins({ agentDir }).length, 2)
    const before = listInstalledPackages({ agentDir })
    assert.deepEqual(
      before.map((entry) => [entry.id, entry.version, entry.trust]),
      [
        ['office', '1.0.1', 'builtin'],
        ['visualization', '1.0.2', 'builtin']
      ]
    )
    assert.deepEqual(packagesAvailableForPlanning(agentDir), before)
    assert.ok(before.every((entry) => entry.sha256 === '' && entry.registry === 'bundled'))
    const official = signedUpgrade(root)
    const updates = listPackageUpdates([official], { agentDir, appVersion: '1.0.0' })
    assert.deepEqual(
      updates.map((entry) => [entry.id, entry.currentVersion, entry.newVersion]),
      [['visualization', '1.0.2', '1.0.3']]
    )
    await applyPackageUpdate(updates[0], [official], {
      agentDir,
      runtimeRoot: join(root, 'runtime'),
      appVersion: '1.0.0',
      garbageCollect: () => ({ removed: [], orphans: [], skipped: [], logsRemoved: 0 })
    })
    const after = listInstalledPackages({ agentDir })
    assert.deepEqual(
      after.map((entry) => [entry.id, entry.version, entry.trust]),
      [
        ['office', '1.0.1', 'builtin'],
        ['visualization', '1.0.3', 'official']
      ]
    )
    assert.equal(after.find((entry) => entry.id === 'visualization')?.enabled, false)
    assert.equal(after.find((entry) => entry.id === 'visualization')?.registry, 'phi-packages')
    assert.equal(existsSync(oldVisualization), false)
    assert.deepEqual(readFileSync(join(officeDir, 'phi-package.yaml')), officeManifest)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('present invalid source metadata never falls back to a legacy plugin or planning entry', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-legacy-plugin-invalid-'))
  try {
    const agentDir = join(root, 'agent')
    const dir = legacyPlugin(root, 'office', '1.0.1')
    for (const value of [
      '{',
      '{}',
      JSON.stringify({
        registry: 'phi-packages',
        id: 'different-id',
        type: 'plugin',
        version: '1.0.1',
        sha256: '',
        installedAt: '2026-10-08T00:00:00Z',
        installedBy: 'user',
        trust: 'official'
      })
    ]) {
      write(join(dir, '.source.json'), value)
      assert.equal(listInstalledPlugins({ agentDir }).length, 1)
      assert.deepEqual(listInstalledPackages({ agentDir }), [])
      assert.deepEqual(packagesAvailableForPlanning(agentDir), [])
    }
    rmSync(join(dir, '.source.json'))
    symlinkSync(join(root, 'missing.json'), join(dir, '.source.json'))
    assert.deepEqual(listInstalledPackages({ agentDir }), [])
    assert.deepEqual(packagesAvailableForPlanning(agentDir), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('legacy local plugins use imported trust and invalid plugin manifests remain absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-legacy-plugin-local-'))
  try {
    const agentDir = join(root, 'agent')
    const dir = legacyPlugin(root, 'office', '1.0.1', 'local')
    assert.equal(listInstalledPackages({ agentDir })[0]?.trust, 'imported')
    write(join(dir, 'phi-package.yaml'), 'invalid: true\n')
    assert.deepEqual(listInstalledPlugins({ agentDir }), [])
    assert.deepEqual(listInstalledPackages({ agentDir }), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
