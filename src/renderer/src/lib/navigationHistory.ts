import type { AppView } from '../App'

export type NavigationHistoryEntry = { view: AppView; sessionPath: string | null }
export type NavigationHistoryState = { entries: NavigationHistoryEntry[]; index: number }

export function initialNavigationHistory(entry: NavigationHistoryEntry): NavigationHistoryState {
  return { entries: [entry], index: 0 }
}

export function recordNavigationEntry(
  state: NavigationHistoryState,
  current: NavigationHistoryEntry
): NavigationHistoryState {
  const existing = state.entries[state.index]
  if (existing && existing.view === current.view && existing.sessionPath === current.sessionPath) {
    return state
  }
  // Navigating from a mid-stack position drops the forward entries,
  // matching standard browser back/forward semantics.
  const truncated = state.entries.slice(0, state.index + 1)
  const nextEntries = [...truncated, current]
  return { entries: nextEntries, index: nextEntries.length - 1 }
}

export function navigationHistoryTargetIndex(
  state: NavigationHistoryState,
  direction: 'back' | 'forward'
): number | null {
  if (direction === 'back') {
    return state.index > 0 ? state.index - 1 : null
  }
  return state.index < state.entries.length - 1 ? state.index + 1 : null
}

/**
 * A restoration can span an async gap: the view changes synchronously but,
 * if the target entry also names a different session, restoring it is an
 * IPC round trip that lands later. Call this on every
 * (activeView, activeSessionPath) change while a restoration is in flight
 * to find out whether the target has now fully landed.
 */
export function navigationRestorationSettled(
  target: NavigationHistoryEntry,
  current: NavigationHistoryEntry
): boolean {
  if (target.view !== current.view) return false
  if (target.sessionPath !== null && target.sessionPath !== current.sessionPath) return false
  return true
}
