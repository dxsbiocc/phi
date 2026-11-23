import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  assertCoreAblationParity,
  buildBatchSchedule,
  runEvalBatch,
  type EvalArmConfig
} from '../scripts/eval/scientific/batch-runner'
import { PILOT_VISIBLE_TASKS } from '../scripts/eval/scientific/pilot-tasks'

const PHI_FULL: EvalArmConfig = {
  armId: 'phi_full',
  model: 'anthropic/claude-sonnet-4',
  promptVersion: '1.0.0',
  tools: ['wrapper', 'notebook', 'read', 'write'],
  enableOutputAssertions: true,
  enablePostStepVerification: true,
  enableCrossStepContextChecks: true
}

const PHI_NO_CTX: EvalArmConfig = {
  ...PHI_FULL,
  armId: 'phi_without_context_checks',
  enableCrossStepContextChecks: false
}

test('assertCoreAblationParity verifies only enableCrossStepContextChecks differs between core arms', () => {
  assert.deepEqual(assertCoreAblationParity(PHI_FULL, PHI_NO_CTX), { ok: true, errors: [] })

  const mismatchedModel = { ...PHI_NO_CTX, model: 'openai/gpt-5' }
  const parity = assertCoreAblationParity(PHI_FULL, mismatchedModel)
  assert.equal(parity.ok, false)
  assert.ok(parity.errors.some((e) => e.includes('model mismatch')))
})

test('buildBatchSchedule produces 36 deterministic interleaved trials for 6 tasks x 2 arms x 3 reps', () => {
  const s1 = buildBatchSchedule({
    studyId: 'pilot',
    tasks: PILOT_VISIBLE_TASKS,
    arms: [PHI_FULL, PHI_NO_CTX],
    reps: 3,
    seed: 20261123
  })
  const s2 = buildBatchSchedule({
    studyId: 'pilot',
    tasks: PILOT_VISIBLE_TASKS,
    arms: [PHI_FULL, PHI_NO_CTX],
    reps: 3,
    seed: 20261123
  })
  assert.equal(s1.length, 36)
  assert.deepEqual(s1, s2)
  assert.equal(new Set(s1.map((t) => t.trialId)).size, 36)
})

test('runEvalBatch resumes without rerunning terminal trials and separates completeness from scientific pass rate', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'phi-batch-'))
  try {
    const schedule = buildBatchSchedule({
      studyId: 'pilot',
      tasks: PILOT_VISIBLE_TASKS.slice(0, 2),
      arms: [PHI_FULL, PHI_NO_CTX],
      reps: 1,
      seed: 42
    })
    const executedFirst: string[] = []
    let failThird = true

    const first = await runEvalBatch({
      batchId: 'b1',
      studyId: 'pilot',
      mode: 'dry_run',
      batchDir: dir,
      schedule,
      executeTrial: async (trial) => {
        executedFirst.push(trial.trialId)
        if (failThird && executedFirst.length === 3) {
          failThird = false
          return { status: 'remote_unknown' }
        }
        return {
          status: 'completed',
          score: {
            scorerVersion: '1.0.0',
            taskId: trial.taskId,
            taskVersion: '1.0.0',
            trialId: trial.trialId,
            scoredAt: '2026-11-23T01:00:00.000Z',
            fileValidity: 'valid',
            scientificScore: {
              status: trial.armId === 'phi_full' ? 'passed' : 'failed',
              score: trial.armId === 'phi_full' ? 1 : 0,
              artifacts: []
            },
            systemClaim: 'claimed_success',
            falseSuccessClaim: trial.armId !== 'phi_full'
          }
        }
      }
    })

    assert.equal(first.terminalCount, 3)
    assert.equal(first.batchCompletenessRate, 0.75)

    // Resume: must ONLY rerun the single non-terminal `remote_unknown` trial.
    const executedSecond: string[] = []
    const second = await runEvalBatch({
      batchId: 'b1',
      studyId: 'pilot',
      mode: 'dry_run',
      batchDir: dir,
      schedule,
      executeTrial: async (trial) => {
        executedSecond.push(trial.trialId)
        return {
          status: 'completed',
          score: {
            scorerVersion: '1.0.0',
            taskId: trial.taskId,
            taskVersion: '1.0.0',
            trialId: trial.trialId,
            scoredAt: '2026-11-23T01:05:00.000Z',
            fileValidity: 'valid',
            scientificScore: {
              status: trial.armId === 'phi_full' ? 'passed' : 'failed',
              score: trial.armId === 'phi_full' ? 1 : 0,
              artifacts: []
            },
            systemClaim: 'claimed_success',
            falseSuccessClaim: trial.armId !== 'phi_full'
          }
        }
      }
    })

    assert.equal(executedSecond.length, 1, 'terminal trials must not be re-executed on resume')
    assert.equal(second.terminalCount, 4)
    assert.equal(second.batchCompletenessRate, 1)
    assert.equal(second.scientificPassCount, 2)
    assert.equal(second.scientificPassRate, 0.5)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
