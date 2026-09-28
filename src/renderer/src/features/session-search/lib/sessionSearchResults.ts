import type { SessionSummary } from '../../../types'
import { filterSessionSummaries, normalizeSessionQuery } from './sessionFilter'

export type SessionSearchResult = {
  session: SessionSummary
  projectName: string | null
}

type SearchProject = { id: string; name: string }

function activityTime(session: SessionSummary): number {
  const parsed = Date.parse(session.lastActivityAt ?? session.modified ?? session.created)
  return Number.isFinite(parsed) ? parsed : 0
}

export function buildSessionSearchResults(
  ordinarySessions: readonly SessionSummary[],
  projects: readonly SearchProject[],
  projectSessions: Readonly<Record<string, SessionSummary[]>>,
  query: string,
  limit: number
): SessionSearchResult[] {
  const normalizedQuery = normalizeSessionQuery(query)
  const results: SessionSearchResult[] = []
  const seenPaths = new Set<string>()

  const append = (session: SessionSummary, projectName: string | null): void => {
    if (seenPaths.has(session.path)) return
    seenPaths.add(session.path)
    results.push({ session, projectName })
  }

  for (const session of filterSessionSummaries([...ordinarySessions], normalizedQuery)) {
    append(session, null)
  }
  for (const project of projects) {
    const sessions = projectSessions[project.id] ?? []
    const projectMatches = normalizeSessionQuery(project.name).includes(normalizedQuery)
    for (const session of projectMatches
      ? sessions
      : filterSessionSummaries(sessions, normalizedQuery)) {
      append(session, project.name)
    }
  }

  return results.sort((a, b) => activityTime(b.session) - activityTime(a.session)).slice(0, limit)
}
