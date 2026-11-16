import assert from 'node:assert/strict'

import type { KernelProtocolClient } from '../../src/main/agent/engine/kernel-client'
import type { PlanSpec } from '../../src/shared/planRunTypes'
import { record, type ModelReply, type ScenarioClient } from './harness'

type Step = <T>(name: string, action: () => Promise<T>) => Promise<T>

interface PlanScenarioReport {
  evidence: {
    planRunId?: string
    planReviewCount?: number
    agentRunState?: string
    planApprovalTools?: string[]
    planStateBeforeReplan?: Record<string, unknown>
    planStateAfterReplan?: Record<string, unknown>
  }
}

async function eventually(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function originalPlan(): PlanSpec {
  return {
    version: 1,
    goal: 'Inspect two inputs and produce a verified result',
    steps: [
      {
        id: 'read-a',
        title: 'Read input A',
        instructions: 'Inspect input A.',
        acceptance: 'A is understood.',
        dependsOn: [],
        access: 'read'
      },
      {
        id: 'read-b',
        title: 'Read input B',
        instructions: 'Inspect input B.',
        acceptance: 'B is understood.',
        dependsOn: [],
        access: 'read'
      },
      {
        id: 'write-result',
        title: 'Write result',
        instructions: 'Write the combined result.',
        acceptance: 'The result exists.',
        dependsOn: ['read-a', 'read-b'],
        access: 'write',
        writes: ['result.txt']
      }
    ]
  }
}

function replacementPlan(): PlanSpec {
  const current = originalPlan()
  return {
    ...current,
    steps: [
      ...current.steps,
      {
        id: 'verify-result',
        title: 'Verify result without rewriting',
        instructions: 'Verify the completed read evidence and report the outcome.',
        acceptance: 'The result is verified.',
        dependsOn: ['read-a', 'read-b'],
        access: 'read'
      }
    ]
  }
}

const INJECTED_STEP_FAILURE =
  '<phi_agent_result>{"status":"failed","missingInputs":[],"nextAgent":null,"fallbackReason":null}</phi_agent_result>Injected write failure.'

const INITIAL_REQUEST = 'Plan and execute the G3 scenario.'
const REPLAN_REQUEST = 'G3_REPLAN_REQUEST'
const HOST_TASK = 'Inspect the G3 scenario before plan execution.'

function completed(match: string, text: string): ModelReply {
  return {
    match,
    text:
      '<phi_agent_result>{"status":"completed","missingInputs":[],"nextAgent":null,"fallbackReason":null}</phi_agent_result>' +
      text
  }
}

function tool(match: string, name: string, id: string, args: Record<string, unknown>): ModelReply {
  return { match, tool: { name, id, args } }
}

function planState(value: unknown): Record<string, unknown> {
  const list = Array.isArray(value) ? value : []
  assert.equal(list.length, 1)
  return record(list[0])
}

export async function runPlanScenario(options: {
  provider: { enqueue(...replies: ModelReply[]): void }
  client: ScenarioClient
  projectRoot: string
  report: PlanScenarioReport
  step: Step
}): Promise<void> {
  let reviewCount = 0
  const protocol = options.client.client as KernelProtocolClient
  protocol.registerHostHandler('workMode.selected', (params) => {
    const input = record(params)
    return {
      ok: true,
      mode: input.execute === true ? 'plan_execute' : 'plan',
      ...(typeof input.reason === 'string' ? { reason: input.reason } : {})
    }
  })
  protocol.registerHostHandler('planReview.request', () => {
    reviewCount += 1
    return { decision: 'approve' }
  })

  // The shared approval responder is installed after this scenario returns, so answer here.
  const approvalTools: string[] = []
  const stopApprovals = protocol.onEvent((event) => {
    if (event.type !== 'approval.requested' || !event.sessionId) return
    const payload = record(event.payload)
    approvalTools.push(String(payload.toolName))
    void protocol
      .request(
        'approval.respond',
        { approvalId: String(payload.approvalId), decision: 'approved' },
        { sessionId: event.sessionId }
      )
      .catch(() => undefined)
  })
  try {
    await runPlanFlow(options, protocol, () => reviewCount)
  } finally {
    stopApprovals()
    options.report.evidence.planApprovalTools = approvalTools
    options.report.evidence.planReviewCount = reviewCount
  }
}

async function runPlanFlow(
  options: Parameters<typeof runPlanScenario>[0],
  protocol: KernelProtocolClient,
  reviewCount: () => number
): Promise<void> {
  const sessionId = await options.step('plan scenario session created with bundled agents', () =>
    options.client.create(options.projectRoot, true, { workMode: 'auto' })
  )

  options.provider.enqueue(completed(HOST_TASK, 'Host-started sub-task complete.'))
  const child = record(
    await options.step('host sub-task durably started', () =>
      protocol.request(
        'agentRuns.start',
        {
          requestId: 'g3-host-subtask-1',
          agent: 'PlanStep',
          task: HOST_TASK
        },
        { sessionId }
      )
    )
  )
  assert.equal(typeof child.runId, 'string')
  const waited = record(
    await options.step('host sub-task reached a terminal receipt', () =>
      protocol.request(
        'agentRuns.wait',
        { runId: child.runId as string, timeoutMs: 60_000 },
        { sessionId }
      )
    )
  )
  const waitedRun = record(waited.run)
  assert.equal(waitedRun.state, 'done')
  options.report.evidence.agentRunState = String(waitedRun.state)

  const initial = originalPlan()
  options.provider.enqueue(
    tool(INITIAL_REQUEST, 'enter_plan_mode', 'g3-enter-plan', {
      execute: true,
      reason: 'Run the G3 dependency plan'
    }),
    tool(
      INITIAL_REQUEST,
      'propose_plan_steps',
      'g3-propose-plan',
      initial as unknown as Record<string, unknown>
    ),
    // Match the current step, not its title in the shared plan overview. Concurrent
    // reads and the main conversation must not consume each other's replies.
    { match: INITIAL_REQUEST, text: 'Plan review accepted.' },
    completed('## Current step: read-a:', 'Completed one approved action.'),
    completed('## Current step: read-b:', 'Completed one approved action.'),
    { match: '## Current step: write-result:', text: INJECTED_STEP_FAILURE },
    { match: '## Current step: write-result:', text: INJECTED_STEP_FAILURE }
  )
  await options.step('three-step plan approved and injected failure observed', async () => {
    const completion = await options.client.prompt(sessionId, INITIAL_REQUEST)
    assert.equal(completion.status, 'completed')
    await eventually(async () => {
      const state = planState(await protocol.request('planRuns.list', {}, { sessionId }))
      options.report.evidence.planStateBeforeReplan = state
      return state.status === 'paused'
    }, 'failed plan pause')
  })

  const before = planState(await protocol.request('planRuns.list', {}, { sessionId }))
  options.report.evidence.planStateBeforeReplan = before
  const originalSteps = record(before.steps)
  for (const id of ['read-a', 'read-b']) {
    assert.equal(record(originalSteps[id]).status, 'done', `${id} must complete before replan`)
    assert.equal(record(originalSteps[id]).attempts, 1, `${id} must run exactly once`)
  }
  assert.equal(record(originalSteps['write-result']).status, 'failed')
  assert.equal(record(originalSteps['write-result']).attempts, 2)
  assert.equal(typeof before.id, 'string')
  options.report.evidence.planRunId = String(before.id)
  const replan = record(
    await options.step('remaining plan entered replan mode', () =>
      protocol.request('planRuns.replan', { runId: before.id as string }, { sessionId })
    )
  )
  assert.equal(typeof replan.prompt, 'string')

  const replacement = replacementPlan()
  options.provider.enqueue(
    tool(
      REPLAN_REQUEST,
      'propose_plan_steps',
      'g3-propose-replacement',
      replacement as unknown as Record<string, unknown>
    ),
    { match: REPLAN_REQUEST, text: 'Replacement accepted.' },
    completed('## Current step: verify-result:', 'Verification complete.'),
    { match: REPLAN_REQUEST, text: 'The approved plan is complete and summarized.' }
  )
  await options.step('replan completed without replaying finished reads', async () => {
    const completion = await options.client.prompt(
      sessionId,
      `${String(replan.prompt)}\n\n${REPLAN_REQUEST}`
    )
    assert.equal(completion.status, 'completed')
    await eventually(async () => {
      const state = planState(await protocol.request('planRuns.list', {}, { sessionId }))
      options.report.evidence.planStateAfterReplan = state
      return state.status === 'completed'
    }, 'replanned plan completion')
    const state = planState(await protocol.request('planRuns.list', {}, { sessionId }))
    options.report.evidence.planStateAfterReplan = state
    const steps = record(state.steps)
    assert.equal(record(steps['read-a']).attempts, 1)
    assert.equal(record(steps['read-b']).attempts, 1)
    assert.equal(record(steps['write-result']).status, 'skipped')
    assert.equal(record(steps['verify-result']).status, 'done')
  })
  options.report.evidence.planReviewCount = reviewCount()
  assert.equal(reviewCount(), 2)
}
