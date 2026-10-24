import assert from 'node:assert/strict'
import test from 'node:test'

import type { PhiEngine } from '../src/main/agent/engine/types'
import { createWorkModeActivity } from '../src/main/agent/plan/plan-execution-wiring'

function activityFor(
  runs: unknown[],
  planActive = false
): ReturnType<typeof createWorkModeActivity> {
  const engine = {
    sessions: { has: (sessionId: string) => sessionId === 'runtime-1' },
    agentRuns: { list: async () => runs }
  } as unknown as PhiEngine
  return createWorkModeActivity({
    engine,
    planRuns: { hasActiveWork: () => planActive },
    sessionKeys: {
      runtimeSessionIdForPhiSession: (phiSessionId, isLive) =>
        phiSessionId === 'phi-1' && isLive('runtime-1') ? 'runtime-1' : undefined
    }
  })
}

for (const origin of ['tool', 'host'] as const) {
  test(`work-mode activity detects unfinished ${origin}-origin background agents`, async () => {
    const activity = activityFor([
      {
        agentSessionId: 'runtime-1',
        agentRunId: `run-${origin}`,
        state: 'running',
        background: true,
        origin
      }
    ])

    assert.equal(await activity.hasActiveAgentRuns('phi-1'), true)
  })
}

test('work-mode activity ignores terminal or unrelated agent runs', async () => {
  const activity = activityFor([
    { agentSessionId: 'runtime-1', state: 'done', background: true, origin: 'tool' },
    { agentSessionId: 'runtime-2', state: 'running', background: true, origin: 'host' }
  ])

  assert.equal(await activity.hasActiveAgentRuns('phi-1'), false)
  assert.equal(await activity.hasActiveAgentRuns('phi-missing'), false)
})

test('work-mode activity delegates active plan detection to the plan service', () => {
  assert.equal(activityFor([], true).hasActivePlanWork('phi-1'), true)
})
