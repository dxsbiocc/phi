import type { SessionSummary } from '../types'

export function sessionActivityTime(session: SessionSummary): number {
  for (const value of [session.lastActivityAt, session.modified, session.created]) {
    const timestamp = value ? Date.parse(value) : NaN
    if (Number.isFinite(timestamp)) return timestamp
  }
  return 0
}

export function orderSessionsForDisplay(sessions: SessionSummary[]): SessionSummary[] {
  return [...sessions].sort((left, right) => {
    const activityDifference = sessionActivityTime(right) - sessionActivityTime(left)
    if (activityDifference !== 0) return activityDifference
    return left.path.localeCompare(right.path)
  })
}
