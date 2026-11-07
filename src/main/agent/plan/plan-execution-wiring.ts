import type { PlanRunState } from '../../../shared/planRunTypes'
import type { RoutedPlanRunOperations } from '../engine/session-routing-engine'
import type { PhiEngine } from '../engine/types'
import {
  registerPlanReviewHostService,
  type PlanReviewHostServiceDeps
} from './plan-review-host-service'
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
  'host' | 'appendSessionEvent'
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
}

interface PlanExecutionSessionKeys {
  runtimeSessionIdForPhiSession(
    phiSessionId: string,
    isLive: (runtimeSessionId: string) => boolean
  ): string | undefined
}

function routedPlanRunsForPhiSession(
  engine: PhiEngine,
  phiSessionId: string
): RoutedPlanRunOperations | undefined {
  const routed = engine as PhiEngine & {
    planRunsForPhiSession?(sessionId: string): RoutedPlanRunOperations | undefined
  }
  return routed.planRunsForPhiSession?.(phiSessionId)
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
  sessionKeys: PlanExecutionSessionKeys
}): WorkModeActivity {
  return {
    hasActivePlanWork: async (phiSessionId) => {
      const planRuns = routedPlanRunsForPhiSession(deps.engine, phiSessionId)
      if (!planRuns) return false
      return (await planRuns.list()).some(hasActivePlanWork)
    },
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
  workModeActivity: WorkModeActivity
}

/** Plan-run IPC resolves exclusively through the live kernel session owner. */
export function kernelPlanRunRouting(engine: () => PhiEngine): {
  kernelPlanRuns(phiSessionId: string): RoutedPlanRunOperations | undefined
} {
  return {
    kernelPlanRuns: (phiSessionId) => routedPlanRunsForPhiSession(engine(), phiSessionId)
  }
}

function hasActivePlanWork(state: PlanRunState): boolean {
  return (
    state.status === 'running' ||
    Object.values(state.steps).some(
      (step) =>
        step.status === 'running' || step.status === 'launching' || step.status === 'unknown'
    )
  )
}

/** Registers the desktop review UI and work-mode bridge for kernel-owned plan runs. */
export function wirePlanExecution<StoredEvent extends Record<string, unknown>>(
  deps: PlanExecutionAppDeps<StoredEvent>
): PlanExecutionWiring {
  registerPlanReviewHostService({ ...deps, host: deps.engine.host })
  registerWorkModeSelectionHost({ ...deps, host: deps.engine.host })
  return {
    workModeActivity: createWorkModeActivity({
      engine: deps.engine,
      sessionKeys: deps.sessionKeys
    })
  }
}
