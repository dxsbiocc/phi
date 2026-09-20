import type { WrapperOutputRecord, WrapperRunState } from '../types'
import type { RunProgress } from './progress'

/**
 * Background wrapper jobs. The job manager lives in the main process (a job
 * must outlive any chat session, and the worker is stopped when idle); the
 * worker's agent tools reach it through {@link WrapperJobClient}, which is
 * implemented directly by the manager and, across the process boundary, by
 * `createHostJobClient`.
 */

export interface WrapperJobStatus {
  runId: string
  wrapperId: string
  state: WrapperRunState
  profile: string
  outDir: string
  startedAt?: string
  completedAt?: string
  elapsedSeconds: number
  exitCode?: number
  progress: RunProgress
  /** Newest output, at most ~4000 characters. */
  logTail: string
  /** Set once the run has ended. */
  outputs?: WrapperOutputRecord[]
  missingOutputs?: string[]
}

export interface WrapperJobSummary {
  runId: string
  wrapperId: string
  state: WrapperRunState
  startedAt?: string
  elapsedSeconds: number
}

export type StartJobResult = { ok: true; status: WrapperJobStatus } | { ok: false; error: string }
export type CancelJobResult = { ok: true; status: WrapperJobStatus } | { ok: false; error: string }

export interface WrapperJobClient {
  start(input: {
    id: string
    overrides: Record<string, unknown>
    profile: string
    /** The runtime session whose agent started this run; used to tell that conversation when it ends. */
    originSessionId?: string
    /** `false` opts out of waking that conversation when the run ends. Anything else means yes. */
    continueWhenDone?: boolean
  }): Promise<StartJobResult>
  status(runId: string): Promise<WrapperJobStatus | undefined>
  /** Newest first. */
  list(limit?: number): Promise<WrapperJobSummary[]>
  cancel(runId: string): Promise<CancelJobResult>
  /** Resolves with the status once the run ends or `timeoutMs` passes, whichever is first. */
  wait(runId: string, timeoutMs: number): Promise<WrapperJobStatus | undefined>
}

export const WRAPPER_JOB_HOST_METHODS = {
  start: 'wrapperJob.start',
  status: 'wrapperJob.status',
  list: 'wrapperJob.list',
  cancel: 'wrapperJob.cancel',
  wait: 'wrapperJob.wait'
} as const

/** States in which a run has ended for good. */
export const TERMINAL_RUN_STATES: readonly WrapperRunState[] = [
  'completed',
  'failed',
  'cancelled',
  'lost'
]
