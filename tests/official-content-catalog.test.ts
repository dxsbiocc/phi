import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  KnownPackageRegistryView,
  PackageManagerType,
  PackageRegistryView
} from '../src/shared/packageManagerTypes'
import {
  catalogPackages,
  installCatalogPackage,
  loadContentCatalog
} from '../src/renderer/src/lib/contentCatalog'
import { knownSkillCatalogPackages } from '../src/renderer/src/features/skill/lib/skillCatalogBrowser'
import { wrapperCatalogChoices } from '../src/renderer/src/features/wrapper/lib/wrapperCatalog'

function registry(
  dir: string,
  kind: 'official' | 'directory',
  type: PackageManagerType = 'skill',
  version = '1.0.0'
): PackageRegistryView {
  return {
    id: kind === 'official' ? 'phi-packages' : dir,
    dir,
    kind,
    trust: kind === 'official' ? 'official' : 'imported',
    schemaVersion: 1,
    generatedAt: '2026-10-08T00:00:00.000Z',
    packages: [
      {
        id: 'shared',
        type,
        version,
        title: 'Shared',
        summary: 'Shared package',
        archive: 'shared.tgz',
        sha256: 'a'.repeat(64),
        size: 32,
        dependsOn: []
      }
    ]
  }
}

const official: KnownPackageRegistryView = {
  id: 'phi-packages',
  kind: 'official',
  path: 'phi-packages',
  label: 'Phi Packages',
  removable: false
}

test('an old backend returning only a bundled source reports restart instead of an empty catalog', async () => {
  const result = await loadContentCatalog({
    listPackageRegistries: async () => [
      { id: 'builtin', kind: 'bundled', path: '/resources', removable: false }
    ],
    readPackageRegistry: async () => {
      throw new Error('bundled sources must not be read')
    }
  })
  assert.deepEqual(result.registries, [])
  assert.match(result.errors.join('\n'), /后台.*旧版本.*重新启动 Phi/)
})

test('old backend feedback does not hide a usable user-imported source', async () => {
  const result = await loadContentCatalog({
    listPackageRegistries: async () => [
      { id: 'builtin', kind: 'bundled', path: '/resources', removable: false },
      { id: 'local', kind: 'directory', path: '/local', removable: true }
    ],
    readPackageRegistry: async (path) => registry(path, 'directory')
  })
  assert.equal(result.registries[0].dir, '/local')
  assert.match(result.errors.join('\n'), /后台.*旧版本/)
})

test('catalog loads official first, excludes bundled sources, and keeps the actual generation path', async () => {
  const reads: string[] = []
  const result = await loadContentCatalog({
    listPackageRegistries: async () => [
      { id: 'local', kind: 'directory', path: '/local', removable: true },
      { id: 'bundled', kind: 'bundled', path: '/resources', removable: false },
      official
    ],
    readPackageRegistry: async (path) => {
      reads.push(path)
      return registry(
        path === 'phi-packages' ? '/cache/generations/verified' : path,
        path === 'phi-packages' ? 'official' : 'directory'
      )
    }
  })
  assert.deepEqual(reads, ['phi-packages', '/local'])
  assert.equal(result.registries[0].dir, '/cache/generations/verified')
  assert.equal(result.registries[0].label, 'Phi Packages')
  assert.deepEqual(result.errors, [])
})

test('a failed official source stays visible while imported directories remain usable', async () => {
  const result = await loadContentCatalog({
    listPackageRegistries: async () => [
      { ...official, status: 'unavailable', error: 'Network unavailable; no verified cache.' },
      { id: 'local', kind: 'directory', path: '/local', removable: true }
    ],
    readPackageRegistry: async (path) => registry(path, 'directory')
  })
  assert.equal(result.registries.length, 1)
  assert.equal(result.registries[0].dir, '/local')
  assert.match(result.errors[0], /Phi Packages.*no verified cache/)
})

test('cached official content preserves offline feedback instead of falling back to resources', async () => {
  const result = await loadContentCatalog({
    listPackageRegistries: async () => [{ ...official, status: 'cached' }],
    readPackageRegistry: async () => registry('/verified-cache', 'official')
  })
  assert.equal(result.registries[0].status, 'cached')
  assert.deepEqual(result.notices, ['Phi Packages：正在使用离线缓存。'])
})

test('read failures include source identity and do not silently discard the official error', async () => {
  const result = await loadContentCatalog({
    listPackageRegistries: async () => [official],
    readPackageRegistry: async () => {
      throw new Error('Invalid registry signature')
    }
  })
  assert.deepEqual(result.registries, [])
  assert.deepEqual(result.errors, ['Phi Packages：Invalid registry signature'])
})

test('official source wins duplicate names while newest versions still win within one source class', () => {
  const local = registry('/local', 'directory', 'skill', '9.0.0')
  const remote = registry('/verified', 'official')
  const newer = registry('/verified-new', 'official', 'skill', '1.0.1')
  const selected = catalogPackages([local, remote, newer], 'skill')
  assert.equal(selected[0].registry.dir, '/verified-new')
  assert.equal(selected[0].entry.version, '1.0.1')
  assert.equal(
    catalogPackages([registry('/v1', 'directory'), local], 'skill')[0].registry.dir,
    '/local'
  )
})

test('skill and wrapper choices preserve official source precedence and generation installation path', () => {
  const skillChoices = knownSkillCatalogPackages([
    registry('/imported', 'directory', 'skill', '9.0.0'),
    registry('/official-generation', 'official')
  ])
  assert.equal(skillChoices[0].registryDir, '/official-generation')
  const wrappers = wrapperCatalogChoices(
    [],
    [
      registry('/imported', 'directory', 'wrapper', '9.0.0'),
      registry('/official-generation', 'official', 'wrapper')
    ]
  )
  assert.equal(wrappers[0].registryPath, '/official-generation')
  assert.equal(wrappers[0].installed, false)
})

test('legacy automatic wrappers use a verified source installation instead of a local enable action', () => {
  const choices = wrapperCatalogChoices(
    [
      {
        id: 'nf-core/modules/shared',
        name: 'shared',
        summary: 'Legacy cached wrapper',
        params: {},
        outputs: {},
        packageId: 'shared',
        enablementId: 'shared',
        packageSelected: false,
        packageEnabled: false
      }
    ],
    [registry('/official-generation', 'official', 'wrapper', '1.0.1')]
  )
  assert.equal(choices[0].installed, false)
  assert.equal(choices[0].selected, false)
  assert.equal(choices[0].registryPath, '/official-generation')
  assert.equal(choices[0].registryEntry?.version, '1.0.1')
})

test('all content types install with the selected registry generation, type, id, and exact version', async () => {
  const calls: unknown[][] = []
  const api = {
    installPackage: async (...args: unknown[]) => {
      calls.push(args)
      return []
    }
  }
  for (const type of ['skill', 'plugin', 'wrapper', 'mcp'] as const) {
    const entry = registry('/verified-generation', 'official', type).packages[0]
    await installCatalogPackage(api, '/verified-generation', entry)
  }
  assert.deepEqual(
    calls,
    ['skill', 'plugin', 'wrapper', 'mcp'].map((type) => [
      '/verified-generation',
      type,
      'shared',
      '1.0.0'
    ])
  )
})
