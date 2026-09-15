import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PHI_WRAPPER_RUNTIME_VERSION,
  assertEngineExecutable,
  canonicalManifestDigest,
  isEngineExecutable,
  parseWrapperManifest
} from '../src/main/agent/wrappers/manifest'
import { validateWrapperParams } from '../src/main/agent/wrappers/schema'
import { readLegacyFastqQcWrapperManifestText } from './helpers/wrapperFixtures'

function readFixture(): string {
  return readLegacyFastqQcWrapperManifestText()
}

test('parseWrapperManifest accepts the declared fastqc -> multiqc steps DAG', () => {
  const result = parseWrapperManifest(readFixture())
  assert.equal(result.valid, true)
  assert.deepEqual(result.manifest?.steps, [
    { id: 'fastqc', label: 'FastQC', dependsOn: [] },
    { id: 'multiqc', label: 'MultiQC', dependsOn: ['fastqc'] }
  ])
})

test('parseWrapperManifest rejects a step depending on an undeclared step id', () => {
  const raw = readFixture().replace('dependsOn: [fastqc]', 'dependsOn: [does-not-exist]')
  const result = parseWrapperManifest(raw)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.includes('未声明的 step')))
})

test('parseWrapperManifest accepts a manifest with no steps declared at all', () => {
  const raw = readFixture().replace(/steps:\n(?:.|\n)*?\nenvironment:/, 'environment:')
  const result = parseWrapperManifest(raw)
  assert.equal(result.valid, true)
  assert.equal(result.manifest?.steps, undefined)
})

test('parseWrapperManifest accepts the bundled phi/ngs/fastq-qc fixture', () => {
  const result = parseWrapperManifest(readFixture())
  assert.equal(result.valid, true)
  assert.deepEqual(result.errors, [])
  assert.equal(result.manifest?.id, 'phi/ngs/fastq-qc')
  assert.equal(result.manifest?.shortId, 'fastq-qc')
  assert.equal(result.manifest?.engine.type, 'nextflow')
  assert.equal(result.manifest?.resourceClass, 'light')
})

test('parseWrapperManifest preserves docs/license/citation metadata untouched', () => {
  const result = parseWrapperManifest(readFixture())
  assert.deepEqual(result.manifest?.license, {
    wrapper: 'MIT',
    tools: [
      { name: 'FastQC', license: 'GPL-3.0' },
      { name: 'MultiQC', license: 'GPL-3.0' }
    ]
  })
  assert.deepEqual(result.manifest?.citations, [
    { id: 'multiqc', doi: '10.1093/bioinformatics/btw354' }
  ])
  assert.equal(result.manifest?.tests?.smoke?.params, 'tests/smoke/params.yaml')
})

test('parseWrapperManifest rejects a non-SemVer version', () => {
  const raw = readFixture().replace('version: 1.0.0', 'version: not-a-version')
  const result = parseWrapperManifest(raw)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.includes('version 必须是合法的 SemVer')))
})

test('parseWrapperManifest rejects an unsupported phiWrapperVersion', () => {
  const raw = readFixture().replace('phiWrapperVersion: 1', 'phiWrapperVersion: 2')
  const result = parseWrapperManifest(raw)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.includes('phiWrapperVersion')))
})

test('parseWrapperManifest rejects a runtime range incompatible with the current Phi wrapper runtime', () => {
  const raw = readFixture().replace('maxVersion: 1.x', 'maxVersion: 0.9.0')
  const result = parseWrapperManifest(raw)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.includes(PHI_WRAPPER_RUNTIME_VERSION)))
})

test('parseWrapperManifest accepts a non-nextflow engine type but marks it non-executable', () => {
  const raw = readFixture().replace('type: nextflow', 'type: snakemake')
  const result = parseWrapperManifest(raw)
  assert.equal(result.valid, true)
  assert.ok(result.manifest)
  assert.equal(isEngineExecutable(result.manifest!), false)
  assert.throws(() => assertEngineExecutable(result.manifest!), /暂不支持执行/)
})

test('parseWrapperManifest requires at least one declared output', () => {
  const raw = readFixture().replace(/outputs:\n(?:.|\n)*?\nsummaries:/, 'outputs: []\nsummaries:')
  const result = parseWrapperManifest(raw)
  assert.equal(result.valid, false)
  assert.ok(result.errors.some((error) => error.includes('outputs 必须至少声明一个输出')))
})

test('a manifest self-declaring verification.status: official_verified is parsed but not treated as trusted by anything here', () => {
  const raw = readFixture().replace('status: unverified', 'status: official_verified')
  const result = parseWrapperManifest(raw)
  assert.equal(result.valid, true)
  // manifest.ts exposes no function that derives a trust tier from this field —
  // trust tier resolution belongs to catalog.ts (Milestone P1.3), driven by
  // install location, not manifest content.
  assert.equal(result.manifest?.verification?.status, 'official_verified')
})

test('canonicalManifestDigest is stable across key order and whitespace but changes with content', () => {
  const result = parseWrapperManifest(readFixture())
  const digest = canonicalManifestDigest(result.manifest!)
  assert.match(digest, /^sha256:[0-9a-f]{64}$/)

  const reordered = { ...result.manifest!, name: result.manifest!.name }
  const swapped = {
    version: reordered.version,
    id: reordered.id,
    ...reordered
  }
  assert.equal(canonicalManifestDigest(swapped as typeof reordered), digest)

  const changed = { ...result.manifest!, version: '2.0.0' }
  assert.notEqual(canonicalManifestDigest(changed), digest)
})

test('validateWrapperParams enforces the manifest parameter schema', () => {
  const result = parseWrapperManifest(readFixture())
  const schema = result.manifest!.parameters.schema

  const valid = validateWrapperParams(schema, { reads: 'data/*_{R1,R2}.fastq.gz', threads: 8 })
  assert.equal(valid.valid, true)

  const invalid = validateWrapperParams(schema, { threads: 999 })
  assert.equal(invalid.valid, false)
  assert.ok(invalid.errors.length > 0)
})
