import assert from 'node:assert/strict'
import test from 'node:test'

import {
  enterPlanReviewMode,
  type PlanReviewSession
} from '../src/main/agent/plan/plan-review-mode'
import { planModeToolDecision } from '../src/main/agent/plan/plan-tool-policy'

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

test('plan mode keeps office_read available while reserving office_apply as a blocked write', async () => {
  const session = fakeSession()
  session.activeTools.push('office_read', 'office_apply')
  await enterPlanReviewMode(
    session,
    async () => ({ title: 'plan', content: '# Plan', planFilePath: 'local://plan.md' }),
    async () => ({ decision: 'approve' })
  )

  assert.equal(session.activeTools.includes('office_read'), true)
  assert.equal(session.activeTools.includes('office_apply'), false)
  assert.equal(planModeToolDecision(true, 'office_read', {}).allowed, true)
  assert.equal(planModeToolDecision(true, 'office_apply', {}).allowed, false)
})
