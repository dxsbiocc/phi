import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  collectStructuredQcMetrics,
  parseFastpJson,
  parseFastqcData,
  parseFeatureCountsSummary,
  parseSalmonMetaInfo,
  parseStarLogFinal
} from '../src/main/agent/wrappers/qc-extractors'
import { createWrapperRunPlan } from '../src/main/agent/wrappers/plans'
import { buildWrapperReproducibilityBundle } from '../src/main/agent/wrappers/reproducibility'
import { submitWrapperRunPlan } from '../src/main/agent/wrappers/runs'
import { writeWrapperQcSummary } from '../src/main/agent/wrappers/store'
import { installLegacyFastqQcWrapper } from './helpers/wrapperFixtures'

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'phi-qc-extract-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('parses FastQC, fastp, Salmon, featureCounts, and STAR QC outputs into structured metrics', () => {
  const fastqc = parseFastqcData(
    [
      '##FastQC\t0.12.1',
      '>>Basic Statistics\tpass',
      'Filename\tS1_R1.fastq.gz',
      'Total Sequences\t100000',
      'Sequences flagged as poor quality\t0',
      'Sequence length\t150',
      '%GC\t48',
      '>>END_MODULE',
      '>>Adapter Content\twarn',
      '>>END_MODULE'
    ].join('\n'),
    'fastqc/S1_R1/fastqc_data.txt'
  )
  assert.deepEqual(fastqc, {
    tool: 'fastqc',
    sourcePath: 'fastqc/S1_R1/fastqc_data.txt',
    sample: 'S1_R1.fastq.gz',
    metrics: {
      totalSequences: 100000,
      poorQualitySequences: 0,
      sequenceLength: '150',
      gcPercent: 48
    },
    flags: {
      'Basic Statistics': 'PASS',
      'Adapter Content': 'WARN'
    }
  })

  const fastp = parseFastpJson(
    JSON.stringify({
      summary: {
        before_filtering: { total_reads: 200000, q20_rate: 0.98, q30_rate: 0.94, gc_content: 0.49 },
        after_filtering: { total_reads: 190000, q20_rate: 0.99, q30_rate: 0.96, gc_content: 0.49 }
      },
      filtering_result: { passed_filter_reads: 190000 },
      duplication: { rate: 0.12 }
    }),
    'fastp/S1.fastp.json'
  )
  assert.deepEqual(fastp?.metrics, {
    beforeTotalReads: 200000,
    afterTotalReads: 190000,
    q20Rate: 0.99,
    q30Rate: 0.96,
    gcContent: 0.49,
    duplicationRate: 0.12,
    passedFilterRate: 0.95
  })

  const salmon = parseSalmonMetaInfo(
    JSON.stringify({
      salmon_version: '1.10.3',
      num_processed: 50000,
      num_mapped: 42500,
      percent_mapped: 85.0
    }),
    'salmon/S1/aux_info/meta_info.json'
  )
  assert.deepEqual(salmon?.metrics, {
    numProcessed: 50000,
    numMapped: 42500,
    percentMapped: 85,
    salmonVersion: '1.10.3'
  })

  const fc = parseFeatureCountsSummary(
    ['Status\tS1.bam\tS2.bam', 'Assigned\t800\t900', 'Unassigned_NoFeatures\t200\t100'].join('\n'),
    'counts/counts.txt.summary'
  )
  assert.deepEqual(fc, [
    {
      tool: 'featurecounts',
      sourcePath: 'counts/counts.txt.summary',
      sample: 'S1.bam',
      metrics: { assigned: 800, total: 1000, assignedRate: 0.8 }
    },
    {
      tool: 'featurecounts',
      sourcePath: 'counts/counts.txt.summary',
      sample: 'S2.bam',
      metrics: { assigned: 900, total: 1000, assignedRate: 0.9 }
    }
  ])

  const star = parseStarLogFinal(
    [
      '                          Number of input reads |\t1000000',
      '                   Uniquely mapped reads number |\t880000',
      '                        Uniquely mapped reads % |\t88.00%',
      '             % of reads mapped to multiple loci |\t4.50%'
    ].join('\n'),
    'star/S1.Log.final.out'
  )
  assert.deepEqual(star?.metrics, {
    inputReads: 1000000,
    uniquelyMappedReads: 880000,
    uniquelyMappedPercent: 88,
    multiMappedPercent: 4.5
  })
})

test('collectStructuredQcMetrics scans output tree and reproducibility bundle exports qc.json', () => {
  withTempDir((dir) => {
    const outDir = join(dir, 'results')
    mkdirSync(join(outDir, 'salmon', 'S1', 'aux_info'), { recursive: true })
    writeFileSync(
      join(outDir, 'salmon', 'S1', 'aux_info', 'meta_info.json'),
      JSON.stringify({
        salmon_version: '1.10.3',
        num_processed: 1000,
        num_mapped: 900,
        percent_mapped: 90
      })
    )
    const qc = collectStructuredQcMetrics(outDir)
    assert.ok(qc)
    assert.equal(qc.entries.length, 1)
    assert.equal(qc.entries[0].tool, 'salmon')

    const agentDir = join(dir, '.phi-home')
    const projectDir = join(dir, 'project')
    mkdirSync(join(projectDir, 'data'), { recursive: true })
    writeFileSync(join(projectDir, 'data', 'S1_R1.fastq.gz'), 'r1')
    writeFileSync(join(projectDir, 'data', 'S1_R2.fastq.gz'), 'r2')
    const entry = installLegacyFastqQcWrapper(agentDir, projectDir)
    const plan = createWrapperRunPlan({
      actor: 'agent',
      wrapper: entry,
      params: { reads: 'data/*_{R1,R2}.fastq.gz' },
      cwd: projectDir,
      agentDir
    })
    const run = submitWrapperRunPlan(plan.planId, { agentDir, autoExecute: false })
    writeWrapperQcSummary(run.runId, qc, agentDir)

    const bundle = buildWrapperReproducibilityBundle(run.runId, agentDir)
    assert.deepEqual(bundle.qc, qc)
  })
})
