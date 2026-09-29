/**
 * The runs of one conversation's specialist agents. Foreground and background
 * delegations share it, so they share one set of limits and one place to look a
 * run up, steer it, or stop it. It knows nothing about sessions or the SDK: the
 * work itself is an injected runner (see runner.ts), which keeps this testable
 * with fakes — see tests/phi-agent-runs.test.ts.
 */
import {
  AgentCancelledError,
  AgentTimeoutError,
  describeToolStart,
  type AgentImage,
  type AgentRunControl,
  type AgentRunRequest,
  type AgentRunResult,
  type AgentRunToolStep
} from './runner'
import type { VisualizationWorkflow } from './tool-resolution'
import { parseAgentReport, type AgentReportStatus } from './report'

export type AgentRunState = 'queued' | 'running' | 'done' | 'error' | 'cancelled'

export interface AgentRunSnapshot {
  id: string
  agent: string
  task: string
  state: AgentRunState
  /** Started with `background: true`: nobody was waiting on the tool call. */
  background: boolean
  startedAt: number
  completedAt?: number
  toolCalls?: number
  report?: string
  /** Machine-readable outcome supplied by native Phi agents. */
  reportStatus?: AgentReportStatus
  missingInputs?: string[]
  nextAgent?: string
  fallbackReason?: string
  /** For `error` and `cancelled`: the message naming the agent. */
  error?: string
  /** The latest tool call the agent made, as one short line. */
  lastStep?: string
  /** The main agent has been handed this run's outcome (agent_wait / agent_status). */
  reported?: boolean
  /** The delegation tool call that started it: the card in the chat that shows this run. */
  toolCallId?: string
}

export interface AgentRunListener {
  /** A run ended: done, failed or cancelled. */
  onFinish?: (run: AgentRunSnapshot) => void
  /** The main agent has just been handed a finished run's outcome, for the first time. */
  onReported?: (run: AgentRunSnapshot) => void
  /** The run made progress: a tool call started, streamed output, or finished. */
  onStep?: (run: AgentRunSnapshot, step: AgentRunToolStep) => void
}

export interface AgentRunLimits {
  /** Sessions running at once; further runs wait in a queue. */
  maxConcurrent: number
  /** Runs one conversation may start in total. Stops a delegation loop. */
  maxRuns: number
}

export const DEFAULT_AGENT_RUN_LIMITS: AgentRunLimits = { maxConcurrent: 4, maxRuns: 64 }

export class AgentRunLimitError extends Error {
  constructor(readonly maxRuns: number) {
    super(
      `This conversation has already started ${maxRuns} agent runs, which is the limit. Finish the work with the results you have, or ask the user how to proceed.`
    )
    this.name = 'AgentRunLimitError'
  }
}

export type AgentRunFn = (request: AgentRunRequest) => Promise<AgentRunResult>

export interface AgentLaunchInput {
  agent: string
  task: string
  images?: AgentImage[]
  workflow?: VisualizationWorkflow
  runner: AgentRunFn
  background: boolean
  /** Cancels a foreground run when it fires. Ignored for background runs, which outlive their tool call. */
  signal?: AbortSignal
  /** The delegation tool call that starts this run. */
  toolCallId?: string
  onProgress?: (line: string, runId: string) => void
  onToolStep?: (step: AgentRunToolStep, runId: string) => void
}

export interface AgentRunHandle {
  id: string
  /** Settles when the run ends, however it ends; never rejects. */
  done: Promise<AgentRunSnapshot>
}

export interface AgentWaitOptions {
  timeoutMs: number
  /** `all` (default) waits for every targeted run, `any` for the first to finish. */
  mode?: 'all' | 'any'
  /** Stops the wait, not the runs. */
  signal?: AbortSignal
}

export interface AgentWaitResult {
  runs: AgentRunSnapshot[]
  timedOut: boolean
}

interface RunRecord {
  snapshot: AgentRunSnapshot
  input: AgentLaunchInput
  controller: AbortController
  control?: AgentRunControl
  done: Promise<AgentRunSnapshot>
  settle: (snapshot: AgentRunSnapshot) => void
  detachSignal?: () => void
}

export function isFinalAgentRunState(state: AgentRunState): boolean {
  return state === 'done' || state === 'error' || state === 'cancelled'
}

export class AgentRunRegistry {
  private readonly limits: AgentRunLimits
  private readonly now: () => number
  private readonly runs = new Map<string, RunRecord>()
  private readonly queue: RunRecord[] = []
  private readonly listeners = new Set<AgentRunListener>()
  private active = 0
  private sequence = 0

  constructor(options: { limits?: Partial<AgentRunLimits>; now?: () => number } = {}) {
    this.limits = { ...DEFAULT_AGENT_RUN_LIMITS, ...options.limits }
    this.now = options.now ?? Date.now
  }

  launch(input: AgentLaunchInput): AgentRunHandle {
    if (this.runs.size >= this.limits.maxRuns) throw new AgentRunLimitError(this.limits.maxRuns)

    const id = `run_${++this.sequence}`
    let settle!: (snapshot: AgentRunSnapshot) => void
    const done = new Promise<AgentRunSnapshot>((resolve) => {
      settle = resolve
    })
    const record: RunRecord = {
      snapshot: {
        id,
        agent: input.agent,
        task: input.task,
        state: 'queued',
        background: input.background,
        startedAt: this.now(),
        ...(input.toolCallId ? { toolCallId: input.toolCallId } : {})
      },
      input,
      controller: new AbortController(),
      done,
      settle
    }
    this.runs.set(id, record)
    this.queue.push(record)

    if (input.signal && !input.background) {
      const { signal } = input
      const onAbort = (): void => {
        this.stop(id)
      }
      if (signal.aborted) {
        onAbort()
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
        record.detachSignal = () => signal.removeEventListener('abort', onAbort)
      }
    }

    this.pump()
    return { id, done }
  }

  get(id: string): AgentRunSnapshot | undefined {
    const record = this.runs.get(id)
    return record ? { ...record.snapshot } : undefined
  }

  list(): AgentRunSnapshot[] {
    return [...this.runs.values()].map((record) => ({ ...record.snapshot }))
  }

  fallbackReadiness(
    agent: string,
    afterFailures: number
  ): { allowed: boolean; failures: number; reason?: string } {
    const attempts = [...this.runs.values()]
      .map((record) => record.snapshot)
      .filter((run) => run.agent === agent)
    const latest = attempts.at(-1)
    if (!latest) {
      return { allowed: false, failures: 0, reason: `${agent} must be delegated first.` }
    }
    if (!isFinalAgentRunState(latest.state)) {
      return { allowed: false, failures: 0, reason: `${agent} is still ${latest.state}.` }
    }

    let failures = 0
    for (const run of attempts.toReversed()) {
      const failed =
        run.state === 'error' ||
        (run.state === 'done' &&
          (run.reportStatus === 'not_found' ||
            run.reportStatus === 'blocked' ||
            run.reportStatus === 'failed'))
      if (!failed) break
      failures += 1
    }
    return failures >= afterFailures
      ? { allowed: true, failures }
      : {
          allowed: false,
          failures,
          reason: `${agent} fallback needs ${afterFailures} consecutive not-found, blocked, or failed attempt(s); ${failures} recorded.`
        }
  }

  subscribe(listener: AgentRunListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * Records that the main agent has been handed a finished run's outcome, so
   * nobody needs to wake it up with the same news. True only the first time.
   */
  markReported(id: string): boolean {
    const record = this.runs.get(id)
    if (!record || !isFinalAgentRunState(record.snapshot.state) || record.snapshot.reported) {
      return false
    }
    record.snapshot = { ...record.snapshot, reported: true }
    this.notify((listener) => listener.onReported?.({ ...record.snapshot }))
    return true
  }

  /** Stops one run. False when there is no such run or it has already ended. */
  stop(id: string): boolean {
    const record = this.runs.get(id)
    if (!record || isFinalAgentRunState(record.snapshot.state)) return false

    if (record.snapshot.state === 'queued') {
      const index = this.queue.indexOf(record)
      if (index >= 0) this.queue.splice(index, 1)
      this.finish(record, {
        state: 'cancelled',
        error: new AgentCancelledError(record.snapshot.agent).message
      })
    } else {
      // The runner ends the session and rejects; finish() happens when it does.
      record.controller.abort()
    }
    return true
  }

  stopAll(): void {
    for (const id of [...this.runs.keys()]) this.stop(id)
  }

  /** Delivers a message to a running agent; it reads it after its current tool call. */
  async steer(id: string, message: string): Promise<void> {
    const record = this.require(id)
    const { state, agent } = record.snapshot
    if (isFinalAgentRunState(state)) {
      throw new Error(`Run ${id} (${agent}) has already finished, so it cannot be steered.`)
    }
    if (state === 'queued') {
      throw new Error(`Run ${id} (${agent}) has not started yet; steer it once it is running.`)
    }
    if (!record.control) {
      throw new Error(`Run ${id} (${agent}) cannot be steered.`)
    }
    await record.control.steer(message)
  }

  async wait(
    ids: readonly string[] | undefined,
    options: AgentWaitOptions
  ): Promise<AgentWaitResult> {
    const targets = ids
      ? ids.map((id) => this.require(id))
      : [...this.runs.values()].filter((record) => !isFinalAgentRunState(record.snapshot.state))
    if (targets.length === 0) return { runs: [], timedOut: false }

    const dones = targets.map((record) => record.done)
    const finished = options.mode === 'any' ? Promise.race(dones) : Promise.all(dones)
    let timer: ReturnType<typeof setTimeout> | undefined
    let onAbort: (() => void) | undefined
    const timedOut = await new Promise<boolean>((resolve) => {
      void finished.then(() => resolve(false))
      timer = setTimeout(() => resolve(true), options.timeoutMs)
      onAbort = () => resolve(true)
      if (options.signal?.aborted) resolve(true)
      else options.signal?.addEventListener('abort', onAbort, { once: true })
    })
    clearTimeout(timer)
    if (onAbort) options.signal?.removeEventListener('abort', onAbort)

    return { runs: targets.map((record) => ({ ...record.snapshot })), timedOut }
  }

  private require(id: string): RunRecord {
    const record = this.runs.get(id)
    if (!record) throw new Error(`Unknown run: ${id}`)
    return record
  }

  private pump(): void {
    while (this.active < this.limits.maxConcurrent && this.queue.length > 0) {
      const record = this.queue.shift()
      if (!record || record.snapshot.state !== 'queued') continue
      record.snapshot = { ...record.snapshot, state: 'running' }
      this.active += 1
      void this.execute(record)
    }
  }

  private async execute(record: RunRecord): Promise<void> {
    const { input } = record
    try {
      const result = await input.runner({
        task: input.task,
        ...(input.images?.length ? { images: input.images } : {}),
        ...(input.workflow ? { workflow: input.workflow } : {}),
        runId: record.snapshot.id,
        signal: record.controller.signal,
        onProgress: (line) => {
          this.patch(record, { lastStep: line })
          input.onProgress?.(line, record.snapshot.id)
        },
        onToolStep: (step) => {
          if (step.status === 'running' && step.args !== undefined) {
            this.patch(record, { lastStep: describeToolStart(step.toolName, step.args) })
          }
          input.onToolStep?.(step, record.snapshot.id)
          this.notify((listener) => listener.onStep?.({ ...record.snapshot }, step))
        },
        onControl: (control) => {
          record.control = control
        }
      })
      const report = parseAgentReport(result.text)
      if (report.text) {
        this.finish(record, {
          state: 'done',
          report: report.text,
          reportStatus: report.status,
          missingInputs: report.missingInputs,
          ...(report.nextAgent ? { nextAgent: report.nextAgent } : {}),
          ...(report.fallbackReason ? { fallbackReason: report.fallbackReason } : {}),
          toolCalls: result.toolCalls
        })
      } else {
        this.finish(record, {
          state: 'error',
          toolCalls: result.toolCalls,
          error: `The ${input.agent} agent finished but produced no report. Try again with a more specific task.`
        })
      }
    } catch (error) {
      if (error instanceof AgentCancelledError) {
        this.finish(record, { state: 'cancelled', error: error.message })
      } else if (error instanceof AgentTimeoutError) {
        this.finish(record, { state: 'error', error: error.message })
      } else {
        const reason = error instanceof Error ? error.message : String(error)
        this.finish(record, { state: 'error', error: `The ${input.agent} agent failed: ${reason}` })
      }
    }
  }

  private patch(record: RunRecord, changes: Partial<AgentRunSnapshot>): void {
    record.snapshot = { ...record.snapshot, ...changes }
  }

  private finish(
    record: RunRecord,
    outcome: Pick<AgentRunSnapshot, 'state'> & Partial<AgentRunSnapshot>
  ): void {
    if (isFinalAgentRunState(record.snapshot.state)) return
    const wasRunning = record.snapshot.state === 'running'
    record.input.images = undefined
    record.snapshot = { ...record.snapshot, ...outcome, completedAt: this.now() }
    record.detachSignal?.()
    if (wasRunning) this.active -= 1
    record.settle({ ...record.snapshot })
    this.notify((listener) => listener.onFinish?.({ ...record.snapshot }))
    this.pump()
  }

  /** A listener is someone else's code; it must never break a run or its siblings. */
  private notify(call: (listener: AgentRunListener) => void): void {
    for (const listener of [...this.listeners]) {
      try {
        call(listener)
      } catch {
        // Ignored by design.
      }
    }
  }
}
