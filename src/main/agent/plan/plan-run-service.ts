import { randomUUID } from 'node:crypto'

import type {
  PlanRunFinishedEvent,
  PlanRunState,
  PlanRunTimelineSnapshot,
  PlanRunTimelineStepSnapshot,
  PlanSpec,
  PlanStep
} from '../../../shared/planRunTypes'
import { agentRunCompletions, type AgentRunCompletions } from './execution/agent-run-completions'
import { createEngineStepRunner } from './execution/engine-step-runner'
import {
  createPlanExecutor,
  type PlanExecutor,
  type PlanExecutorClock,
  type PlanExecutorEvent,
  type PlanExecutorIds
} from './execution/plan-executor'
import {
  listPlanRuns,
  listUnfinishedPlanRuns,
  readPlanRun,
  writePlanRun
} from './persistence/plan-run-store'

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
      start(params: { sessionId: string; agent?: string; task: string }): Promise<{ runId: string }>
      stop(params: { sessionId: string; runId: string }): Promise<unknown>
    }
  }
  resolveRuntimeSessionId(phiSessionId: string): string | null
  timeline: {
    append(sessionId: string, event: TimelineEvent): StoredEvent
    broadcast(sessionId: string, event: StoredEvent): void
  }
  continueConversation(sessionId: string, event: PlanRunFinishedEvent): void
  logError(error: unknown, metadata: { runId: string; source: string }): void
  completions?: AgentRunCompletions
  store?: PlanRunServiceStore
  clock?: PlanExecutorClock | (() => string)
  ids?: PlanExecutorIds | (() => string)
  maxConcurrent?: number
}

export interface PlanRunService {
  startFromApprovedPlan(phiSessionId: string, spec: PlanSpec): Promise<PlanRunState>
  list(phiSessionId: string): Promise<PlanRunState[]>
  get(phiSessionId: string, runId: string): Promise<PlanRunState | null>
  pause(phiSessionId: string, runId: string): Promise<PlanRunState>
  resume(phiSessionId: string, runId: string): Promise<PlanRunState>
  stop(phiSessionId: string, runId: string): Promise<PlanRunState>
  retryStep(phiSessionId: string, runId: string, stepId: string): Promise<PlanRunState>
  skipStep(phiSessionId: string, runId: string, stepId: string): Promise<PlanRunState>
  recoverSession(phiSessionId: string): Promise<PlanRunState[]>
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

function timelineSnapshot(state: PlanRunState): PlanRunTimelineSnapshot {
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
  const snapshot = timelineSnapshot(state)
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
  deps.timeline.broadcast(state.sessionId, stored)
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

  async startFromApprovedPlan(phiSessionId: string, spec: PlanSpec): Promise<PlanRunState> {
    await this.recoverSession(phiSessionId)
    if (!this.deps.resolveRuntimeSessionId(phiSessionId)) {
      throw new Error(RUNTIME_UNAVAILABLE_MESSAGE)
    }
    return this.executor.start(spec, phiSessionId)
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

  async pause(phiSessionId: string, runId: string): Promise<PlanRunState> {
    await this.requireActive(phiSessionId, runId)
    return this.executor.pause(runId)
  }

  async resume(phiSessionId: string, runId: string): Promise<PlanRunState> {
    await this.requireActive(phiSessionId, runId)
    return this.executor.resume(runId)
  }

  async stop(phiSessionId: string, runId: string): Promise<PlanRunState> {
    await this.requireActive(phiSessionId, runId)
    return this.executor.stop(runId)
  }

  async retryStep(phiSessionId: string, runId: string, stepId: string): Promise<PlanRunState> {
    await this.requireActive(phiSessionId, runId)
    return this.executor.retryStep(runId, stepId)
  }

  async skipStep(phiSessionId: string, runId: string, stepId: string): Promise<PlanRunState> {
    await this.requireActive(phiSessionId, runId)
    return this.executor.skipStep(runId, stepId)
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
    ...(deps.maxConcurrent === undefined ? {} : { maxConcurrent: deps.maxConcurrent })
  })
  return new PlanRunServiceImplementation(executor, deps, store, events.prime)
}
