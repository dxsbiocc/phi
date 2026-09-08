import assert from 'node:assert/strict'
import test from 'node:test'

import { agentEventBelongsToActiveSession } from '../src/renderer/src/lib/agentEventRouting'

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
