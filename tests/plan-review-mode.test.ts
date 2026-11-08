import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cancelPlanReviewReplanMode,
  enterPlanReviewMode,
  type PlanReviewSession
} from '../src/main/agent/plan/plan-review-mode'
import {
  planModeToolDecision,
  suppressPlanExecutePromptContext
} from '../src/main/agent/engine/phi-extension'
import { buildPhiMainSystemPrompt } from '../src/main/agent/main-system-prompt'
import { planReviewContent } from '../src/main/agent/plan/plan-review-content'
import type { PlanSpec } from '../src/shared/planRunTypes'

function fakeSession(): PlanReviewSession & {
  activeTools: string[]
  handler: ((title: string) => Promise<unknown>) | null
  referencePath?: string
} {
  let state: ReturnType<PlanReviewSession['getPlanModeState']>
  return {
    activeTools: ['read', 'glob', 'grep', 'bash', 'write', 'edit', 'todo', 'download_file'],
    handler: null,
    referencePath: undefined,
    getPlanModeState: () => state,
    setPlanModeState(next) {
      state = next
    },
    getActiveToolNames() {
      return [...this.activeTools]
    },
    hasBuiltInTool(name) {
      return name === 'write'
    },
    async setActiveToolsByName(names) {
      this.activeTools = [...names]
    },
    setPlanProposalHandler(handler) {
      this.handler = handler
    },
    setPlanReferencePath(path) {
      this.referencePath = path
    }
  }
}

test('plan review limits tools until approval and restores them after approval', async () => {
  const session = fakeSession()
  const fullTools = [...session.activeTools]
  const proposal = {
    title: 'analysis-plan',
    content: '# Analysis plan\nRead then edit.',
    planFilePath: 'local://analysis-plan.md'
  }
  const entered = await enterPlanReviewMode(
    session,
    async () => proposal,
    async () => ({ decision: 'approve' })
  )
  assert.equal(entered, true)
  assert.equal(session.getPlanModeState()?.enabled, true)
  assert.deepEqual(session.activeTools, ['read', 'glob', 'grep', 'write', 'edit', 'todo'])
  assert.ok(session.handler)
  const result = await session.handler('analysis-plan')
  assert.match(JSON.stringify(result), /Plan approved/)
  assert.equal(session.getPlanModeState(), undefined)
  assert.equal(session.referencePath, proposal.planFilePath)
  assert.equal(session.handler, null)
  assert.deepEqual(session.activeTools, fullTools)
})

test('revision keeps plan mode active and cancellation exits without execution', async () => {
  const session = fakeSession()
  const proposal = {
    title: 'analysis-plan',
    content: '# Plan',
    planFilePath: 'local://analysis-plan.md'
  }
  let decision: 'revise' | 'cancel' = 'revise'
  await enterPlanReviewMode(
    session,
    async () => proposal,
    async () => ({ decision, note: 'Add tests' })
  )
  assert.ok(session.handler)
  const revised = await session.handler('analysis-plan')
  assert.match(JSON.stringify(revised), /Add tests/)
  assert.equal(session.getPlanModeState()?.enabled, true)
  assert.equal(session.getPlanModeState()?.planFilePath, proposal.planFilePath)
  assert.deepEqual(session.activeTools, ['read', 'glob', 'grep', 'write', 'edit', 'todo'])
  decision = 'cancel'
  const cancelled = await session.handler('analysis-plan')
  assert.match(JSON.stringify(cancelled), /Do not implement/)
  assert.equal(session.getPlanModeState(), undefined)
  assert.equal(session.handler, null)
})

test('entering plan review again does not overwrite its original tool set', async () => {
  const session = fakeSession()
  const proposal = { title: 'plan', content: '# Plan', planFilePath: 'local://plan.md' }
  await enterPlanReviewMode(
    session,
    async () => proposal,
    async () => ({ decision: 'revise' })
  )
  assert.equal(
    await enterPlanReviewMode(
      session,
      async () => proposal,
      async () => ({ decision: 'approve' })
    ),
    false
  )
})

test('replan request identity stays in plan-mode state until review ends', async () => {
  const session = fakeSession()
  let structured: ((input: unknown) => Promise<unknown>) | null = null
  await enterPlanReviewMode(
    session,
    async () => ({ title: 'unused', content: 'unused', planFilePath: 'local://PLAN.md' }),
    async () => ({ decision: 'cancel' }),
    {
      execute: true,
      replanRequestId: 'replan-1',
      reviewSteps: async () => ({
        ok: true,
        spec: { version: 1, goal: 'Goal', steps: [] },
        choice: { decision: 'cancel' }
      }),
      setProposalHandler: (handler) => {
        structured = handler
      }
    }
  )
  assert.equal(session.getPlanModeState()?.replanRequestId, 'replan-1')
  assert.ok(structured)
  await (structured as (input: unknown) => Promise<unknown>)({})
  assert.equal(session.getPlanModeState(), undefined)
})

test('replan rollback restores tools only for the matching request', async () => {
  const session = fakeSession()
  const originalTools = [...session.activeTools]
  let structured: ((input: unknown) => Promise<unknown>) | null = null
  await enterPlanReviewMode(
    session,
    async () => ({ title: 'unused', content: 'unused', planFilePath: 'local://PLAN.md' }),
    async () => ({ decision: 'cancel' }),
    {
      execute: true,
      replanRequestId: 'replan-1',
      reviewSteps: async () => ({ ok: false, errors: ['unused'] }),
      setProposalHandler: (handler) => {
        structured = handler
      }
    }
  )
  assert.equal(await cancelPlanReviewReplanMode(session, 'replan-2'), false)
  assert.equal(session.getPlanModeState()?.replanRequestId, 'replan-1')
  assert.equal(await cancelPlanReviewReplanMode(session, 'replan-1'), true)
  assert.equal(session.getPlanModeState(), undefined)
  assert.deepEqual(session.activeTools, originalTools)
  assert.equal(structured, null)
  assert.equal(await cancelPlanReviewReplanMode(session, 'replan-1'), false)
})

test('plan tool guard blocks workspace mutations and hidden device calls', () => {
  assert.equal(planModeToolDecision(true, 'read', { path: 'src/index.ts' }).allowed, true)
  assert.equal(planModeToolDecision(true, 'todo', { op: 'init' }).allowed, true)
  assert.equal(
    planModeToolDecision(true, 'write', { path: 'local://analysis-plan.md' }).allowed,
    true
  )
  assert.equal(planModeToolDecision(true, 'write', { path: 'xd://propose' }).allowed, true)
  assert.equal(
    planModeToolDecision(true, 'edit', { path: '[local://analysis-plan.md#ABCD]' }).allowed,
    true
  )
  assert.equal(planModeToolDecision(true, 'write', { path: '[xd://propose]' }).allowed, true)
  for (const [name, input] of [
    ['write', { path: 'src/index.ts' }],
    ['edit', { path: 'src/index.ts' }],
    ['bash', { command: 'git status' }],
    ['download_file', { url: 'https://example.invalid' }],
    ['write', { path: 'xd://resolve' }],
    ['skill_run', { skill: 'echo', script: 'run.py' }],
    ['plot_save', { dest: 'out.txt' }]
  ] as const) {
    assert.equal(planModeToolDecision(true, name, input).allowed, false)
  }
  assert.equal(planModeToolDecision(false, 'bash', { command: 'npm test' }).allowed, true)
})

test('structured plan mode admits reads and propose_plan_steps only', () => {
  assert.equal(planModeToolDecision(true, 'propose_plan_steps', { steps: [] }, true).allowed, true)
  assert.equal(planModeToolDecision(true, 'read', { path: 'src/index.ts' }, true).allowed, true)
  for (const [name, input] of [
    ['write', { path: 'local://PLAN.md' }],
    ['write', { path: 'xd://propose' }],
    ['edit', { path: 'local://PLAN.md' }],
    ['bash', { command: 'git status' }]
  ] as const) {
    const decision = planModeToolDecision(true, name, input, true)
    assert.equal(decision.allowed, false)
    assert.match(decision.reason ?? '', /propose_plan_steps/)
  }
})

test('plan_execute replaces OMP plan-mode context and its xd://propose reminder', () => {
  const planContext = {
    role: 'custom',
    customType: 'plan-mode-context',
    content: 'Write local://demo-plan.md, then write the slug to xd://propose.',
    display: false,
    timestamp: 1
  }
  const reminder = {
    role: 'developer',
    content: [
      {
        type: 'text',
        text: '<system-reminder>\nPlan mode turn ended without a required tool call.\nWrite the plan to local://demo-plan.md and submit it through xd://propose.\n</system-reminder>'
      }
    ],
    timestamp: 2
  }
  const user = { role: 'user', content: [{ type: 'text', text: 'keep me' }], timestamp: 3 }
  const filtered = suppressPlanExecutePromptContext([planContext, reminder, user])
  assert.ok(filtered)
  assert.equal(filtered.length, 2)
  const serialized = JSON.stringify(filtered)
  assert.doesNotMatch(serialized, /xd:\/\/propose/)
  assert.doesNotMatch(serialized, /local:\/\//)
  assert.match(serialized, /propose_plan_steps/)
  assert.match(serialized, /keep me/)
  assert.equal(suppressPlanExecutePromptContext([user]), undefined)
})

test('plan_execute system prompt names only propose_plan_steps', () => {
  const prompt = buildPhiMainSystemPrompt(['base instructions'], {
    workMode: 'plan_execute'
  }).join('\n')
  assert.match(prompt, /propose_plan_steps/)
  assert.doesNotMatch(prompt, /xd:\/\/propose/)
  assert.doesNotMatch(prompt, /local:\/\//)
})

test('structured review content stays within the host payload limit', () => {
  const spec: PlanSpec = {
    version: 1,
    goal: '目标'.repeat(50_000),
    steps: Array.from({ length: 20 }, (_, index) => ({
      id: `step-${index}`,
      title: `Step ${index}`,
      instructions: '说明'.repeat(2_000),
      acceptance: '完成'.repeat(500),
      dependsOn: [],
      access: 'read'
    }))
  }
  assert.ok(Buffer.byteLength(planReviewContent(spec), 'utf8') < 64 * 1024)
})

test('structured review shows the shared default agent for a step that omits one', () => {
  const content = planReviewContent({
    version: 1,
    goal: 'Finish the plan',
    steps: [
      {
        id: 's1',
        title: 'First step',
        instructions: 'Do the first step',
        acceptance: 'The first step is done',
        dependsOn: [],
        access: 'read'
      }
    ]
  })
  assert.match(content, /agent: PlanStep/)
})
