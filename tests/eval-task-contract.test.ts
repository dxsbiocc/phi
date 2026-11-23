import assert from 'node:assert/strict'
import test from 'node:test'

import {
  EVAL_CONTRACT_VERSION,
  extractVisibleTaskCard,
  freezeTaskSetDigest,
  trialEvidencePaths,
  validateVisibleTaskCard,
  type HiddenReferenceSpec,
  type VisibleEvalTaskCard
} from '../scripts/eval/scientific/contract'

function makeSyntheticTask(index: number): VisibleEvalTaskCard {
  return {
    contractVersion: EVAL_CONTRACT_VERSION,
    taskId: `SYNTH_TASK_${index}`,
    taskVersion: '1.0.0',
    title: `Synthetic task ${index}`,
    studyId: 'synthetic_study_v1',
    datasetId: 'synthetic_dataset_v1',
    relatedTaskIds: index > 1 ? [`SYNTH_TASK_${index - 1}`] : [],
    split: index % 2 === 0 ? 'heldout' : 'dev',
    readiness: 'ready',
    prompt: `Run synthetic analysis step ${index} and export summary table.`,
    inputSource: {
      accession: `SYNTH_ACC_${index}`,
      version: '2026-01-01',
      summary: 'Synthetic test input fixture',
      acquisitionSteps: ['Stage synthetic fixture into trial workspace']
    },
    referenceVersion: 'SYNTH_REF_v1',
    tools: ['wrapper', 'notebook'],
    visibleOutputs: [
      {
        id: 'summary_table',
        path: 'results/summary.tsv',
        format: 'tsv',
        description: 'Synthetic numeric output table',
        requiredColumns: ['feature_id', 'value'],
        minDataRows: 1
      }
    ],
    budget: {
      maxWallSeconds: 300,
      maxModelCalls: 20,
      maxCostUsd: 2
    },
    scoringVersion: '1.0.0'
  }
}

const SYNTHETIC_VISIBLE_TASKS: VisibleEvalTaskCard[] = [1, 2, 3].map(makeSyntheticTask)
const SYNTHETIC_HIDDEN_REFERENCES: HiddenReferenceSpec[] = SYNTHETIC_VISIBLE_TASKS.map((card) => ({
  taskId: card.taskId,
  taskVersion: card.taskVersion,
  scoringVersion: card.scoringVersion,
  referenceArtifactKey: `ref/${card.taskId.toLowerCase()}.tsv`,
  tolerances: { absTol: 1e-3, relTol: 1e-2, minJaccard: 0.95 }
}))

test('synthetic task cards satisfy the versioned task contract and match hidden reference specs', () => {
  for (const card of SYNTHETIC_VISIBLE_TASKS) {
    const result = validateVisibleTaskCard(card)
    assert.deepEqual(result, { ok: true, errors: [] }, card.taskId)
    const hidden = SYNTHETIC_HIDDEN_REFERENCES.find((spec) => spec.taskId === card.taskId)
    assert.ok(hidden, `missing hidden reference spec for ${card.taskId}`)
    assert.equal(hidden.scoringVersion, card.scoringVersion)
  }
  const digest = freezeTaskSetDigest(SYNTHETIC_VISIBLE_TASKS)
  assert.match(digest, /^[0-9a-f]{64}$/)
})

test('validateVisibleTaskCard rejects missing provenance, referenceVersion, budget, or leaked hidden fields', () => {
  const broken = {
    ...SYNTHETIC_VISIBLE_TASKS[0],
    referenceVersion: '',
    scoringVersion: 'bad',
    budget: { maxWallSeconds: 0, maxModelCalls: 10, maxCostUsd: 1 },
    hiddenReference: '/secret/truth.tsv'
  }
  const result = validateVisibleTaskCard(broken as never)
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((e) => e.includes('referenceVersion')))
  assert.ok(result.errors.some((e) => e.includes('scoringVersion')))
  assert.ok(result.errors.some((e) => e.includes('budget')))
  assert.ok(result.errors.some((e) => e.includes('hidden field')))

  const stripped = extractVisibleTaskCard(broken as never)
  assert.equal('hiddenReference' in (stripped as unknown as Record<string, unknown>), false)
})

test('freezeTaskSetDigest is order-independent and changes whenever a task version changes', () => {
  const baselineDigest = freezeTaskSetDigest(SYNTHETIC_VISIBLE_TASKS)
  const reversed = [...SYNTHETIC_VISIBLE_TASKS].reverse()
  assert.equal(freezeTaskSetDigest(reversed), baselineDigest)

  const bumped = SYNTHETIC_VISIBLE_TASKS.map((task, idx) =>
    idx === 0 ? { ...task, taskVersion: '1.0.1' } : task
  )
  assert.notEqual(freezeTaskSetDigest(bumped), baselineDigest)

  const paths = trialEvidencePaths('/tmp/artifacts', 'study_1', 'trial_001')
  assert.equal(paths.scoreJson, '/tmp/artifacts/research/study_1/trial_001/score.json')
})
