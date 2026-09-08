import type { AgentEventSummary } from '../types'

export function agentEventBelongsToActiveSession(
  event: AgentEventSummary,
  active: {
    path: string | null
    cwd: string
    sessionGeneration: number
  }
): boolean {
  if (
    typeof event.sessionGeneration === 'number' &&
    event.sessionGeneration !== active.sessionGeneration
  ) {
    return false
  }

  if (typeof event.cwd === 'string' && active.cwd && event.cwd !== active.cwd) {
    return false
  }

  if (typeof event.sessionPath === 'string') {
    return active.path === event.sessionPath
  }

  if (event.sessionPath === null) {
    return active.path === null
  }

  return true
}
