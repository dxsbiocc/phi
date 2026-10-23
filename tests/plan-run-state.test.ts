import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  PlanRunState,
  PlanSpec,
  PlanStep,
  PlanStepReportSummary
} from '../src/shared/planRunTypes'
import {
  PlanRunTransitionError,
  createPlanRunState,
  reducePlanRun,
  validatePlanRunState
} from '../src/main/agent/plan/model/plan-run-state'

const start = '2026-10-23T00:00:00.000Z'
const at = (seconds: number): string => new Date(Date.parse(start) + seconds * 1_000).toISOString()

function step(id: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: id,
    instructions: `do ${id}`,
    acceptance: `verify ${id}`,
    dependsOn: [],
    access: 'read',
    ...overrides
  }
}

function spec(steps: PlanStep[] = [step('a'), step('b', { dependsOn: ['a'] })]): PlanSpec {
  return { version: 1, goal: 'goal', steps }
}

function state(steps?: PlanStep[]): PlanRunState {
  return createPlanRunState({ id: 'run-1', sessionId: 'session-1', spec: spec(steps), now: start })
}

function report(
  status: PlanStepReportSummary['status'] = 'completed',
  missingInputs: string[] = []
): PlanStepReportSummary {
  return { status, text: `${status} report`, missingInputs }
}

function launch(current: PlanRunState, stepId: string, seconds: number): PlanRunState {
  return reducePlanRun(current, {
    type: 'step_launched',
    stepId,
    agentRunId: `agent-${stepId}-${seconds}`,
    at: at(seconds)
  })
}

function fail(current: PlanRunState, stepId: string, seconds: number): PlanRunState {
  return reducePlanRun(current, { type: 'step_failed', stepId, error: 'boom', at: at(seconds) })
}

function expectCode(action: () => unknown, code: PlanRunTransitionError['code']): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof PlanRunTransitionError)
    assert.equal(error.code, code)
    return true
  })
}

test('creates a cloned running state with pending steps', () => {
  const input = spec()
  const created = createPlanRunState({
    id: 'run-1',
    sessionId: 'session-1',
    spec: input,
    now: start
  })
  assert.equal(created.status, 'running')
  assert.equal(created.replans, 0)
  assert.deepEqual(created.steps, {
    a: { status: 'pending', attempts: 0 },
    b: { status: 'pending', attempts: 0 }
  })
  assert.notEqual(created.spec, input)
  assert.notEqual(created.spec.steps[0], input.steps[0])
})

test('launches and completes steps immutably, then seals the run', () => {
  const initial = state([step('a')])
  const running = launch(initial, 'a', 1)
  assert.equal(initial.steps.a.status, 'pending')
  assert.deepEqual(running.steps.a, {
    status: 'running',
    attempts: 1,
    agentRunId: 'agent-a-1',
    startedAt: at(1)
  })
  const completed = reducePlanRun(running, {
    type: 'step_succeeded',
    stepId: 'a',
    report: report(),
    at: at(2)
  })
  assert.equal(completed.status, 'completed')
  assert.equal(completed.steps.a.status, 'done')
  assert.equal(running.steps.a.status, 'running')
  expectCode(() => reducePlanRun(completed, { type: 'stop', at: at(3) }), 'RUN_FINISHED')
})

test('automatically retries once, pauses after a second failure, and accepts manual retry', () => {
  const firstFailure = fail(launch(state(), 'a', 1), 'a', 2)
  assert.equal(firstFailure.status, 'running')
  assert.equal(firstFailure.steps.a.status, 'pending')
  assert.equal(firstFailure.steps.a.attempts, 1)

  const secondFailure = fail(launch(firstFailure, 'a', 3), 'a', 4)
  assert.equal(secondFailure.status, 'paused')
  assert.deepEqual(secondFailure.pause, { reason: 'step_failed', stepId: 'a' })
  assert.equal(secondFailure.steps.a.status, 'failed')
  expectCode(
    () => reducePlanRun(secondFailure, { type: 'resume', at: at(5) }),
    'INVALID_RUN_STATUS'
  )

  const retried = reducePlanRun(secondFailure, { type: 'retry_step', stepId: 'a', at: at(6) })
  assert.equal(retried.status, 'running')
  assert.equal(retried.steps.a.status, 'pending')
  assert.equal(retried.steps.a.attempts, 2)
  assert.equal(retried.steps.a.error, undefined)
})

test('missing inputs pause immediately without automatic retry', () => {
  const paused = reducePlanRun(launch(state(), 'a', 1), {
    type: 'step_needs_input',
    stepId: 'a',
    report: report('blocked', ['dataset']),
    at: at(2)
  })
  assert.equal(paused.steps.a.attempts, 1)
  assert.equal(paused.steps.a.status, 'failed')
  assert.deepEqual(paused.pause, { reason: 'needs_input', stepId: 'a' })
})

test('pause, resume, skip, retry, and stop enforce transitions', () => {
  const paused = reducePlanRun(state(), { type: 'pause', at: at(1) })
  assert.equal(reducePlanRun(paused, { type: 'resume', at: at(2) }).status, 'running')
  expectCode(
    () => reducePlanRun(paused, { type: 'retry_step', stepId: 'a', at: at(2) }),
    'INVALID_STEP_TRANSITION'
  )
  const running = launch(state(), 'a', 1)
  expectCode(
    () => reducePlanRun(running, { type: 'skip_step', stepId: 'a', at: at(2) }),
    'INVALID_STEP_TRANSITION'
  )
  const stopped = reducePlanRun(running, { type: 'stop', at: at(2) })
  assert.equal(stopped.status, 'stopped')
  assert.equal(stopped.steps.a.status, 'cancelled')
  assert.equal(stopped.steps.b.status, 'pending')
})

test('skip satisfies completion and resolves a failure pause', () => {
  let current = fail(launch(state([step('a')]), 'a', 1), 'a', 2)
  current = fail(launch(current, 'a', 3), 'a', 4)
  const skipped = reducePlanRun(current, { type: 'skip_step', stepId: 'a', at: at(5) })
  assert.equal(skipped.steps.a.status, 'skipped')
  assert.equal(skipped.status, 'completed')
  assert.equal(skipped.pause, undefined)
})

test('restart recovery interrupts running steps and pauses the run', () => {
  const running = launch(state(), 'a', 1)
  const recovered = reducePlanRun(running, { type: 'recover_after_restart', at: at(2) })
  assert.equal(recovered.status, 'paused')
  assert.equal(recovered.steps.a.status, 'interrupted')
  assert.equal(recovered.steps.b.status, 'pending')
  assert.deepEqual(recovered.pause, { reason: 'interrupted', stepId: 'a' })
  assert.equal(running.steps.a.status, 'running')
})

test('restart recovery stays paused until every interrupted step is retried', () => {
  const initial = state([step('a'), step('b')])
  const running = launch(launch(initial, 'a', 1), 'b', 2)
  const recovered = reducePlanRun(running, { type: 'recover_after_restart', at: at(3) })
  assert.deepEqual(recovered.pause, { reason: 'interrupted', stepId: 'a' })

  const retriedA = reducePlanRun(recovered, { type: 'retry_step', stepId: 'a', at: at(4) })
  assert.equal(retriedA.status, 'paused')
  assert.deepEqual(retriedA.pause, { reason: 'interrupted', stepId: 'b' })
  const retriedB = reducePlanRun(retriedA, { type: 'retry_step', stepId: 'b', at: at(5) })
  assert.equal(retriedB.status, 'running')
  assert.equal(retriedB.pause, undefined)
})

test('a step failure supersedes a user pause and resolving it resumes the run', () => {
  let current = fail(launch(state([step('a')]), 'a', 1), 'a', 2)
  current = launch(current, 'a', 3)
  current = reducePlanRun(current, { type: 'pause', at: at(4) })
  current = fail(current, 'a', 5)
  assert.deepEqual(current.pause, { reason: 'step_failed', stepId: 'a' })

  current = reducePlanRun(current, { type: 'retry_step', stepId: 'a', at: at(6) })
  assert.equal(current.status, 'running')
  assert.equal(current.pause, undefined)
})

test('replacement protects started steps, initializes new steps, and enforces the replan cap', () => {
  let current = fail(launch(state(), 'a', 1), 'a', 2)
  current = fail(launch(current, 'a', 3), 'a', 4)
  const changedStarted = spec([step('a', { title: 'changed' }), step('c')])
  expectCode(
    () =>
      reducePlanRun(current, { type: 'replace_remaining_steps', spec: changedStarted, at: at(5) }),
    'INVALID_REPLACEMENT'
  )
  const replacement = spec([step('a'), step('c', { dependsOn: ['a'] })])
  current = reducePlanRun(current, {
    type: 'replace_remaining_steps',
    spec: replacement,
    at: at(5)
  })
  assert.equal(current.steps.a.status, 'skipped')
  assert.deepEqual(current.steps.c, { status: 'pending', attempts: 0 })
  assert.equal(current.status, 'running')
  assert.equal(current.replans, 1)

  current = reducePlanRun(current, { type: 'pause', at: at(6) })
  current = reducePlanRun(current, {
    type: 'replace_remaining_steps',
    spec: spec([step('a'), step('d', { dependsOn: ['a'] })]),
    at: at(7)
  })
  assert.equal(current.replans, 2)
  assert.deepEqual(current.steps.d, { status: 'pending', attempts: 0 })
  expectCode(
    () =>
      reducePlanRun(current, {
        type: 'replace_remaining_steps',
        spec: current.spec,
        at: at(8)
      }),
    'REPLAN_LIMIT_REACHED'
  )
})

test('replacement validates the entire graph and preserves the goal', () => {
  const paused = reducePlanRun(state(), { type: 'pause', at: at(1) })
  const cyclic = spec([step('a', { dependsOn: ['b'] }), step('b', { dependsOn: ['a'] })])
  expectCode(
    () => reducePlanRun(paused, { type: 'replace_remaining_steps', spec: cyclic, at: at(2) }),
    'INVALID_REPLACEMENT'
  )
  expectCode(
    () =>
      reducePlanRun(paused, {
        type: 'replace_remaining_steps',
        spec: { ...spec(), goal: 'different' },
        at: at(2)
      }),
    'INVALID_REPLACEMENT'
  )
})

test('replacement compares started step fields independent of object property order', () => {
  const reordered: PlanStep = {
    access: 'read',
    dependsOn: [],
    acceptance: 'verify a',
    instructions: 'do a',
    title: 'a',
    id: 'a'
  }
  let current = fail(launch(state([reordered]), 'a', 1), 'a', 2)
  current = fail(launch(current, 'a', 3), 'a', 4)
  const replaced = reducePlanRun(current, {
    type: 'replace_remaining_steps',
    spec: spec([step('a'), step('new')]),
    at: at(5)
  })
  assert.equal(replaced.steps.a.status, 'skipped')
  assert.deepEqual(replaced.steps.new, { status: 'pending', attempts: 0 })
})

test('replacement skips every retained failed or interrupted step', () => {
  let current = state([step('a'), step('b')])
  current = fail(launch(current, 'a', 1), 'a', 2)
  current = launch(current, 'a', 3)
  current = launch(current, 'b', 4)
  current = fail(current, 'a', 5)
  current = reducePlanRun(current, { type: 'recover_after_restart', at: at(6) })
  const replaced = reducePlanRun(current, {
    type: 'replace_remaining_steps',
    spec: spec([step('a'), step('b'), step('c', { dependsOn: ['a', 'b'] })]),
    at: at(7)
  })
  assert.equal(replaced.steps.a.status, 'skipped')
  assert.equal(replaced.steps.b.status, 'skipped')
  assert.equal(replaced.status, 'running')
})

test('report summaries are capped at 8 KiB without splitting UTF-8', () => {
  const completed = reducePlanRun(launch(state([step('a')]), 'a', 1), {
    type: 'step_succeeded',
    stepId: 'a',
    report: { status: 'completed', text: '界'.repeat(3_000), missingInputs: [] },
    at: at(2)
  })
  const text = completed.steps.a.report?.text ?? ''
  assert.ok(Buffer.byteLength(text, 'utf8') <= 8 * 1_024)
  assert.doesNotMatch(text, /�/)
})

test('validates persisted states strictly and returns detached data', () => {
  const input = state()
  const valid = validatePlanRunState(JSON.parse(JSON.stringify(input)) as unknown)
  assert.deepEqual(valid, input)
  assert.notEqual(valid, input)
  assert.notEqual(valid?.steps, input.steps)
  assert.equal(validatePlanRunState({ ...input, status: 'unknown' }), null)
  assert.equal(validatePlanRunState({ ...input, replans: 3 }), null)
  assert.equal(
    validatePlanRunState({ ...input, steps: { ...input.steps, extra: input.steps.a } }),
    null
  )
  assert.equal(validatePlanRunState({ ...input, createdAt: 'not-a-date' }), null)
  assert.equal(validatePlanRunState({ ...input, status: 'paused' }), null)
})
