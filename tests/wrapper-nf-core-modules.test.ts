import assert from 'node:assert/strict'
import { basename } from 'node:path'
import test from 'node:test'

import {
  findWrapperCompositionEntry,
  listWrapperCompositionCatalog,
  resetWrapperCompositionCatalogCache
} from '../src/main/agent/wrappers/composition/discovery'
import { parseWrapperCompositionManifest } from '../src/main/agent/wrappers/composition/manifest'
import {
  buildWrapperCompositionInspectTool,
  buildWrapperCompositionSearchTool,
  buildWrapperCompositionTools
} from '../src/main/agent/wrappers/composition/tools'

const EXPECTED_MODULE_WRAPPER_IDS = [
  'nf-core/modules/fastp',
  'nf-core/modules/fastqc',
  'nf-core/modules/gffread',
  'nf-core/modules/gunzip',
  'nf-core/modules/multiqc',
  'nf-core/modules/star-align',
  'nf-core/modules/trimgalore'
]

test('composition discovery finds wrappers from the modules/subworkflows resource layout', () => {
  resetWrapperCompositionCatalogCache()

  const entries = listWrapperCompositionCatalog()
  assert.deepEqual(entries.map((entry) => entry.manifest.id).sort(), EXPECTED_MODULE_WRAPPER_IDS)

  assert.ok(entries.every((entry) => basename(entry.wrapperDir) === 'wrapper'))
  assert.ok(
    entries.every((entry) =>
      /resources\/wrappers\/(modules|subworkflows)\//.test(entry.componentDir)
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
