import type { MatrixValueSemantics } from './scientificContextTypes'

export const PLAN_SPEC_VERSION = 1 as const
export const PLAN_DEFAULT_STEP_AGENT = 'PlanStep'
export const PLAN_MAX_STEPS = 20
export const PLAN_MAX_STEP_ID_LENGTH = 40
export const PLAN_MAX_STEP_TITLE_LENGTH = 80
export const PLAN_MAX_STEP_INSTRUCTIONS_LENGTH = 4_000
export const PLAN_MAX_STEP_ACCEPTANCE_LENGTH = 1_000
export const PLAN_MAX_REPORT_SUMMARY_BYTES = 8 * 1_024
export const PLAN_STEP_PROMPT_MAX_BYTES = 30 * 1_024
export const PLAN_MAX_REPLANS = 2
export const PLAN_DEFAULT_MAX_CONCURRENT = 3
export const PLAN_RUN_STATUSES = ['running', 'paused', 'completed', 'stopped'] as const
export const PLAN_STEP_STATUSES = [
  'pending',
  'launching',
  'running',
  'unknown',
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
export const PLAN_RUN_PAUSE_REASONS = [
  'user',
  'step_failed',
  'interrupted',
  'needs_input',
  'unknown'
] as const

export type PlanStepAccess = 'read' | 'write'

export const PLAN_STEP_CHECK_KINDS = [
  'file_exists',
  'non_empty_file',
  'json_valid',
  'table_schema'
] as const

export type PlanStepCheckKind = (typeof PLAN_STEP_CHECK_KINDS)[number]

/** Closed list of host-evaluated, read-only post-step objective checks (R12). */
export type PlanStepVerificationCheck =
  | { kind: 'file_exists'; path: string }
  | { kind: 'non_empty_file'; path: string }
  | { kind: 'json_valid'; path: string }
  | {
      kind: 'table_schema'
      path: string
      format?: 'tsv' | 'csv'
      minDataRows?: number
      minColumns?: number
      requiredColumns?: string[]
    }

export interface PlanStepVerificationResult {
  ok: boolean
  failures: string[]
}

export interface PlanStepInputContract {
  /** Project-relative path to an upstream artifact whose scientific context must be checked before launch (R14). */
  path: string
  expectedReferenceAssembly?: string
  /** Project-relative path to another artifact whose reference assembly must match this one. */
  mustMatchReferenceWith?: string
  requiredMatrixSemantics?: MatrixValueSemantics[]
  /** Project-relative path to another artifact whose sample IDs must match this one. */
  requireSampleMatchWith?: string
  requireDonorMapping?: boolean
}

export type PlanStepPreflightResult =
  | { status: 'compatible' }
  | { status: 'needs_input'; missingInputs: string[]; summary: string }
  | { status: 'incompatible'; reasons: string[] }

export interface PlanStep {
  id: string
  title: string
  instructions: string
  acceptance: string
  dependsOn: string[]
  access: PlanStepAccess
  writes?: string[]
  checks?: PlanStepVerificationCheck[]
  inputContracts?: PlanStepInputContract[]
  agent?: string
}

export interface PlanSpec {
  version: typeof PLAN_SPEC_VERSION
  /** User-confirmed question shared by scientific step handoffs. */
  researchQuestion?: string
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
  requestId?: string
  report?: PlanStepReportSummary
  error?: string
  startedAt?: string
  finishedAt?: string
  /** Last time the run durably knew this step was alive; used to stop interrupted durations. */
  lastSeenAt?: string
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

export interface PlanRunTimelineStepSnapshot {
  id: string
  title: string
  access: PlanStepAccess
  dependsOn: string[]
  agent?: string
  status: PlanStepStatus
  attempts: number
  agentRunId?: string
  startedAt?: string
  finishedAt?: string
  reportStatus?: PlanStepReportStatus
  missingInputs: string[]
  error?: string
}

export interface PlanRunTimelineSnapshot {
  id: string
  status: PlanRunStatus
  pause?: PlanRunPause
  replans: number
  createdAt: string
  updatedAt: string
  goal: string
  steps: PlanRunTimelineStepSnapshot[]
}

export interface ResearchPlanPausedEvent {
  type: 'research_plan_paused'
  runId: string
  stepId: string
  attempt: number
  reason: 'needs_input' | 'step_failed'
  originalQuestion: string
  report?: string
}

/** Identifies one paused attempt without persisting its scientific evidence a second time. */
export type ResearchPauseIdentity = Pick<ResearchPlanPausedEvent, 'runId' | 'stepId' | 'attempt'>

export function isResearchPause(state: PlanRunState): boolean {
  return Boolean(
    state.spec.researchQuestion &&
    state.status === 'paused' &&
    (state.pause?.reason === 'needs_input' || state.pause?.reason === 'step_failed')
  )
}

export interface PlanRunFinishedEvent {
  type: 'plan_run_finished'
  runId: string
  state: PlanRunState
}

export interface PlanRunSessionInput {
  phiSessionId: string
}

export interface PlanRunIdInput extends PlanRunSessionInput {
  runId: string
}

export interface PlanRunStepInput extends PlanRunIdInput {
  stepId: string
}

export interface PlanRunReplanRequest {
  requestId: string
  runId: string
  prompt: string
}

export interface PlanRunPendingReplan {
  requestId: string
  runId: string
}

export interface PlanRunReplanCancelInput extends PlanRunIdInput {
  requestId: string
}

export interface PlanRunRendererApi {
  listPlanRuns(phiSessionId: string): Promise<PlanRunState[]>
  getPlanRun(phiSessionId: string, runId: string): Promise<PlanRunState | null>
  getPendingPlanRunReplan(phiSessionId: string, runId: string): Promise<PlanRunPendingReplan | null>
  pausePlanRun(phiSessionId: string, runId: string): Promise<PlanRunState>
  resumePlanRun(phiSessionId: string, runId: string): Promise<PlanRunState>
  stopPlanRun(phiSessionId: string, runId: string): Promise<PlanRunState>
  retryPlanRunStep(phiSessionId: string, runId: string, stepId: string): Promise<PlanRunState>
  skipPlanRunStep(phiSessionId: string, runId: string, stepId: string): Promise<PlanRunState>
  requestPlanRunReplan(phiSessionId: string, runId: string): Promise<PlanRunReplanRequest>
  cancelPlanRunReplan(phiSessionId: string, runId: string, requestId: string): Promise<void>
}

export type PlanRunTransitionErrorCode =
  | 'RUN_FINISHED'
  | 'INVALID_RUN_STATUS'
  | 'STEP_NOT_FOUND'
  | 'INVALID_STEP_TRANSITION'
  | 'REPLAN_LIMIT_REACHED'
  | 'INVALID_REPLACEMENT'

export type PlanRunEvent =
  | { type: 'step_launch_requested'; stepId: string; requestId: string; at: string }
  | { type: 'step_launch_unknown'; stepId: string; requestId: string; at: string }
  | { type: 'step_launch_quiescent'; stepId: string; requestId: string; at: string }
  | { type: 'step_interrupted'; stepId: string; at: string }
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
  | {
      type: 'step_preflight_blocked'
      stepId: string
      reason: 'needs_input' | 'step_failed'
      report?: PlanStepReportSummary
      error?: string
      at: string
    }
  | { type: 'pause'; at: string }
  | { type: 'resume'; at: string }
  | { type: 'retry_step'; stepId: string; at: string }
  | { type: 'skip_step'; stepId: string; at: string }
  | { type: 'stop'; at: string }
  | { type: 'replace_remaining_steps'; spec: PlanSpec; at: string }
  | { type: 'recover_after_restart'; at: string }
