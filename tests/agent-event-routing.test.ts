import assert from 'node:assert/strict'
import test from 'node:test'

import {
  agentEventBelongsToActiveSession,
  agentEventMaterializesActiveFreshSession
} from '../src/renderer/src/lib/agentEventRouting'

test('agent event routing keeps background materialized sessions out of a fresh chat', () => {
  assert.equal(
    agentEventBelongsToActiveSession(
      {
        type: 'message_update',
        sessionGeneration: 0,
        sessionPath: 'background.jsonl',
        cwd: '/workspace'
      },
      { path: null, cwd: '/workspace', sessionGeneration: 0 }
    ),
    false
  )
})

test('agent event routing accepts the active materialized session only', () => {
  assert.equal(
    agentEventBelongsToActiveSession(
      {
        type: 'message_update',
        sessionGeneration: 0,
        sessionPath: 'active.jsonl',
        cwd: '/workspace'
      },
      { path: 'active.jsonl', cwd: '/workspace', sessionGeneration: 0 }
    ),
    true
  )
  assert.equal(
    agentEventBelongsToActiveSession(
      {
        type: 'message_update',
        sessionGeneration: 0,
        sessionPath: 'other.jsonl',
        cwd: '/workspace'
      },
      { path: 'active.jsonl', cwd: '/workspace', sessionGeneration: 0 }
    ),
    false
  )
})

test('agent event routing keeps fresh-session events generation scoped', () => {
  assert.equal(
    agentEventBelongsToActiveSession(
      {
        type: 'run_started',
        sessionGeneration: 2,
        sessionPath: null,
        cwd: '/workspace'
      },
      { path: null, cwd: '/workspace', sessionGeneration: 2 }
    ),
    true
  )
  assert.equal(
    agentEventBelongsToActiveSession(
      {
        type: 'run_started',
        sessionGeneration: 1,
        sessionPath: null,
        cwd: '/workspace'
      },
      { path: null, cwd: '/workspace', sessionGeneration: 2 }
    ),
    false
  )
})

test('agent event routing materializes only the currently sending fresh session', () => {
  const active = { path: null, cwd: '/workspace', sessionGeneration: 2 }
  const event = {
    type: 'run_started',
    phiSessionId: 'phi-1',
    sessionGeneration: 2,
    sessionPath: 'phi-session:phi-1',
    cwd: '/workspace'
  }

  assert.equal(agentEventMaterializesActiveFreshSession(event, active, true), true)
  assert.equal(agentEventMaterializesActiveFreshSession(event, active, false), false)
  assert.equal(
    agentEventMaterializesActiveFreshSession({ ...event, type: 'message_update' }, active, true),
    false
  )
})
