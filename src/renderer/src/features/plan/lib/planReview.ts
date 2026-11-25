import type { AgentUserInteractionResponse, ChatItem, PlanReviewItem } from '../../../types'
import { isRecord } from '../../../../../shared/guards'
import { isResearchQuestion } from '../../../../../shared/kernel-protocol/research-question'
import type { PlanSpec, PlanStep } from '../../../../../shared/planRunTypes'

function readStringList(value: unknown): string[] | undefined {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : undefined
}

function readRecordList<T>(value: unknown): T[] | undefined {
  if (!Array.isArray(value)) return undefined
  const filtered = value.filter(isRecord) as unknown as T[]
  return filtered.length > 0 ? filtered : undefined
}

function optionalStepArrays(value: Record<string, unknown>): Partial<PlanStep> {
  const writes = readStringList(value.writes)
  const hypothesisIds = readStringList(value.hypothesisIds)
  const checks = readRecordList<NonNullable<PlanStep['checks']>[number]>(value.checks)
  const inputContracts = readRecordList<NonNullable<PlanStep['inputContracts']>[number]>(
    value.inputContracts
  )
  const extra: Partial<PlanStep> = {}
  if (writes) extra.writes = writes
  if (checks) extra.checks = checks
  if (inputContracts) extra.inputContracts = inputContracts
  if (hypothesisIds?.length) extra.hypothesisIds = hypothesisIds
  if (typeof value.agent === 'string') extra.agent = value.agent
  return extra
}

function planStepFromUnknown(value: unknown): PlanStep | null {
  if (!isRecord(value)) return null
  if (
    typeof value.id !== 'string' ||
    typeof value.title !== 'string' ||
    typeof value.instructions !== 'string' ||
    typeof value.acceptance !== 'string' ||
    (value.access !== 'read' && value.access !== 'write') ||
    !Array.isArray(value.dependsOn) ||
    !value.dependsOn.every((id) => typeof id === 'string')
  )
    return null
  return {
    id: value.id,
    title: value.title,
    instructions: value.instructions,
    acceptance: value.acceptance,
    access: value.access,
    dependsOn: value.dependsOn,
    ...optionalStepArrays(value)
  }
}

function planSpecFromUnknown(value: unknown): PlanSpec | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.goal !== 'string') return undefined
  if (!Array.isArray(value.steps) || value.steps.length === 0) return undefined
  const steps = value.steps.map(planStepFromUnknown)
  if (steps.some((step) => step === null)) return undefined
  const researchQuestion = value.researchQuestion
  if (researchQuestion !== undefined && !isResearchQuestion(researchQuestion)) return undefined
  const literatureReview = isRecord(value.literatureReview)
    ? (value.literatureReview as unknown as PlanSpec['literatureReview'])
    : undefined
  const hypotheses = Array.isArray(value.hypotheses)
    ? (value.hypotheses.filter(isRecord) as unknown as PlanSpec['hypotheses'])
    : undefined
  return {
    version: 1,
    goal: value.goal,
    ...(researchQuestion ? { researchQuestion } : {}),
    ...(literatureReview ? { literatureReview } : {}),
    ...(hypotheses?.length ? { hypotheses } : {}),
    steps: steps.filter((step) => step !== null)
  }
}

export function planReviewResponse(
  requestId: string,
  decision: 'approve' | 'revise',
  note = ''
): AgentUserInteractionResponse {
  return {
    requestId,
    answers: [{ questionIndex: 0, question: 'plan_review', kind: 'option', answer: decision }],
    ...(decision === 'revise' && note.trim() ? { globalNote: note.trim() } : {})
  }
}

export function planReviewItemFromEvent(event: {
  type?: string
  eventId?: string
  reviewId?: string
  runId?: string
  createdAt?: string
  title?: unknown
  content?: unknown
  planFilePath?: unknown
  steps?: unknown
}): PlanReviewItem | null {
  if (
    event.type !== 'plan_review_submitted' ||
    typeof event.reviewId !== 'string' ||
    typeof event.title !== 'string' ||
    typeof event.content !== 'string' ||
    typeof event.planFilePath !== 'string'
  )
    return null
  const steps = planSpecFromUnknown(event.steps)
  return {
    id: event.eventId ?? `plan-review-${event.reviewId}`,
    role: 'plan_review',
    reviewId: event.reviewId,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.createdAt ? { createdAt: event.createdAt } : {}),
    title: event.title,
    content: event.content,
    planFilePath: event.planFilePath,
    ...(steps ? { steps } : {}),
    status: 'pending'
  }
}

export function applyPlanReviewDecision(
  items: ChatItem[],
  event: { type?: string; reviewId?: string; decision?: unknown; note?: unknown }
): boolean {
  if (event.type !== 'plan_review_decided' || typeof event.reviewId !== 'string') return false
  const status =
    event.decision === 'approve'
      ? 'approved'
      : event.decision === 'revise'
        ? 'revise'
        : event.decision === 'cancel'
          ? 'cancelled'
          : null
  if (!status) return true
  const index = items.findIndex(
    (item) => item.role === 'plan_review' && item.reviewId === event.reviewId
  )
  if (index >= 0) {
    items[index] = {
      ...(items[index] as PlanReviewItem),
      status,
      ...(status === 'revise' && typeof event.note === 'string' && event.note
        ? { note: event.note }
        : {})
    }
  }
  return true
}

/**
 * The confirmation panel is the plan surface until the user decides.
 * An approved plan stays out of the transcript; the finished run record replaces it.
 * A pending plan with no open confirmation (for example after a reload) stays visible.
 */
export function planReviewShownInTranscript(
  item: PlanReviewItem,
  openReviewId: string | null
): boolean {
  if (item.status === 'pending') return item.reviewId !== openReviewId
  if (item.status === 'approved') return false
  return true
}
