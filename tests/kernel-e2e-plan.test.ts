import assert from 'node:assert/strict'
import test from 'node:test'

import type { KernelProtocolClient } from '../src/main/agent/engine/kernel-client'
import type { JsonValue } from '../src/shared/kernel-protocol'
import { parseAgentReport, requireDeclaredCompletion } from '../src/main/agent/agents/report'
import { runPlanScenario } from '../scripts/kernel-e2e/plan-scenario'
import type { ModelReply, ScenarioClient } from '../scripts/kernel-e2e/harness'

async function runFixture(readFailed = false): Promise<{
  report: Parameters<typeof runPlanScenario>[0]['report']
  prompts: number
  approvalResponses: JsonValue[]
  listeners: Set<(event: { type: string; sessionId?: string; payload?: JsonValue }) => void>
  replies: ModelReply[]
  steps: string[]
  error: unknown
}> {
  const handlers = new Map<string, (params: JsonValue) => unknown>()
  const replies: ModelReply[] = []
  const report: {
    evidence: {
      planRunId?: string
      planReviewCount?: number
      agentRunState?: string
      planApprovalTools?: string[]
      planStateBeforeReplan?: Record<string, unknown>
      planStateAfterReplan?: Record<string, unknown>
    }
  } = { evidence: {} }
  const listeners = new Set<
    (event: { type: string; sessionId?: string; payload?: JsonValue }) => void
  >()
  const approvalResponses: JsonValue[] = []
  let listCount = 0
  const planState = (completed: boolean): JsonValue[] => [
    {
      id: 'plan-1',
      status: completed ? 'completed' : 'paused',
      steps: {
        'read-a': { status: readFailed ? 'failed' : 'done', attempts: 1 },
        'read-b': { status: 'done', attempts: 1 },
        'write-result': { status: completed ? 'skipped' : 'failed', attempts: 2 },
        'verify-result': { status: completed ? 'done' : 'pending', attempts: completed ? 1 : 0 }
      }
    }
  ]
  const protocol = {
    registerHostHandler(name: string, handler: (params: JsonValue) => unknown) {
      handlers.set(name, handler)
      return () => handlers.delete(name)
    },
    onEvent(listener: (event: { type: string; sessionId?: string; payload?: JsonValue }) => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    async request(method: string, params?: JsonValue): Promise<JsonValue> {
      if (method === 'approval.respond') {
        approvalResponses.push(params ?? null)
        return { ok: true }
      }
      if (method === 'agentRuns.start') {
        return {
          requestId: 'g3-host-subtask-1',
          runId: 'child-1',
          agent: 'PlanStep',
          task: 'inspect',
          state: 'started',
          origin: 'host',
          background: true,
          acceptedAt: '2026-10-26T01:00:00.000Z'
        }
      }
      if (method === 'agentRuns.wait') {
        return {
          timedOut: false,
          run: {
            requestId: 'g3-host-subtask-1',
            runId: 'child-1',
            agent: 'PlanStep',
            task: 'inspect',
            state: 'done',
            origin: 'host',
            background: true,
            acceptedAt: '2026-10-26T01:00:00.000Z'
          }
        }
      }
      if (method === 'planRuns.list') return planState(++listCount >= 3)
      if (method === 'planRuns.replan') {
        return { requestId: 'replan-1', runId: 'plan-1', prompt: 'Replan the rest.' }
      }
      throw new Error(`Unexpected method: ${method}`)
    }
  }
  let prompts = 0
  const scenario = {
    client: protocol as unknown as KernelProtocolClient,
    async create(): Promise<string> {
      return 'session-1'
    },
    async prompt(): Promise<{ runId: string; status: string }> {
      prompts += 1
      for (const listener of listeners) {
        listener({
          type: 'approval.requested',
          sessionId: 'session-1',
          payload: { approvalId: `approval-${prompts}`, toolName: 'propose_plan_steps' }
        })
      }
      await handlers.get('planReview.request')?.({})
      return { runId: `main-${prompts}`, status: 'completed' }
    }
  } as unknown as ScenarioClient
  const steps: string[] = []

  let error: unknown
  try {
    await runPlanScenario({
      provider: { enqueue: (...items) => replies.push(...items) },
      client: scenario,
      projectRoot: '/project',
      report,
      step: async (name, action) => {
        steps.push(name)
        return action()
      }
    })
  } catch (caught) {
    error = caught
  }
  return { report, prompts, approvalResponses, listeners, replies, steps, error }
}

test('plan E2E scenario uses declared, actor-matched replies and records exact replan evidence', async () => {
  const { report, prompts, approvalResponses, listeners, replies, steps, error } =
    await runFixture()
  assert.equal(error, undefined)
  assert.equal(report.evidence.agentRunState, 'done')
  assert.equal(report.evidence.planRunId, 'plan-1')
  assert.equal(report.evidence.planReviewCount, 2)
  assert.equal(prompts, 2)
  assert.deepEqual(approvalResponses, [
    { approvalId: 'approval-1', decision: 'approved' },
    { approvalId: 'approval-2', decision: 'approved' }
  ])
  assert.deepEqual(report.evidence.planApprovalTools, ['propose_plan_steps', 'propose_plan_steps'])
  assert.equal(listeners.size, 0)
  assert.ok(replies.length >= 10)
  const successfulChildren = replies.filter(
    (reply) =>
      reply.text?.includes('Completed one approved action.') ||
      reply.text?.includes('Verification complete.') ||
      reply.text?.includes('Host-started sub-task complete.')
  )
  assert.equal(successfulChildren.length, 4)
  for (const reply of successfulChildren) {
    assert.equal(requireDeclaredCompletion(parseAgentReport(reply.text!)).status, 'completed')
  }
  assert.ok(replies.every((reply) => typeof reply.match === 'string' && reply.match.length > 0))
  const reads = replies.filter((reply) => reply.match?.startsWith('## Current step: read-'))
  assert.equal(reads.length, 2)
  assert.equal(reads[0].match, '## Current step: read-a:')
  assert.equal(reads[1].match, '## Current step: read-b:')
  assert.deepEqual(steps, [
    'plan scenario session created with bundled agents',
    'host sub-task durably started',
    'host sub-task reached a terminal receipt',
    'three-step plan approved and injected failure observed',
    'remaining plan entered replan mode',
    'replan completed without replaying finished reads'
  ])
})

test('plan E2E rejects a paused read failure instead of calling it the injected write failure', async () => {
  const { report, prompts, error } = await runFixture(true)
  assert.match(String(error), /read-a must complete before replan/)
  assert.equal(prompts, 1)
  assert.equal(report.evidence.planReviewCount, 1)
  const before = report.evidence.planStateBeforeReplan
  assert.ok(before)
  const steps = before.steps as Record<string, { status: string }>
  assert.equal(steps['read-a'].status, 'failed')
  assert.equal(report.evidence.planStateAfterReplan, undefined)
})
