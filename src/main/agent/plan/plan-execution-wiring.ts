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
import type { WorkModeActivity } from './work-mode-control'
import { registerWorkModeSelectionHost } from './work-mode-selection-host'

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

interface PlanExecutionSessionKeys {
  runtimeSessionIdForPhiSession(
    phiSessionId: string,
    isLive: (runtimeSessionId: string) => boolean
  ): string | undefined
}

function liveRuntimeSessionId(
  engine: PhiEngine,
  sessionKeys: PlanExecutionSessionKeys,
  phiSessionId: string
): string | undefined {
  return sessionKeys.runtimeSessionIdForPhiSession(phiSessionId, (id) => engine.sessions.has(id))
}

function isActiveBackgroundAgentRun(value: unknown, runtimeSessionId: string): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const run = value as Record<string, unknown>
  return (
    run.agentSessionId === runtimeSessionId && (run.state === 'queued' || run.state === 'running')
  )
}

export function createWorkModeActivity(deps: {
  engine: PhiEngine
  planRuns: Pick<PlanRunService, 'hasActiveWork'>
  sessionKeys: PlanExecutionSessionKeys
}): WorkModeActivity {
  return {
    hasActivePlanWork: (phiSessionId) => deps.planRuns.hasActiveWork(phiSessionId),
    hasActiveAgentRuns: async (phiSessionId) => {
      const runtimeSessionId = liveRuntimeSessionId(deps.engine, deps.sessionKeys, phiSessionId)
      if (!runtimeSessionId) return false
      const runs = await deps.engine.agentRuns.list({})
      return Array.isArray(runs)
        ? runs.some((run) => isActiveBackgroundAgentRun(run, runtimeSessionId))
        : false
    }
  }
}

export interface PlanExecutionWiring {
  planRuns: PlanRunService
  workModeActivity: WorkModeActivity
}

/** Creates the plan run service and registers the plan review host request that starts runs. */
export function wirePlanExecution<StoredEvent extends Record<string, unknown>>(
  deps: PlanExecutionAppDeps<StoredEvent>
): PlanExecutionWiring {
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
      liveRuntimeSessionId(deps.engine, deps.sessionKeys, phiSessionId) ?? null,
    timeline: { append: deps.appendSessionEvent, broadcast: deps.broadcastRunEvent },
    continueConversation,
    logError: deps.logError
  })
  registerPlanReviewHostService({ ...deps, host: deps.engine.host, planRuns })
  registerWorkModeSelectionHost({ ...deps, host: deps.engine.host })
  return {
    planRuns,
    workModeActivity: createWorkModeActivity({
      engine: deps.engine,
      planRuns,
      sessionKeys: deps.sessionKeys
    })
  }
}
