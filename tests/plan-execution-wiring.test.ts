import assert from 'node:assert/strict'
import test from 'node:test'

import {
  SessionRoutingEngine,
  type RoutedSessionDriver
} from '../src/main/agent/engine/session-routing-engine'
import { createWorkModeActivity } from '../src/main/agent/plan/plan-execution-wiring'
import type { PlanRunState } from '../src/shared/planRunTypes'
import { legacyEngine, params } from './helpers/kernelSessionFactoryFake'

const planRun: PlanRunState = {
  id: 'plan-1',
  sessionId: 'phi-1',
  spec: { version: 1, goal: 'Ship', steps: [] },
  status: 'running',
  steps: {},
  replans: 0,
  createdAt: '2026-11-07T00:00:00.000Z',
  updatedAt: '2026-11-07T00:00:00.000Z'
}

function driver(runs: unknown[], planActive: boolean): RoutedSessionDriver {
  const state = { cwd: '/project', messages: [] }
  return {
    isLive: true,
    state: () => state,
    prompt: async () => state,
    contextUsage: async () => null,
    rename: async () => state,
    abort: async () => state,
    dispose: async () => undefined,
    agentRuns: {
      list: async () => runs as Record<string, unknown>[],
      resourceOwner: () => ({ toolOwner: 'test', allowedSkills: [] }),
      steer: async () => undefined,
      stop: async () => undefined,
      wait: async () => undefined
    },
    planRuns: {
      list: async () => (planActive ? [planRun] : []),
      get: async () => null,
      stop: async () => planRun,
      retryStep: async () => planRun,
      skipStep: async () => planRun,
      requestReplan: async () => ({ requestId: 'request-1', runId: planRun.id, prompt: '' }),
      cancelReplan: async () => true
    }
  }
}

async function activityFor(
  runs: unknown[],
  planActive = false
): Promise<ReturnType<typeof createWorkModeActivity>> {
  const engine = new SessionRoutingEngine(legacyEngine(), () => ({
    create: async () => driver(runs, planActive)
  }))
  await engine.sessions.create({ ...params('runtime-1'), phiSessionId: 'phi-1' })
  return createWorkModeActivity({
    engine,
    sessionKeys: {
      runtimeSessionIdForPhiSession: (phiSessionId, isLive) =>
        phiSessionId === 'phi-1' && isLive('runtime-1') ? 'runtime-1' : undefined
    }
  })
}

for (const origin of ['tool', 'host'] as const) {
  test(`work-mode activity detects unfinished ${origin}-origin background agents`, async () => {
    const activity = await activityFor([
      { agentRunId: `run-${origin}`, state: 'running', background: true, origin }
    ])

    assert.equal(await activity.hasActiveAgentRuns('phi-1'), true)
  })
}

test('work-mode activity ignores terminal kernel agent runs', async () => {
  const activity = await activityFor([{ state: 'done', background: true, origin: 'tool' }])

  assert.equal(await activity.hasActiveAgentRuns('phi-1'), false)
  assert.equal(await activity.hasActiveAgentRuns('phi-missing'), false)
})

test('work-mode activity reads active plan state from the routed kernel coordinator', async () => {
  assert.equal(await (await activityFor([], true)).hasActivePlanWork('phi-1'), true)
  assert.equal(await (await activityFor([], false)).hasActivePlanWork('phi-1'), false)
})
