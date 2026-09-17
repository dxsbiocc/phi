import type { AgentEventSummary, SessionRuntimeState } from '../types'

export function sessionStatusIsBusy(
  session: Pick<SessionRuntimeState, 'status'> | null | undefined
): boolean {
  return (
    session?.status === 'running' ||
    session?.status === 'needs_approval' ||
    session?.status === 'needs_input'
  )
}

export function idleSessionRuntimeState(): SessionRuntimeState {
  return { status: 'idle', unreadKind: null }
}

export function sessionRuntimeStateFrom(
  input: Partial<SessionRuntimeState> | null | undefined
): SessionRuntimeState {
  return {
    status: input?.status ?? 'idle',
    unreadKind: input?.unreadKind ?? null,
    lastRunOutcome: input?.lastRunOutcome,
    currentRunId: input?.currentRunId,
    currentRunStartedAt: input?.currentRunStartedAt,
    lastActivityAt: input?.lastActivityAt
  }
}

export function sessionRuntimeStateIsBusy(state: SessionRuntimeState | null | undefined): boolean {
  return sessionStatusIsBusy(state)
}

export function sessionRuntimeStateNeedsAcknowledgement(
  state: Pick<SessionRuntimeState, 'unreadKind'> | null | undefined
): boolean {
  return state?.unreadKind === 'completed' || state?.unreadKind === 'failed'
}

function sessionRuntimeStateHasTerminalSignal(state: SessionRuntimeState): boolean {
  return (
    state.status === 'failed' ||
    state.status === 'completed_unread' ||
    state.unreadKind === 'failed' ||
    state.unreadKind === 'completed' ||
    state.lastRunOutcome === 'completed' ||
    state.lastRunOutcome === 'failed' ||
    state.lastRunOutcome === 'interrupted' ||
    state.lastRunOutcome === 'stopped'
  )
}

export function mergeSessionRuntimeState(
  previous: SessionRuntimeState | null | undefined,
  incoming: Partial<SessionRuntimeState> | null | undefined,
  options: { preserveBusy?: boolean } = {}
): SessionRuntimeState {
  const next = sessionRuntimeStateFrom(incoming)
  if (!previous) return next

  const current = sessionRuntimeStateFrom(previous)
  if (
    options.preserveBusy !== false &&
    sessionRuntimeStateIsBusy(current) &&
    !sessionRuntimeStateIsBusy(next)
  ) {
    const sameRun =
      !current.currentRunId || !next.currentRunId || current.currentRunId === next.currentRunId
    if (sameRun && !sessionRuntimeStateHasTerminalSignal(next)) {
      return current
    }
  }

  return next
}

export function sessionRuntimeStatesEqual(
  left: SessionRuntimeState | null | undefined,
  right: SessionRuntimeState | null | undefined
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.status === right.status &&
    left.unreadKind === right.unreadKind &&
    left.lastRunOutcome === right.lastRunOutcome &&
    left.currentRunId === right.currentRunId &&
    left.currentRunStartedAt === right.currentRunStartedAt &&
    left.lastActivityAt === right.lastActivityAt
  )
}

export function reduceSessionRuntimeState(
  previous: SessionRuntimeState,
  event: AgentEventSummary
): SessionRuntimeState {
  const timestamp = typeof event.createdAt === 'string' ? event.createdAt : previous.lastActivityAt
  const runId = typeof event.runId === 'string' ? event.runId : previous.currentRunId

  if (event.type === 'run_started') {
    return {
      status: 'running',
      unreadKind: null,
      currentRunId: runId,
      currentRunStartedAt: timestamp,
      lastActivityAt: timestamp
    }
  }

  if (event.type === 'approval_requested') {
    return {
      ...previous,
      status: 'needs_approval',
      unreadKind: 'approval',
      currentRunId: runId,
      lastActivityAt: timestamp
    }
  }

  if (event.type === 'input_requested') {
    return {
      ...previous,
      status: 'needs_input',
      unreadKind: 'input',
      currentRunId: runId,
      lastActivityAt: timestamp
    }
  }

  if (event.type === 'approval_approved' || event.type === 'run_resumed') {
    return {
      ...previous,
      status: 'running',
      unreadKind: null,
      currentRunId: runId,
      lastActivityAt: timestamp
    }
  }

  if (event.type === 'input_answered' || event.type === 'input_cancelled') {
    return {
      ...previous,
      status: 'running',
      unreadKind: null,
      currentRunId: runId,
      lastActivityAt: timestamp
    }
  }

  if (event.type === 'run_failed' || event.type === 'approval_denied') {
    return {
      status: 'failed',
      unreadKind: 'failed',
      lastRunOutcome: 'failed',
      lastActivityAt: timestamp
    }
  }

  if (event.type === 'run_interrupted' || event.type === 'approval_cancelled') {
    return {
      status: 'idle',
      unreadKind: null,
      lastRunOutcome: event.type === 'run_interrupted' ? 'interrupted' : previous.lastRunOutcome,
      lastActivityAt: timestamp
    }
  }

  if (event.type === 'run_completed') {
    return {
      status: 'completed_unread',
      unreadKind: 'completed',
      lastRunOutcome: 'completed',
      lastActivityAt: timestamp
    }
  }

  return previous
}
