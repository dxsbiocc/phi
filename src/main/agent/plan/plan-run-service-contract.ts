import type { AgentRunCompletions } from './execution/agent-run-completions'
import type { PlanExecutorClock, PlanExecutorIds } from './execution/plan-executor'
import type { PlanSpecValidationResult } from './model/plan-spec'
import type {
  PlanRunFinishedEvent,
  PlanRunReplanRequest,
  PlanRunState,
  PlanSpec
} from '../../../shared/planRunTypes'

type Awaitable<T> = T | Promise<T>
type TimelineEvent = Record<string, unknown> & { type: string; runId: string }

export interface PlanRunServiceStore {
  write(state: PlanRunState): Awaitable<void>
  read(sessionId: string, runId: string): PlanRunState | null
  list(sessionId: string): PlanRunState[]
  listUnfinished(sessionId: string): PlanRunState[]
}

export interface PlanRunServiceDependencies<StoredEvent extends Record<string, unknown>> {
  engine: {
    agentRuns: {
      start(params: {
        sessionId: string
        agent?: string
        task: string
        requestId?: string
      }): Promise<{ runId: string }>
      stop(params: { sessionId: string; runId: string }): Promise<unknown>
    }
  }
  resolveRuntimeSessionId(phiSessionId: string): string | null
  requiresDurableLaunch?(phiSessionId: string): boolean
  enterReplanMode?(runtimeSessionId: string, requestId: string): Promise<unknown>
  exitReplanMode?(runtimeSessionId: string, requestId: string): Promise<boolean>
  timeline: {
    append(sessionId: string, event: TimelineEvent): StoredEvent
    broadcast(sessionId: string, event: StoredEvent, state: PlanRunState): void
  }
  continueConversation(sessionId: string, event: PlanRunFinishedEvent): void
  logError(error: unknown, metadata: { runId: string; source: string }): void
  completions?: AgentRunCompletions
  store?: PlanRunServiceStore
  clock?: PlanExecutorClock | (() => string)
  ids?: PlanExecutorIds | (() => string)
  maxConcurrent?: number
}

export interface ApprovedPlanStartGuard {
  expectedRuntimeSessionId: string
  assertCurrent(): void
  signal?: AbortSignal
}

export interface PlanRunService {
  startFromApprovedPlan(
    phiSessionId: string,
    spec: PlanSpec,
    guard?: ApprovedPlanStartGuard
  ): Promise<PlanRunState>
  hasActiveWork(phiSessionId: string): boolean
  list(phiSessionId: string): Promise<PlanRunState[]>
  get(phiSessionId: string, runId: string): Promise<PlanRunState | null>
  pause(phiSessionId: string, runId: string): Promise<PlanRunState>
  resume(phiSessionId: string, runId: string): Promise<PlanRunState>
  stop(phiSessionId: string, runId: string): Promise<PlanRunState>
  retryStep(phiSessionId: string, runId: string, stepId: string): Promise<PlanRunState>
  skipStep(phiSessionId: string, runId: string, stepId: string): Promise<PlanRunState>
  requestReplan(phiSessionId: string, runId: string): Promise<PlanRunReplanRequest>
  cancelRequestedReplan(phiSessionId: string, runId: string, requestId: string): Promise<void>
  pendingReplan(
    phiSessionId: string,
    runtimeSessionId: string
  ): { requestId: string; runId: string } | null
  pendingReplanForRun(
    phiSessionId: string,
    runId: string
  ): { requestId: string; runId: string } | null
  validateReplanProposal(
    phiSessionId: string,
    requestId: string,
    spec: unknown
  ): Promise<PlanSpecValidationResult>
  applyApprovedReplan(
    phiSessionId: string,
    runtimeSessionId: string,
    requestId: string,
    spec: PlanSpec
  ): Promise<PlanRunState>
  cancelReplan(phiSessionId: string, requestId: string): void
  recoverSession(phiSessionId: string): Promise<PlanRunState[]>
  /** Prevents new launches while the session runtime is shutting down. */
  suspendSession(phiSessionId: string): Promise<void>
  /** Marks running/launching steps interrupted before their children are cancelled. */
  interruptRunningSteps(phiSessionId: string): Promise<void>
  /** After recovery, releases unknown launches whose request is proven settled. */
  releaseSettledLaunches(
    phiSessionId: string,
    settled: (requestId: string) => boolean
  ): Promise<void>
}

export type { TimelineEvent }
