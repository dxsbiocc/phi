import type { PlanRunFinishedEvent } from '../../../shared/planRunTypes'
import {
  createPlanRunTimelineStore,
  type PlanRunTimelineStoreDeps
} from './plan-run-timeline-store'

export interface KernelPlanRunCompletionDeps extends PlanRunTimelineStoreDeps {
  continueConversation(phiSessionId: string, event: PlanRunFinishedEvent): void
  onPersistError?(error: unknown, phiSessionId: string, event: PlanRunFinishedEvent): void
}

export interface KernelPlanRunCompletion {
  /**
   * Persists the finished plan's transcript card and, only for a genuinely completed run,
   * wakes the conversation. Replayed finish events stay card-only and never wake twice.
   */
  handleFinished(phiSessionId: string, event: PlanRunFinishedEvent): boolean
}

export function createKernelPlanRunCompletion(
  deps: KernelPlanRunCompletionDeps
): KernelPlanRunCompletion {
  const store = createPlanRunTimelineStore(deps)
  return {
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
