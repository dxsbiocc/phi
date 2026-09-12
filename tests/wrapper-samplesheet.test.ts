import assert from 'node:assert/strict'
import test from 'node:test'

import { buildPairedEndFastqSamplesheet } from '../src/main/agent/wrappers/samplesheet'

test('buildPairedEndFastqSamplesheet pairs R1/R2 files by sample and sorts rows', () => {
  const result = buildPairedEndFastqSamplesheet([
    '/data/S2_R1.fastq.gz',
    '/data/S1_R1.fastq.gz',
    '/data/S2_R2.fastq.gz',
    '/data/S1_R2.fastq.gz'
  ])

  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.rows, [
    { sample: 'S1', fastq_1: '/data/S1_R1.fastq.gz', fastq_2: '/data/S1_R2.fastq.gz' },
    { sample: 'S2', fastq_1: '/data/S2_R1.fastq.gz', fastq_2: '/data/S2_R2.fastq.gz' }
  ])
  assert.equal(
    result.csv,
    'sample,fastq_1,fastq_2\nS1,/data/S1_R1.fastq.gz,/data/S1_R2.fastq.gz\nS2,/data/S2_R1.fastq.gz,/data/S2_R2.fastq.gz'
  )
})

test('buildPairedEndFastqSamplesheet reports an unrecognized file name instead of dropping it silently', () => {
  const result = buildPairedEndFastqSamplesheet(['/data/notes.txt'])
  assert.equal(result.rows.length, 0)
  assert.match(result.errors[0], /无法从文件名识别样本\/mate 信息/)
})

test('buildPairedEndFastqSamplesheet reports a sample missing its R1 mate', () => {
  const result = buildPairedEndFastqSamplesheet(['/data/S1_R2.fastq.gz'])
  assert.equal(result.rows.length, 0)
  assert.match(result.errors[0], /缺少 R1 文件/)
})

test('buildPairedEndFastqSamplesheet quotes a path containing a comma instead of corrupting the row', () => {
  // A path with a literal comma is rare but real (an oddly-named project
  // directory) — without RFC4180 quoting, this would silently shift every
  // later column in the CSV row, which Nextflow would then misread.
  const result = buildPairedEndFastqSamplesheet([
    '/data/a, b/S1_R1.fastq.gz',
    '/data/a, b/S1_R2.fastq.gz'
  ])

  assert.deepEqual(result.errors, [])
  const lines = result.csv.split('\n')
  assert.equal(lines[0], 'sample,fastq_1,fastq_2')
  assert.equal(lines[1], 'S1,"/data/a, b/S1_R1.fastq.gz","/data/a, b/S1_R2.fastq.gz"')
})

test('buildPairedEndFastqSamplesheet escapes embedded double quotes', () => {
  const result = buildPairedEndFastqSamplesheet([
    '/data/a"b/S1_R1.fastq.gz',
    '/data/a"b/S1_R2.fastq.gz'
  ])

  const lines = result.csv.split('\n')
  assert.equal(lines[1], 'S1,"/data/a""b/S1_R1.fastq.gz","/data/a""b/S1_R2.fastq.gz"')
})
