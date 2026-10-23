import assert from 'node:assert/strict'
import test from 'node:test'

import type { PlanRunState } from '../src/shared/planRunTypes'
import {
  createPlanRunDetailsLoader,
  type PlanRunDetailRequest
} from '../src/renderer/src/features/plan/lib/planRunDetailsLoader'

function state(updatedAt: string): PlanRunState {
  return {
    id: 'plan-1',
    sessionId: 'phi-1',
    spec: { version: 1, goal: 'Ship', steps: [] },
    status: 'running',
    steps: {},
    replans: 0,
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt
  }
}

test('plan details loader single-flights by version and rejects an older late response', async () => {
  const resolvers: Array<(value: PlanRunState) => void> = []
  const accepted: string[] = []
  const loader = createPlanRunDetailsLoader(() => new Promise((resolve) => resolvers.push(resolve)))
  const request = (updatedAt: string): PlanRunDetailRequest => ({
    sessionId: 'phi-1',
    runId: 'plan-1',
    updatedAt,
    isCurrent: () => true,
    accept: (value: PlanRunState) => {
      accepted.push(value.updatedAt)
      return true
    },
    onError: () => assert.fail('unexpected error')
  })
  const first = loader.load(request('2026-10-23T00:00:01.000Z'))
  assert.equal(loader.load(request('2026-10-23T00:00:01.000Z')), first)
  const second = loader.load(request('2026-10-23T00:00:02.000Z'))
  assert.equal(resolvers.length, 2)
  resolvers[1]!(state('2026-10-23T00:00:02.000Z'))
  assert.equal((await second)?.updatedAt, '2026-10-23T00:00:02.000Z')
  resolvers[0]!(state('2026-10-23T00:00:01.000Z'))
  assert.equal(await first, null)
  assert.deepEqual(accepted, ['2026-10-23T00:00:02.000Z'])
})
