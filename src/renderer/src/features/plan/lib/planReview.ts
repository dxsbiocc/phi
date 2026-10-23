import type { AgentUserInteractionResponse, ChatItem, PlanReviewItem } from '../../../types'
import { isRecord } from '../../../../../shared/guards'
import type { PlanSpec, PlanStep } from '../../../../../shared/planRunTypes'

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
  const writes = Array.isArray(value.writes)
    ? value.writes.filter((path): path is string => typeof path === 'string')
    : undefined
  return {
    id: value.id,
    title: value.title,
    instructions: value.instructions,
    acceptance: value.acceptance,
    access: value.access,
    dependsOn: value.dependsOn,
    ...(writes ? { writes } : {}),
    ...(typeof value.agent === 'string' ? { agent: value.agent } : {})
  }
}

function planSpecFromUnknown(value: unknown): PlanSpec | undefined {
  if (!isRecord(value) || value.version !== 1 || typeof value.goal !== 'string') return undefined
  if (!Array.isArray(value.steps) || value.steps.length === 0) return undefined
  const steps = value.steps.map(planStepFromUnknown)
  if (steps.some((step) => step === null)) return undefined
  return { version: 1, goal: value.goal, steps: steps.filter((step) => step !== null) }
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
