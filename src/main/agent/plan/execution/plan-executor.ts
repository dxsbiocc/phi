import type { AgentReport } from '../../agents/report'
import type { PlanRunState, PlanSpec, PlanStepReportSummary } from '../../../../shared/planRunTypes'
import { createPlanRunState, reducePlanRun, type PlanRunEvent } from '../model/plan-run-state'
import { validatePlanSpec } from '../model/plan-spec'
import { selectLaunchableSteps } from '../model/plan-scheduler'
import { truncateUtf8 } from '../model/utf8-truncate'
import { buildStepPrompt } from './step-prompt'
import type { StepOutcome, StepRunHandle, StepRunner } from './step-runner'

type Awaitable<T> = T | Promise<T>

export type PlanExecutorEvent =
  | { type: 'state_changed'; state: PlanRunState }
  | { type: 'run_finished'; state: PlanRunState }
  | { type: 'executor_error'; runId: string; error: string }

export interface PlanExecutorStore {
  write(state: PlanRunState): Awaitable<void>
}

export interface PlanExecutorEvents {
  emit(event: PlanExecutorEvent): Awaitable<void>
}

export interface PlanExecutorClock {
  now(): string
}

export interface PlanExecutorIds {
  runId(): string
}

export interface PlanExecutorDependencies {
  runner: StepRunner
  store: PlanExecutorStore
  events: PlanExecutorEvents
  clock: PlanExecutorClock | (() => string)
  ids: PlanExecutorIds | (() => string)
  maxConcurrent?: number
}

export interface PlanExecutor {
  start(spec: PlanSpec, sessionId: string): Promise<PlanRunState>
  pause(runId: string): Promise<PlanRunState>
  resume(runId: string): Promise<PlanRunState>
  stop(runId: string): Promise<PlanRunState>
  retryStep(runId: string, stepId: string): Promise<PlanRunState>
  skipStep(runId: string, stepId: string): Promise<PlanRunState>
  replaceRemainingSteps(runId: string, spec: PlanSpec): Promise<PlanRunState>
  recover(state: PlanRunState): Promise<PlanRunState>
  get(runId: string): PlanRunState | undefined
}

interface ActiveStep {
  agentRunId: string
  controller: AbortController
}

interface Runtime {
  states: Map<string, PlanRunState>
  queues: Map<string, Promise<void>>
  active: Map<string, Map<string, ActiveStep>>
}

function clockNow(clock: PlanExecutorDependencies['clock']): string {
  return typeof clock === 'function' ? clock() : clock.now()
}

function nextRunId(ids: PlanExecutorDependencies['ids']): string {
  return typeof ids === 'function' ? ids() : ids.runId()
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function reportSummary(report: AgentReport): PlanStepReportSummary {
  return {
    status: report.status,
    text: truncateUtf8(report.text, 8 * 1024),
    missingInputs: [...report.missingInputs]
  }
}

function eventForOutcome(stepId: string, outcome: StepOutcome, at: string): PlanRunEvent {
  if (!outcome.ok) return { type: 'step_failed', stepId, error: outcome.error, at }
  const report = reportSummary(outcome.report)
  if (report.missingInputs.length) return { type: 'step_needs_input', stepId, report, at }
  if (report.status === 'completed') return { type: 'step_succeeded', stepId, report, at }
  return { type: 'step_failed', stepId, report, at }
}

function requireState(runtime: Runtime, runId: string): PlanRunState {
  const state = runtime.states.get(runId)
  if (!state) throw new Error(`Plan run not found: ${runId}`)
  return state
}

class PlanExecutorImplementation implements PlanExecutor {
  private readonly runtime: Runtime = { states: new Map(), queues: new Map(), active: new Map() }

  constructor(private readonly deps: PlanExecutorDependencies) {}

  private enqueue<T>(runId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.runtime.queues.get(runId) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(operation)
    this.runtime.queues.set(
      runId,
      current.then(
        () => undefined,
        () => undefined
      )
    )
    return current
  }

  private async publish(previous: PlanRunState | undefined, state: PlanRunState): Promise<void> {
    await this.deps.store.write(state)
    await this.deps.events.emit({ type: 'state_changed', state })
    if (state.status === 'completed' && previous?.status !== 'completed') {
      await this.deps.events.emit({ type: 'run_finished', state })
    }
  }

  private async emitExecutorError(runId: string, error: unknown): Promise<void> {
    try {
      await this.deps.events.emit({ type: 'executor_error', runId, error: errorText(error) })
    } catch {
      // Error reporting is best-effort and must never create another unhandled rejection.
    }
  }

  private async apply(runId: string, event: PlanRunEvent, schedule = true): Promise<PlanRunState> {
    const previous = requireState(this.runtime, runId)
    const state = reducePlanRun(previous, event)
    // Memory is authoritative if persistence fails; a later successful write replaces stale disk state.
    this.runtime.states.set(runId, state)
    await this.publish(previous, state)
    if (schedule) await this.scheduleRun(runId)
    return requireState(this.runtime, runId)
  }

  private settle(runId: string, stepId: string, agentRunId: string, outcome: StepOutcome): void {
    try {
      void this.enqueue(runId, async () => {
        const active = this.runtime.active.get(runId)?.get(stepId)
        const state = this.runtime.states.get(runId)
        if (!active || active.agentRunId !== agentRunId || !state) return state
        this.runtime.active.get(runId)?.delete(stepId)
        if (state.status === 'stopped' || state.steps[stepId]?.status !== 'running') return state
        return this.apply(runId, eventForOutcome(stepId, outcome, clockNow(this.deps.clock)))
      }).catch((error: unknown) => this.emitExecutorError(runId, error))
    } catch (error) {
      void this.emitExecutorError(runId, error)
    }
  }

  private watch(runId: string, stepId: string, handle: StepRunHandle): void {
    try {
      void handle.done
        .then(
          (outcome) => this.settle(runId, stepId, handle.runId, outcome),
          (error: unknown) =>
            this.settle(runId, stepId, handle.runId, { ok: false, error: errorText(error) })
        )
        .catch((error: unknown) => this.emitExecutorError(runId, error))
    } catch (error) {
      void this.emitExecutorError(runId, error)
    }
  }

  private async recordLaunchFailure(runId: string, stepId: string, error: unknown): Promise<void> {
    const state = requireState(this.runtime, runId)
    const attempt = (state.steps[stepId]?.attempts ?? 0) + 1
    const agentRunId = `${runId}:${stepId}:launch-${attempt}`
    await this.apply(
      runId,
      { type: 'step_launched', stepId, agentRunId, at: clockNow(this.deps.clock) },
      false
    )
    await this.apply(
      runId,
      { type: 'step_failed', stepId, error: errorText(error), at: clockNow(this.deps.clock) },
      false
    )
  }

  private async launch(runId: string, stepId: string): Promise<void> {
    const state = requireState(this.runtime, runId)
    const step = state.spec.steps.find((candidate) => candidate.id === stepId)!
    const controller = new AbortController()
    let handle: StepRunHandle
    try {
      handle = await this.deps.runner.start({
        sessionId: state.sessionId,
        ...(step.agent ? { agent: step.agent } : {}),
        task: buildStepPrompt(state, stepId),
        signal: controller.signal
      })
    } catch (error) {
      await this.recordLaunchFailure(runId, stepId, error)
      return
    }
    this.runtime.active.get(runId)?.set(stepId, { agentRunId: handle.runId, controller })
    this.watch(runId, stepId, handle)
    await this.apply(
      runId,
      { type: 'step_launched', stepId, agentRunId: handle.runId, at: clockNow(this.deps.clock) },
      false
    )
  }

  private async scheduleRun(runId: string): Promise<void> {
    try {
      const state = requireState(this.runtime, runId)
      const selected = selectLaunchableSteps(state, { maxConcurrent: this.deps.maxConcurrent })
      for (const stepId of selected) {
        const current = requireState(this.runtime, runId)
        if (current.status !== 'running') break
        if (current.steps[stepId]?.status === 'pending') await this.launch(runId, stepId)
      }
      if (selected.length && requireState(this.runtime, runId).status === 'running') {
        await this.scheduleRun(runId)
      }
    } catch (error) {
      await this.emitExecutorError(runId, error)
    }
  }

  private async transition(runId: string, event: PlanRunEvent): Promise<PlanRunState> {
    return this.enqueue(runId, () => this.apply(runId, event))
  }

  async start(spec: PlanSpec, sessionId: string): Promise<PlanRunState> {
    const validated = validatePlanSpec(spec)
    if (!validated.ok) throw new Error(`Invalid plan: ${validated.errors.join('; ')}`)
    const id = nextRunId(this.deps.ids)
    if (this.runtime.states.has(id)) throw new Error(`Plan run already exists: ${id}`)
    const state = createPlanRunState({
      id,
      sessionId,
      spec: validated.spec,
      now: clockNow(this.deps.clock)
    })
    this.runtime.states.set(id, state)
    this.runtime.active.set(id, new Map())
    await this.enqueue(id, async () => {
      await this.publish(undefined, state)
      await this.scheduleRun(id)
    })
    return requireState(this.runtime, id)
  }

  async stop(runId: string): Promise<PlanRunState> {
    return this.enqueue(runId, async () => {
      const state = requireState(this.runtime, runId)
      const active = [...(this.runtime.active.get(runId)?.values() ?? [])]
      await Promise.allSettled(
        active.map(async ({ agentRunId, controller }) => {
          controller.abort()
          await this.deps.runner.stop(state.sessionId, agentRunId)
        })
      )
      this.runtime.active.get(runId)?.clear()
      return this.apply(runId, { type: 'stop', at: clockNow(this.deps.clock) }, false)
    })
  }

  async recover(state: PlanRunState): Promise<PlanRunState> {
    if (this.runtime.states.has(state.id)) throw new Error(`Plan run already exists: ${state.id}`)
    this.runtime.states.set(state.id, state)
    this.runtime.active.set(state.id, new Map())
    return this.enqueue(state.id, () =>
      this.apply(state.id, { type: 'recover_after_restart', at: clockNow(this.deps.clock) })
    )
  }

  pause(runId: string): Promise<PlanRunState> {
    return this.transition(runId, { type: 'pause', at: clockNow(this.deps.clock) })
  }

  resume(runId: string): Promise<PlanRunState> {
    return this.transition(runId, { type: 'resume', at: clockNow(this.deps.clock) })
  }

  retryStep(runId: string, stepId: string): Promise<PlanRunState> {
    return this.transition(runId, {
      type: 'retry_step',
      stepId,
      at: clockNow(this.deps.clock)
    })
  }

  skipStep(runId: string, stepId: string): Promise<PlanRunState> {
    return this.transition(runId, { type: 'skip_step', stepId, at: clockNow(this.deps.clock) })
  }

  replaceRemainingSteps(runId: string, spec: PlanSpec): Promise<PlanRunState> {
    return this.transition(runId, {
      type: 'replace_remaining_steps',
      spec,
      at: clockNow(this.deps.clock)
    })
  }

  get(runId: string): PlanRunState | undefined {
    return this.runtime.states.get(runId)
  }
}

export function createPlanExecutor(deps: PlanExecutorDependencies): PlanExecutor {
  return new PlanExecutorImplementation(deps)
}
