import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  findWrapperCompositionEntry,
  listWrapperCompositionCatalog,
  readWrapperCompositionDag,
  readWrapperModuleDetails,
  resetWrapperCompositionCatalogCache
} from '../src/main/agent/wrappers/composition/discovery'
import { WrapperJobManager } from '../src/main/agent/wrappers/composition/job-manager'
import {
  buildWrapperCompositionRunTool,
  buildWrapperCompositionTools
} from '../src/main/agent/wrappers/composition/tools'
import { writeGffreadFixture } from './helpers/compositionFixtures'

async function withTree(
  callback: (options: { sourceRoot: string; agentDir: string }) => Promise<void> | void
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'phi-wrapper-discovery-'))
  const sourceRoot = join(root, 'source')
  const agentDir = join(root, 'agent')
  writeGffreadFixture(sourceRoot)
  resetWrapperCompositionCatalogCache()
  try {
    await callback({ sourceRoot, agentDir })
  } finally {
    resetWrapperCompositionCatalogCache()
    rmSync(root, { recursive: true, force: true })
  }
}

test('composition discovery scans all three component tiers and isolates malformed manifests', async () => {
  await withTree((options) => {
    for (const tier of ['subworkflows', 'workflows']) {
      const dir = join(options.sourceRoot, tier, 'acme', 'demo', 'wrapper')
      mkdirSync(dir, { recursive: true })
      writeFileSync(
        join(dir, 'wrapper.yaml'),
        JSON.stringify({
          id: `acme/${tier}/demo`,
          name: 'Demo',
          summary: 'Tier fixture',
          params: {},
          outputs: { report: { type: 'path', path: 'results/report.txt', primary: true } }
        })
      )
    }
    const malformed = join(options.sourceRoot, 'modules/acme/bad/wrapper')
    mkdirSync(malformed, { recursive: true })
    writeFileSync(join(malformed, 'wrapper.yaml'), 'invalid manifest')
    assert.deepEqual(
      listWrapperCompositionCatalog(options)
        .map((entry) => entry.manifest.id)
        .sort(),
      ['acme/subworkflows/demo', 'acme/workflows/demo', 'nf-core/modules/gffread']
    )
    const found = findWrapperCompositionEntry('nf-core/modules/gffread', options)
    assert.ok(found)
    assert.equal(found.manifest.params.gff.kind, 'input')
    assert.equal(findWrapperCompositionEntry('acme/modules/missing', options), undefined)
  })
})

test('composition discovery reads DAG and module details, with absent-file fallbacks', async () => {
  await withTree((options) => {
    const id = 'nf-core/modules/gffread'
    assert.match(readWrapperCompositionDag(id, options) ?? '', /GFFREAD/)
    const details = readWrapperModuleDetails(id, options)
    assert.equal(details?.meta?.description, 'Annotation conversion fixture')
    assert.deepEqual(details?.meta?.keywords, ['conversion'])
    assert.equal(details?.meta?.tools?.[0].name, 'gffread')
    assert.deepEqual(details?.meta?.tools?.[0].licence, ['MIT'])
    assert.match(details?.environment ?? '', /gffread=0\.12\.7/)
    assert.equal(readWrapperCompositionDag('acme/modules/missing', options), undefined)
    assert.equal(readWrapperModuleDetails('acme/modules/missing', options), undefined)
    rmSync(join(options.sourceRoot, 'modules/nf-core/gffread/wrapper/dag.mmd'))
    rmSync(join(options.sourceRoot, 'modules/nf-core/gffread/meta.yml'))
    rmSync(join(options.sourceRoot, 'modules/nf-core/gffread/environment.yml'))
    assert.equal(readWrapperCompositionDag(id, options), undefined)
    assert.equal(readWrapperModuleDetails(id, options), undefined)
  })
})

test('composition tools retain the generic workflow and reject invalid inputs before execution', async () => {
  await withTree(async (discovery) => {
    const jobs = new WrapperJobManager({ discovery, agentDir: () => discovery.agentDir })
    assert.deepEqual(
      buildWrapperCompositionTools(jobs, discovery).map((tool) => tool.name),
      [
        'wrapper_search',
        'wrapper_inspect',
        'wrapper_run',
        'wrapper_status',
        'wrapper_wait',
        'wrapper_cancel'
      ]
    )
    const run = buildWrapperCompositionRunTool(jobs)
    const unknown = await run.execute(
      'unknown-param',
      {
        id: 'nf-core/modules/gffread',
        params: { gf: 'x.gff3' }
      },
      undefined,
      undefined as never
    )
    assert.equal(unknown.isError, true)
    assert.match(JSON.stringify(unknown.content), /Unknown parameter: gf/)
    const missing = await run.execute(
      'missing-input',
      {
        id: 'nf-core/modules/gffread',
        params: { gff: '/definitely/not/here.gff3' }
      },
      undefined,
      undefined as never
    )
    assert.equal(missing.isError, true)
    assert.match(JSON.stringify(missing.content), /input path does not exist/)
    assert.deepEqual(await jobs.list(), [])
  })
})
