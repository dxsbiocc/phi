import assert from 'node:assert/strict'
import { basename } from 'node:path'
import test from 'node:test'

import {
  findWrapperCompositionEntry,
  listWrapperCompositionCatalog,
  readWrapperCompositionDag,
  readWrapperModuleDetails,
  resetWrapperCompositionCatalogCache
} from '../src/main/agent/wrappers/composition/discovery'
import { parseWrapperCompositionManifest } from '../src/main/agent/wrappers/composition/manifest'
import {
  buildWrapperCompositionInspectTool,
  buildWrapperCompositionSearchTool,
  buildWrapperCompositionTools
} from '../src/main/agent/wrappers/composition/tools'

const EXPECTED_MODULE_WRAPPER_IDS = [
  'nf-core/modules/bowtie2-align',
  'nf-core/modules/bowtie2-build',
  'nf-core/modules/fastp',
  'nf-core/modules/fastqc',
  'nf-core/modules/gffread',
  'nf-core/modules/gunzip',
  'nf-core/modules/hisat2-align',
  'nf-core/modules/hisat2-build',
  'nf-core/modules/hisat2-extractsplicesites',
  'nf-core/modules/kallisto-index',
  'nf-core/modules/kallisto-quant',
  'nf-core/modules/multiqc',
  'nf-core/modules/rsem-calculateexpression',
  'nf-core/modules/rsem-preparereference',
  'nf-core/modules/salmon-index',
  'nf-core/modules/salmon-quant',
  'nf-core/modules/samtools-faidx',
  'nf-core/modules/samtools-fastq',
  'nf-core/modules/samtools-flagstat',
  'nf-core/modules/samtools-idxstats',
  'nf-core/modules/samtools-index',
  'nf-core/modules/samtools-sort',
  'nf-core/modules/samtools-stats',
  'nf-core/modules/samtools-view',
  'nf-core/modules/star-align',
  'nf-core/modules/star-genomegenerate',
  'nf-core/modules/stringtie-merge',
  'nf-core/modules/stringtie-stringtie',
  'nf-core/modules/trimgalore',
  'nf-core/workflows/rnaseq'
]

test('composition discovery finds wrappers from the modules/subworkflows/workflows resource layout', () => {
  resetWrapperCompositionCatalogCache()

  const entries = listWrapperCompositionCatalog()
  assert.deepEqual(entries.map((entry) => entry.manifest.id).sort(), EXPECTED_MODULE_WRAPPER_IDS)

  assert.ok(entries.every((entry) => basename(entry.wrapperDir) === 'wrapper'))
  assert.ok(
    entries.every((entry) =>
      /resources\/wrappers\/(modules|subworkflows|workflows)\//.test(entry.componentDir)
    )
  )
})

test('composition discovery can find a wrapper by canonical id', () => {
  resetWrapperCompositionCatalogCache()

  const entry = findWrapperCompositionEntry('nf-core/modules/star-align')
  assert.ok(entry)
  assert.equal(entry!.manifest.name, 'STAR align')
  assert.equal(entry!.manifest.params.reads.kind, 'input')
})

test('readWrapperCompositionDag reads the pre-generated Nextflow DAG next to a wrapper', () => {
  resetWrapperCompositionCatalogCache()

  const dag = readWrapperCompositionDag('nf-core/modules/fastqc')
  assert.ok(dag)
  assert.match(dag!, /^flowchart TB/)
  assert.match(dag!, /FASTQC/)
})

test('readWrapperCompositionDag returns undefined for an unknown wrapper id', () => {
  resetWrapperCompositionCatalogCache()

  assert.equal(readWrapperCompositionDag('nf-core/modules/does-not-exist'), undefined)
})

test('readWrapperModuleDetails reads real meta.yml/environment.yml next to a module', () => {
  resetWrapperCompositionCatalogCache()

  const details = readWrapperModuleDetails('nf-core/modules/fastqc')
  assert.ok(details)
  assert.equal(details!.meta?.description, 'Run FastQC on sequenced reads')
  assert.ok(details!.meta?.keywords?.includes('quality control'))
  assert.equal(details!.meta?.tools?.[0].name, 'fastqc')
  assert.match(details!.meta?.tools?.[0].description ?? '', /general quality metrics/)
  assert.deepEqual(details!.meta?.tools?.[0].licence, ['GPL-2.0-only'])
  assert.ok(details!.meta?.tools?.[0].homepage?.startsWith('https://'))
  assert.ok(details!.meta?.authors && details!.meta.authors.length > 0)

  assert.match(details!.environment ?? '', /channels:/)
  assert.match(details!.environment ?? '', /bioconda::fastqc=0\.12\.1/)
})

test('readWrapperModuleDetails returns undefined for a wrapper with neither file (the full pipeline)', () => {
  resetWrapperCompositionCatalogCache()

  assert.equal(readWrapperModuleDetails('nf-core/workflows/rnaseq'), undefined)
})

test('readWrapperModuleDetails returns undefined for an unknown wrapper id', () => {
  resetWrapperCompositionCatalogCache()

  assert.equal(readWrapperModuleDetails('nf-core/modules/does-not-exist'), undefined)
})

test('wrapper.search lists matching composition wrappers', async () => {
  resetWrapperCompositionCatalogCache()

  const result = await buildWrapperCompositionSearchTool().execute('call-1', {
    query: 'fastqc'
  })

  assert.equal(result.isError, undefined)
  const details = result.details as { results: Array<{ id: string }> }
  assert.deepEqual(
    details.results.map((item) => item.id),
    ['nf-core/modules/fastqc']
  )
})

test('wrapper.inspect returns the composition manifest plus default params', async () => {
  resetWrapperCompositionCatalogCache()

  const result = await buildWrapperCompositionInspectTool().execute('call-1', {
    id: 'nf-core/modules/fastqc'
  })

  assert.equal(result.isError, undefined)
  const details = result.details as {
    manifest: { id: string; params: Record<string, unknown> }
    defaultParams: Record<string, unknown>
  }
  assert.equal(details.manifest.id, 'nf-core/modules/fastqc')
  assert.deepEqual(details.defaultParams, {
    reads: 'tests/data/test_{1,2}.fastq.gz',
    outdir: 'results'
  })
})

test('composition tools expose the generic wrapper workflow only', () => {
  assert.deepEqual(
    buildWrapperCompositionTools().map((tool) => tool.name),
    ['wrapper.search', 'wrapper.inspect', 'wrapper.run']
  )
})

test('composition manifest parser rejects invalid param kinds', () => {
  assert.throws(
    () =>
      parseWrapperCompositionManifest(`
id: acme/tools/bad
name: Bad
summary: Invalid
params:
  reads:
    kind: file
    type: fastq_glob
outputs:
  reports:
    type: directory
    path: results
`),
    /kind must be input, output, or option/
  )
})
