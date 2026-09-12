import assert from 'node:assert/strict'
import test from 'node:test'

import {
  parseSamplesheetCsv,
  parseSamplesheetRow
} from '../src/renderer/src/features/wrapper/lib/wrapperSamplesheet'

test('parseSamplesheetRow splits a plain unquoted row', () => {
  assert.deepEqual(parseSamplesheetRow('S1,/data/S1_R1.fastq.gz,/data/S1_R2.fastq.gz'), [
    'S1',
    '/data/S1_R1.fastq.gz',
    '/data/S1_R2.fastq.gz'
  ])
})

test('parseSamplesheetRow un-quotes a field containing a comma, matching samplesheet.ts csvField', () => {
  assert.deepEqual(parseSamplesheetRow('S1,"/data/a, b/S1_R1.fastq.gz",/data/S1_R2.fastq.gz'), [
    'S1',
    '/data/a, b/S1_R1.fastq.gz',
    '/data/S1_R2.fastq.gz'
  ])
})

test('parseSamplesheetRow un-doubles an escaped quote inside a quoted field', () => {
  assert.deepEqual(parseSamplesheetRow('S1,"/data/a""b/S1_R1.fastq.gz"'), [
    'S1',
    '/data/a"b/S1_R1.fastq.gz'
  ])
})

test('parseSamplesheetCsv splits header from rows and skips blank lines', () => {
  const csv = 'sample,fastq_1,fastq_2\nS1,/data/S1_R1.fastq.gz,/data/S1_R2.fastq.gz\n'
  const { header, rows } = parseSamplesheetCsv(csv)
  assert.deepEqual(header, ['sample', 'fastq_1', 'fastq_2'])
  assert.deepEqual(rows, [['S1', '/data/S1_R1.fastq.gz', '/data/S1_R2.fastq.gz']])
})

test('parseSamplesheetCsv round-trips a real quoted samplesheet from buildPairedEndFastqSamplesheet', async () => {
  const { buildPairedEndFastqSamplesheet } = await import('../src/main/agent/wrappers/samplesheet')
  const { csv } = buildPairedEndFastqSamplesheet([
    '/data/a, b/S1_R1.fastq.gz',
    '/data/a, b/S1_R2.fastq.gz'
  ])
  const { header, rows } = parseSamplesheetCsv(csv)
  assert.deepEqual(header, ['sample', 'fastq_1', 'fastq_2'])
  assert.deepEqual(rows, [['S1', '/data/a, b/S1_R1.fastq.gz', '/data/a, b/S1_R2.fastq.gz']])
})
