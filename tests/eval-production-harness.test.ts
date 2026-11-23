import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { PILOT_VISIBLE_TASKS } from '../scripts/eval/scientific/pilot-tasks'
import { isPathContainedInTrial } from '../scripts/eval/scientific/isolation'
import {
  REQUIRED_PRODUCTION_SERVICES,
  runEvaluatedTrial,
  validateProductionAssembly,
  type ProductionAssemblyManifest
} from '../scripts/eval/scientific/production-harness'

function buildAssembly(
  mode: ProductionAssemblyManifest['mode'],
  implementation: 'production' | 'controlled_mock'
): ProductionAssemblyManifest {
  const services = Object.fromEntries(
    REQUIRED_PRODUCTION_SERVICES.map((service) => [
      service,
      {
        service,
        implementation,
        provider:
          implementation === 'production'
            ? `src/main/agent/app-kernel-desktop-services.ts#${service}`
            : `scripts/kernel-e2e/harness.ts#${service}`
      }
    ])
  ) as ProductionAssemblyManifest['services']
  return {
    mode,
    hostRuntime: mode === 'production' ? 'electron_headless' : 'calibration_harness',
    services
  }
}

test('validateProductionAssembly rejects missing or mocked services in production mode', () => {
  const validProd = validateProductionAssembly(buildAssembly('production', 'production'))
  assert.deepEqual(validProd, { ok: true, errors: [] })

  const mockInProd = validateProductionAssembly(buildAssembly('production', 'controlled_mock'))
  assert.equal(mockInProd.ok, false)
  assert.equal(mockInProd.errors.length, REQUIRED_PRODUCTION_SERVICES.length)

  const missingNotebook = buildAssembly('production', 'production')
  missingNotebook.services.notebook = {
    service: 'notebook',
    implementation: 'missing',
    provider: ''
  }
  const missingResult = validateProductionAssembly(missingNotebook)
  assert.equal(missingResult.ok, false)
  assert.ok(missingResult.errors.some((e) => e.includes('notebook')))

  const validCalib = validateProductionAssembly(
    buildAssembly('engineering_calibration', 'controlled_mock')
  )
  assert.deepEqual(validCalib, { ok: true, errors: [] })
})

test('runEvaluatedTrial integrates R01 contract, R03 canary isolation, R02 assembly, and R09 read-only scoring', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-eval-harness-'))
  try {
    const hiddenDir = join(root, 'hidden-ref')
    const artifactsDir = join(root, 'artifacts')
    mkdirSync(hiddenDir, { recursive: true })
    const refPath = join(hiddenDir, 'de.tsv')
    writeFileSync(refPath, 'gene_id\tlog2FoldChange\tpadj\nENSG1\t2.0\t0.001\nENSG2\t-1.5\t0.02\n')

    const result = await runEvaluatedTrial({
      trialId: 'trial_calib_001',
      arm: 'phi_full',
      task: PILOT_VISIBLE_TASKS[3],
      assembly: buildAssembly('engineering_calibration', 'controlled_mock'),
      artifactsBaseDir: artifactsDir,
      hiddenReferenceDir: hiddenDir,
      baseTempDir: root,
      scoringRules: [
        {
          artifactId: 'de_results',
          candidatePath: 'results/deseq2_results.tsv',
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
      ],
      attemptCanaryRead: async (sandbox, targetPath) =>
        isPathContainedInTrial(sandbox.cwd, targetPath),
      execute: async ({ sandbox }) => {
        mkdirSync(join(sandbox.cwd, 'results'), { recursive: true })
        writeFileSync(
          join(sandbox.cwd, 'results', 'deseq2_results.tsv'),
          'gene_id\tlog2FoldChange\tpadj\nENSG2\t-1.5\t0.02\nENSG1\t2.0\t0.001\n'
        )
        return {
          outcome: 'completed',
          systemClaim: 'claimed_success',
          sessionId: 'sess_calib_1',
          events: [
            { type: 'trial_started', timestamp: '2026-11-23T00:00:00.000Z' },
            { type: 'trial_completed', timestamp: '2026-11-23T00:00:01.000Z' }
          ]
        }
      }
    })

    assert.equal(result.isolation.status, 'verified')
    assert.equal(result.score.fileValidity, 'valid')
    assert.equal(result.score.scientificScore.status, 'passed')
    assert.equal(result.score.falseSuccessClaim, false)
    assert.ok(existsSync(join(result.evidenceDir, 'config.json')))
    assert.ok(existsSync(join(result.evidenceDir, 'verification.json')))
    assert.ok(existsSync(join(result.evidenceDir, 'score.json')))
    assert.ok(existsSync(join(result.evidenceDir, 'events.jsonl')))
    const savedScore = JSON.parse(readFileSync(join(result.evidenceDir, 'score.json'), 'utf-8'))
    assert.equal(savedScore.scientificScore.score, 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
