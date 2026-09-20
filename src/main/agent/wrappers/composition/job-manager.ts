import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { getPhiAgentDir } from '../../runtime-paths'
import { getWrapperRunsDir, listWrapperRuns, readWrapperRun, writeWrapperRun } from '../store'
import type { WrapperRun } from '../types'
import {
  findWrapperCompositionEntry,
  readWrapperCompositionDag,
  readWrapperDefaultParams,
  type WrapperCompositionEntry
} from './discovery'
import {
  WRAPPER_EXECUTION_PROFILES,
  killAllWrapperProcesses,
  startWrapperComposition,
  type WrapperExecutionProfile,
  type WrapperProcess
} from './executor'
import {
  TERMINAL_RUN_STATES,
  type CancelJobResult,
  type StartJobResult,
  type WrapperJobClient,
  type WrapperJobStatus,
  type WrapperJobSummary
} from './job-types'
import { countDagProcesses, createProgressTracker, type ProgressTracker } from './progress'
import {
  finishCompositionRun,
  markCompositionRunCancelling,
  startCompositionRun,
  type CompositionRunOutcome
} from './run-record'
import { findMissingPrimaryOutputs, validateWrapperParams } from './validate'

/**
 * Owns every background wrapper run. It lives in the main process on purpose:
 * a run has to outlive any chat session, and the agent worker is stopped when
 * idle. Agent tools reach it through `WrapperJobClient`.
 *
 * Each run is persisted in the run store as it happens (state, throttled
 * progress) and its full Nextflow log goes to `runs/<runId>/nextflow.log`, so
 * status can be answered from disk after a restart.
 */

const LOG_FILE = 'nextflow.log'
const LOG_TAIL_CHARS = 4000
const DEFAULT_MAX_CONCURRENT = 3
const DEFAULT_PROGRESS_THROTTLE_MS = 2000

export interface WrapperJobManagerOptions {
  agentDir?: () => string
  maxConcurrent?: number
  killGraceMs?: number
  progressThrottleMs?: number
}

interface LiveJob {
  run: WrapperRun
  entry: WrapperCompositionEntry
  params: Record<string, unknown>
  proc: WrapperProcess
  tracker: ProgressTracker
  logPath: string
  startedMs: number
  lastPersistMs: number
  cancelRequested: boolean
  finalized: boolean
  finished: Promise<WrapperJobStatus>
}

function elapsedSeconds(run: WrapperRun, now = Date.now()): number {
  const start = Date.parse(run.startedAt ?? run.createdAt)
  const end = run.completedAt ? Date.parse(run.completedAt) : now
  return Math.max(0, Math.round((end - start) / 1000))
}

function readTail(path: string, maxChars: number): string {
  try {
    const text = readFileSync(path, 'utf-8')
    return text.length > maxChars ? text.slice(-maxChars) : text
  } catch {
    return ''
  }
}

function readSummary(runsDir: string, runId: string): { missingOutputs?: string[] } {
  try {
    return JSON.parse(readFileSync(join(runsDir, runId, 'summary.json'), 'utf-8')) as {
      missingOutputs?: string[]
    }
  } catch {
    return {}
  }
}

export class WrapperJobManager implements WrapperJobClient {
  private readonly live = new Map<string, LiveJob>()
  private readonly reported = new Set<string>()
  private readonly listeners = new Set<(runId: string) => void>()
  private readonly finishListeners = new Set<(run: WrapperRun, status: WrapperJobStatus) => void>()
  private readonly agentDir: () => string
  private readonly maxConcurrent: number
  private readonly killGraceMs: number | undefined
  private readonly progressThrottleMs: number

  constructor(options: WrapperJobManagerOptions = {}) {
    this.agentDir = options.agentDir ?? getPhiAgentDir
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    this.killGraceMs = options.killGraceMs
    this.progressThrottleMs = options.progressThrottleMs ?? DEFAULT_PROGRESS_THROTTLE_MS
  }

  onChange(listener: (runId: string) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Called once when a run ends on its own (completed, failed or cancelled).
   * Not called when the app is shutting down: nobody is left to tell.
   */
  onFinish(listener: (run: WrapperRun, status: WrapperJobStatus) => void): () => void {
    this.finishListeners.add(listener)
    return () => this.finishListeners.delete(listener)
  }

  private emitFinish(runId: string): void {
    const run = readWrapperRun(runId, this.agentDir())
    const status = this.statusSync(runId)
    if (!run || !status) return
    for (const listener of this.finishListeners) {
      try {
        listener(run, status)
      } catch {
        // A broken listener must not disturb a run.
      }
    }
  }

  private emit(runId: string): void {
    for (const listener of this.listeners) {
      try {
        listener(runId)
      } catch {
        // A broken listener must not disturb a run.
      }
    }
  }

  async start(input: {
    id: string
    overrides: Record<string, unknown>
    profile: string
    originSessionId?: string
    continueWhenDone?: boolean
  }): Promise<StartJobResult> {
    const { id, overrides, profile } = input
    if (!(WRAPPER_EXECUTION_PROFILES as readonly string[]).includes(profile)) {
      return {
        ok: false,
        error: `Invalid profile: ${profile}. Must be one of ${WRAPPER_EXECUTION_PROFILES.join(', ')}.`
      }
    }
    const entry = findWrapperCompositionEntry(id)
    if (!entry) return { ok: false, error: `Wrapper not found: ${id}` }

    const defaults = readWrapperDefaultParams(entry.wrapperDir)
    const errors = validateWrapperParams(entry.manifest, defaults, overrides, entry.componentDir)
    if (errors.length > 0) {
      return {
        ok: false,
        error: `Invalid parameters for ${id}:\n${errors.map((error) => `- ${error}`).join('\n')}`
      }
    }
    if (this.live.size >= this.maxConcurrent) {
      return {
        ok: false,
        error: `Too many wrapper runs are already running (limit ${this.maxConcurrent}). Wait for one to finish or cancel it first.`
      }
    }

    const agentDir = this.agentDir()
    const params = { ...defaults, ...overrides }
    let run: WrapperRun
    try {
      run = startCompositionRun({
        entry,
        params,
        profile,
        originSessionId: input.originSessionId,
        continueWhenDone: input.continueWhenDone,
        agentDir
      })
    } catch (error) {
      return {
        ok: false,
        error: `Could not record the run: ${error instanceof Error ? error.message : String(error)}`
      }
    }

    const logPath = join(getWrapperRunsDir(agentDir), run.runId, LOG_FILE)
    writeFileSync(logPath, '')
    const tracker = createProgressTracker({
      total: countDagProcesses(readWrapperCompositionDag(id))
    })

    const jobRef: { current?: LiveJob } = {}
    const onOutput = (chunk: string): void => {
      appendFileSync(logPath, chunk)
      tracker.push(chunk)
      if (jobRef.current) this.persistProgress(jobRef.current)
    }

    let proc: WrapperProcess
    try {
      proc = startWrapperComposition(
        entry.wrapperDir,
        overrides,
        profile as WrapperExecutionProfile,
        {
          onOutput,
          killGraceMs: this.killGraceMs
        }
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finishCompositionRun({
        run,
        entry,
        params,
        outcome: 'failed',
        exitCode: -1,
        output: message,
        missingOutputs: [],
        agentDir
      })
      this.emit(run.runId)
      return { ok: false, error: `Could not start Nextflow: ${message}` }
    }

    const started: LiveJob = {
      run,
      entry,
      params,
      proc,
      tracker,
      logPath,
      startedMs: Date.now(),
      lastPersistMs: 0,
      cancelRequested: false,
      finalized: false,
      finished: Promise.resolve(undefined as never)
    }
    jobRef.current = started
    this.live.set(run.runId, started)
    started.finished = proc.done.then((result) => this.finalize(started, result))
    this.emit(run.runId)
    return { ok: true, status: this.liveStatus(started) }
  }

  private persistProgress(job: LiveJob): void {
    const now = Date.now()
    if (job.finalized || now - job.lastPersistMs < this.progressThrottleMs) return
    job.lastPersistMs = now
    try {
      job.run = {
        ...job.run,
        progress: job.tracker.snapshot(),
        updatedAt: new Date(now).toISOString()
      }
      writeWrapperRun(job.run, this.agentDir())
      this.emit(job.run.runId)
    } catch {
      // Progress is advisory; never disturb the run for it.
    }
  }

  private finalize(
    job: LiveJob,
    result: { success: boolean; cancelled?: boolean; exitCode: number; output: string }
  ): WrapperJobStatus {
    const runId = job.run.runId
    if (job.finalized) return this.statusSync(runId) as WrapperJobStatus
    job.finalized = true

    const missing = result.success
      ? findMissingPrimaryOutputs(job.entry.manifest, job.params, job.entry.componentDir)
      : []
    const outcome: CompositionRunOutcome = result.cancelled
      ? 'cancelled'
      : result.success && missing.length === 0
        ? 'completed'
        : 'failed'
    try {
      finishCompositionRun({
        run: job.run,
        entry: job.entry,
        params: job.params,
        outcome,
        exitCode: result.exitCode,
        output: job.tracker.tail(),
        missingOutputs: missing,
        progress: job.tracker.snapshot(),
        agentDir: this.agentDir()
      })
    } catch {
      // The run itself is over; a store problem only costs the record.
    }
    this.live.delete(runId)
    this.emit(runId)
    this.emitFinish(runId)
    return this.statusSync(runId) as WrapperJobStatus
  }

  private liveStatus(job: LiveJob): WrapperJobStatus {
    return {
      runId: job.run.runId,
      wrapperId: job.run.wrapper.canonicalId,
      state: job.run.state,
      profile: job.run.profile,
      outDir: job.run.outDir,
      startedAt: job.run.startedAt,
      elapsedSeconds: Math.max(0, Math.round((Date.now() - job.startedMs) / 1000)),
      progress: job.tracker.snapshot(),
      logTail: job.tracker.tail(LOG_TAIL_CHARS)
    }
  }

  /** Live snapshot when the run is in flight, otherwise what is on disk. */
  statusSync(runId: string): WrapperJobStatus | undefined {
    const job = this.live.get(runId)
    if (job) return this.liveStatus(job)

    const agentDir = this.agentDir()
    const run = readWrapperRun(runId, agentDir)
    if (!run) return undefined
    const runsDir = getWrapperRunsDir(agentDir)
    return {
      runId: run.runId,
      wrapperId: run.wrapper.canonicalId,
      state: run.state,
      profile: run.profile,
      outDir: run.outDir,
      ...(run.startedAt ? { startedAt: run.startedAt } : {}),
      ...(run.completedAt ? { completedAt: run.completedAt } : {}),
      elapsedSeconds: elapsedSeconds(run),
      ...(run.exitCode !== undefined ? { exitCode: run.exitCode } : {}),
      progress: run.progress ?? { started: 0 },
      logTail: readTail(join(runsDir, run.runId, LOG_FILE), LOG_TAIL_CHARS),
      ...(run.outputs ? { outputs: run.outputs } : {}),
      ...(TERMINAL_RUN_STATES.includes(run.state)
        ? { missingOutputs: readSummary(runsDir, run.runId).missingOutputs ?? [] }
        : {})
    }
  }

  async status(runId: string): Promise<WrapperJobStatus | undefined> {
    return this.noteReported(this.statusSync(runId))
  }

  /**
   * True once an agent has been handed this run's final outcome (through `wait` or
   * `status`). Finishing on its own does not count. Used so Phi does not wake a
   * conversation to announce a result the agent already reported in the same turn.
   */
  hasBeenReported(runId: string): boolean {
    return this.reported.has(runId)
  }

  private noteReported(status: WrapperJobStatus | undefined): WrapperJobStatus | undefined {
    if (status && TERMINAL_RUN_STATES.includes(status.state)) this.reported.add(status.runId)
    return status
  }

  async list(limit = 10): Promise<WrapperJobSummary[]> {
    const runs = listWrapperRuns(this.agentDir())
      .filter((run) => run.origin === 'composition')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, limit))
    return runs.map((stored) => {
      const run = this.live.get(stored.runId)?.run ?? stored
      return {
        runId: run.runId,
        wrapperId: run.wrapper.canonicalId,
        state: run.state,
        ...(run.startedAt ? { startedAt: run.startedAt } : {}),
        elapsedSeconds: elapsedSeconds(run)
      }
    })
  }

  async cancel(runId: string): Promise<CancelJobResult> {
    const job = this.live.get(runId)
    if (!job) {
      const stored = readWrapperRun(runId, this.agentDir())
      return {
        ok: false,
        error: stored
          ? `Run ${runId} is not running (state: ${stored.state}); nothing to cancel.`
          : `Run not found: ${runId}`
      }
    }
    if (!job.cancelRequested) {
      job.cancelRequested = true
      try {
        job.run = markCompositionRunCancelling(job.run, this.agentDir())
      } catch {
        // The kill below is what matters.
      }
      job.proc.cancel()
      this.emit(runId)
    }
    return { ok: true, status: this.liveStatus(job) }
  }

  async wait(runId: string, timeoutMs: number): Promise<WrapperJobStatus | undefined> {
    const job = this.live.get(runId)
    if (!job) return this.noteReported(this.statusSync(runId))

    let timer: NodeJS.Timeout | undefined
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), Math.max(0, timeoutMs))
    })
    try {
      const outcome = await Promise.race([job.finished, timeout])
      return this.noteReported(outcome === 'timeout' ? this.statusSync(runId) : outcome)
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /**
   * App is quitting: stop every live run and record it cancelled right now
   * (synchronously — the process is about to exit).
   */
  shutdown(): void {
    for (const job of [...this.live.values()]) {
      if (job.finalized) continue
      job.finalized = true
      job.proc.cancel()
      try {
        finishCompositionRun({
          run: job.run,
          entry: job.entry,
          params: job.params,
          outcome: 'cancelled',
          exitCode: -1,
          output: job.tracker.tail(),
          missingOutputs: [],
          progress: job.tracker.snapshot(),
          agentDir: this.agentDir()
        })
      } catch {
        // Best effort: startup reconciliation marks anything left over as lost.
      }
      this.live.delete(job.run.runId)
    }
    killAllWrapperProcesses()
  }
}
