import { randomUUID } from 'node:crypto'

import type {
  PlanRunFinishedEvent,
  PlanRunReplanRequest,
  PlanRunState,
  PlanRunTimelineSnapshot,
  PlanRunTimelineStepSnapshot,
  PlanSpec,
  PlanStep
} from '../../../shared/planRunTypes'
import { PLAN_MAX_REPLANS } from '../../../shared/planRunTypes'
import { agentRunCompletions } from './execution/agent-run-completions'
import { createEngineStepRunner } from './execution/engine-step-runner'
import {
  createPlanExecutor,
  type PlanExecutor,
  type PlanExecutorEvent
} from './execution/plan-executor'
import { reducePlanRun } from './model/plan-run-state'
import { validatePlanSpec, type PlanSpecValidationResult } from './model/plan-spec'
import type {
  ApprovedPlanStartGuard,
  PlanRunService,
  PlanRunServiceDependencies,
  PlanRunServiceStore,
  TimelineEvent
} from './plan-run-service-contract'
import { replanPrompt } from './replan-prompt'
import {
  listPlanRuns,
  listUnfinishedPlanRuns,
  readPlanRun,
  writePlanRun
} from './persistence/plan-run-store'

export type {
  ApprovedPlanStartGuard,
  PlanRunService,
  PlanRunServiceDependencies,
  PlanRunServiceStore
} from './plan-run-service-contract'

interface PendingReplan {
  requestId: string
  runId: string
  runtimeSessionId: string
  entered: boolean
  applying: boolean
  cancelling: boolean
}

function isFullyPaused(state: PlanRunState): boolean {
  return (
    state.status === 'paused' &&
    !Object.values(state.steps).some((step) =>
      ['running', 'launching', 'unknown'].includes(step.status)
    )
  )
}

const defaultStore: PlanRunServiceStore = {
  write: writePlanRun,
  read: readPlanRun,
  list: listPlanRuns,
  listUnfinished: listUnfinishedPlanRuns
}

const TIMELINE_MAX_BYTES = 16 * 1024
const TIMELINE_ENVELOPE_RESERVE_BYTES = 512
const TIMELINE_PAYLOAD_MAX_BYTES = TIMELINE_MAX_BYTES - TIMELINE_ENVELOPE_RESERVE_BYTES
const TIMELINE_TEXT_MAX_CHARACTERS = 500
const TIMELINE_STEP_COMPACTION_LIMITS = [256, 128, 64, 32, 16, 8, 4, 1, 0] as const
const RUNTIME_UNAVAILABLE_MESSAGE =
  'The conversation runtime is not running; open the conversation to continue the plan.'

function stateFingerprint(state: PlanRunState): string {
  return JSON.stringify([
    state.status,
    state.spec.steps.map((step) => [step.id, state.steps[step.id]?.status])
  ])
}

function truncateCharacters(value: string, maxCharacters: number): string {
  const characters = Array.from(value)
  return characters.length <= maxCharacters ? value : characters.slice(0, maxCharacters).join('')
}

function timelineStepSnapshot(state: PlanRunState, step: PlanStep): PlanRunTimelineStepSnapshot {
  const result = state.steps[step.id]!
  return {
    id: step.id,
    title: step.title,
    access: step.access,
    dependsOn: [...step.dependsOn],
    ...(step.agent ? { agent: step.agent } : {}),
    status: result.status,
    attempts: result.attempts,
    ...(result.agentRunId ? { agentRunId: result.agentRunId } : {}),
    ...(result.startedAt ? { startedAt: result.startedAt } : {}),
    ...(result.finishedAt ? { finishedAt: result.finishedAt } : {}),
    ...(result.report ? { reportStatus: result.report.status } : {}),
    missingInputs: [...(result.report?.missingInputs ?? [])],
    ...(result.error
      ? { error: truncateCharacters(result.error, TIMELINE_TEXT_MAX_CHARACTERS) }
      : {})
  }
}

export function planRunTimelineSnapshot(state: PlanRunState): PlanRunTimelineSnapshot {
  return {
    id: state.id,
    status: state.status,
    ...(state.pause ? { pause: { ...state.pause } } : {}),
    replans: state.replans,
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    goal: truncateCharacters(state.spec.goal, TIMELINE_TEXT_MAX_CHARACTERS),
    steps: state.spec.steps.map((step) => timelineStepSnapshot(state, step))
  }
}

function compactTimelineStep(
  step: PlanRunTimelineStepSnapshot,
  maxCharacters: number
): PlanRunTimelineStepSnapshot {
  const maxMissingInputs = maxCharacters === 0 ? 0 : Math.max(1, Math.floor(maxCharacters / 32))
  return {
    ...step,
    title: truncateCharacters(step.title, maxCharacters),
    ...(step.agent === undefined ? {} : { agent: truncateCharacters(step.agent, maxCharacters) }),
    ...(step.agentRunId === undefined
      ? {}
      : { agentRunId: truncateCharacters(step.agentRunId, maxCharacters) }),
    missingInputs: step.missingInputs
      .slice(0, maxMissingInputs)
      .map((value) => truncateCharacters(value, maxCharacters)),
    ...(step.error === undefined ? {} : { error: truncateCharacters(step.error, maxCharacters) })
  }
}

function eventBytes(event: TimelineEvent): number {
  return Buffer.byteLength(JSON.stringify(event), 'utf8')
}

function snapshotEvent(type: string, state: PlanRunState): TimelineEvent {
  const snapshot = planRunTimelineSnapshot(state)
  const event = { type, runId: state.id, state: snapshot }
  if (eventBytes(event) <= TIMELINE_PAYLOAD_MAX_BYTES) return event
  for (const limit of TIMELINE_STEP_COMPACTION_LIMITS) {
    const compacted = {
      ...event,
      state: { ...snapshot, steps: snapshot.steps.map((step) => compactTimelineStep(step, limit)) }
    }
    if (eventBytes(compacted) <= TIMELINE_PAYLOAD_MAX_BYTES) return compacted
  }
  throw new Error(`Plan run ${state.id} exceeds the timeline snapshot limit`)
}

function emitTimeline<StoredEvent extends Record<string, unknown>>(
  deps: PlanRunServiceDependencies<StoredEvent>,
  type: string,
  state: PlanRunState
): void {
  const stored = deps.timeline.append(state.sessionId, snapshotEvent(type, state))
  deps.timeline.broadcast(state.sessionId, stored, state)
}

function reportServiceError<StoredEvent extends Record<string, unknown>>(
  deps: PlanRunServiceDependencies<StoredEvent>,
  runId: string,
  source: string,
  error: unknown
): void {
  try {
    deps.logError(error, { runId, source })
  } catch {
    // Logging is best-effort and must not stop deterministic plan execution.
  }
}

function planExecutorEvents<StoredEvent extends Record<string, unknown>>(
  deps: PlanRunServiceDependencies<StoredEvent>
): { emit(event: PlanExecutorEvent): void; prime(state: PlanRunState): void } {
  const fingerprints = new Map<string, string>()
  return {
    prime(state) {
      fingerprints.set(state.id, stateFingerprint(state))
    },
    emit(event) {
      if (event.type === 'executor_error') {
        reportServiceError(deps, event.runId, 'executor', event.error)
        return
      }
      if (event.type === 'state_changed') {
        const fingerprint = stateFingerprint(event.state)
        if (fingerprints.get(event.state.id) === fingerprint) return
        fingerprints.set(event.state.id, fingerprint)
        try {
          emitTimeline(deps, 'plan_run_updated', event.state)
          // A stopped run ends here: the executor reports run_finished only for completed
          // runs. Record the ending, but the user stopped it, so the agent is not woken.
          if (event.state.status === 'stopped') {
            emitTimeline(deps, 'plan_run_finished', event.state)
          }
        } catch (error) {
          reportServiceError(deps, event.state.id, 'timeline_update', error)
        }
        return
      }
      const finished: PlanRunFinishedEvent = {
        type: 'plan_run_finished',
        runId: event.state.id,
        state: event.state
      }
      try {
        emitTimeline(deps, finished.type, event.state)
      } catch (error) {
        reportServiceError(deps, event.state.id, 'timeline_finish', error)
      }
      try {
        deps.continueConversation(event.state.sessionId, finished)
      } catch (error) {
        reportServiceError(deps, event.state.id, 'continuation', error)
      }
    }
  }
}

class PlanRunServiceImplementation<
  StoredEvent extends Record<string, unknown>
> implements PlanRunService {
  private readonly recoveredSessions = new Set<string>()
  private readonly recoveries = new Map<string, Promise<PlanRunState[]>>()
  private readonly replanRequests = new Map<string, PendingReplan>()
  private readonly replanAdmissions = new Set<string>()
  private readonly activeMutations = new Map<string, number>()

  constructor(
    private readonly executor: PlanExecutor,
    private readonly deps: PlanRunServiceDependencies<StoredEvent>,
    private readonly store: PlanRunServiceStore,
    private readonly primeTimelineState: (state: PlanRunState) => void
  ) {}

  private async requireActive(phiSessionId: string, runId: string): Promise<PlanRunState> {
    await this.recoverSession(phiSessionId)
    const active = this.executor.get(runId)
    if (active?.sessionId === phiSessionId) return active
    const stored = this.store.read(phiSessionId, runId)
    if (!stored) throw new Error(`Plan run not found: ${runId}`)
    throw new Error(`Plan run is already ${stored.status}: ${runId}`)
  }

  async startFromApprovedPlan(
    phiSessionId: string,
    spec: PlanSpec,
    guard?: ApprovedPlanStartGuard
  ): Promise<PlanRunState> {
    await this.recoverSession(phiSessionId)
    const assertCurrent = (): void => {
      if (guard?.signal?.aborted) throw new Error('Plan review is no longer active.')
      guard?.assertCurrent()
      const runtimeSessionId = this.deps.resolveRuntimeSessionId(phiSessionId)
      if (!runtimeSessionId || (guard && runtimeSessionId !== guard.expectedRuntimeSessionId)) {
        throw new Error(RUNTIME_UNAVAILABLE_MESSAGE)
      }
    }
    assertCurrent()
    return this.executor.start(spec, phiSessionId, assertCurrent)
  }

  hasActiveWork(phiSessionId: string): boolean {
    return this.store
      .list(phiSessionId)
      .some(
        (state) =>
          state.status === 'running' ||
          Object.values(state.steps).some(
            (step) =>
              step.status === 'running' || step.status === 'launching' || step.status === 'unknown'
          )
      )
  }

  async list(phiSessionId: string): Promise<PlanRunState[]> {
    await this.recoverSession(phiSessionId)
    return this.store
      .list(phiSessionId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  }

  async get(phiSessionId: string, runId: string): Promise<PlanRunState | null> {
    await this.recoverSession(phiSessionId)
    const active = this.executor.get(runId)
    return active?.sessionId === phiSessionId ? active : this.store.read(phiSessionId, runId)
  }

  private assertNoReplanMutation(phiSessionId: string, runId: string): void {
    if (
      this.replanAdmissions.has(phiSessionId) ||
      this.replanRequests.get(phiSessionId)?.runId === runId
    ) {
      throw new Error('A replan is in progress for this plan run.')
    }
  }

  private async mutateRun(
    phiSessionId: string,
    runId: string,
    action: () => Promise<PlanRunState>
  ): Promise<PlanRunState> {
    this.assertNoReplanMutation(phiSessionId, runId)
    this.activeMutations.set(phiSessionId, (this.activeMutations.get(phiSessionId) ?? 0) + 1)
    try {
      await this.requireActive(phiSessionId, runId)
      this.assertNoReplanMutation(phiSessionId, runId)
      return await action()
    } finally {
      const remaining = (this.activeMutations.get(phiSessionId) ?? 1) - 1
      if (remaining) this.activeMutations.set(phiSessionId, remaining)
      else this.activeMutations.delete(phiSessionId)
    }
  }

  pause(phiSessionId: string, runId: string): Promise<PlanRunState> {
    return this.mutateRun(phiSessionId, runId, () => this.executor.pause(runId))
  }

  resume(phiSessionId: string, runId: string): Promise<PlanRunState> {
    return this.mutateRun(phiSessionId, runId, () => this.executor.resume(runId))
  }

  async stop(phiSessionId: string, runId: string): Promise<PlanRunState> {
    await this.dropReplanForStop(phiSessionId, runId)
    return this.mutateRun(phiSessionId, runId, () => this.executor.stop(runId))
  }

  /**
   * Stopping a plan ends any replan still being drafted for it. The request is dropped even if
   * the conversation cannot leave replan mode, since a proposal for a stopped run fails anyway.
   */
  private async dropReplanForStop(phiSessionId: string, runId: string): Promise<void> {
    const request = this.replanRequests.get(phiSessionId)
    if (!request || request.runId !== runId) return
    if (request.applying) throw new Error('Approved plan replacement is already in progress.')
    if (
      request.entered &&
      this.deps.exitReplanMode &&
      this.deps.resolveRuntimeSessionId(phiSessionId) === request.runtimeSessionId
    ) {
      await this.deps.exitReplanMode(request.runtimeSessionId, request.requestId).catch(() => false)
    }
    if (this.replanRequests.get(phiSessionId) === request) this.replanRequests.delete(phiSessionId)
  }

  retryStep(phiSessionId: string, runId: string, stepId: string): Promise<PlanRunState> {
    return this.mutateRun(phiSessionId, runId, () => this.executor.retryStep(runId, stepId))
  }

  skipStep(phiSessionId: string, runId: string, stepId: string): Promise<PlanRunState> {
    return this.mutateRun(phiSessionId, runId, () => this.executor.skipStep(runId, stepId))
  }

  private async reuseOrClearReplan(
    phiSessionId: string,
    runtimeSessionId: string,
    state: PlanRunState
  ): Promise<PlanRunReplanRequest | null> {
    const existing = this.replanRequests.get(phiSessionId)
    if (!existing) return null
    if (existing.applying) throw new Error('Approved plan replacement is already in progress.')
    if (existing.runtimeSessionId !== runtimeSessionId) {
      // The old runtime no longer owns this Phi session. Its request cannot pass
      // the runtime identity check at approval, so an absent old worker cannot block a new one.
      this.replanRequests.delete(phiSessionId)
    } else if (
      existing.runId === state.id &&
      existing.entered &&
      !existing.applying &&
      !existing.cancelling
    ) {
      return { requestId: existing.requestId, runId: state.id, prompt: replanPrompt(state) }
    } else {
      throw new Error('A replan is already in progress.')
    }
    if (this.replanRequests.has(phiSessionId)) throw new Error('A replan is already in progress.')
    return null
  }

  private async rollbackEnteredReplan(phiSessionId: string, request: PendingReplan): Promise<void> {
    if (this.replanRequests.get(phiSessionId) !== request) return
    if (!request.entered) {
      this.replanRequests.delete(phiSessionId)
      return
    }
    if (!this.deps.exitReplanMode) return
    try {
      if (await this.deps.exitReplanMode(request.runtimeSessionId, request.requestId)) {
        this.replanRequests.delete(phiSessionId)
      }
    } catch {
      // Keep the binding so a later request can retry exact rollback.
    }
  }

  async requestReplan(phiSessionId: string, runId: string): Promise<PlanRunReplanRequest> {
    if (this.replanAdmissions.has(phiSessionId) || this.activeMutations.has(phiSessionId)) {
      throw new Error('A plan run operation is already in progress.')
    }
    this.replanAdmissions.add(phiSessionId)
    try {
      const state = await this.requireActive(phiSessionId, runId)
      if (!isFullyPaused(state)) {
        throw new Error('The plan must be fully paused before replanning.')
      }
      if (state.replans >= PLAN_MAX_REPLANS) throw new Error('Plan replan limit has been reached.')
      const runtimeSessionId = this.deps.resolveRuntimeSessionId(phiSessionId)
      if (!runtimeSessionId) throw new Error(RUNTIME_UNAVAILABLE_MESSAGE)
      if (!this.deps.enterReplanMode) throw new Error('Plan replan mode is unavailable.')
      const reused = await this.reuseOrClearReplan(phiSessionId, runtimeSessionId, state)
      if (reused) return reused
      const current = this.executor.get(runId)
      if (!current || current.sessionId !== phiSessionId || !isFullyPaused(current)) {
        throw new Error('The plan must be fully paused before replanning.')
      }
      const request: PendingReplan = {
        requestId: randomUUID(),
        runId,
        runtimeSessionId,
        entered: false,
        applying: false,
        cancelling: false
      }
      this.replanRequests.set(phiSessionId, request)
      try {
        await this.deps.enterReplanMode(runtimeSessionId, request.requestId)
        request.entered = true
        if (this.replanRequests.get(phiSessionId) !== request) {
          throw new Error('Plan replan request was cancelled.')
        }
        if (this.deps.resolveRuntimeSessionId(phiSessionId) !== runtimeSessionId) {
          throw new Error(RUNTIME_UNAVAILABLE_MESSAGE)
        }
        return { requestId: request.requestId, runId, prompt: replanPrompt(state) }
      } catch (error) {
        await this.rollbackEnteredReplan(phiSessionId, request)
        throw error
      }
    } finally {
      this.replanAdmissions.delete(phiSessionId)
    }
  }

  pendingReplanForRun(
    phiSessionId: string,
    runId: string
  ): { requestId: string; runId: string } | null {
    const request = this.replanRequests.get(phiSessionId)
    return request?.runId === runId ? { requestId: request.requestId, runId: request.runId } : null
  }

  pendingReplan(
    phiSessionId: string,
    runtimeSessionId: string
  ): { requestId: string; runId: string } | null {
    const request = this.replanRequests.get(phiSessionId)
    return request?.runtimeSessionId === runtimeSessionId && !request.cancelling
      ? { requestId: request.requestId, runId: request.runId }
      : null
  }

  async cancelRequestedReplan(
    phiSessionId: string,
    runId: string,
    requestId: string
  ): Promise<void> {
    const request = this.replanRequests.get(phiSessionId)
    if (!request || request.runId !== runId || request.requestId !== requestId) return
    if (request.applying) throw new Error('Approved plan replacement is already in progress.')
    if (request.cancelling) return
    request.cancelling = true
    try {
      if (this.deps.resolveRuntimeSessionId(phiSessionId) !== request.runtimeSessionId) {
        this.replanRequests.delete(phiSessionId)
        return
      }
      if (!this.deps.exitReplanMode) throw new Error('Plan replan mode cannot be cancelled.')
      const exited = await this.deps.exitReplanMode(request.runtimeSessionId, requestId)
      if (!exited) throw new Error('Plan replan mode is already active in a conversation.')
      if (this.replanRequests.get(phiSessionId) === request)
        this.replanRequests.delete(phiSessionId)
    } finally {
      request.cancelling = false
    }
  }

  async validateReplanProposal(
    phiSessionId: string,
    requestId: string,
    spec: unknown
  ): Promise<PlanSpecValidationResult> {
    const request = this.replanRequests.get(phiSessionId)
    if (!request || request.requestId !== requestId || request.cancelling) {
      return { ok: false, errors: ['Plan replan request is no longer active.'] }
    }
    const result = validatePlanSpec(spec)
    if (!result.ok) return result
    try {
      const state = await this.requireActive(phiSessionId, request.runId)
      reducePlanRun(state, {
        type: 'replace_remaining_steps',
        spec: result.spec,
        at: new Date().toISOString()
      })
      return result
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)] }
    }
  }

  private async recoverCommittedReplacement(
    phiSessionId: string,
    request: PendingReplan,
    previousReplans: number,
    error: unknown
  ): Promise<PlanRunState> {
    const current = this.executor.get(request.runId)
    if (!current || current.replans === previousReplans) throw error
    // Replacement persisted before becoming active in memory. A later event
    // failure must keep the already approved plan and pause further scheduling.
    this.replanRequests.delete(phiSessionId)
    reportServiceError(this.deps, request.runId, 'replan_persist', error)
    if (current.status !== 'running') return current
    try {
      return await this.executor.pause(request.runId)
    } catch (pauseError) {
      reportServiceError(this.deps, request.runId, 'replan_pause', pauseError)
      return this.executor.get(request.runId) ?? current
    }
  }

  async applyApprovedReplan(
    phiSessionId: string,
    runtimeSessionId: string,
    requestId: string,
    spec: PlanSpec
  ): Promise<PlanRunState> {
    const request = this.replanRequests.get(phiSessionId)
    if (
      !request ||
      request.requestId !== requestId ||
      request.runtimeSessionId !== runtimeSessionId ||
      request.applying ||
      request.cancelling
    ) {
      throw new Error('Plan replan request is no longer active for this conversation.')
    }
    request.applying = true
    try {
      await this.requireActive(phiSessionId, request.runId)
      if (this.deps.resolveRuntimeSessionId(phiSessionId) !== runtimeSessionId) {
        throw new Error(RUNTIME_UNAVAILABLE_MESSAGE)
      }
      const validation = await this.validateReplanProposal(phiSessionId, requestId, spec)
      if (!validation.ok) throw new Error(validation.errors.join(' '))
      if (
        this.replanRequests.get(phiSessionId) !== request ||
        this.deps.resolveRuntimeSessionId(phiSessionId) !== runtimeSessionId
      ) {
        throw new Error('Plan replan request is no longer active for this conversation.')
      }
      const before = this.executor.get(request.runId)!
      try {
        const replaced = await this.executor.replaceRemainingSteps(request.runId, validation.spec)
        this.replanRequests.delete(phiSessionId)
        return replaced
      } catch (error) {
        return this.recoverCommittedReplacement(phiSessionId, request, before.replans, error)
      }
    } finally {
      request.applying = false
    }
  }

  cancelReplan(phiSessionId: string, requestId: string): void {
    if (this.replanRequests.get(phiSessionId)?.requestId === requestId) {
      this.replanRequests.delete(phiSessionId)
    }
  }

  async recoverSession(phiSessionId: string): Promise<PlanRunState[]> {
    if (this.recoveredSessions.has(phiSessionId)) return this.store.listUnfinished(phiSessionId)
    const pending = this.recoveries.get(phiSessionId)
    if (pending) return pending
    const recovery = this.recover(phiSessionId)
    this.recoveries.set(phiSessionId, recovery)
    try {
      const states = await recovery
      this.recoveredSessions.add(phiSessionId)
      return states
    } finally {
      this.recoveries.delete(phiSessionId)
    }
  }

  async suspendSession(phiSessionId: string): Promise<void> {
    await this.executor.suspendSession(phiSessionId)
  }

  async interruptRunningSteps(phiSessionId: string): Promise<void> {
    await this.executor.interruptRunningSteps(phiSessionId)
  }

  async releaseSettledLaunches(
    phiSessionId: string,
    settled: (requestId: string) => boolean
  ): Promise<void> {
    for (const state of await this.recoverSession(phiSessionId)) {
      for (const [stepId, step] of Object.entries(state.steps)) {
        if (step.status !== 'unknown' || !step.requestId || !settled(step.requestId)) continue
        await this.executor.confirmLaunchQuiescent(state.id, stepId, step.requestId)
      }
    }
  }

  private async recover(phiSessionId: string): Promise<PlanRunState[]> {
    const recovered: PlanRunState[] = []
    for (const state of this.store.listUnfinished(phiSessionId)) {
      const existing = this.executor.get(state.id)
      if (existing) recovered.push(existing)
      else {
        this.primeTimelineState(state)
        recovered.push(await this.executor.recover(state))
      }
    }
    return recovered
  }
}

export function createPlanRunService<StoredEvent extends Record<string, unknown>>(
  deps: PlanRunServiceDependencies<StoredEvent>
): PlanRunService {
  const store = deps.store ?? defaultStore
  const completions = deps.completions ?? agentRunCompletions
  const resolveRuntimeSessionId = (phiSessionId: string): string | null => {
    const current = deps.resolveRuntimeSessionId(phiSessionId)
    if (!current) throw new Error(RUNTIME_UNAVAILABLE_MESSAGE)
    return current
  }
  const events = planExecutorEvents(deps)
  const runner = createEngineStepRunner({
    engine: deps.engine,
    completions,
    resolveRuntimeSessionId
  })
  const executor = createPlanExecutor({
    runner,
    store,
    events,
    clock: deps.clock ?? (() => new Date().toISOString()),
    ids: deps.ids ?? randomUUID,
    ...(deps.requiresDurableLaunch ? { requiresDurableLaunch: deps.requiresDurableLaunch } : {}),
    ...(deps.maxConcurrent === undefined ? {} : { maxConcurrent: deps.maxConcurrent })
  })
  return new PlanRunServiceImplementation(executor, deps, store, events.prime)
}
