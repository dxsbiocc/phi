export const PLAN_SPEC_VERSION = 1 as const
export const PLAN_MAX_STEPS = 20
export const PLAN_MAX_STEP_ID_LENGTH = 40
export const PLAN_MAX_STEP_TITLE_LENGTH = 80
export const PLAN_MAX_STEP_INSTRUCTIONS_LENGTH = 4_000
export const PLAN_MAX_STEP_ACCEPTANCE_LENGTH = 1_000
export const PLAN_MAX_REPORT_SUMMARY_BYTES = 8 * 1_024
export const PLAN_MAX_REPLANS = 2
export const PLAN_DEFAULT_MAX_CONCURRENT = 3
export const PLAN_RUN_STATUSES = ['running', 'paused', 'completed', 'stopped'] as const
export const PLAN_STEP_STATUSES = [
  'pending',
  'running',
  'done',
  'failed',
  'skipped',
  'cancelled',
  'interrupted'
] as const
export const PLAN_STEP_REPORT_STATUSES = [
  'completed',
  'partial',
  'not_found',
  'blocked',
  'failed'
] as const
export const PLAN_RUN_PAUSE_REASONS = ['user', 'step_failed', 'interrupted', 'needs_input'] as const

export type PlanStepAccess = 'read' | 'write'

export interface PlanStep {
  id: string
  title: string
  instructions: string
  acceptance: string
  dependsOn: string[]
  access: PlanStepAccess
  writes?: string[]
  agent?: string
}

export interface PlanSpec {
  version: typeof PLAN_SPEC_VERSION
  goal: string
  steps: PlanStep[]
}

export type PlanRunStatus = (typeof PLAN_RUN_STATUSES)[number]
export type PlanStepStatus = (typeof PLAN_STEP_STATUSES)[number]
export type PlanStepReportStatus = (typeof PLAN_STEP_REPORT_STATUSES)[number]

export interface PlanStepReportSummary {
  status: PlanStepReportStatus
  text: string
  missingInputs: string[]
}

export interface PlanStepState {
  status: PlanStepStatus
  attempts: number
  agentRunId?: string
  report?: PlanStepReportSummary
  error?: string
  startedAt?: string
  finishedAt?: string
}

export interface PlanRunPause {
  reason: (typeof PLAN_RUN_PAUSE_REASONS)[number]
  stepId?: string
}

export interface PlanRunState {
  id: string
  sessionId: string
  spec: PlanSpec
  status: PlanRunStatus
  steps: Record<string, PlanStepState>
  pause?: PlanRunPause
  replans: number
  createdAt: string
  updatedAt: string
}

export type PlanRunTransitionErrorCode =
  | 'RUN_FINISHED'
  | 'INVALID_RUN_STATUS'
  | 'STEP_NOT_FOUND'
  | 'INVALID_STEP_TRANSITION'
  | 'REPLAN_LIMIT_REACHED'
  | 'INVALID_REPLACEMENT'

export type PlanRunEvent =
  | { type: 'step_launched'; stepId: string; agentRunId: string; at: string }
  | { type: 'step_succeeded'; stepId: string; report: PlanStepReportSummary; at: string }
  | {
      type: 'step_failed'
      stepId: string
      report?: PlanStepReportSummary
      error?: string
      at: string
    }
  | { type: 'step_needs_input'; stepId: string; report: PlanStepReportSummary; at: string }
  | { type: 'pause'; at: string }
  | { type: 'resume'; at: string }
  | { type: 'retry_step'; stepId: string; at: string }
  | { type: 'skip_step'; stepId: string; at: string }
  | { type: 'stop'; at: string }
  | { type: 'replace_remaining_steps'; spec: PlanSpec; at: string }
  | { type: 'recover_after_restart'; at: string }
