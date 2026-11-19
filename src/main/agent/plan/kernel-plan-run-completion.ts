import type { PlanRunFinishedEvent, ResearchPlanPausedEvent } from '../../../shared/planRunTypes'
import {
  createPlanRunTimelineStore,
  type PlanRunTimelineStoreDeps
} from './plan-run-timeline-store'

export interface KernelPlanRunCompletionDeps extends PlanRunTimelineStoreDeps {
  continueConversation(phiSessionId: string, event: PlanRunFinishedEvent): void
  onPersistError?(
    error: unknown,
    phiSessionId: string,
    event: PlanRunFinishedEvent | ResearchPlanPausedEvent
  ): void
}

export interface KernelPlanRunCompletion {
  /**
   * Persists the finished plan's transcript card and, only for a genuinely completed run,
   * wakes the conversation. Replayed finish events stay card-only and never wake twice.
   */
  handleFinished(phiSessionId: string, event: PlanRunFinishedEvent): boolean
  /** Claim only immediately before dispatch, so a restart can recover an undelivered queued notice. */
  claimResearchPause(phiSessionId: string, event: ResearchPlanPausedEvent): boolean
  releaseResearchPause(phiSessionId: string, event: ResearchPlanPausedEvent): void
  dismissResearchPause(phiSessionId: string, event: ResearchPlanPausedEvent): void
}

export function createKernelPlanRunCompletion(
  deps: KernelPlanRunCompletionDeps
): KernelPlanRunCompletion {
  const store = createPlanRunTimelineStore(deps)
  const pending = new Set<string>()
  function claimId(sessionId: string, event: ResearchPlanPausedEvent): string {
    return JSON.stringify([sessionId, event.runId, event.stepId, event.attempt])
  }
  return {
    claimResearchPause(phiSessionId, event) {
      try {
        const id = claimId(phiSessionId, event)
        if (pending.has(id) || store.hasResearchPauseReceipt(phiSessionId, event)) return false
        pending.add(id)
        return true
      } catch (error) {
        deps.onPersistError?.(error, phiSessionId, event)
        return false
      }
    },
    releaseResearchPause(phiSessionId, event) {
      pending.delete(claimId(phiSessionId, event))
    },
    dismissResearchPause(phiSessionId, event) {
      try {
        store.dismissResearchPause(phiSessionId, event)
      } catch (error) {
        deps.onPersistError?.(error, phiSessionId, event)
      }
    },
    handleFinished(phiSessionId, event) {
      let recorded = false
      try {
        recorded = store.appendFinished(phiSessionId, event)
      } catch (error) {
        deps.onPersistError?.(error, phiSessionId, event)
        return false
      }
      // A user-stopped plan still gets its transcript card, but nothing new to summarize.
      if (recorded && event.state.status === 'completed') {
        deps.continueConversation(phiSessionId, event)
      }
      return recorded
    }
  }
}
