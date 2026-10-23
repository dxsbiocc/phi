import type { PlanRunFinishedEvent } from '../../../shared/planRunTypes'
import { createPlanRunContinuation } from '../agents/run-continue'
import type { AppLogEntry } from '../app-logger'
import type { PhiEngine } from '../engine/types'
import { agentRunCompletions } from './execution/agent-run-completions'
import {
  registerPlanReviewHostService,
  type PlanReviewHostServiceDeps
} from './plan-review-host-service'
import { createPlanRunService, type PlanRunService } from './plan-run-service'

type TimelineEvent = Record<string, unknown> & { type: string }

/**
 * What plan execution needs from the app shell. Everything here is an existing
 * main-process function handed over as is; the composition lives below, so the
 * app entry point only makes one call.
 */
export interface PlanExecutionAppDeps<StoredEvent extends Record<string, unknown>> extends Omit<
  PlanReviewHostServiceDeps<StoredEvent>,
  'host' | 'planRuns' | 'appendSessionEvent'
> {
  engine: PhiEngine
  /** Records plan review and plan run events alike in the session timeline. */
  appendSessionEvent(sessionId: string, event: TimelineEvent): StoredEvent
  sessionKeys: {
    runtimeSessionIdForPhiSession(
      phiSessionId: string,
      isLive: (runtimeSessionId: string) => boolean
    ): string | undefined
  }
  automaticContinuationCount(phiSessionId: string): number
  wakeConversation(phiSessionId: string, event: PlanRunFinishedEvent): void
  writeAppLog(entry: AppLogEntry): void
  broadcastRunEvent(phiSessionId: string, event: StoredEvent): void
  logError(error: unknown): void
}

/** Creates the plan run service and registers the plan review host request that starts runs. */
export function wirePlanExecution<StoredEvent extends Record<string, unknown>>(
  deps: PlanExecutionAppDeps<StoredEvent>
): PlanRunService {
  const continueConversation = createPlanRunContinuation({
    automaticCount: deps.automaticContinuationCount,
    wakeConversation: deps.wakeConversation,
    onLimit: (phiSessionId, runId) =>
      deps.writeAppLog({
        event: 'plan_run_continue_limit',
        metadata: { phiSessionId, planRunId: runId }
      })
  })
  const planRuns = createPlanRunService({
    engine: deps.engine,
    completions: agentRunCompletions,
    // Only a runtime that is still running can take new plan steps.
    resolveRuntimeSessionId: (phiSessionId) =>
      deps.sessionKeys.runtimeSessionIdForPhiSession(phiSessionId, (id) =>
        deps.engine.sessions.has(id)
      ) ?? null,
    timeline: { append: deps.appendSessionEvent, broadcast: deps.broadcastRunEvent },
    continueConversation,
    logError: deps.logError
  })
  registerPlanReviewHostService({ ...deps, host: deps.engine.host, planRuns })
  return planRuns
}
