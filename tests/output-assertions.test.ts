import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { verifyFileContentAssertion } from '../src/main/agent/verification/output-assertions'
import { parseWrapperCompositionManifest } from '../src/main/agent/wrappers/composition/manifest'
import { findFailedOutputAssertions } from '../src/main/agent/wrappers/composition/validate'

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'phi-output-assertions-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('verifyFileContentAssertion catches 0-byte files, invalid JSON, and broken TSV/CSV schemas', () => {
  withTempDir((dir) => {
    const emptyFile = join(dir, 'empty.tsv')
    writeFileSync(emptyFile, '')
    assert.equal(verifyFileContentAssertion(emptyFile, { nonEmpty: true }).ok, false)

    const badJson = join(dir, 'bad.json')
    writeFileSync(badJson, '{"broken": ')
    assert.equal(verifyFileContentAssertion(badJson, { nonEmpty: true, format: 'json' }).ok, false)

    const goodJson = join(dir, 'good.json')
    writeFileSync(goodJson, '{"ok": true}')
    assert.equal(verifyFileContentAssertion(goodJson, { nonEmpty: true, format: 'json' }).ok, true)

    const headerOnlyTsv = join(dir, 'header-only.tsv')
    writeFileSync(headerOnlyTsv, 'gene_id\tlog2FoldChange\tpadj\n')
    assert.equal(
      verifyFileContentAssertion(headerOnlyTsv, {
        nonEmpty: true,
        format: 'tsv',
        minDataRows: 1,
        requiredColumns: ['gene_id', 'padj']
      }).ok,
      false
    )

    const validTsv = join(dir, 'valid.tsv')
    writeFileSync(validTsv, 'gene_id\tlog2FoldChange\tpadj\nENSG0001\t1.5\t0.001\n')
    assert.equal(
      verifyFileContentAssertion(validTsv, {
        nonEmpty: true,
        format: 'tsv',
        minDataRows: 1,
        minColumns: 3,
        requiredColumns: ['gene_id', 'padj']
      }).ok,
      true
    )

    const missingColCsv = join(dir, 'missing-col.csv')
    writeFileSync(missingColCsv, 'sample,fastq_1\nS1,"/a, b/S1_R1.fq.gz"\n')
    const colResult = verifyFileContentAssertion(missingColCsv, {
      format: 'csv',
      requiredColumns: ['sample', 'fastq_1', 'fastq_2']
    })
    assert.equal(colResult.ok, false)
    assert.match(colResult.reason ?? '', /fastq_2/)
  })
})

test('verifyFileContentAssertion blocks symlink escapes outside rootDir', () => {
  withTempDir((dir) => {
    const root = join(dir, 'project')
    const outside = join(dir, 'secret.json')
    mkdirSync(root, { recursive: true })
    writeFileSync(outside, '{"secret": true}')
    const link = join(root, 'escape.json')
    symlinkSync(outside, link)

    const verdict = verifyFileContentAssertion(link, { format: 'json' }, { rootDir: root })
    assert.equal(verdict.ok, false)
    assert.match(verdict.reason ?? '', /not a regular file|escapes/)
  })
})

test('composition manifest parses output assertions and findFailedOutputAssertions enforces them', () => {
  withTempDir((dir) => {
    const manifest = parseWrapperCompositionManifest(`
id: acme/modules/counts
name: Counts
summary: Produces a gene count table
params:
  outdir:
    kind: output
    type: path
    required: true
outputs:
  counts:
    type: file
    path: '\${outdir}/counts.tsv'
    primary: true
    assertions:
      nonEmpty: true
      format: tsv
      minDataRows: 1
      minColumns: 2
      requiredColumns:
        - gene_id
        - sample_1
`)
    const outDir = join(dir, 'results')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'counts.tsv'), 'gene_id\tsample_1\n')
    const failures = findFailedOutputAssertions(manifest, { outdir: 'results' }, dir)
    assert.equal(failures.length, 1)
    assert.match(failures[0], /expected at least 1 data rows/)

    writeFileSync(join(outDir, 'counts.tsv'), 'gene_id\tsample_1\nGENE1\t42\n')
    assert.deepEqual(findFailedOutputAssertions(manifest, { outdir: 'results' }, dir), [])
  })
})
