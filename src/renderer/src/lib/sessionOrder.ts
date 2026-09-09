import type { SessionSummary } from '../types'

const SESSION_ORDER_STORAGE_PREFIX = 'phi.sessionOrder.'

function sessionOrderStorageKey(scopeKey: string): string {
  return `${SESSION_ORDER_STORAGE_PREFIX}${scopeKey}`
}

export function readSessionOrder(scopeKey: string): string[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(sessionOrderStorageKey(scopeKey))
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : []
  } catch {
    return []
  }
}

export function sessionPaths(sessions: SessionSummary[]): string[] {
  return sessions.map((session) => session.path)
}

export function initialSessionOrderForDisplay(
  scopeKey: string,
  sessions: SessionSummary[]
): string[] {
  const storedOrder = readSessionOrder(scopeKey)
  return storedOrder.length > 0 ? storedOrder : sessionPaths(sessions)
}

export function writeSessionOrder(scopeKey: string, order: string[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(sessionOrderStorageKey(scopeKey), JSON.stringify(order))
}

function sessionActivityTime(session: SessionSummary): number {
  const value = session.lastActivityAt ?? session.modified ?? session.created
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

export function isSessionListSortedByActivityTime(sessions: SessionSummary[]): boolean {
  return sessions.every((session, index) => {
    if (index === 0) return true
    return sessionActivityTime(sessions[index - 1]) >= sessionActivityTime(session)
  })
}

export function preserveSessionListOrder(
  previous: SessionSummary[],
  next: SessionSummary[]
): SessionSummary[] {
  if (previous.length === 0 || next.length <= 1) return next
  if (!isSessionListSortedByActivityTime(next)) return next

  const nextByPath = new Map(next.map((session) => [session.path, session]))
  const ordered = previous
    .map((session) => nextByPath.get(session.path))
    .filter((session): session is SessionSummary => session !== undefined)
  const orderedPaths = new Set(ordered.map((session) => session.path))
  const additions = next.filter((session) => !orderedPaths.has(session.path))

  return [...ordered, ...additions]
}

export function reconcileSessionOrder(sessions: SessionSummary[], order: string[]): string[] {
  const paths = new Set(sessions.map((session) => session.path))
  const kept = order.filter((path) => paths.has(path))
  const keptSet = new Set(kept)
  return [...kept, ...sessions.map((session) => session.path).filter((path) => !keptSet.has(path))]
}

export function orderSessionsForDisplay(
  sessions: SessionSummary[],
  order: string[]
): SessionSummary[] {
  const byPath = new Map(sessions.map((session) => [session.path, session]))
  return reconcileSessionOrder(sessions, order)
    .map((path) => byPath.get(path))
    .filter((session): session is SessionSummary => session !== undefined)
}
