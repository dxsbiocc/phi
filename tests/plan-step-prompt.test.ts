import assert from 'node:assert/strict'
import test from 'node:test'

import { AGENT_REPORT_PROTOCOL } from '../src/main/agent/agents/report'
import { buildStepPrompt } from '../src/main/agent/plan/execution/step-prompt'
import { truncateUtf8 } from '../src/main/agent/plan/model/utf8-truncate'
import {
  PLAN_MAX_STEP_INSTRUCTIONS_LENGTH,
  PLAN_STEP_PROMPT_MAX_BYTES,
  type PlanRunState,
  type PlanStep,
  type PlanStepState
} from '../src/shared/planRunTypes'

const NOW = '2026-10-23T00:00:00.000Z'

function planStep(id: string, overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id,
    title: `Step ${id}`,
    instructions: `Instructions for ${id}`,
    acceptance: `Acceptance for ${id}`,
    dependsOn: [],
    access: 'read',
    ...overrides
  }
}

function runState(
  planSteps: PlanStep[],
  stepStates: Record<string, Partial<PlanStepState>> = {}
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
    spec: { version: 1, goal: 'Ship the deterministic executor', steps: planSteps },
    status: 'running',
    steps,
    replans: 0,
    createdAt: NOW,
    updatedAt: NOW
  }
}

function section(prompt: string, start: string, end: string): string {
  const startAt = prompt.indexOf(start)
  const endAt = prompt.indexOf(end, startAt + start.length)
  assert.notEqual(startAt, -1)
  assert.notEqual(endAt, -1)
  return prompt.slice(startAt + start.length, endAt)
}

test('builds the required prompt sections in order and appends the shared protocol', () => {
  const steps = [
    planStep('research'),
    planStep('implement', {
      title: 'Implement it',
      instructions: 'Change only the requested files.',
      acceptance: 'Focused tests pass.',
      dependsOn: ['research'],
      access: 'write',
      writes: ['src']
    })
  ]
  const state = runState(steps, {
    research: {
      status: 'done',
      attempts: 1,
      report: { status: 'completed', text: 'Found the relevant boundary.', missingInputs: [] }
    }
  })
  const prompt = buildStepPrompt(state, 'implement')
  const headings = [
    '## Overall goal',
    '## Plan overview',
    '## Current step: implement: Implement it',
    '## Upstream reports',
    '## Required final report protocol'
  ]

  assert.deepEqual(
    headings.map((heading) => prompt.indexOf(heading)),
    [...headings.map((heading) => prompt.indexOf(heading))].sort((a, b) => a - b)
  )
  assert.match(prompt, /\[pending\] implement: Implement it/)
  assert.match(prompt, /Change only the requested files\./)
  assert.match(prompt, /Focused tests pass\./)
  assert.match(prompt, /Status: completed/)
  assert.match(prompt, /Missing inputs: none/)
  assert.match(prompt, /Found the relevant boundary\./)
  assert.ok(prompt.endsWith(AGENT_REPORT_PROTOCOL))
})

test('includes only direct dependency reports while keeping every step in the overview', () => {
  const steps = [
    planStep('a'),
    planStep('b', { dependsOn: ['a'] }),
    planStep('c', { dependsOn: ['b'] })
  ]
  const report = (text: string): PlanStepState['report'] => ({
    status: 'completed',
    text,
    missingInputs: []
  })
  const state = runState(steps, {
    a: { status: 'done', attempts: 1, report: report('report-a') },
    b: { status: 'done', attempts: 1, report: report('report-b') }
  })
  const prompt = buildStepPrompt(state, 'c')

  assert.match(prompt, /\[done\] a: Step a/)
  assert.match(prompt, /### b: Step b/)
  assert.doesNotMatch(prompt, /### a: Step a/)
  assert.doesNotMatch(prompt, /report-a/)
})

test('states when a dependency has no report and when a step has no dependencies', () => {
  const upstream = planStep('upstream')
  const downstream = planStep('downstream', { dependsOn: ['upstream'] })
  const state = runState([upstream, downstream], {
    upstream: { status: 'skipped', attempts: 0 }
  })

  assert.match(buildStepPrompt(state, 'downstream'), /No report was recorded/)
  assert.match(buildStepPrompt(state, 'upstream'), /## Upstream reports\n\nNone\./)
})

test('truncates upstream reports to 4 KiB without splitting UTF-8 characters', () => {
  const upstream = planStep('upstream')
  const downstream = planStep('downstream', { dependsOn: ['upstream'] })
  const state = runState([upstream, downstream], {
    upstream: {
      status: 'done',
      attempts: 1,
      report: { status: 'completed', text: '汉'.repeat(2_000), missingInputs: [] }
    }
  })
  const prompt = buildStepPrompt(state, 'downstream')
  const summary = section(prompt, 'Report summary:\n', '\n\n## Required final report protocol')

  assert.ok(Buffer.byteLength(summary, 'utf8') <= 4 * 1024)
  assert.match(summary, /\[truncated to 4 KiB\]$/)
  assert.doesNotMatch(summary, /�/)
  assert.match(summary, /^汉+\n/)
})

test('does not mark a report at the byte limit as truncated', () => {
  const upstream = planStep('upstream')
  const downstream = planStep('downstream', { dependsOn: ['upstream'] })
  const state = runState([upstream, downstream], {
    upstream: {
      status: 'done',
      attempts: 1,
      report: { status: 'completed', text: 'x'.repeat(4 * 1024), missingInputs: ['token'] }
    }
  })
  const prompt = buildStepPrompt(state, 'downstream')

  assert.match(prompt, /Missing inputs: token/)
  assert.doesNotMatch(prompt, /\[truncated to 4 KiB\]/)
})

test('caps a 20-step fan-in prompt by UTF-8 bytes while retaining every upstream title', () => {
  const upstream = Array.from({ length: 19 }, (_, index) =>
    planStep(`upstream-${index + 1}`, { title: `上游步骤 ${index + 1}` })
  )
  const final = planStep('final', {
    title: '最终步骤',
    instructions: '界'.repeat(PLAN_MAX_STEP_INSTRUCTIONS_LENGTH),
    dependsOn: upstream.map((step) => step.id)
  })
  const state = runState([...upstream, final])
  for (const step of upstream) {
    state.steps[step.id] = {
      status: 'done',
      attempts: 1,
      report: { status: 'completed', text: '汉'.repeat(8 * 1024), missingInputs: [] }
    }
  }

  const prompt = buildStepPrompt(state, final.id)

  assert.ok(Buffer.byteLength(prompt, 'utf8') <= PLAN_STEP_PROMPT_MAX_BYTES)
  assert.doesNotMatch(prompt, /�/)
  for (const step of upstream) assert.match(prompt, new RegExp(`### ${step.id}: ${step.title}`))
})

test('omits report bodies when the average remaining share is below 512 bytes', () => {
  const upstream = Array.from({ length: 19 }, (_, index) => planStep(`source-${index + 1}`))
  const final = planStep('final', { dependsOn: upstream.map((step) => step.id) })
  const state = runState([...upstream, final])
  // Without reserving all 19 omission markers first, the apparent share is
  // above 512 bytes and this case incorrectly keeps the report bodies.
  state.spec.goal = 'g'.repeat(16_500)
  for (const step of upstream) {
    state.steps[step.id] = {
      status: 'done',
      attempts: 1,
      report: { status: 'completed', text: 'report'.repeat(1_000), missingInputs: ['token'] }
    }
  }

  const prompt = buildStepPrompt(state, final.id)

  assert.ok(Buffer.byteLength(prompt, 'utf8') <= PLAN_STEP_PROMPT_MAX_BYTES)
  assert.match(prompt, /Missing inputs: token/)
  assert.equal(
    prompt.match(/\[report omitted: prompt budget exhausted\]/g)?.length,
    upstream.length
  )
})

test('rejects a prompt whose non-report content alone exceeds the byte budget', () => {
  const state = runState([planStep('only')])
  state.spec.goal = '界'.repeat(PLAN_STEP_PROMPT_MAX_BYTES)

  assert.throws(() => buildStepPrompt(state, 'only'), /before upstream report bodies/)
})

test('rejects an unknown step id', () => {
  assert.throws(() => buildStepPrompt(runState([planStep('known')]), 'missing'), {
    message: 'Unknown plan step: missing'
  })
})

test('truncateUtf8 respects ASCII, Chinese, and emoji byte boundaries', () => {
  assert.equal(truncateUtf8('abcd', 4), 'abcd')
  assert.equal(truncateUtf8('abcd', 3), 'abc')
  assert.equal(truncateUtf8('中文', 6), '中文')
  assert.equal(truncateUtf8('中文', 5), '中')
  assert.equal(truncateUtf8('A😀B', 6), 'A😀B')
  assert.equal(truncateUtf8('A😀B', 4), 'A')
  assert.doesNotMatch(truncateUtf8('中😀', 5), /�/)
})
