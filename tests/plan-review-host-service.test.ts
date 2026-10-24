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
      },
      pendingReplan: () => null,
      validateReplanProposal: async () => ({ ok: true, spec }),
      applyApprovedReplan: async () => ({ id: 'plan-run-1' }),
      cancelReplan: () => undefined
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
      { originSessionId: 'runtime-1' }
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
        { originSessionId: 'runtime-1' }
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

test('reviewed replan applies only to its bound session and keeps revisions pending', async () => {
  const handlers = new Map<string, PhiHostRequestHandler>()
  const calls: string[] = []
  let decision: 'approve' | 'revise' | 'cancel' = 'revise'
  let pending = true
  let promptRunId = 'prompt-1'
  let promptCancelled = false
  let failApply = false
  let holdValidation = false
  const validationGate: { release?: () => void } = {}
  let reviewCards = 0
  const deps: PlanReviewHostServiceDeps<Record<string, unknown>> = {
    host: {
      register: (method, handler) => {
        handlers.set(method, handler)
        return () => handlers.delete(method)
      }
    },
    optionalStringField: (record, key) =>
      typeof record[key] === 'string' ? record[key].trim() : undefined,
    findActivePromptRunByRuntimeSessionId: (runtimeSessionId) =>
      runtimeSessionId === 'runtime-1'
        ? {
            phiSessionId: 'phi-1',
            runId: promptRunId,
            cwd: '/workspace',
            sessionGeneration: 1,
            cancelled: promptCancelled
          }
        : null,
    getProject: () => undefined,
    findPhiSessionById: () => ({ projectLocation: { kind: 'local' } }),
    phiOnlySessionPath: (sessionId) => `phi-session:${sessionId}`,
    getActiveWindow: () => ({}) as never,
    canRequestAgentUserInteraction: (window): window is NonNullable<typeof window> =>
      Boolean(window),
    waitForAgentUserInteraction: async () => {
      reviewCards += 1
      return { answers: [{ question: 'plan_review', answer: decision }] } as never
    },
    appendSessionEvent: (_sessionId, event) => ({ ...event }),
    broadcastSessionTimelineEvent: () => undefined,
    createRunId: () => 'review-1',
    runnerRegistry: {
      markNeedsInput: () => undefined,
      markInputCancelled: () => undefined,
      markInputAnswered: () => undefined
    },
    notifySessionChanged: () => undefined,
    planRuns: {
      startFromApprovedPlan: async () => {
        throw new Error('must not create a new plan run')
      },
      pendingReplan: (sessionId, runtimeSessionId) =>
        pending && sessionId === 'phi-1' && runtimeSessionId === 'runtime-1'
          ? { requestId: 'replan-1', runId: 'plan-1' }
          : null,
      validateReplanProposal: async (sessionId, requestId, candidate) => {
        calls.push(`validate:${sessionId}:${requestId}`)
        if (holdValidation)
          await new Promise<void>((resolve) => {
            validationGate.release = resolve
          })
        return { ok: true, spec: candidate as PlanSpec }
      },
      applyApprovedReplan: async (sessionId, runtimeSessionId, requestId) => {
        if (failApply) throw new Error('replacement failed')
        calls.push(`apply:${sessionId}:${runtimeSessionId}:${requestId}`)
        pending = false
        return { id: 'plan-1' }
      },
      cancelReplan: (sessionId, requestId) => {
        calls.push(`cancel:${sessionId}:${requestId}`)
        pending = false
      }
    }
  }
  registerPlanReviewHostService(deps)
  const handler = handlers.get('planReview.request')
  assert.ok(handler)
  const request = {
    runtimeSessionId: 'runtime-1',
    title: 'Remaining work',
    planContent: '# Plan',
    planFilePath: 'local://PLAN.md',
    steps: spec,
    replanRequestId: 'replan-1'
  }
  await assert.rejects(
    async () => handler(request, { originSessionId: 'runtime-2' }),
    /No active conversation/
  )
  await assert.rejects(
    async () => handler({ ...request, replanRequestId: 'other' }, { originSessionId: 'runtime-1' }),
    /no longer active/
  )
  assert.equal(calls.length, 0)
  assert.deepEqual(await handler(request, { originSessionId: 'runtime-1' }), { decision: 'revise' })
  assert.equal(pending, true)
  assert.equal(
    calls.some((call) => call.startsWith('apply:')),
    false
  )
  decision = 'approve'
  assert.deepEqual(await handler(request, { originSessionId: 'runtime-1' }), {
    decision: 'approve',
    planRunId: 'plan-1'
  })
  assert.equal(calls.includes('apply:phi-1:runtime-1:replan-1'), true)

  pending = true
  decision = 'cancel'
  assert.deepEqual(await handler(request, { originSessionId: 'runtime-1' }), { decision: 'cancel' })
  assert.equal(calls.includes('cancel:phi-1:replan-1'), true)

  pending = true
  decision = 'approve'
  const previousApplies = calls.filter((call) => call.startsWith('apply:')).length
  deps.waitForAgentUserInteraction = async () => {
    promptRunId = 'prompt-2'
    return { answers: [{ question: 'plan_review', answer: 'approve' }] } as never
  }
  // Register a fresh handler so the changed response dependency is used.
  registerPlanReviewHostService(deps)
  const lateHandler = handlers.get('planReview.request')
  assert.ok(lateHandler)
  assert.deepEqual(await lateHandler(request, { originSessionId: 'runtime-1' }), {
    decision: 'cancel'
  })
  assert.equal(calls.filter((call) => call.startsWith('apply:')).length, previousApplies)
  assert.equal(pending, false)

  promptRunId = 'prompt-1'
  pending = true
  failApply = true
  registerPlanReviewHostService({
    ...deps,
    waitForAgentUserInteraction: async () =>
      ({ answers: [{ question: 'plan_review', answer: 'approve' }] }) as never
  })
  const failedHandler = handlers.get('planReview.request')
  assert.ok(failedHandler)
  assert.deepEqual(await failedHandler(request, { originSessionId: 'runtime-1' }), {
    decision: 'cancel'
  })
  assert.equal(pending, false)

  failApply = false
  pending = true
  holdValidation = true
  deps.waitForAgentUserInteraction = async () => {
    reviewCards += 1
    return { answers: [{ question: 'plan_review', answer: 'approve' }] } as never
  }
  registerPlanReviewHostService(deps)
  const delayedHandler = handlers.get('planReview.request')
  assert.ok(delayedHandler)
  const cardsBeforeValidation = reviewCards
  const delayedReview = delayedHandler(request, { originSessionId: 'runtime-1' })
  assert.ok(validationGate.release)
  promptCancelled = true
  validationGate.release()
  assert.deepEqual(await delayedReview, { decision: 'cancel' })
  assert.equal(reviewCards, cardsBeforeValidation)
  assert.equal(pending, false)
})
