import assert from 'node:assert/strict'
import test from 'node:test'

import {
  extractVisibleTaskCard,
  freezeTaskSetDigest,
  trialEvidencePaths,
  validateVisibleTaskCard
} from '../scripts/eval/scientific/contract'
import {
  PILOT_HIDDEN_REFERENCES,
  PILOT_TASK_SET_DIGEST,
  PILOT_VISIBLE_TASKS
} from '../scripts/eval/scientific/pilot-tasks'

test('all 6 pilot RNA-seq task cards satisfy the versioned task contract and have matching hidden specs', () => {
  assert.equal(PILOT_VISIBLE_TASKS.length, 6)
  assert.equal(PILOT_HIDDEN_REFERENCES.length, 6)

  for (const card of PILOT_VISIBLE_TASKS) {
    const result = validateVisibleTaskCard(card)
    assert.deepEqual(result, { ok: true, errors: [] }, card.taskId)
    const hidden = PILOT_HIDDEN_REFERENCES.find((spec) => spec.taskId === card.taskId)
    assert.ok(hidden, `missing hidden reference spec for ${card.taskId}`)
    assert.equal(hidden.scoringVersion, card.scoringVersion)
  }
  assert.match(PILOT_TASK_SET_DIGEST, /^[0-9a-f]{64}$/)
})

test('validateVisibleTaskCard rejects missing provenance, referenceVersion, budget, or leaked hidden fields', () => {
  const broken = {
    ...PILOT_VISIBLE_TASKS[0],
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
  const reversed = [...PILOT_VISIBLE_TASKS].reverse()
  assert.equal(freezeTaskSetDigest(reversed), PILOT_TASK_SET_DIGEST)

  const bumped = PILOT_VISIBLE_TASKS.map((task, idx) =>
    idx === 0 ? { ...task, taskVersion: '1.0.1' } : task
  )
  assert.notEqual(freezeTaskSetDigest(bumped), PILOT_TASK_SET_DIGEST)

  const paths = trialEvidencePaths('/tmp/artifacts', 'study_1', 'trial_001')
  assert.equal(paths.scoreJson, '/tmp/artifacts/research/study_1/trial_001/score.json')
})
