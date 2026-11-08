import type {
  InteractionCancelledPayload,
  KernelEventFrame,
  ProtocolError
} from '../../shared/kernel-protocol'
import { makeProtocolError } from '../protocol/errors'

type ApprovalState = 'answered' | 'cancelled'

export interface PendingApproval {
  readonly event: KernelEventFrame
  readonly generation: number
}

export class KernelApprovalTracker {
  private readonly pending = new Map<string, PendingApproval>()
  private readonly tombstones = new Map<string, ApprovalState>()

  constructor(private readonly capacity: number) {}

  add(approvalId: string, event: KernelEventFrame, generation: number): void {
    this.pending.set(approvalId, { event, generation })
  }

  reserveAnswer(approvalId: string, sessionId?: string): PendingApproval | ProtocolError {
    const pending = this.pending.get(approvalId)
    if (!pending) {
      const state = this.tombstones.get(approvalId)
      if (state === 'cancelled') {
        return makeProtocolError('CANCELLED', 'The approval request was cancelled.')
      }
      if (state === 'answered') {
        return makeProtocolError('DUPLICATE_REQUEST', 'The approval request was already answered.')
      }
      return makeProtocolError('INVALID_PARAMS', 'The approval request is unknown.')
    }
    // A caller that names a session may only answer that session's approval. Leave the
    // pending entry intact so the owning session can still decide it.
    if (sessionId !== undefined && pending.event.sessionId !== sessionId) {
      return makeProtocolError('INVALID_PARAMS', 'The approval request belongs to another session.')
    }
    this.pending.delete(approvalId)
    this.remember(approvalId, 'answered')
    return pending
  }

  cancelRun(sessionId: string, runId: string): Array<[string, PendingApproval]> {
    return this.cancelMatching(
      ({ event }) => event.sessionId === sessionId && event.runId === runId
    )
  }

  cancelAgentRun(sessionId: string, agentRunId: string): Array<[string, PendingApproval]> {
    return this.cancelMatching(({ event }) => {
      if (event.sessionId !== sessionId || event.type !== 'approval.requested') return false
      const payload = event.payload
      return (
        payload !== null &&
        typeof payload === 'object' &&
        !Array.isArray(payload) &&
        payload.agentRunId === agentRunId
      )
    })
  }

  cancelSession(sessionId: string): Array<[string, PendingApproval]> {
    return this.cancelMatching(({ event }) => event.sessionId === sessionId)
  }

  cancelAll(): Array<[string, PendingApproval]> {
    return this.cancelMatching(() => true)
  }

  entries(): IterableIterator<[string, PendingApproval]> {
    return this.pending.entries()
  }

  ids(): IterableIterator<string> {
    return this.pending.keys()
  }

  get(approvalId: string): PendingApproval | undefined {
    return this.pending.get(approvalId)
  }

  private cancelMatching(
    predicate: (pending: PendingApproval) => boolean
  ): Array<[string, PendingApproval]> {
    const cancelled: Array<[string, PendingApproval]> = []
    for (const [approvalId, pending] of this.pending) {
      if (!predicate(pending)) continue
      this.pending.delete(approvalId)
      this.remember(approvalId, 'cancelled')
      cancelled.push([approvalId, pending])
    }
    return cancelled
  }

  private remember(approvalId: string, state: ApprovalState): void {
    this.tombstones.delete(approvalId)
    this.tombstones.set(approvalId, state)
    if (this.tombstones.size <= this.capacity) return
    const oldest = this.tombstones.keys().next().value
    if (oldest !== undefined) this.tombstones.delete(oldest)
  }
}

export function approvalCancellationPayload(
  approvalId: string,
  pending: PendingApproval,
  reason: string
): InteractionCancelledPayload | undefined {
  if (!pending.event.sessionId) return undefined
  return {
    kind: 'approval',
    id: approvalId,
    sessionId: pending.event.sessionId,
    ...(pending.event.runId ? { runId: pending.event.runId } : {}),
    reason
  }
}
