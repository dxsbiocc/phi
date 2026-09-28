import type { AgentUserInteractionResponse, ChatItem, PlanReviewItem } from '../../../types'

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
}): PlanReviewItem | null {
  if (
    event.type !== 'plan_review_submitted' ||
    typeof event.reviewId !== 'string' ||
    typeof event.title !== 'string' ||
    typeof event.content !== 'string' ||
    typeof event.planFilePath !== 'string'
  )
    return null
  return {
    id: event.eventId ?? `plan-review-${event.reviewId}`,
    role: 'plan_review',
    reviewId: event.reviewId,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.createdAt ? { createdAt: event.createdAt } : {}),
    title: event.title,
    content: event.content,
    planFilePath: event.planFilePath,
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
