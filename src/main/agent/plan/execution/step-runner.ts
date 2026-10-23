import type { AgentReport } from '../../agents/report'

export type StepOutcome = { ok: true; report: AgentReport } | { ok: false; error: string }

export interface StepRunHandle {
  runId: string
  /** Settles with a report or error; adapters should not reject, but the executor is defensive. */
  done: Promise<StepOutcome>
}

export interface StepRunnerStartInput {
  sessionId: string
  agent?: string
  task: string
  signal: AbortSignal
}

export interface StepRunner {
  start(input: StepRunnerStartInput): Promise<StepRunHandle>
  stop(sessionId: string, runId: string): Promise<void> | void
}
