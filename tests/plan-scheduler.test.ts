import assert from 'node:assert/strict'
import test from 'node:test'

import { selectLaunchableSteps } from '../src/main/agent/plan/model/plan-scheduler'
import type { PlanRunState, PlanStep, PlanStepState } from '../src/shared/planRunTypes'

const NOW = '2026-10-23T00:00:00.000Z'

function planStep(id: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: `Step ${id}`,
    instructions: `Run ${id}`,
    acceptance: `${id} is complete`,
    dependsOn: [],
    access: 'read',
    ...overrides
  }
}

function runState(
  planSteps: PlanStep[],
  stepStates: Record<string, Partial<PlanStepState>> = {},
  status: PlanRunState['status'] = 'running'
): PlanRunState {
  const steps = Object.fromEntries(
    planSteps.map((step) => [
      step.id,
      { status: 'pending', attempts: 0, ...stepStates[step.id] } satisfies PlanStepState
    ])
  )
  return {
    id: 'run-1',
    sessionId: 'session-1',
    spec: { version: 1, goal: 'Complete the plan', steps: planSteps },
    status,
    steps,
    replans: 0,
    createdAt: NOW,
    updatedAt: NOW
  }
}

test('returns no work unless the run is running', () => {
  const steps = [planStep('a')]
  assert.deepEqual(selectLaunchableSteps(runState(steps, {}, 'paused')), [])
  assert.deepEqual(selectLaunchableSteps(runState(steps, {}, 'completed')), [])
  assert.deepEqual(selectLaunchableSteps(runState(steps, {}, 'stopped')), [])
})

test('selects dependency-ready steps in plan order and counts active slots', () => {
  const steps = [
    planStep('a'),
    planStep('b', { dependsOn: ['a'] }),
    planStep('c', { dependsOn: ['a'] }),
    planStep('d')
  ]
  const state = runState(steps, {
    a: { status: 'skipped', attempts: 0 },
    d: { status: 'running', attempts: 1 }
  })

  assert.deepEqual(selectLaunchableSteps(state, { maxConcurrent: 2 }), ['b'])
  assert.deepEqual(selectLaunchableSteps(state, { maxConcurrent: 3 }), ['b', 'c'])
})

test('uses the default concurrency limit of three and ignores blocked dependencies', () => {
  const steps = [
    planStep('blocked', { dependsOn: ['upstream'] }),
    planStep('upstream'),
    planStep('a'),
    planStep('b'),
    planStep('c')
  ]
  const state = runState(steps)

  assert.deepEqual(selectLaunchableSteps(state), ['upstream', 'a', 'b'])
  assert.deepEqual(selectLaunchableSteps(state, { maxConcurrent: 0 }), [])
})

test('serializes write steps when either side omits writes', () => {
  const undeclared = planStep('undeclared', { access: 'write' })
  const declared = planStep('declared', { access: 'write', writes: ['src/declared'] })
  const reader = planStep('reader')

  assert.deepEqual(selectLaunchableSteps(runState([undeclared, declared, reader])), [
    'undeclared',
    'reader'
  ])
  const active = runState([undeclared, declared, reader], {
    undeclared: { status: 'running', attempts: 1 }
  })
  assert.deepEqual(selectLaunchableSteps(active), ['reader'])
})

test('allows disjoint declared writes but rejects path-segment prefix overlaps', () => {
  const steps = [
    planStep('base', { access: 'write', writes: ['src/a'] }),
    planStep('near-name', { access: 'write', writes: ['src/ab'] }),
    planStep('nested', { access: 'write', writes: ['src/a/b'] }),
    planStep('docs', { access: 'write', writes: ['docs'] })
  ]

  assert.deepEqual(selectLaunchableSteps(runState(steps), { maxConcurrent: 4 }), [
    'base',
    'near-name',
    'docs'
  ])
})

test('normalizes leading ./ and trailing slashes before comparing writes', () => {
  const steps = [
    planStep('active', { access: 'write', writes: ['./src/a/'] }),
    planStep('nested', { access: 'write', writes: ['src/a/b/'] }),
    planStep('separate', { access: 'write', writes: ['./src/b/'] })
  ]
  const state = runState(steps, { active: { status: 'running', attempts: 1 } })

  assert.deepEqual(selectLaunchableSteps(state, { maxConcurrent: 3 }), ['separate'])
})

test('does not mutate the run state while scheduling', () => {
  const state = runState([
    planStep('a', { access: 'write', writes: ['src/a'] }),
    planStep('b', { access: 'write', writes: ['src/b'] })
  ])
  const before = structuredClone(state)

  assert.deepEqual(selectLaunchableSteps(state), ['a', 'b'])
  assert.deepEqual(state, before)
})
