import type {
  HomeActivityDay,
  HomeActivityPeriodSummary,
  HomeActivitySummary,
  SessionSummary
} from '../../../types'

export type HomeActivityLevel = 0 | 1 | 2 | 3 | 4

export interface HomeActivityCalendarDay extends HomeActivityDay {
  label: string
  level: HomeActivityLevel
}

export interface HomeActivityCalendarWeek {
  key: string
  days: Array<HomeActivityCalendarDay | null>
  monthLabel?: string
}

const DAY_MS = 24 * 60 * 60 * 1000
const CALENDAR_WEEK_COUNT = 53

function startOfLocalDay(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate())
}

function addDays(value: Date, days: number): Date {
  const next = new Date(value)
  next.setDate(next.getDate() + days)
  return next
}

function localDateKey(value: Date): string {
  const year = value.getFullYear()
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function sundayFor(value: Date): Date {
  return addDays(value, -value.getDay())
}

function activityScore(day: HomeActivityDay): number {
  return day.totalRuns + day.durationMs / (60 * 60 * 1000)
}

function activityThresholds(days: HomeActivityDay[]): [number, number, number] {
  const scores = days
    .map(activityScore)
    .filter((value) => value > 0)
    .sort((left, right) => left - right)
  if (scores.length === 0) return [0, 0, 0]

  const percentile = (fraction: number): number =>
    scores[Math.min(scores.length - 1, Math.floor((scores.length - 1) * fraction))]
  return [percentile(0.25), percentile(0.5), percentile(0.75)]
}

function activityLevel(
  day: HomeActivityDay,
  [low, medium, high]: [number, number, number]
): HomeActivityLevel {
  const score = activityScore(day)
  if (score <= 0) return 0
  if (score <= low) return 1
  if (score <= medium) return 2
  if (score <= high) return 3
  return 4
}

export function buildHomeActivityCalendar(
  buckets: HomeActivityDay[],
  today = new Date()
): HomeActivityCalendarWeek[] {
  const currentDay = startOfLocalDay(today)
  const start = addDays(sundayFor(currentDay), -(CALENDAR_WEEK_COUNT - 1) * 7)
  const byDate = new Map(buckets.map((bucket) => [bucket.date, bucket]))
  const startKey = localDateKey(start)
  const currentDayKey = localDateKey(currentDay)
  const thresholds = activityThresholds(
    buckets.filter((bucket) => bucket.date >= startKey && bucket.date <= currentDayKey)
  )
  const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
  const monthFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'short' })

  return Array.from({ length: CALENDAR_WEEK_COUNT }, (_, weekIndex) => {
    const weekStart = addDays(start, weekIndex * 7)
    const weekDates = Array.from({ length: 7 }, (_, dayIndex) => addDays(weekStart, dayIndex))
    const monthStart = weekDates.find((date) => date.getDate() === 1 && date <= currentDay)
    const monthLabel =
      weekIndex === 0
        ? monthFormatter.format(weekStart)
        : monthStart
          ? monthFormatter.format(monthStart)
          : undefined

    return {
      key: localDateKey(weekStart),
      ...(monthLabel ? { monthLabel } : {}),
      days: weekDates.map((date) => {
        if (date > currentDay) return null
        const dateKey = localDateKey(date)
        const bucket = byDate.get(dateKey) ?? {
          date: dateKey,
          durationMs: 0,
          completedRuns: 0,
          totalRuns: 0
        }
        return {
          ...bucket,
          label: dateFormatter.format(date),
          level: activityLevel(bucket, thresholds)
        }
      })
    }
  })
}

export function formatActivityDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs) || durationMs <= 0) return '0 分钟'
  const totalMinutes = Math.max(1, Math.round(durationMs / 60_000))
  if (totalMinutes < 60) return `${totalMinutes} 分钟`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  return minutes === 0 ? `${hours} 小时` : `${hours} 小时 ${minutes} 分`
}

export function completionRate(period: HomeActivityPeriodSummary): number {
  if (period.totalRuns <= 0) return 0
  return Math.round((period.completedRuns / period.totalRuns) * 100)
}

export function totalActiveDays(summary: HomeActivitySummary): number {
  return summary.dayBuckets.filter((day) => day.totalRuns > 0 || day.durationMs > 0).length
}

export function formatSessionActivity(session: SessionSummary, now = new Date()): string {
  const timestamp = Date.parse(session.lastActivityAt ?? session.modified)
  if (!Number.isFinite(timestamp)) return '最近使用'
  const elapsedDays = Math.max(
    0,
    Math.floor(
      (startOfLocalDay(now).getTime() - startOfLocalDay(new Date(timestamp)).getTime()) / DAY_MS
    )
  )
  if (elapsedDays === 0) return '今天'
  if (elapsedDays === 1) return '昨天'
  if (elapsedDays < 7) return `${elapsedDays} 天前`
  return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric' }).format(
    new Date(timestamp)
  )
}
