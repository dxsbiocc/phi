import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { buildPairedEndFastqSamplesheet } from '../src/main/agent/wrappers/samplesheet'
import { evaluateStepScientificCompatibility } from '../src/main/agent/scientific-context/compatibility'
import {
  injectFaultVariant,
  summarizeFaultPackOutcomes
} from '../scripts/eval/scientific/fault-pack'

test('fault-pack injects verifiable duplicate_mate, truncated_table, reference_mismatch, and matrix_semantics_mismatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-fault-pack-'))
  try {
    mkdirSync(join(dir, 'fastq'), { recursive: true })
    const r1 = join(dir, 'fastq', 'S1_R1.fastq.gz')
    const r2 = join(dir, 'fastq', 'S1_R2.fastq.gz')
    writeFileSync(r1, 'r1')
    writeFileSync(r2, 'r2')

    // 1. Duplicate mate fault -> verified injection & caught by R08 samplesheet validator.
    const dupRecipe = injectFaultVariant({
      variantId: 'f_dup_1',
      faultKind: 'duplicate_mate',
      seed: 1,
      targetPath: r1
    })
    assert.equal(dupRecipe.injectionStatus, 'verified')
    const sheet = buildPairedEndFastqSamplesheet([r1, r2, dupRecipe.sourcePath])
    assert.ok(sheet.errors.some((e) => e.includes('Duplicate R1')))

    // 2. Matrix semantics mismatch -> verified injection & caught by R14 compatibility preflight.
    mkdirSync(join(dir, 'results'), { recursive: true })
    const counts = join(dir, 'results', 'counts.tsv')
    writeFileSync(counts, 'gene_id\tS1\nG1\t10\nG2\t20\n')
    const matRecipe = injectFaultVariant({
      variantId: 'f_mat_1',
      faultKind: 'matrix_semantics_mismatch',
      seed: 2,
      targetPath: counts
    })
    assert.equal(matRecipe.injectionStatus, 'verified')
    const verdict = evaluateStepScientificCompatibility(
      {
        id: 'de',
        title: 'DESeq2',
        instructions: 'Run DESeq2',
        acceptance: 'done',
        dependsOn: [],
        access: 'write',
        inputContracts: [{ path: 'results/counts.tsv', requiredMatrixSemantics: ['raw_counts'] }]
      },
      dir
    )
    assert.equal(verdict.status, 'incompatible')

    // 3. Truncated table -> verified hash change.
    const truncRecipe = injectFaultVariant({
      variantId: 'f_trunc_1',
      faultKind: 'truncated_table',
      seed: 3,
      targetPath: counts
    })
    assert.equal(truncRecipe.injectionStatus, 'verified')
    assert.notEqual(truncRecipe.beforeSha256, truncRecipe.afterSha256)

    // 4. Missing target -> marked invalid_trial (never silently passes as valid fault trial).
    const invalidRecipe = injectFaultVariant({
      variantId: 'f_bad_1',
      faultKind: 'truncated_table',
      seed: 4,
      targetPath: join(dir, 'missing.tsv')
    })
    assert.equal(invalidRecipe.injectionStatus, 'invalid_trial')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('summarizeFaultPackOutcomes separates normal, fault-rejected, silent-continue, false-block, unknown, and invalid injections', () => {
  const summary = summarizeFaultPackOutcomes([
    {
      pairId: 'p1',
      isFaultVariant: false,
      detectableFromInput: true,
      injectionStatus: 'verified',
      outcome: 'passed'
    },
    {
      pairId: 'p1',
      isFaultVariant: true,
      detectableFromInput: true,
      injectionStatus: 'verified',
      outcome: 'rejected'
    },
    {
      pairId: 'p2',
      isFaultVariant: false,
      detectableFromInput: true,
      injectionStatus: 'verified',
      outcome: 'false_block'
    },
    {
      pairId: 'p2',
      isFaultVariant: true,
      detectableFromInput: true,
      injectionStatus: 'verified',
      outcome: 'continued_silently'
    },
    {
      pairId: 'p3',
      isFaultVariant: true,
      detectableFromInput: true,
      injectionStatus: 'verified',
      outcome: 'unknown_paused'
    },
    {
      pairId: 'p4',
      isFaultVariant: true,
      detectableFromInput: true,
      injectionStatus: 'invalid_trial',
      outcome: 'rejected'
    },
    {
      pairId: 'p5',
      isFaultVariant: true,
      detectableFromInput: false,
      injectionStatus: 'verified',
      outcome: 'continued_silently'
    }
  ])

  assert.deepEqual(summary, {
    normalPassed: 1,
    falseBlockOnNormal: 1,
    faultRejected: 1,
    faultContinuedSilently: 1,
    unknownPaused: 1,
    invalidInjectionTrials: 1,
    unobservableFaultsTotal: 1
  })
})
