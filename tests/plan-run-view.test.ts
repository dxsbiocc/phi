import assert from 'node:assert/strict'
import test from 'node:test'

import type { PlanRunTimelineSnapshot } from '../src/shared/planRunTypes'
import {
  latestPlanRun,
  planStepDurationMs,
  planStepActions,
  planRunPauseReason,
  planRunProgress,
  planRunSnapshotFromUnknown,
  upsertPlanRun
} from '../src/renderer/src/features/plan/lib/planRunView'

function runSnapshot(): PlanRunTimelineSnapshot {
  return {
    id: 'plan-1',
    status: 'running',
    replans: 0,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:03.000Z',
    goal: 'Ship the renderer loop',
    steps: [
      {
        id: 'read',
        title: 'Inspect the code',
        access: 'read',
        dependsOn: [],
        status: 'done',
        attempts: 1,
        missingInputs: []
      },
      {
        id: 'write',
        title: 'Implement the panel',
        access: 'write',
        dependsOn: ['read'],
        status: 'running',
        attempts: 1,
        missingInputs: []
      }
    ]
  }
}

test('planRunProgress reports completed and total steps', () => {
  assert.deepEqual(planRunProgress(runSnapshot()), { completed: 1, total: 2 })
})

test('planRunPauseReason names the blocked step and missing inputs', () => {
  const run = runSnapshot()
  run.status = 'paused'
  run.pause = { reason: 'needs_input', stepId: 'write' }
  run.steps[1]!.missingInputs = ['output format', 'target audience']

  assert.equal(
    planRunPauseReason(run, {
      user: '用户暂停',
      interrupted: '中断（应用重启）',
      failed: (step) => `第 ${step} 步失败`,
      needsInput: (step, inputs) => `第 ${step} 步需要补充信息：${inputs.join('、')}`
    }),
    '第 2 步需要补充信息：output format、target audience'
  )
})

test('planRunPauseReason distinguishes user, failure and restart pauses', () => {
  const copy = {
    user: '用户暂停',
    interrupted: '中断（应用重启）',
    failed: (step: number) => `第 ${step} 步失败`,
    needsInput: (step: number, inputs: string[]) => `第 ${step} 步：${inputs.join('、')}`
  }
  const run = runSnapshot()
  run.pause = { reason: 'user' }
  assert.equal(planRunPauseReason(run, copy), '用户暂停')
  run.pause = { reason: 'step_failed', stepId: 'write' }
  assert.equal(planRunPauseReason(run, copy), '第 2 步失败')
  run.pause = { reason: 'interrupted' }
  assert.equal(planRunPauseReason(run, copy), '中断（应用重启）')
})

test('planStepActions only exposes recovery actions on the paused problem step', () => {
  const run = runSnapshot()
  run.status = 'paused'
  run.pause = { reason: 'step_failed', stepId: 'write' }
  run.steps[1]!.status = 'failed'

  assert.deepEqual(planStepActions(run, 'read'), [])
  assert.deepEqual(planStepActions(run, 'write'), ['retry', 'skip', 'stop'])
})

test('planStepDurationMs uses the finish time or the supplied current time', () => {
  const finished = runSnapshot().steps[0]!
  finished.startedAt = '2026-10-23T00:00:01.000Z'
  finished.finishedAt = '2026-10-23T00:00:03.500Z'
  assert.equal(planStepDurationMs(finished, Date.parse('2026-10-23T00:01:00.000Z')), 2_500)

  const running = runSnapshot().steps[1]!
  running.startedAt = '2026-10-23T00:00:04.000Z'
  assert.equal(planStepDurationMs(running, Date.parse('2026-10-23T00:00:09.000Z')), 5_000)
})

test('latestPlanRun selects the newest run by creation time', () => {
  const older = runSnapshot()
  const newer = { ...runSnapshot(), id: 'plan-2', createdAt: '2026-10-23T01:00:00.000Z' }
  assert.equal(latestPlanRun([newer, older])?.id, 'plan-2')
  assert.equal(latestPlanRun([]), null)
})

test('timeline snapshots validate and cannot overwrite a newer run state', () => {
  const current = runSnapshot()
  const older = {
    ...runSnapshot(),
    status: 'paused' as const,
    updatedAt: '2026-10-22T23:59:00.000Z'
  }
  const parsed = planRunSnapshotFromUnknown(current)
  assert.deepEqual(parsed, current)
  assert.equal(planRunSnapshotFromUnknown({ ...current, steps: [{ nope: true }] }), null)
  assert.equal(upsertPlanRun([current], older)[0], current)
})
