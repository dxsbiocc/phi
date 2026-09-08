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

export function writeSessionOrder(scopeKey: string, order: string[]): void {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(sessionOrderStorageKey(scopeKey), JSON.stringify(order))
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
