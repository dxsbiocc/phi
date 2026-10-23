import assert from 'node:assert/strict'
import test from 'node:test'

import type { PhiHostRequestHandler } from '../src/main/agent/engine/types'
import {
  registerPlanReviewHostService,
  type PlanReviewHostServiceDeps
} from '../src/main/agent/plan/plan-review-host-service'
import type { PlanSpec } from '../src/shared/planRunTypes'

const spec: PlanSpec = {
  version: 1,
  goal: 'Ship the approved plan',
  steps: [
    {
      id: 'inspect',
      title: 'Inspect',
      instructions: 'Inspect the target.',
      acceptance: 'The target is understood.',
      dependsOn: [],
      access: 'read'
    }
  ]
}

test('plan review host service owns registration and forwards approved steps to plan runs', async () => {
  const handlers = new Map<string, PhiHostRequestHandler>()
  const calls: string[] = []
  let failStart = false
  const deps: PlanReviewHostServiceDeps<Record<string, unknown>> = {
    host: {
      register: (method, handler) => {
        handlers.set(method, handler)
        return () => {
          handlers.delete(method)
        }
      }
    },
    optionalStringField: (record, key) =>
      typeof record[key] === 'string' ? record[key].trim() : undefined,
    findActivePromptRunByRuntimeSessionId: () => ({
      phiSessionId: 'phi-1',
      runId: 'run-1',
      cwd: '/workspace',
      sessionGeneration: 1,
      cancelled: false
    }),
    getProject: () => undefined,
    findPhiSessionById: () => ({ projectLocation: { kind: 'local' } }),
    phiOnlySessionPath: (sessionId) => `phi-session:${sessionId}`,
    getActiveWindow: () => ({}) as never,
    canRequestAgentUserInteraction: (window): window is NonNullable<typeof window> =>
      Boolean(window),
    waitForAgentUserInteraction: async () =>
      ({ answers: [{ question: 'plan_review', answer: 'approve' }] }) as never,
    appendSessionEvent: (_sessionId, event) => {
      if (event.type === 'plan_review_decided') {
        calls.push(`decision:${event.decision}:${String(event.reason ?? '')}`)
      }
      return { ...event }
    },
    broadcastSessionTimelineEvent: (_sessionId, event) => calls.push(`broadcast:${event.type}`),
    createRunId: () => 'review-1',
    runnerRegistry: {
      markNeedsInput: () => calls.push('needs-input'),
      markInputCancelled: () => calls.push('cancelled'),
      markInputAnswered: () => calls.push('answered')
    },
    notifySessionChanged: () => calls.push('changed'),
    planRuns: {
      startFromApprovedPlan: async (sessionId, approvedSpec) => {
        if (failStart) throw new Error('plan start failed')
        calls.push(`start:${sessionId}:${approvedSpec.goal}`)
        return { id: 'plan-run-1' }
      }
    }
  }

  const unregister = registerPlanReviewHostService(deps)
  const handler = handlers.get('planReview.request')
  assert.ok(handler)
  assert.deepEqual(
    await handler(
      {
        runtimeSessionId: 'runtime-1',
        title: 'Approved plan',
        planContent: '# Plan',
        planFilePath: 'local://approved-plan.md',
        steps: spec
      },
      {}
    ),
    { decision: 'approve', planRunId: 'plan-run-1' }
  )
  assert.equal(calls.includes('start:phi-1:Ship the approved plan'), true)

  const decidedBeforeFailure = calls.filter(
    (call) => call === 'broadcast:plan_review_decided'
  ).length
  failStart = true
  await assert.rejects(
    async () =>
      handler(
        {
          runtimeSessionId: 'runtime-1',
          title: 'Approved plan',
          planContent: '# Plan',
          planFilePath: 'local://approved-plan.md',
          steps: spec
        },
        {}
      ),
    /plan start failed/
  )
  assert.equal(
    calls.filter((call) => call === 'broadcast:plan_review_decided').length,
    decidedBeforeFailure + 1
  )
  assert.equal(calls.includes('decision:cancel:plan_start_failed'), true)
  assert.equal(calls.filter((call) => call === 'cancelled').length, 1)

  unregister()
  assert.equal(handlers.has('planReview.request'), false)
})
