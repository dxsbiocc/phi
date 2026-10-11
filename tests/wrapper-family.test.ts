import assert from 'node:assert/strict'
import test from 'node:test'

import type { WrapperCompositionCatalogItem } from '../src/shared/wrapperCompositionManifestTypes'
import {
  groupWrapperPackages,
  wrapperFamilyName,
  wrapperToolLabel
} from '../src/renderer/src/features/wrapper/lib/wrapperFamily'

function item(
  id: string,
  packageId: string | undefined,
  overrides: Partial<WrapperCompositionCatalogItem> = {}
): WrapperCompositionCatalogItem {
  return {
    id,
    name: id,
    summary: '',
    params: {},
    outputs: {},
    ...(packageId ? { packageId, enablementId: packageId } : {}),
    ...overrides
  }
}

test('family names drop the package kind and provider prefix', () => {
  assert.equal(wrapperFamilyName('module-nf-core-samtools'), 'samtools')
  assert.equal(wrapperFamilyName('module-nf-core-gatk4'), 'gatk4')
  assert.equal(wrapperFamilyName('module-local-differential-expression'), 'differential-expression')
  assert.equal(
    wrapperFamilyName('subworkflow-nf-core-bam-sort-stats-samtools'),
    'bam-sort-stats-samtools'
  )
  assert.equal(wrapperFamilyName('workflow-nf-core-rnaseq'), 'rnaseq')
  assert.equal(wrapperFamilyName('custom-mine'), 'custom-mine')
})

test('wrappers of one package collapse into one row, sorted by tool name', () => {
  const packages = groupWrapperPackages([
    item('nf-core/modules/samtools-view', 'module-nf-core-samtools'),
    item('nf-core/modules/samtools-sort', 'module-nf-core-samtools'),
    item('nf-core/modules/bowtie2-align', 'module-nf-core-bowtie2', { packageEnabled: false }),
    item('local/modules/mine', undefined)
  ])
  assert.deepEqual(
    packages.map((entry) => [entry.key, entry.name, entry.members.length]),
    [
      ['module-nf-core-bowtie2', 'bowtie2', 1],
      ['module-nf-core-samtools', 'samtools', 2],
      ['local/modules/mine', 'mine', 1]
    ]
  )
  const samtools = packages[1]
  assert.deepEqual(
    samtools.members.map((entry) => entry.id),
    ['nf-core/modules/samtools-sort', 'nf-core/modules/samtools-view']
  )
  assert.equal(samtools.tier, 'modules')
  assert.equal(samtools.enabled, true)
  assert.equal(packages[0].enabled, false)
})

test('opening a package prefers the member the user already has open', () => {
  const [samtools] = groupWrapperPackages([
    item('nf-core/modules/samtools-sort', 'module-nf-core-samtools'),
    item('nf-core/modules/samtools-view', 'module-nf-core-samtools')
  ])
  assert.equal(samtools.open('nf-core/modules/samtools-view').id, 'nf-core/modules/samtools-view')
  assert.equal(samtools.open('elsewhere').id, 'nf-core/modules/samtools-sort')
  assert.equal(samtools.open(null).id, 'nf-core/modules/samtools-sort')
})

test('tool labels drop the family prefix of the wrapper id', () => {
  assert.equal(wrapperToolLabel('samtools', 'nf-core/modules/samtools-addreplacerg'), 'addreplacerg')
  assert.equal(wrapperToolLabel('gatk4', 'nf-core/modules/gatk4-mutect2'), 'mutect2')
  assert.equal(wrapperToolLabel('rnaseq', 'nf-core/workflows/rnaseq'), 'rnaseq')
  assert.equal(wrapperToolLabel('bowtie2', 'nf-core/modules/other-tool'), 'other-tool')
})
