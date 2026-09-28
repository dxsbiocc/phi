import type { SessionSummary } from '../../../types'

export function normalizeSessionQuery(value: string): string {
  return value.trim().normalize('NFKC').toLocaleLowerCase()
}

export function matchesSessionQuery(session: SessionSummary, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true
  return [session.name, session.firstMessage].some(
    (value) => typeof value === 'string' && normalizeSessionQuery(value).includes(normalizedQuery)
  )
}

export function filterSessionSummaries(
  sessions: SessionSummary[],
  normalizedQuery: string
): SessionSummary[] {
  return normalizedQuery
    ? sessions.filter((session) => matchesSessionQuery(session, normalizedQuery))
    : sessions
}
