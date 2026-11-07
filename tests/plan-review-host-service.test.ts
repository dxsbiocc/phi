import assert from 'node:assert/strict'
import test from 'node:test'

import type { PhiHostRequestHandler } from '../src/main/agent/engine/types'
import {
  createPlanReviewRequest,
  type PlanReviewRequestDeps
} from '../src/main/agent/host-requests/plan-review-request'
import { registerPlanReviewHostService } from '../src/main/agent/plan/plan-review-host-service'

const steps = {
  version: 1 as const,
  goal: 'Ship the kernel plan',
  steps: [
    {
      id: 'step-1',
      title: 'Implement',
      instructions: 'Implement it',
      acceptance: 'The change is verified',
      dependsOn: [],
      access: 'write' as const
    }
  ]
}

function reviewDeps(location: 'local' | 'ssh' = 'local'): {
  timeline: Array<Record<string, unknown>>
  deps: PlanReviewRequestDeps<Record<string, unknown>>
} {
  const timeline: Array<Record<string, unknown>> = []
  const run = {
    phiSessionId: 'phi-1',
    runId: 'prompt-1',
    cwd: '/workspace',
    projectId: 'project-1',
    sessionGeneration: 1,
    cancelled: false
  }
  return {
    timeline,
    deps: {
      fields: {
        optionalStringField: (record: Record<string, unknown>, key: string) =>
          typeof record[key] === 'string' ? record[key] : undefined
      },
      runs: { findByRuntimeSessionId: (id: string) => (id === 'runtime-1' ? run : null) },
      projects: { getById: () => ({ name: 'Project', location: { kind: location } }) },
      sessions: {
        findById: () => ({ projectLocation: { kind: location }, workMode: 'plan_execute' }),
        sessionPath: () => 'phi-session:phi-1'
      },
      renderer: {
        getActiveWindow: () => null,
        waitForResponse: async () => ({
          requestId: 'review-1',
          answers: [
            {
              questionIndex: 0,
              question: 'plan_review',
              kind: 'option' as const,
              answer: 'approve'
            }
          ]
        })
      },
      timeline: {
        append: (_sessionId: string, event: Record<string, unknown>) => {
          timeline.push(event)
          return event
        },
        broadcast: () => undefined
      },
      state: {
        createId: () => 'review-1',
        markNeedsInput: () => undefined,
        markInputCancelled: () => undefined,
        markInputAnswered: () => undefined,
        notifySessionChanged: () => undefined
      }
    }
  }
}

const request = {
  runtimeSessionId: 'runtime-1',
  title: 'Kernel plan',
  planContent: '# Kernel plan',
  planFilePath: 'local://PLAN.md',
  steps
}

test('SSH plan review accepts only its authenticated kernel run', async () => {
  const { deps } = reviewDeps('ssh')
  const handler = createPlanReviewRequest(deps)

  await assert.rejects(handler(request, { originSessionId: 'runtime-1' }), /暂不支持计划评审/u)
  assert.deepEqual(
    await handler(request, {
      originSessionId: 'runtime-1',
      kernelOrigin: true
    }),
    { decision: 'approve' }
  )
})

test('plan review host records decisions while the kernel retains plan ownership', async () => {
  const { deps, timeline } = reviewDeps()
  let registered: PhiHostRequestHandler | undefined
  const remove = registerPlanReviewHostService({
    ...deps,
    host: {
      register: (method, handler) => {
        assert.equal(method, 'planReview.request')
        registered = handler
        return () => {
          registered = undefined
        }
      }
    },
    optionalStringField: deps.fields.optionalStringField,
    findActivePromptRunByRuntimeSessionId: deps.runs.findByRuntimeSessionId,
    getProject: deps.projects.getById,
    findPhiSessionById: deps.sessions.findById,
    phiOnlySessionPath: deps.sessions.sessionPath,
    getActiveWindow: deps.renderer.getActiveWindow,
    waitForAgentUserInteraction: deps.renderer.waitForResponse,
    appendSessionEvent: deps.timeline.append,
    broadcastSessionTimelineEvent: deps.timeline.broadcast,
    createRunId: deps.state.createId,
    runnerRegistry: {
      markNeedsInput: deps.state.markNeedsInput,
      markInputCancelled: deps.state.markInputCancelled,
      markInputAnswered: deps.state.markInputAnswered
    },
    notifySessionChanged: deps.state.notifySessionChanged
  })
  assert.ok(registered)

  assert.deepEqual(
    await registered(
      { ...request, replanRequestId: 'kernel-replan-1' },
      { originSessionId: 'runtime-1', kernelOrigin: true }
    ),
    { decision: 'approve' }
  )
  assert.deepEqual(
    timeline.map((event) => event.type),
    ['plan_review_submitted', 'plan_review_decided']
  )

  remove()
  assert.equal(registered, undefined)
})
