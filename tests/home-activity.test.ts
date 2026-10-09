import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { getHomeActivity } from '../src/main/agent/session/home-activity'
import { appendSessionEvent, createPhiSession } from '../src/main/agent/session/session-store'

function withPhiDir<T>(callback: () => T): T {
  const previous = process.env.PI_CODING_AGENT_DIR
  const phiDir = mkdtempSync(join(tmpdir(), 'phi-home-activity-'))
  process.env.PI_CODING_AGENT_DIR = phiDir
  try {
    return callback()
  } finally {
    if (previous === undefined) {
      delete process.env.PI_CODING_AGENT_DIR
    } else {
      process.env.PI_CODING_AGENT_DIR = previous
    }
    rmSync(phiDir, { recursive: true, force: true })
  }
}

function localDate(year: number, month: number, day: number, hour = 12): Date {
  return new Date(year, month - 1, day, hour)
}

function createSession(kind: 'ordinary' | 'project', projectId?: string): string {
  return createPhiSession({
    kind,
    ...(projectId ? { projectId } : {}),
    cwd: kind === 'project' ? '/project' : '/workspace',
    cwdRealPath: kind === 'project' ? '/project' : '/workspace',
    permissionMode: kind === 'project' ? 'ask' : 'auto'
  }).sessionId
}

test('home activity aggregates terminal runs across ordinary and project sessions', () => {
  withPhiDir(() => {
    const ordinary = createSession('ordinary')
    const project = createSession('project', 'project-1')

    appendSessionEvent(ordinary, {
      type: 'run_completed',
      runId: 'completed-today',
      createdAt: localDate(2026, 10, 9).toISOString(),
      durationMs: 30 * 60_000
    })
    appendSessionEvent(project, {
      type: 'run_failed',
      runId: 'failed-yesterday',
      createdAt: localDate(2026, 10, 8).toISOString(),
      durationMs: 10 * 60_000
    })
    appendSessionEvent(project, {
      type: 'run_completed',
      runId: 'completed-today',
      createdAt: localDate(2026, 10, 9).toISOString(),
      durationMs: 30 * 60_000
    })
    appendSessionEvent(project, {
      type: 'run_interrupted',
      runId: 'interrupted-spring',
      createdAt: localDate(2026, 3, 2).toISOString(),
      durationMs: 5 * 60_000
    })
    appendSessionEvent(project, {
      type: 'assistant_message_finalized',
      runId: 'not-a-run-terminal',
      createdAt: localDate(2026, 10, 9).toISOString(),
      durationMs: 999_999
    })

    const summary = getHomeActivity(localDate(2026, 10, 9, 18))
    assert.equal(summary.dayBuckets.length, 371)
    assert.deepEqual(summary.periods.week, {
      durationMs: 40 * 60_000,
      completedRuns: 1,
      totalRuns: 2,
      activeDays: 2
    })
    assert.deepEqual(summary.periods.month, summary.periods.week)
    assert.deepEqual(summary.periods.year, {
      durationMs: 45 * 60_000,
      completedRuns: 1,
      totalRuns: 3,
      activeDays: 3
    })

    const today = summary.dayBuckets.find((day) => day.date === '2026-10-09')
    assert.deepEqual(today, {
      date: '2026-10-09',
      durationMs: 30 * 60_000,
      completedRuns: 1,
      totalRuns: 1
    })
  })
})

test('home activity ignores future events and sanitizes invalid durations', () => {
  withPhiDir(() => {
    const sessionId = createSession('ordinary')
    appendSessionEvent(sessionId, {
      type: 'run_completed',
      runId: 'invalid-duration',
      createdAt: localDate(2026, 10, 9).toISOString(),
      durationMs: -1
    })
    appendSessionEvent(sessionId, {
      type: 'run_completed',
      runId: 'future-run',
      createdAt: localDate(2026, 10, 10).toISOString(),
      durationMs: 60_000
    })

    const summary = getHomeActivity(localDate(2026, 10, 9, 18))
    assert.deepEqual(summary.periods.week, {
      durationMs: 0,
      completedRuns: 1,
      totalRuns: 1,
      activeDays: 1
    })
  })
})
