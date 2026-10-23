import assert from 'node:assert/strict'
import test from 'node:test'

import { PLAN_MAX_STEPS, type PlanSpec, type PlanStep } from '../src/shared/planRunTypes'
import { validatePlanSpec } from '../src/main/agent/plan/model/plan-spec'

function step(id: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: ` ${id} title `,
    instructions: ` do ${id} `,
    acceptance: ` verify ${id} `,
    dependsOn: [],
    access: 'read',
    ...overrides
  }
}

function spec(steps: PlanStep[]): PlanSpec {
  return { version: 1, goal: ' ship safely ', steps }
}

test('validates, normalizes, deduplicates, and clones a plan spec', () => {
  const input = spec([
    step('research', { agent: ' analyst ' }),
    step('build', {
      title: ' Build ',
      dependsOn: [' research ', 'research'],
      access: 'write',
      writes: [' ./src ', 'src']
    })
  ])
  const result = validatePlanSpec(input)
  assert.equal(result.ok, true)
  if (!result.ok) return
  assert.notEqual(result.spec, input)
  assert.notEqual(result.spec.steps, input.steps)
  assert.notEqual(result.spec.steps[0], input.steps[0])
  assert.equal(result.spec.goal, 'ship safely')
  assert.equal(result.spec.steps[0].title, 'research title')
  assert.equal(result.spec.steps[0].agent, 'analyst')
  assert.deepEqual(result.spec.steps[1].dependsOn, ['research'])
  assert.deepEqual(result.spec.steps[1].writes, ['./src', 'src'])
})

test('collects field, identity, reference, and write-path errors together', () => {
  const value = {
    version: 2,
    goal: ' ',
    steps: [
      {
        id: 'Bad Id',
        title: '',
        instructions: 42,
        acceptance: 'ok',
        dependsOn: ['missing', '', 4],
        access: 'read',
        writes: ['../secret', '/absolute', 'C:\\absolute']
      },
      step('same'),
      step('same')
    ]
  }
  const result = validatePlanSpec(value)
  assert.equal(result.ok, false)
  if (result.ok) return
  const errors = result.errors.join('\n')
  assert.match(errors, /version/)
  assert.match(errors, /goal/)
  assert.match(errors, /step "Bad Id"\.id/)
  assert.match(errors, /step "Bad Id"\.title/)
  assert.match(errors, /step "Bad Id"\.instructions/)
  assert.match(errors, /step "Bad Id"\.dependsOn\[1\]/)
  assert.match(errors, /step "Bad Id"\.dependsOn references missing step "missing"/)
  assert.match(errors, /step "Bad Id"\.writes is only allowed/)
  assert.match(errors, /unsafe relative path "\.\.\/secret"/)
  assert.match(errors, /unsafe relative path "\/absolute"/)
  assert.match(errors, /unsafe relative path "C:\\absolute"/)
  assert.match(errors, /step "same"\.id must be unique/)
})

test('reports exactly the ids participating in dependency cycles', () => {
  const result = validatePlanSpec(
    spec([
      step('a', { dependsOn: ['b'] }),
      step('b', { dependsOn: ['a'] }),
      step('downstream', { dependsOn: ['a'] })
    ])
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  const cycle = result.errors.find((error) => error.includes('cycle'))
  assert.match(cycle ?? '', /a/)
  assert.match(cycle ?? '', /b/)
  assert.doesNotMatch(cycle ?? '', /downstream/)
})

test('reports an independent cycle even when another id is duplicated', () => {
  const result = validatePlanSpec(
    spec([
      step('same'),
      step('same'),
      step('a', { dependsOn: ['b'] }),
      step('b', { dependsOn: ['a'] })
    ])
  )
  assert.equal(result.ok, false)
  if (result.ok) return
  assert.match(result.errors.join('\n'), /step "same"\.id must be unique/)
  assert.match(result.errors.join('\n'), /cycle involving step ids: a, b/)
})

test('enforces step count and Unicode character limits', () => {
  const tooMany = validatePlanSpec(
    spec(Array.from({ length: PLAN_MAX_STEPS + 1 }, (_, index) => step(`s-${index}`)))
  )
  assert.equal(tooMany.ok, false)
  if (!tooMany.ok) assert.match(tooMany.errors.join('\n'), /between 1 and 20/)

  const accepted = validatePlanSpec(spec([step('emoji', { title: '😀'.repeat(80) })]))
  assert.equal(accepted.ok, true)
  const rejected = validatePlanSpec(spec([step('emoji', { title: '😀'.repeat(81) })]))
  assert.equal(rejected.ok, false)
  if (!rejected.ok) assert.match(rejected.errors.join('\n'), /emoji.*title.*80/)
})

test('rejects malformed top-level and step collection values', () => {
  assert.deepEqual(validatePlanSpec(null), {
    ok: false,
    errors: ['Plan spec must be an object.']
  })
  const noSteps = validatePlanSpec({ version: 1, goal: 'goal', steps: 'nope' })
  assert.equal(noSteps.ok, false)
  if (!noSteps.ok) assert.match(noSteps.errors.join('\n'), /steps must be an array/)
  const empty = validatePlanSpec(spec([]))
  assert.equal(empty.ok, false)
})
