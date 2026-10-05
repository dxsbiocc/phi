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
  wrapperCatalogChoices
} from '../src/renderer/src/features/wrapper/lib/wrapperCatalog'

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
    [registry([packageEntry('fastqc'), packageEntry('rnaseq')])],
    [installed('fastqc', 'bundled-wrappers'), installed('rnaseq', 'builtin')]
  )
  assert.equal(choices[0].installed, true)
  assert.equal(choices[0].selected, false)
  assert.equal(choices[1].selected, true)
  assert.equal(choices[1].enabled, false)
})
