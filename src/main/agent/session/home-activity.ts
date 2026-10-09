import type {
  HomeActivityDay,
  HomeActivityPeriodSummary,
  HomeActivitySummary
} from '../../../shared/homeActivityTypes'
import { listPhiSessions, readSessionEvents, type StoredSessionEvent } from './session-store'

const CALENDAR_DAYS = 53 * 7
const TERMINAL_RUN_EVENTS = new Set(['run_completed', 'run_failed', 'run_interrupted'])

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value)
  next.setDate(next.getDate() + days)
  return next
}

function dateKey(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function mondayFor(value: Date): Date {
  return addDays(value, -((value.getDay() + 6) % 7))
}

function validDuration(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function terminalRunEvents(): StoredSessionEvent[] {
  const uniqueEvents = new Map<string, StoredSessionEvent>()

  for (const manifest of listPhiSessions()) {
    let events: StoredSessionEvent[]
    try {
      events = readSessionEvents(manifest.sessionId)
    } catch {
      // A damaged history must not make the secondary home dashboard unavailable.
      continue
    }
    for (const event of events) {
      if (!TERMINAL_RUN_EVENTS.has(event.type)) continue
      const key =
        typeof event.runId === 'string' ? event.runId : `${event.sessionId}:${event.eventId}`
      const previous = uniqueEvents.get(key)
      if (!previous || previous.createdAt <= event.createdAt) uniqueEvents.set(key, event)
    }
  }

  return [...uniqueEvents.values()]
}

function blankPeriod(): HomeActivityPeriodSummary {
  return { durationMs: 0, completedRuns: 0, totalRuns: 0, activeDays: 0 }
}

function periodSummary(
  events: Array<{ event: StoredSessionEvent; completedAt: Date }>,
  start: Date,
  end: Date
): HomeActivityPeriodSummary {
  const summary = blankPeriod()
  const activeDays = new Set<string>()

  for (const { event, completedAt } of events) {
    if (completedAt < start || completedAt > end) continue
    summary.totalRuns += 1
    if (event.type === 'run_completed') summary.completedRuns += 1
    summary.durationMs += validDuration(event.durationMs)
    activeDays.add(dateKey(completedAt))
  }

  summary.activeDays = activeDays.size
  return summary
}

export function getHomeActivity(now = new Date()): HomeActivitySummary {
  const generatedAt = new Date(now)
  const today = startOfLocalDay(generatedAt)
  const endOfToday = addDays(today, 1)
  endOfToday.setMilliseconds(-1)
  const calendarStart = addDays(today, -(CALENDAR_DAYS - 1))
  const events = terminalRunEvents().flatMap((event) => {
    const completedAt = new Date(event.createdAt)
    return Number.isFinite(completedAt.getTime()) ? [{ event, completedAt }] : []
  })
  const byDate = new Map<string, HomeActivityDay>()

  for (let dayIndex = 0; dayIndex < CALENDAR_DAYS; dayIndex += 1) {
    const date = dateKey(addDays(calendarStart, dayIndex))
    byDate.set(date, { date, durationMs: 0, completedRuns: 0, totalRuns: 0 })
  }

  for (const { event, completedAt } of events) {
    const bucket = byDate.get(dateKey(completedAt))
    if (!bucket || completedAt > endOfToday) continue
    bucket.totalRuns += 1
    if (event.type === 'run_completed') bucket.completedRuns += 1
    bucket.durationMs += validDuration(event.durationMs)
  }

  return {
    generatedAt: generatedAt.toISOString(),
    dayBuckets: [...byDate.values()],
    periods: {
      week: periodSummary(events, mondayFor(today), endOfToday),
      month: periodSummary(events, new Date(today.getFullYear(), today.getMonth(), 1), endOfToday),
      year: periodSummary(events, new Date(today.getFullYear(), 0, 1), endOfToday)
    }
  }
}
