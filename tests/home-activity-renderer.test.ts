import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildHomeActivityCalendar,
  completionRate,
  formatActivityDuration,
  formatSessionActivity
} from '../src/renderer/src/features/home/lib/homeActivity'
import type { SessionSummary } from '../src/renderer/src/types'

test('home activity calendar creates a GitHub-style Sunday-first grid ending today', () => {
  const weeks = buildHomeActivityCalendar(
    [
      { date: '2026-10-08', durationMs: 60_000, completedRuns: 1, totalRuns: 1 },
      { date: '2026-10-09', durationMs: 3_600_000, completedRuns: 2, totalRuns: 2 },
      { date: '2026-10-10', durationMs: 7_200_000, completedRuns: 3, totalRuns: 3 }
    ],
    new Date(2026, 9, 9, 18)
  )

  assert.equal(weeks.length, 53)
  assert.equal(
    weeks.every((week) => week.days.length === 7),
    true
  )
  assert.equal(weeks.at(-1)?.days[0]?.date, '2026-10-04')
  assert.equal(weeks.at(-1)?.days[1]?.date, '2026-10-05')
  assert.equal(weeks.at(-1)?.days[5]?.date, '2026-10-09')
  assert.equal(weeks.at(-1)?.days[5]?.level, 4)
  assert.equal(weeks.at(-1)?.days[6], null)
})

test('home activity formatting keeps duration and completion labels readable', () => {
  assert.equal(formatActivityDuration(0), '0 分钟')
  assert.equal(formatActivityDuration(30_000), '1 分钟')
  assert.equal(formatActivityDuration(90 * 60_000), '1 小时 30 分')
  assert.equal(completionRate({ durationMs: 0, completedRuns: 2, totalRuns: 3, activeDays: 1 }), 67)
})

test('recent session activity uses local calendar days', () => {
  const session: SessionSummary = {
    path: '/session',
    id: 'session',
    created: new Date(2026, 9, 7, 12).toISOString(),
    modified: new Date(2026, 9, 8, 23).toISOString(),
    messageCount: 2,
    firstMessage: 'Task',
    status: 'idle',
    unreadKind: null
  }

  assert.equal(formatSessionActivity(session, new Date(2026, 9, 9, 9)), '昨天')
})
