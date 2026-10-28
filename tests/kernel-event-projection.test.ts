import assert from 'node:assert/strict'
import test from 'node:test'

import { projectKernelEvent } from '../src/main/agent/engine/kernel-event-projection'
import type { SessionBinding } from '../src/main/agent/engine/kernel-session-support'
import type { PhiAgentEvent } from '../src/main/agent/engine/types'
import type { JsonValue, KernelEventFrame } from '../src/shared/kernel-protocol'
import type { PlanRunState } from '../src/shared/planRunTypes'

const state: PlanRunState = {
  id: 'plan-1',
  sessionId: 'kernel-session-1',
  spec: { version: 1, goal: 'Finish the kernel plan', steps: [] },
  status: 'running',
  steps: {},
  replans: 0,
  createdAt: '2026-10-28T00:00:00.000Z',
  updatedAt: '2026-10-28T00:00:01.000Z'
}

function projectPlanEvent(event: 'plan_run_updated' | 'plan_run_finished'): PhiAgentEvent {
  const projected: PhiAgentEvent[] = []
  const binding = {
    sink: {
      event: (value: PhiAgentEvent) => {
        projected.push(value)
      }
    }
  } as unknown as SessionBinding
  const payload = { event, state } as unknown as Record<string, JsonValue>
  const frame = {
    kind: 'event',
    seq: 1,
    type: 'planRun.updated',
    sessionId: 'kernel-session-1',
    payload
  } as KernelEventFrame

  projectKernelEvent(binding, frame, payload)
  assert.equal(projected.length, 1)
  return projected[0]
}

test('kernel plan events project to the renderer plan-run event shape', () => {
  assert.deepEqual(projectPlanEvent('plan_run_updated'), {
    type: 'plan_run_updated',
    state
  })
  assert.deepEqual(projectPlanEvent('plan_run_finished'), {
    type: 'plan_run_finished',
    state
  })
})
