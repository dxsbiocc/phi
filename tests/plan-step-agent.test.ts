import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PLAN_DEFAULT_STEP_AGENT,
  planStepAgent,
  unavailablePlanAgents
} from '../src/main/agent/plan/model/plan-step-agent'
import type { PlanSpec, PlanStep } from '../src/shared/planRunTypes'

function step(id: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: `Step ${id}`,
    instructions: `Do ${id}`,
    acceptance: `Verify ${id}`,
    dependsOn: [],
    access: 'read',
    ...overrides
  }
}

function spec(steps: PlanStep[]): PlanSpec {
  return { version: 1, goal: 'Finish the plan', steps }
}

test('omitted plan step agents resolve to the shared PlanStep default', () => {
  assert.equal(PLAN_DEFAULT_STEP_AGENT, 'PlanStep')
  assert.equal(planStepAgent(step('s1')), 'PlanStep')
  assert.equal(planStepAgent(step('s2', { agent: 'Wrapper' })), 'Wrapper')
})

test('an omitted agent passes when PlanStep is available', () => {
  const available = new Map([
    ['PlanStep', {}],
    ['Wrapper', {}]
  ])
  assert.deepEqual(unavailablePlanAgents(spec([step('s1')]), available), [])
})

test('an unavailable agent error lists every available agent by name', () => {
  const available = new Map([
    ['Wrapper', {}],
    ['PlanStep', {}],
    ['General', {}]
  ])
  assert.deepEqual(unavailablePlanAgents(spec([step('s1', { agent: 'Ghost' })]), available), [
    'step "s1".agent "Ghost" is not available. Available agents: General, PlanStep, Wrapper.'
  ])
})

test('a missing agent table reports that none are available', () => {
  assert.deepEqual(unavailablePlanAgents(spec([step('s1')]), undefined), [
    'step "s1".agent "PlanStep" is not available. Available agents: none.'
  ])
})
