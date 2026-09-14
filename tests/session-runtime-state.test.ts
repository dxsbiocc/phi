import assert from 'node:assert/strict'
import test from 'node:test'
import {
  idleSessionRuntimeState,
  mergeSessionRuntimeState,
  reduceSessionRuntimeState,
  sessionRuntimeStateNeedsAcknowledgement,
  sessionRuntimeStateIsBusy,
  sessionRuntimeStatesEqual
} from '../src/renderer/src/lib/sessionRuntimeState'
import type { AgentEventSummary, SessionRuntimeState } from '../src/renderer/src/types'

test('runtime merge preserves a live running state over a stale idle summary', () => {
  const running: SessionRuntimeState = {
    status: 'running',
    unreadKind: null,
    currentRunId: 'run-1',
    currentRunStartedAt: '2026-09-07T00:00:00.000Z',
    lastActivityAt: '2026-09-07T00:00:00.000Z'
  }

  const merged = mergeSessionRuntimeState(running, {
    status: 'idle',
    unreadKind: null,
    currentRunId: 'run-1'
  })

  assert.equal(merged.status, running.status)
  assert.equal(merged.currentRunId, running.currentRunId)
  assert.equal(merged.currentRunStartedAt, running.currentRunStartedAt)
  assert.equal(merged.lastActivityAt, running.lastActivityAt)
  assert.equal(sessionRuntimeStateIsBusy(merged), true)
})

test('runtime merge accepts terminal state from the persisted summary', () => {
  const running: SessionRuntimeState = {
    status: 'running',
    unreadKind: null,
    currentRunId: 'run-1',
    currentRunStartedAt: '2026-09-07T00:00:00.000Z'
  }

  const merged = mergeSessionRuntimeState(running, {
    status: 'failed',
    unreadKind: 'failed',
    lastRunOutcome: 'failed',
    lastActivityAt: '2026-09-07T00:01:00.000Z'
  })

  assert.equal(merged.status, 'failed')
  assert.equal(merged.unreadKind, 'failed')
  assert.equal(merged.lastRunOutcome, 'failed')
})

test('runtime merge accepts authoritative idle state on session switch', () => {
  const running: SessionRuntimeState = {
    status: 'running',
    unreadKind: null,
    currentRunId: 'run-1',
    currentRunStartedAt: '2026-09-07T00:00:00.000Z'
  }

  const merged = mergeSessionRuntimeState(
    running,
    {
      status: 'idle',
      unreadKind: null,
      currentRunId: undefined,
      currentRunStartedAt: undefined
    },
    { preserveBusy: false }
  )

  assert.equal(merged.status, 'idle')
  assert.equal(merged.currentRunId, undefined)
  assert.equal(merged.currentRunStartedAt, undefined)
  assert.equal(sessionRuntimeStateIsBusy(merged), false)
})

test('runtime reducer marks run start and completion as distinct states', () => {
  const startedEvent: AgentEventSummary = {
    type: 'run_started',
    runId: 'run-2',
    createdAt: '2026-09-07T00:00:00.000Z'
  }
  const completedEvent: AgentEventSummary = {
    type: 'run_completed',
    runId: 'run-2',
    createdAt: '2026-09-07T00:02:00.000Z'
  }

  const running = reduceSessionRuntimeState(idleSessionRuntimeState(), startedEvent)
  assert.equal(running.status, 'running')
  assert.equal(running.currentRunId, 'run-2')

  const completed = reduceSessionRuntimeState(running, completedEvent)
  assert.equal(completed.status, 'completed_unread')
  assert.equal(completed.unreadKind, 'completed')
  assert.equal(sessionRuntimeStatesEqual(running, completed), false)
})

test('runtime acknowledgement is only needed for terminal unread states', () => {
  assert.equal(sessionRuntimeStateNeedsAcknowledgement(null), false)
  assert.equal(sessionRuntimeStateNeedsAcknowledgement({ unreadKind: null }), false)
  assert.equal(sessionRuntimeStateNeedsAcknowledgement({ unreadKind: 'approval' }), false)
  assert.equal(sessionRuntimeStateNeedsAcknowledgement({ unreadKind: 'completed' }), true)
  assert.equal(sessionRuntimeStateNeedsAcknowledgement({ unreadKind: 'failed' }), true)
})
