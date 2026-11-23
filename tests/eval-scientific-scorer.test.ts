import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { scoreTrial, type TabularScoringRule } from '../scripts/eval/scientific/scorer'

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'phi-eval-scorer-'))
  try {
    return fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('scoreTrial aligns rows by ID regardless of permutation and checks numeric tolerances without mutating files', () => {
  withTempDir((dir) => {
    const workspace = join(dir, 'trial')
    const refDir = join(dir, 'hidden-ref')
    mkdirSync(join(workspace, 'results'), { recursive: true })
    mkdirSync(refDir, { recursive: true })

    const refPath = join(refDir, 'de.tsv')
    writeFileSync(
      refPath,
      [
        'gene_id\tlog2FoldChange\tpadj',
        'ENSG1\t2.000\t0.0010',
        'ENSG2\t-1.500\t0.0200',
        'ENSG3\t0.500\t0.4000'
      ].join('\n')
    )

    // Reordered rows + slight numeric perturbation within tolerance.
    const candPath = join(workspace, 'results', 'de.tsv')
    const candText = [
      'gene_id\tlog2FoldChange\tpadj',
      'ENSG3\t0.501\t0.4002',
      'ENSG1\t2.005\t0.00101',
      'ENSG2\t-1.498\t0.0201'
    ].join('\n')
    writeFileSync(candPath, candText)

    const rule: TabularScoringRule = {
      artifactId: 'de_results',
      candidatePath: 'results/de.tsv',
      referencePath: refPath,
      format: 'tsv',
      idColumn: 'gene_id',
      numericColumns: ['log2FoldChange', 'padj'],
      directionColumn: 'log2FoldChange',
      absTol: 1e-2,
      relTol: 1e-2,
      minIdJaccard: 1.0,
      minValueMatchRate: 1.0,
      minDirectionAgreement: 1.0
    }

    const report1 = scoreTrial({
      taskId: 'PILOT_RNASEQ_04_DE',
      taskVersion: '1.0.0',
      trialId: 't1',
      workspaceDir: workspace,
      executionOutcome: 'completed',
      systemClaim: 'claimed_success',
      rules: [rule],
      scoredAt: '2026-11-23T00:00:00.000Z'
    })
    const report2 = scoreTrial({
      taskId: 'PILOT_RNASEQ_04_DE',
      taskVersion: '1.0.0',
      trialId: 't1',
      workspaceDir: workspace,
      executionOutcome: 'completed',
      systemClaim: 'claimed_success',
      rules: [rule],
      scoredAt: '2026-11-23T00:00:00.000Z'
    })

    assert.deepEqual(report1, report2, 'repeat scoring on frozen inputs must be deterministic')
    assert.equal(report1.fileValidity, 'valid')
    assert.equal(report1.scientificScore.status, 'passed')
    assert.equal(report1.scientificScore.score, 1)
    assert.equal(report1.falseSuccessClaim, false)
    assert.equal(readFileSync(candPath, 'utf-8'), candText, 'scorer must remain strictly read-only')
  })
})

test('scoreTrial separates fileValidity from scientificScore and flags falseSuccessClaim on out-of-tolerance values', () => {
  withTempDir((dir) => {
    const workspace = join(dir, 'trial')
    const refDir = join(dir, 'hidden-ref')
    mkdirSync(join(workspace, 'results'), { recursive: true })
    mkdirSync(refDir, { recursive: true })

    const refPath = join(refDir, 'de.tsv')
    writeFileSync(refPath, 'gene_id\tlog2FoldChange\tpadj\nENSG1\t2.0\t0.001\nENSG2\t-1.5\t0.02\n')
    // Valid TSV file, but flipped sign & wrong numbers.
    writeFileSync(
      join(workspace, 'results', 'de.tsv'),
      'gene_id\tlog2FoldChange\tpadj\nENSG1\t-2.0\t0.5\nENSG2\t1.5\t0.9\n'
    )

    const report = scoreTrial({
      taskId: 'PILOT_RNASEQ_04_DE',
      taskVersion: '1.0.0',
      trialId: 't2',
      workspaceDir: workspace,
      executionOutcome: 'completed',
      systemClaim: 'claimed_success',
      rules: [
        {
          artifactId: 'de_results',
          candidatePath: 'results/de.tsv',
          referencePath: refPath,
          format: 'tsv',
          idColumn: 'gene_id',
          numericColumns: ['log2FoldChange', 'padj'],
          directionColumn: 'log2FoldChange',
          absTol: 1e-2,
          relTol: 1e-2,
          minIdJaccard: 1.0,
          minValueMatchRate: 0.9,
          minDirectionAgreement: 0.95
        }
      ]
    })

    assert.equal(report.fileValidity, 'valid')
    assert.equal(report.scientificScore.status, 'failed')
    assert.equal(report.falseSuccessClaim, true)
    assert.equal(report.scientificScore.artifacts[0].directionAgreement, 0)
  })
})

test('scoreTrial keeps timeouts in denominator as 0, tracks scorer_error separately, and scores fault rejection', () => {
  const timeoutReport = scoreTrial({
    taskId: 'PILOT_RNASEQ_01_QC',
    taskVersion: '1.0.0',
    trialId: 't_timeout',
    workspaceDir: '/tmp',
    executionOutcome: 'timeout',
    systemClaim: 'timeout',
    rules: []
  })
  assert.equal(timeoutReport.scientificScore.status, 'timeout')
  assert.equal(timeoutReport.scientificScore.score, 0)

  const scorerErrorReport = scoreTrial({
    taskId: 'PILOT_RNASEQ_01_QC',
    taskVersion: '1.0.0',
    trialId: 't_err',
    workspaceDir: '/tmp',
    executionOutcome: 'completed',
    systemClaim: 'claimed_success',
    rules: [
      {
        artifactId: 'missing_ref',
        candidatePath: 'results/x.tsv',
        referencePath: '/nonexistent/hidden/ref.tsv',
        format: 'tsv',
        idColumn: 'id',
        numericColumns: ['val'],
        absTol: 0.01,
        relTol: 0.01,
        minIdJaccard: 1,
        minValueMatchRate: 1
      }
    ]
  })
  assert.equal(scorerErrorReport.scientificScore.status, 'scorer_error')
  assert.equal(scorerErrorReport.scientificScore.score, null)

  const rejectedFault = scoreTrial({
    taskId: 'FAULT_DUP_MATE',
    taskVersion: '1.0.0',
    trialId: 't_fault',
    workspaceDir: '/tmp',
    executionOutcome: 'failed',
    systemClaim: 'rejected_input',
    expectsRejection: true,
    rules: []
  })
  assert.equal(rejectedFault.scientificScore.status, 'rejected_invalid_input')
  assert.equal(rejectedFault.scientificScore.score, 1)
  assert.equal(rejectedFault.falseSuccessClaim, false)
})
