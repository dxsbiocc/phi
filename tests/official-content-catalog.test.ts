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

test('catalog browsing uses the website API generation instead of retaining the old registry skill list', async () => {
  const reads: string[] = []
  const latest = registry('/verified-latest', 'official')
  latest.packages[0] = { ...latest.packages[0], id: 'new-skill', title: 'New skill' }
  const api = {
    readOfficialContentCatalog: async () => {
      reads.push('website-api')
      return latest
    },
    listPackageRegistries: async () => [official],
    readPackageRegistry: async () => {
      reads.push('old-registry')
      return registry('/verified-old', 'official')
    }
  }
  const catalog = await loadContentCatalog(api)
  assert.deepEqual(
    knownSkillCatalogPackages(catalog.registries).map((item) => item.id),
    ['new-skill']
  )
  assert.equal(reads[0], 'website-api')
})

test('a fresh website generation replaces unavailable official snapshots and preserves imported sources and trust', async () => {
  const reads: unknown[] = []
  const latest = { ...registry('/website-generation', 'official'), trust: 'imported' as const }
  const result = await loadContentCatalog(
    {
      readOfficialContentCatalog: async (force) => {
        reads.push(['website', force])
        return latest
      },
      listPackageRegistries: async () => {
        reads.push('known-sources')
        return [
          { ...official, status: 'unavailable', error: 'Outdated source state' },
          { id: 'local', kind: 'directory', path: '/local', removable: true }
        ]
      },
      readPackageRegistry: async (path) => {
        reads.push(path)
        return registry(path, 'directory')
      }
    },
    { forceRefresh: true }
  )
  assert.deepEqual(reads, [['website', true], 'known-sources', '/local'])
  assert.deepEqual(
    result.registries.map((entry) => entry.dir),
    ['/website-generation', '/local']
  )
  assert.equal(result.registries[0].trust, 'imported')
  assert.deepEqual(result.errors, [])
})

test('website API failure retries the original official source and reports the fallback', async () => {
  const paths: string[] = []
  const result = await loadContentCatalog({
    readOfficialContentCatalog: async () => {
      throw new Error('Website temporarily unavailable')
    },
    listPackageRegistries: async () => [
      { ...official, status: 'unavailable', error: 'Old status' }
    ],
    readPackageRegistry: async (path) => {
      paths.push(path)
      return registry('/original-verified-generation', 'official')
    }
  })
  assert.deepEqual(paths, ['phi-packages'])
  assert.equal(result.registries[0].dir, '/original-verified-generation')
  assert.match(
    result.errors.join('\n'),
    /Could not refresh the Phi Website catalog.*Website temporarily unavailable/
  )
  assert.match(result.notices.join('\n'), /Falling back.*Phi Packages/)
})

test('both official source failures remain visible while a user directory is still usable', async () => {
  const result = await loadContentCatalog({
    readOfficialContentCatalog: async () => {
      throw new Error('Website offline')
    },
    listPackageRegistries: async () => [
      { id: 'local', kind: 'directory', path: '/local', removable: true }
    ],
    readPackageRegistry: async (path) => {
      if (path === 'phi-packages') throw new Error('Signature verification failed')
      return registry(path, 'directory')
    }
  })
  assert.deepEqual(
    result.registries.map((entry) => entry.dir),
    ['/local']
  )
  assert.match(result.errors.join('\n'), /Website offline/)
  assert.match(result.errors.join('\n'), /Phi Packages.*Signature verification failed/)
})

test('a successful website catalog survives a failed local source inventory', async () => {
  const result = await loadContentCatalog({
    readOfficialContentCatalog: async () => registry('/fresh', 'official'),
    listPackageRegistries: async () => {
      throw new Error('Local directory list failed')
    },
    readPackageRegistry: async () => {
      throw new Error('Do not read the old official snapshot')
    }
  })
  assert.equal(result.registries[0].dir, '/fresh')
  assert.match(result.errors.join('\n'), /Local directory list failed/)
})

test('website provider cache feedback reaches the catalog without claiming signed trust', async () => {
  const result = await loadContentCatalog({
    readOfficialContentCatalog: async () => ({
      ...registry('/website-cache', 'official'),
      trust: 'imported',
      status: 'cached',
      notice: '官网目录离线，正在使用固定来源缓存。'
    }),
    listPackageRegistries: async () => [official],
    readPackageRegistry: async () => {
      throw new Error('Do not replace the API cache')
    }
  })
  assert.equal(result.registries[0].trust, 'imported')
  assert.deepEqual(result.notices, ['官网目录离线，正在使用固定来源缓存。'])
})

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
  assert.match(result.errors.join('\n'), /older backend.*restart Phi/)
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
  assert.match(result.errors.join('\n'), /older backend/)
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
  assert.deepEqual(result.notices, ['Phi Packages: using the offline cache.'])
})

test('read failures include source identity and do not silently discard the official error', async () => {
  const result = await loadContentCatalog({
    listPackageRegistries: async () => [official],
    readPackageRegistry: async () => {
      throw new Error('Invalid registry signature')
    }
  })
  assert.deepEqual(result.registries, [])
  assert.deepEqual(result.errors, ['Phi Packages: Invalid registry signature'])
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
