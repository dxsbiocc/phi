import type {
  PlanRunFinishedEvent,
  PlanRunState,
  PlanRunTimelineSnapshot
} from '../../../shared/planRunTypes'
import type { SessionEventInput, StoredSessionEvent } from '../session/session-store'

export interface PlanRunTimelineStoreDeps {
  timeline: {
    read(sessionId: string): readonly StoredSessionEvent[]
    append(sessionId: string, event: SessionEventInput): StoredSessionEvent
  }
  /** Bounded snapshot the renderer already knows how to draw in the transcript. */
  snapshot(state: PlanRunState): PlanRunTimelineSnapshot
}

export interface PlanRunTimelineStore {
  /**
   * Appends the finished-plan transcript card once per run. The kernel broadcasts the same
   * finish again after a reconnect, so the persisted run id, not the broadcast, is the receipt.
   */
  appendFinished(sessionId: string, event: PlanRunFinishedEvent): boolean
}

function eventRunId(event: StoredSessionEvent): string | undefined {
  if (event.type !== 'plan_run_finished') return undefined
  if (typeof event.runId === 'string' && event.runId) return event.runId
  const state = event.state
  return state !== null && typeof state === 'object' && !Array.isArray(state)
    ? ((state as { id?: unknown }).id as string | undefined)
    : undefined
}

export function createPlanRunTimelineStore(deps: PlanRunTimelineStoreDeps): PlanRunTimelineStore {
  return {
    appendFinished(sessionId, event) {
      const runId = event.runId || event.state.id
      if (!runId) return false
      if (deps.timeline.read(sessionId).some((stored) => eventRunId(stored) === runId)) {
        return false
      }
      deps.timeline.append(sessionId, {
        type: 'plan_run_finished',
        runId,
        state: deps.snapshot(event.state),
        createdAt: event.state.updatedAt
      })
      return true
    }
  }
}
