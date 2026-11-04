import assert from 'node:assert/strict'
import test from 'node:test'

import type { PhiHostRequestHandler } from '../src/main/agent/engine/types'
import {
  registerPlanReviewHostService,
  type PlanReviewHostServiceDeps
} from '../src/main/agent/plan/plan-review-host-service'
import type { PlanSpec } from '../src/shared/planRunTypes'
import { createPlanReviewRequest } from '../src/main/agent/host-requests/plan-review-request'

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

test('SSH plan review accepts only an authenticated call from its active run', async () => {
  let reviews = 0
  let started = 0
  let generation = 1
  let savedWorkMode = 'plan_execute'
  let delayedRecovery = false
  let releaseRecovery!: () => void
  const waitForRecovery = new Promise<void>((resolve) => {
    releaseRecovery = resolve
  })
  let enteredRecovery: (() => void) | undefined
  const handler = createPlanReviewRequest({
    fields: {
      optionalStringField: (record, key) =>
        typeof record[key] === 'string' ? (record[key] as string) : undefined
    },
    runs: {
      findByRuntimeSessionId: (id) =>
        id === 'runtime-1'
          ? {
              phiSessionId: 'phi-1',
              runId: 'run-1',
              cwd: '/remote',
              projectId: 'project-1',
              sessionGeneration: generation,
              cancelled: false
            }
          : null
    },
    projects: { getById: () => ({ location: { kind: 'ssh' } }) },
    sessions: {
      findById: () => ({ projectLocation: { kind: 'ssh' }, workMode: savedWorkMode }),
      sessionPath: () => 'phi-session:phi-1'
    },
    renderer: {
      getActiveWindow: () => ({}) as never,
      waitForResponse: async () => {
        reviews++
        return { answers: [{ question: 'plan_review', answer: 'approve' }] } as never
      }
    },
    timeline: { append: (_id, event) => event, broadcast: () => undefined },
    state: {
      createId: () => 'review-1',
      markNeedsInput: () => undefined,
      markInputCancelled: () => undefined,
      markInputAnswered: () => undefined,
      notifySessionChanged: () => undefined
    },
    planRuns: {
      startFromApprovedPlan: async (sessionId, approved, guard) => {
        assert.equal(sessionId, 'phi-1')
        assert.deepEqual(approved, spec)
        assert.equal(guard?.expectedRuntimeSessionId, 'runtime-1')
        enteredRecovery?.()
        if (delayedRecovery) await waitForRecovery
        guard?.assertCurrent()
        started++
        return { id: 'plan-1' }
      },
      pendingReplan: () => null,
      validateReplanProposal: async () => ({ ok: true, spec }),
      applyApprovedReplan: async () => ({ id: 'plan-1' }),
      cancelReplan: () => undefined
    }
  })
  const request = {
    runtimeSessionId: 'runtime-1',
    title: 'Finish E5',
    planContent: '# Finish E5',
    planFilePath: 'local://PLAN.md',
    steps: spec
  }
  const origin = {
    originSessionId: 'runtime-1',
    agentRunId: 'run-1',
    toolCallId: 'call-1',
    remotePlanPhase: 'plan_execute' as const
  }
  await assert.rejects(() => handler(request, origin), /远程项目暂不支持计划评审/)
  // Phi's own kernel owns plan state for SSH sessions too; the RPC-era proofs do not apply.
  assert.deepEqual(
    await handler(request, {
      originSessionId: 'runtime-1',
      agentRunId: 'run-1',
      kernelOrigin: true
    }),
    { decision: 'approve', planRunId: 'plan-1' }
  )
  assert.equal(reviews, 1)
  reviews = 0
  started = 0
  await assert.rejects(
    () =>
      handler(request, { ...origin, originSessionId: 'other', remoteOriginAuthenticated: true }),
    /No active conversation/
  )
  await assert.rejects(
    () => handler(request, { ...origin, agentRunId: 'other', remoteOriginAuthenticated: true }),
    /远程项目暂不支持计划评审/
  )
  assert.deepEqual(await handler(request, { ...origin, remoteOriginAuthenticated: true }), {
    decision: 'approve',
    planRunId: 'plan-1'
  })
  assert.equal(reviews, 1)
  assert.equal(started, 1)

  savedWorkMode = 'plan'
  assert.deepEqual(
    await handler(
      { ...request, steps: undefined },
      { ...origin, remoteOriginAuthenticated: true, remotePlanPhase: 'plan' }
    ),
    { decision: 'approve' }
  )
  assert.equal(started, 1)
  savedWorkMode = 'plan_execute'

  savedWorkMode = 'auto'
  await assert.rejects(
    () => handler(request, { ...origin, remoteOriginAuthenticated: true, remotePlanPhase: 'plan' }),
    /远程项目暂不支持计划评审/
  )
  assert.deepEqual(await handler(request, { ...origin, remoteOriginAuthenticated: true }), {
    decision: 'approve',
    planRunId: 'plan-1'
  })
  assert.equal(started, 2)
  savedWorkMode = 'plan_execute'

  delayedRecovery = true
  const entered = new Promise<void>((resolve) => {
    enteredRecovery = resolve
  })
  const controller = new AbortController()
  const stale = handler(request, {
    ...origin,
    remoteOriginAuthenticated: true,
    signal: controller.signal
  })
  await entered
  generation = 2
  controller.abort()
  releaseRecovery()
  await assert.rejects(stale, /Plan approval is no longer active/)
  assert.equal(started, 2)
})

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

test('kernel-owned plan approval records the decision without starting a desktop plan run', async () => {
  const events: Array<Record<string, unknown>> = []
  let desktopStarts = 0
  let desktopReplans = 0
  let replanPending = false
  const handler = createPlanReviewRequest({
    fields: {
      optionalStringField: (record, key) =>
        typeof record[key] === 'string' ? (record[key] as string) : undefined
    },
    runs: {
      findByRuntimeSessionId: () => ({
        phiSessionId: 'phi-1',
        runId: 'run-1',
        cwd: '/workspace',
        sessionGeneration: 1,
        cancelled: false
      })
    },
    projects: { getById: () => undefined },
    sessions: {
      findById: () => ({
        projectLocation: { kind: 'local' },
        kernelRuntimeRef: {
          kind: 'phi-kernel',
          version: 1,
          kernelSessionId: 'kernel-1',
          host: { kind: 'local', agentDir: '/agent' }
        }
      }),
      sessionPath: () => 'phi-session:phi-1'
    },
    renderer: {
      getActiveWindow: () => ({}) as never,
      waitForResponse: async () =>
        ({ answers: [{ question: 'plan_review', answer: 'approve' }] }) as never
    },
    timeline: {
      append: (_sessionId, event) => {
        const stored = { ...event }
        events.push(stored)
        return stored
      },
      broadcast: () => undefined
    },
    state: {
      createId: () => 'review-1',
      markNeedsInput: () => undefined,
      markInputCancelled: () => undefined,
      markInputAnswered: () => undefined,
      notifySessionChanged: () => undefined
    },
    planRuns: {
      startFromApprovedPlan: async () => {
        desktopStarts += 1
        return { id: 'desktop-plan-1' }
      },
      pendingReplan: () =>
        replanPending ? { requestId: 'kernel-replan-1', runId: 'kernel-plan-1' } : null,
      validateReplanProposal: async () => ({ ok: true, spec }),
      applyApprovedReplan: async () => {
        desktopReplans += 1
        return { id: 'desktop-plan-1' }
      },
      cancelReplan: () => undefined
    }
  })

  assert.deepEqual(
    await handler(
      {
        runtimeSessionId: 'runtime-1',
        title: 'Kernel plan',
        planContent: '# Plan',
        planFilePath: 'local://kernel-plan.md',
        steps: spec
      },
      { originSessionId: 'runtime-1' }
    ),
    { decision: 'approve' }
  )
  assert.equal(desktopStarts, 0)

  replanPending = true
  assert.deepEqual(
    await handler(
      {
        runtimeSessionId: 'runtime-1',
        title: 'Kernel replan',
        planContent: '# Replan',
        planFilePath: 'local://kernel-replan.md',
        steps: spec,
        replanRequestId: 'kernel-replan-1'
      },
      { originSessionId: 'runtime-1' }
    ),
    { decision: 'approve' }
  )
  assert.equal(desktopReplans, 0)
  assert.equal(
    events.some((event) => event.type === 'plan_review_decided' && event.decision === 'approve'),
    true
  )
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
