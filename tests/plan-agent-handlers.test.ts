import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeFrame } from '../src/shared/kernel-protocol/codec'
import { createPlanAgentHandlers } from '../src/kernel/worker/plan-agent-handlers'
import type { KernelPlanCoordinator } from '../src/kernel/plans/coordinator'

test('a stopped plan state with undefined optional fields encodes as a response frame', async () => {
  const stopped = {
    id: 'run-1',
    sessionId: 'kernel-1',
    status: 'stopped',
    pause: undefined,
    steps: { s1: { status: 'cancelled', attempts: 1, error: undefined } },
    replans: 0
  }
  const handlers = createPlanAgentHandlers({
    callWorker: async () => undefined,
    plans: { stop: async () => stopped } as unknown as KernelPlanCoordinator,
    agentRuns: {} as never,
    requireLoadedSession: () => undefined
  })
  const result = await handlers['planRuns.stop']!({ runId: 'run-1' }, {} as never, {
    sessionId: 'kernel-1'
  } as never)
  assert.deepEqual(result, {
    id: 'run-1',
    sessionId: 'kernel-1',
    status: 'stopped',
    steps: { s1: { status: 'cancelled', attempts: 1 } },
    replans: 0
  })
  assert.doesNotThrow(() => encodeFrame({ kind: 'response', id: 'r1', ok: true, result } as never))
})
