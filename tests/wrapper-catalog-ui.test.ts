import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  InstalledPackageView,
  PackageRegistryEntryView,
  PackageRegistryView
} from '../src/shared/packageManagerTypes'
import type { WrapperCompositionCatalogItem } from '../src/shared/wrapperCompositionManifestTypes'
import {
  filterWrapperCatalogChoices,
  wrapperCatalogChoices,
  wrapperCatalogGroups
} from '../src/renderer/src/features/wrapper/lib/wrapperCatalog'
import {
  CATALOG_DEFAULT_PAGE_SIZE,
  getCatalogPage
} from '../src/renderer/src/components/catalog/catalogPaging'

function packageEntry(id: string, version = '1.0.0'): PackageRegistryEntryView {
  return {
    id,
    type: 'wrapper',
    version,
    title: id,
    summary: `Install ${id}`,
    archive: `${id}.tgz`,
    sha256: 'a'.repeat(64),
    size: 123,
    dependsOn: []
  }
}

function registry(packages: PackageRegistryEntryView[], dir = '/registry'): PackageRegistryView {
  return {
    id: dir,
    dir,
    trust: 'builtin',
    schemaVersion: 1,
    generatedAt: '2026-10-05T00:00:00.000Z',
    packages
  }
}

function wrapper(
  packageId: string,
  overrides: Partial<WrapperCompositionCatalogItem> = {}
): WrapperCompositionCatalogItem {
  return {
    id: `nf-core/modules/${packageId}`,
    name: packageId,
    summary: 'FASTQ read quality',
    params: {},
    outputs: {},
    packageId,
    enablementId: packageId,
    ...overrides
  }
}

test('fresh wrapper discovery lists registry choices without installing or selecting all packages', () => {
  const choices = wrapperCatalogChoices(
    [],
    [
      registry([
        packageEntry('fastqc'),
        packageEntry('rnaseq'),
        { ...packageEntry('skill-qc'), type: 'skill' }
      ])
    ]
  )
  assert.deepEqual(
    choices.map((entry) => entry.id),
    ['fastqc', 'rnaseq']
  )
  assert.ok(choices.every((entry) => !entry.installed && !entry.selected && !entry.enabled))
  assert.equal(choices[0].registryPath, '/registry')
})

test('cached auto-seeded wrappers stay discoverable while disabled user choices remain installed', () => {
  const cached = [
    wrapper('fastqc', { packageSelected: false, packageEnabled: false }),
    wrapper('rnaseq', { packageSelected: true, packageEnabled: false })
  ]
  const choices = wrapperCatalogChoices(cached, [
    registry([packageEntry('fastqc'), packageEntry('rnaseq')])
  ])
  assert.equal(choices.length, 2)
  assert.equal(choices[0].cached, cached[0])
  assert.equal(choices[0].selected, false)
  assert.equal(choices[0].installed, true)
  assert.equal(choices[1].selected, true)
  assert.equal(choices[1].enabled, false)
})

test('discovery deduplicates shared packages and chooses the newest registry version for new installs', () => {
  const choices = wrapperCatalogChoices(
    [wrapper('quality'), wrapper('quality', { id: 'nf-core/subworkflows/quality' })],
    [registry([packageEntry('rnaseq')]), registry([packageEntry('rnaseq', '2.0.0')], '/new')]
  )
  assert.deepEqual(
    choices.map((entry) => entry.id),
    ['quality', 'rnaseq']
  )
  assert.equal(choices[1].registryEntry?.version, '2.0.0')
  assert.equal(choices[1].registryPath, '/new')
  assert.equal(choices[1].metadata, '/new')
  assert.equal(choices[1].version, '2.0.0')
  assert.equal(filterWrapperCatalogChoices(choices, '2.0.0')[0].id, 'rnaseq')
})

test('wrapper choices preserve actual package categories and infer workflow tiers for cached entries', () => {
  const choices = wrapperCatalogChoices(
    [
      wrapper('rnaseq', { id: 'nf-core/workflows/rnaseq' }),
      wrapper('prepare', { id: 'nf-core/subworkflows/prepare' }),
      wrapper('fastqc')
    ],
    [registry([{ ...packageEntry('fastqc'), category: '质量控制' }])]
  )
  assert.deepEqual(
    choices.map((choice) => [choice.id, 'category' in choice ? choice.category : undefined]),
    [
      ['fastqc', '质量控制'],
      ['prepare', '子流程'],
      ['rnaseq', '工作流']
    ]
  )
})

test('wrapper categories count distinct packages and are selected before the visible batch', () => {
  const cached = Array.from({ length: 80 }, (_, index) =>
    wrapper(`module-${index.toString().padStart(3, '0')}`)
  )
  cached.push(wrapper('z-rnaseq', { id: 'nf-core/workflows/z-rnaseq' }))
  cached.push(wrapper('z-rnaseq', { id: 'nf-core/workflows/duplicate', name: 'duplicate' }))
  const choices = wrapperCatalogChoices(cached, [])
  const groups = wrapperCatalogGroups(choices)

  assert.deepEqual(groups, [
    { id: 'all', label: '全部 Wrapper', count: 81 },
    { id: 'category:工作流', label: '工作流', count: 1 },
    { id: 'category:模块', label: '模块', count: 80 }
  ])
  assert.equal(
    getCatalogPage(choices, 0, CATALOG_DEFAULT_PAGE_SIZE).rows.some(
      (choice) => choice.id === 'z-rnaseq'
    ),
    false
  )
  assert.deepEqual(
    getCatalogPage(
      filterWrapperCatalogChoices(choices, 'RNA', 'category:工作流'),
      0,
      CATALOG_DEFAULT_PAGE_SIZE
    ).rows.map((choice) => choice.id),
    ['z-rnaseq']
  )
  assert.equal(filterWrapperCatalogChoices(choices, 'RNA', 'category:模块').length, 0)
  assert.equal(filterWrapperCatalogChoices(choices, '', 'category:missing').length, 0)
})

test('wrapper package group metadata follows the newest source without changing cached enablement', () => {
  const choices = wrapperCatalogChoices(
    [wrapper('quality', { packageEnabled: false })],
    [
      registry([{ ...packageEntry('quality'), category: '旧分组' }]),
      registry([{ ...packageEntry('quality', '2.0.0'), category: '质量控制' }], '/new')
    ]
  )

  assert.equal(choices[0].category, '质量控制')
  assert.equal(choices[0].metadata, 'nf-core')
  assert.equal(choices[0].installed, true)
  assert.equal(choices[0].enabled, false)
  assert.equal(filterWrapperCatalogChoices(choices, '质量控制').length, 1)
})

test('catalog search covers uncached packages and preserves custom-wrapper enablement identifiers', () => {
  const choices = wrapperCatalogChoices(
    [
      wrapper('unused', {
        id: 'custom/modules/my-quality',
        packageId: undefined,
        enablementId: 'custom-id',
        packageEnabled: false
      })
    ],
    [registry([packageEntry('rnaseq')])]
  )
  assert.deepEqual(
    filterWrapperCatalogChoices(choices, '  FASTQ  ').map((entry) => entry.id),
    ['custom-id']
  )
  assert.deepEqual(
    filterWrapperCatalogChoices(choices, 'install RNA').map((entry) => entry.id),
    ['rnaseq']
  )
  assert.equal(filterWrapperCatalogChoices(choices, 'missing').length, 0)
  assert.equal(choices[0].enabled, false)
})

test('previous automatic seeds are not mistaken for user installations when the tree is unavailable', () => {
  const installed = (id: string, source: string): InstalledPackageView => ({
    id,
    type: 'wrapper',
    version: '1.0.0',
    title: id,
    summary: '',
    dir: `/packages/${id}`,
    installedAt: '',
    installedBy: 'user',
    registry: source,
    sha256: '',
    trust: 'builtin',
    enabled: false
  })
  const choices = wrapperCatalogChoices(
    [],
    [registry([packageEntry('fastqc'), packageEntry('rnaseq', '2.0.0')])],
    [installed('fastqc', 'bundled-wrappers'), installed('rnaseq', 'builtin')]
  )
  assert.equal(choices[0].installed, true)
  assert.equal(choices[0].selected, false)
  assert.equal(choices[1].selected, true)
  assert.equal(choices[1].enabled, false)
  assert.equal(choices[1].version, '1.0.0')
  const cached = wrapperCatalogChoices(
    [wrapper('rnaseq')],
    [registry([packageEntry('rnaseq', '2.0.0')])],
    [installed('rnaseq', 'builtin')]
  )
  assert.equal(cached[0].metadata, 'nf-core')
  assert.equal(cached[0].category, '模块')
  assert.equal(cached[0].version, '1.0.0')
})
