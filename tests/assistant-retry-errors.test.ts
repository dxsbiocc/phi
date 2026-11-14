import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createAgentEventReducerState,
  reduceAgentEventState
} from '../src/renderer/src/lib/agentEventReducer'
import type { AgentEventSummary, ChatItem, ChatMessage } from '../src/renderer/src/types'

function assistantError(
  errorMessage: string,
  timestamp: number
): NonNullable<AgentEventSummary['message']> {
  return { role: 'assistant', stopReason: 'error', errorMessage, timestamp }
}

function errorMessages(items: readonly ChatItem[]): ChatMessage[] {
  return items.filter((item): item is ChatMessage => item.role === 'error')
}

function recoveredRetryErrors(count: number): NonNullable<AgentEventSummary['retryErrors']> {
  return Array.from({ length: count }, () => ({
    retryRecovery: {
      kind: 'auto-retry' as const,
      status: 'recovered' as const,
      attempt: 2,
      recoveredAt: '2026-09-07T00:00:20.000Z',
      recovery: 'plain' as const,
      note: 'Retried automatically'
    }
  }))
}

test('one successful saga clears every assistant error it recovered', () => {
  let state = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'approval_denied',
    eventId: 'approval-denied',
    approvalId: 'approval-1',
    runId: 'run-1',
    toolName: 'bash',
    summary: 'rm -rf build'
  })
  state = reduceAgentEventState(state, {
    type: 'message_end',
    runId: 'run-1',
    message: assistantError('503 upstream busy', 100)
  })
  state = reduceAgentEventState(state, {
    type: 'message_end',
    runId: 'run-1',
    message: assistantError('stream ended unexpectedly', 200)
  })
  state = reduceAgentEventState(state, {
    type: 'auto_retry_end',
    runId: 'run-1',
    success: true,
    attempt: 2,
    retryErrors: recoveredRetryErrors(2)
  })

  const errors = errorMessages(state.messages)
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.approval?.status, 'denied')
})

test('a success event without retryErrors clears all recovered assistant errors in the run', () => {
  let state = createAgentEventReducerState([
    { id: 'error-other-run', role: 'error', runId: 'run-0', content: 'older failure' }
  ])
  state = reduceAgentEventState(state, {
    type: 'approval_denied',
    eventId: 'approval-denied',
    approvalId: 'approval-1',
    runId: 'run-1',
    toolName: 'bash',
    summary: 'rm -rf build'
  })
  state = reduceAgentEventState(state, {
    type: 'context_compaction_failed',
    eventId: 'compaction-failed',
    runId: 'run-1',
    action: 'compact',
    errorMessage: 'compaction broke'
  })
  state = reduceAgentEventState(state, {
    type: 'message_end',
    runId: 'run-1',
    message: assistantError('503 upstream busy', 100)
  })
  state = reduceAgentEventState(state, {
    type: 'message_end',
    runId: 'run-1',
    message: assistantError('stream ended unexpectedly', 200)
  })
  state = reduceAgentEventState(state, {
    type: 'auto_retry_end',
    runId: 'run-1',
    success: true,
    attempt: 2
  })

  const errors = errorMessages(state.messages)
  assert.equal(errors.length, 3)
  assert.equal(
    errors.some((item) => item.content === 'older failure'),
    true
  )
  assert.equal(
    errors.some((item) => item.contextCompaction !== undefined),
    true
  )
  assert.equal(
    errors.some((item) => item.approval?.status === 'denied'),
    true
  )
  assert.equal(
    errors.some((item) => item.content === '503 upstream busy'),
    false
  )
  assert.equal(
    errors.some((item) => item.content === 'stream ended unexpectedly'),
    false
  )
})

test('a known non-matching timestamp never falls back to matching text', () => {
  let state = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'message_end',
    runId: 'run-1',
    message: assistantError('same provider text', 200)
  })
  state = reduceAgentEventState(state, {
    type: 'message_end',
    runId: 'run-1',
    message: {
      ...assistantError('same provider text', 100),
      retryRecovery: {
        kind: 'auto-retry',
        status: 'recovered',
        attempt: 1,
        recoveredAt: '2026-09-07T00:00:20.000Z',
        recovery: 'plain',
        note: 'Retried automatically'
      }
    }
  })

  assert.deepEqual(
    errorMessages(state.messages).map((item) => item.content),
    ['same provider text']
  )
})

test('a legacy error without a timestamp is still removed by its unique text', () => {
  let state = reduceAgentEventState(createAgentEventReducerState(), {
    type: 'message_end',
    runId: 'run-1',
    message: {
      role: 'assistant',
      stopReason: 'error',
      errorMessage: 'legacy provider error'
    }
  })
  state = reduceAgentEventState(state, {
    type: 'message_end',
    runId: 'run-1',
    message: {
      ...assistantError('legacy provider error', 100),
      retryRecovery: {
        kind: 'auto-retry',
        status: 'recovered',
        attempt: 1,
        recoveredAt: '2026-09-07T00:00:20.000Z',
        recovery: 'plain',
        note: 'Retried automatically'
      }
    }
  })

  assert.deepEqual(state.messages, [])
})
