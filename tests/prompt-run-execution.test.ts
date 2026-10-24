import assert from 'node:assert/strict'
import test from 'node:test'

import { planModeRequest } from '../src/main/agent/plan/work-mode-control'

test('prompt execution enters the configured persistent work mode', () => {
  assert.deepEqual(planModeRequest('runtime-1', 'plan'), { sessionId: 'runtime-1' })
  assert.deepEqual(planModeRequest('runtime-1', 'plan_execute'), {
    sessionId: 'runtime-1',
    execute: true
  })
  assert.equal(planModeRequest('runtime-1', 'direct'), undefined)
  assert.equal(planModeRequest('runtime-1', 'auto'), undefined)
})
