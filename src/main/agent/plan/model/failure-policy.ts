import { isRecord } from '../../../../shared/guards'
import {
  PLAN_MAX_REPORT_SUMMARY_BYTES,
  PLAN_STEP_REPORT_STATUSES,
  type PlanStepReportStatus,
  type PlanStepReportSummary,
  type PlanStepState
} from '../../../../shared/planRunTypes'
import { truncateUtf8 } from './utf8-truncate'

export type PlanFailureDecision = 'retry' | 'step_failed' | 'needs_input'

export interface PlanFailureInput {
  attempts: number
  report?: PlanStepReportSummary
  error?: string
}

export function decideFailurePolicy(input: PlanFailureInput): PlanFailureDecision {
  if (input.report?.missingInputs.length) return 'needs_input'
  return input.attempts < 2 ? 'retry' : 'step_failed'
}

export function normalizePlanStepReport(report: PlanStepReportSummary): PlanStepReportSummary {
  return {
    status: report.status,
    text: truncateUtf8(report.text, PLAN_MAX_REPORT_SUMMARY_BYTES),
    missingInputs: [...report.missingInputs]
  }
}

export function validatePlanStepReport(value: unknown): PlanStepReportSummary | null {
  if (!isRecord(value) || !PLAN_STEP_REPORT_STATUSES.includes(value.status as PlanStepReportStatus))
    return null
  if (typeof value.text !== 'string') return null
  if (new TextEncoder().encode(value.text).length > PLAN_MAX_REPORT_SUMMARY_BYTES) return null
  if (!Array.isArray(value.missingInputs)) return null
  if (!value.missingInputs.every((item) => typeof item === 'string')) return null
  return {
    status: value.status as PlanStepReportStatus,
    text: value.text,
    missingInputs: [...value.missingInputs]
  }
}

export function resolvePlanStepFailure(input: {
  current: PlanStepState
  report?: PlanStepReportSummary
  error?: string
  at: string
  needsInput: boolean
}): PlanStepState {
  const report = input.report ? normalizePlanStepReport(input.report) : undefined
  const decision = input.needsInput
    ? 'needs_input'
    : decideFailurePolicy({
        attempts: input.current.attempts,
        ...(report ? { report } : {}),
        ...(input.error ? { error: input.error } : {})
      })
  return {
    ...input.current,
    status: decision === 'retry' ? 'pending' : 'failed',
    ...(report ? { report } : {}),
    ...(input.error ? { error: input.error } : {}),
    finishedAt: input.at
  }
}
