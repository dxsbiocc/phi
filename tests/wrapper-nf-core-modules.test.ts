import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { basename, join } from 'node:path'
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
  buildWrapperCompositionRunTool,
  buildWrapperCompositionSearchTool,
  buildWrapperCompositionTools
} from '../src/main/agent/wrappers/composition/tools'
import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'
import { validateWrapperParams } from '../src/main/agent/wrappers/composition/validate'

const EXPECTED_MODULE_WRAPPER_IDS = [
  'nf-core/modules/bedtools-genomecov',
  'nf-core/modules/bowtie2-align',
  'nf-core/modules/bowtie2-build',
  'nf-core/modules/cat-fastq',
  'nf-core/modules/fastp',
  'nf-core/modules/fastqc',
  'nf-core/modules/fq-lint',
  'nf-core/modules/gffread',
  'nf-core/modules/gunzip',
  'nf-core/modules/hisat2-align',
  'nf-core/modules/hisat2-build',
  'nf-core/modules/hisat2-extractsplicesites',
  'nf-core/modules/kallisto-index',
  'nf-core/modules/kallisto-quant',
  'nf-core/modules/multiqc',
  'nf-core/modules/picard-markduplicates',
  'nf-core/modules/rsem-calculateexpression',
  'nf-core/modules/rsem-preparereference',
  'nf-core/modules/rseqc-bamstat',
  'nf-core/modules/rseqc-inferexperiment',
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
  'nf-core/modules/seqkit-stats',
  'nf-core/modules/star-align',
  'nf-core/modules/star-genomegenerate',
  'nf-core/modules/stringtie-merge',
  'nf-core/modules/stringtie-stringtie',
  'nf-core/modules/subread-featurecounts',
  'nf-core/modules/trimgalore',
  'nf-core/modules/untar',
  'nf-core/subworkflows/bam-sort-stats-samtools',
  'nf-core/subworkflows/fastq-align-hisat2',
  'nf-core/subworkflows/fastq-qc-trim-filter-setstrandedness',
  'nf-core/subworkflows/fastq-remove-rrna',
  'nf-core/subworkflows/quantify-pseudo-alignment',
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

test('wrapper_search lists matching composition wrappers', async () => {
  resetWrapperCompositionCatalogCache()

  const result = await buildWrapperCompositionSearchTool().execute('call-1', {
    query: 'fastqc'
  })

  assert.equal(result.isError, undefined)
  const details = result.details as {
    results: Array<{ id: string; name: string; summary: string }>
  }
  // Matching is a substring search over id/name/summary, so wrappers that merely
  // mention FastQC (e.g. the QC/trim subworkflow) are legitimate hits too.
  assert.ok(details.results.some((item) => item.id === 'nf-core/modules/fastqc'))
  for (const item of details.results) {
    assert.match(`${item.id} ${item.name} ${item.summary}`.toLowerCase(), /fastqc/)
  }
  assert.ok(details.results.length < listWrapperCompositionCatalog().length)
})

test('wrapper_inspect returns the composition manifest plus default params', async () => {
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
    buildWrapperCompositionTools(new WrapperJobManager()).map((tool) => tool.name),
    [
      'wrapper_search',
      'wrapper_inspect',
      'wrapper_run',
      'wrapper_status',
      'wrapper_wait',
      'wrapper_cancel'
    ]
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

test('every bundled wrapper passes validation with its own default params', () => {
  resetWrapperCompositionCatalogCache()

  for (const entry of listWrapperCompositionCatalog()) {
    const defaults = JSON.parse(
      readFileSync(join(entry.wrapperDir, 'params.json'), 'utf-8')
    ) as Record<string, unknown>
    assert.deepEqual(
      validateWrapperParams(entry.manifest, defaults, {}, entry.componentDir),
      [],
      `${entry.manifest.id} default params should validate`
    )
  }
})

test('wrapper_run rejects invalid params before launching Nextflow', async () => {
  resetWrapperCompositionCatalogCache()
  const tool = buildWrapperCompositionRunTool(new WrapperJobManager())

  const unknown = await tool.execute('call-1', {
    id: 'nf-core/modules/fastqc',
    params: { read: 'x.fastq.gz' }
  })
  assert.equal(unknown.isError, true)
  assert.match(JSON.stringify(unknown.content), /Unknown parameter: read/)

  const plain = await tool.execute('call-2', {
    id: 'nf-core/modules/gffread',
    params: { gff: '/definitely/not/here.gff3' }
  })
  assert.equal(plain.isError, true)
  assert.match(JSON.stringify(plain.content), /input path does not exist/)
})
