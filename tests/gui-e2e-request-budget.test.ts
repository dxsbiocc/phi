import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  ActualRequestBudget,
  RequestBudgetExceededError,
  countActualModelRequests,
  readPersistedRequestEvents
} from '../scripts/gui-e2e/request-budget'

function event(
  type: string,
  createdAt: string,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return { type, sessionId: 'session-1', runId: 'run-1', createdAt, ...overrides }
}

test('actual request count groups text, thinking, and tools from one response timestamp', () => {
  const events = [
    event('assistant_thinking_completed', '2026-11-02T01:00:00.000Z'),
    event('assistant_message_finalized', '2026-11-02T01:00:00.000Z'),
    event('tool_call_started', '2026-11-02T01:00:00.000Z', { toolCallId: 'tool-1' }),
    event('tool_call_started', '2026-11-02T01:00:00.000Z', { toolCallId: 'tool-2' }),
    event('assistant_message_finalized', '2026-11-02T01:00:01.000Z'),
    event('user_message', '2026-11-02T01:00:02.000Z')
  ]

  assert.equal(countActualModelRequests(events), 2)
})

test('actual request count separates sessions that reuse a run and timestamp', () => {
  const first = event('assistant_message_finalized', '2026-11-02T01:00:00.000Z')
  const second = { ...first, sessionId: 'session-2' }
  assert.equal(countActualModelRequests([first, second]), 2)
})

test('a failed run without an assistant commit counts one conservative request', () => {
  const failed = event('run_failed', '2026-11-02T01:00:00.000Z')
  assert.equal(countActualModelRequests([failed]), 1)
  assert.equal(
    countActualModelRequests([event('tool_call_started', '2026-11-02T00:59:59.000Z'), failed]),
    2
  )
  assert.equal(
    countActualModelRequests([
      event('tool_call_started', '2026-11-02T00:59:59.000Z'),
      event('approval_denied', '2026-11-02T00:59:59.500Z'),
      failed
    ]),
    1
  )
})

test('ActualRequestBudget excludes the baseline and reserves headroom before a prompt', () => {
  const baseline = [event('assistant_message_finalized', '2026-11-02T01:00:00.000Z')]
  const budget = new ActualRequestBudget(3, baseline)
  assert.equal(budget.observe(baseline).usedRequests, 0)

  const first = event('assistant_message_finalized', '2026-11-02T01:00:01.000Z')
  const second = event('tool_call_started', '2026-11-02T01:00:02.000Z')
  assert.equal(budget.observe([first, second]).usedRequests, 2)
  assert.throws(() => budget.assertCanStartPrompt(2), RequestBudgetExceededError)
  assert.equal(budget.assertCanStartPrompt(1).remainingRequests, 1)

  const limit = budget.observe([event('assistant_message_finalized', '2026-11-02T01:00:03.000Z')])
  assert.equal(limit.atLimit, true)
  assert.throws(() => budget.assertWithinLimit(), RequestBudgetExceededError)
})

test('readPersistedRequestEvents reads every isolated session journal and reports bad lines', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-gui-budget-test-'))
  try {
    const sessionDir = join(root, 'sessions', 'session-from-dir')
    mkdirSync(sessionDir, { recursive: true })
    writeFileSync(
      join(sessionDir, 'messages.jsonl'),
      `${JSON.stringify({
        type: 'assistant_message_finalized',
        runId: 'run-1',
        createdAt: '2026-11-02T01:00:00.000Z'
      })}\ninvalid\n`
    )

    const snapshot = readPersistedRequestEvents(root)
    assert.equal(countActualModelRequests(snapshot.events), 1)
    assert.equal(snapshot.events[0].sessionId, 'session-from-dir')
    assert.deepEqual(snapshot.issues, [
      { sessionId: 'session-from-dir', lineNumber: 2, reason: 'invalid-json' }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readPersistedRequestEvents includes successful and failed automatic title requests', () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-gui-title-budget-'))
  const sessionDir = join(root, 'sessions', 'session-title')
  mkdirSync(sessionDir, { recursive: true })
  writeFileSync(join(sessionDir, 'messages.jsonl'), '')
  writeFileSync(
    join(sessionDir, 'manifest.json'),
    JSON.stringify({ titleSource: 'auto', createdAt: '2026-01-01T00:00:00.000Z' })
  )
  mkdirSync(join(root, 'logs'), { recursive: true })
  writeFileSync(
    join(root, 'logs', '2026-01-01.jsonl'),
    `${[
      {
        event: 'session_auto_title_unavailable',
        sessionId: 'session-failed-title',
        timestamp: '2026-01-01T00:00:01.000Z'
      },
      {
        event: 'run_failed',
        sessionId: 'session-failed-run',
        runId: 'run-failed',
        timestamp: '2026-01-01T00:00:02.000Z'
      }
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n')}\n`
  )
  try {
    const snapshot = readPersistedRequestEvents(root)
    assert.equal(countActualModelRequests(snapshot.events), 3)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
