import type { AgentReport } from '../../agents/report'
import type { AgentRunCancelReason } from './agent-run-completions'

export type StepOutcome =
  | { ok: true; report: AgentReport }
  | {
      ok: false
      error: string
      /** Set when the run was cancelled by app shutdown or session disposal, not failure. */
      interrupted?: AgentRunCancelReason
    }

export interface StepRunHandle {
  runId: string
  /** Settles with a report or error; adapters should not reject, but the executor is defensive. */
  done: Promise<StepOutcome>
}

export interface StepRunnerStartInput {
  sessionId: string
  agent?: string
  task: string
  requestId?: string
  signal: AbortSignal
}

export interface StepRunner {
  start(input: StepRunnerStartInput): Promise<StepRunHandle>
  stop(sessionId: string, runId: string): Promise<void> | void
}
