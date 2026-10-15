import type { ChatItem, ChatMessage } from '../../../types'

export type ApprovalDetails = {
  status: 'pending' | 'approved' | 'denied' | 'cancelled'
  approvalId?: string
  sessionId?: string
  toolCallId?: string
  toolName: string
  summary: string
}

type ApprovalEvent = {
  type?: string
  eventId?: string
  approvalId?: string
  phiSessionId?: string
  sessionId?: string
  runId?: string
  toolCallId?: string
  toolName?: unknown
  summary?: unknown
  createdAt?: string
}

export const APPROVAL_STATUS_LABELS: Record<ApprovalDetails['status'], string> = {
  pending: '等待批准',
  approved: '已批准',
  denied: '已拒绝',
  cancelled: '已取消'
}

const STATUSES: Record<string, ApprovalDetails['status']> = {
  approval_requested: 'pending',
  approval_approved: 'approved',
  approval_denied: 'denied',
  approval_cancelled: 'cancelled'
}

export function approvalSummaryPreview(summary: string): string {
  const line =
    summary
      .split('\n')
      .find((line) => line.trim())
      ?.trim()
      .replace(/\s+/gu, ' ') ?? ''
  return line.length > 110 ? `${line.slice(0, 110)}…` : line
}

function approvalContent(approval: ApprovalDetails): string {
  return `${APPROVAL_STATUS_LABELS[approval.status]} ${approval.toolName}`
}

export function approvalItemFromEvent(event: ApprovalEvent): ChatMessage | null {
  const type = event.type ?? ''
  const status = Object.hasOwn(STATUSES, type) ? STATUSES[type] : undefined
  if (!status) return null
  const id = event.eventId ?? `approval-${event.approvalId ?? event.runId ?? 'legacy'}-${status}`
  const hasIdentity = event.approvalId || (event.runId && event.toolCallId)
  if (!hasIdentity && status !== 'pending') {
    return {
      id,
      role: status === 'denied' ? 'error' : 'warning',
      content: `权限请求${APPROVAL_STATUS_LABELS[status]}。`,
      ...(event.runId ? { runId: event.runId } : {}),
      ...(event.createdAt ? { createdAt: event.createdAt } : {})
    }
  }
  const sessionId = event.phiSessionId || event.sessionId
  const approval: ApprovalDetails = {
    status,
    ...(event.approvalId ? { approvalId: event.approvalId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),
    toolName: typeof event.toolName === 'string' && event.toolName ? event.toolName : '工具调用',
    summary: typeof event.summary === 'string' ? event.summary : ''
  }
  return {
    id,
    role: status === 'denied' ? 'error' : 'warning',
    content: approvalContent(approval),
    approval,
    ...(event.runId ? { runId: event.runId } : {}),
    ...(event.createdAt ? { createdAt: event.createdAt } : {}),
    ...(status !== 'pending' && event.createdAt ? { completedAt: event.createdAt } : {})
  }
}

function compatibleIdentity(left: ChatMessage, right: ChatMessage): boolean {
  return [
    [left.runId, right.runId],
    [left.approval?.sessionId, right.approval?.sessionId],
    [left.approval?.toolCallId, right.approval?.toolCallId]
  ].every(([left, right]) => !left || !right || left === right)
}

function sameApproval(left: ChatMessage, right: ChatMessage): boolean {
  if (!left.approval || !right.approval || !compatibleIdentity(left, right)) return false
  const leftId = left.approval.approvalId
  const rightId = right.approval.approvalId
  if (leftId || rightId) return Boolean(leftId && leftId === rightId)
  // Old records are joinable only with a complete run + tool-call identity.
  return Boolean(
    left.runId &&
    left.runId === right.runId &&
    left.approval.toolCallId &&
    left.approval.toolCallId === right.approval.toolCallId
  )
}

/** Used by streaming and history restoration so replay never revives a resolved request. */
export function applyApprovalTimelineEvent(items: ChatItem[], event: ApprovalEvent): boolean {
  const incoming = approvalItemFromEvent(event)
  if (!incoming) return false
  const matches = items.flatMap((item, index) =>
    (item.role === 'warning' || item.role === 'error') && sameApproval(item, incoming)
      ? [index]
      : []
  )
  const index = matches.length === 1 ? matches[0] : -1
  if (index < 0 || !incoming.approval) {
    if (event.eventId && items.some((item) => item.id === event.eventId)) return true
    const id = items.some((item) => item.id === incoming.id)
      ? `${incoming.id}-${items.length}`
      : incoming.id
    items.push({ ...incoming, id })
    return true
  }
  const current = items[index] as ChatMessage
  const previous = current.approval!
  const next = incoming.approval
  // A terminal decision is final. Late/replayed requests only supply missing metadata.
  const status = previous.status === 'pending' ? next.status : previous.status
  const approval: ApprovalDetails = {
    ...next,
    ...previous,
    status,
    sessionId: previous.sessionId ?? next.sessionId,
    toolCallId: previous.toolCallId ?? next.toolCallId,
    toolName: previous.toolName === '工具调用' ? next.toolName : previous.toolName,
    summary: previous.summary || next.summary
  }
  items[index] = {
    ...current,
    role: status === 'denied' ? 'error' : 'warning',
    content: approvalContent(approval),
    approval,
    ...(current.runId || incoming.runId ? { runId: current.runId ?? incoming.runId } : {}),
    ...(next.status === 'pending' && incoming.createdAt ? { createdAt: incoming.createdAt } : {}),
    ...(previous.status === 'pending' && next.status !== 'pending' && incoming.completedAt
      ? { completedAt: incoming.completedAt }
      : {})
  }
  return true
}
