import type {
  PhiSessionManifest,
  SessionEventInput,
  StoredSessionEvent
} from '../session/session-store'
import type { AgentRunOrigin } from './registry'

type Decision = 'approved' | 'denied' | 'cancelled'

export interface BackgroundApprovalRequest {
  sessionId: string
  agentRunId: string
  approvalId: string
  toolName: string
  summary: string
  cwd: string
}

export interface BackgroundApprovalDependencies {
  readManifest: (sessionId: string) => PhiSessionManifest | null
  resolveRunOrigin?: (
    request: BackgroundApprovalRequest
  ) => AgentRunOrigin | undefined | Promise<AgentRunOrigin | undefined>
  appendEvent: (sessionId: string, event: SessionEventInput) => StoredSessionEvent
  updateManifest: (sessionId: string, patch: Partial<PhiSessionManifest>) => void
  onEvent: (sessionId: string, event: StoredSessionEvent) => void
  onChange: () => void
}

type PendingSession = {
  previousStatus: PhiSessionManifest['status']
  previousUnread: PhiSessionManifest['unreadKind']
  approvals: Set<string>
  denied: boolean
}

type PendingApproval = {
  request: BackgroundApprovalRequest
  origin: Promise<AgentRunOrigin>
}

function resolveRunOrigin(
  dependencies: BackgroundApprovalDependencies,
  request: BackgroundApprovalRequest
): Promise<AgentRunOrigin> {
  try {
    return Promise.resolve(dependencies.resolveRunOrigin?.(request))
      .then((value) => (value === 'host' ? 'host' : 'tool'))
      .catch(() => 'tool' as const)
  } catch {
    return Promise.resolve('tool')
  }
}

export function createBackgroundApprovalRunOriginResolver(dependencies: {
  listRuns: () => Promise<unknown>
  resolveSession: (runtimeSessionId: string) => { phiSessionId: string } | undefined
}): (request: BackgroundApprovalRequest) => Promise<AgentRunOrigin> {
  return async (request) => {
    const runs = await dependencies.listRuns()
    if (!Array.isArray(runs)) return 'tool'
    for (const value of runs) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) continue
      const run = value as Record<string, unknown>
      if (run.agentRunId !== request.agentRunId || typeof run.agentSessionId !== 'string') continue
      if (dependencies.resolveSession(run.agentSessionId)?.phiSessionId !== request.sessionId)
        continue
      return run.origin === 'host' ? 'host' : 'tool'
    }
    return 'tool'
  }
}

/** Persists specialist approvals after the parent model turn has completed. */
export class BackgroundAgentApprovalTracker {
  private readonly pendingById = new Map<string, PendingApproval>()
  private readonly pendingBySession = new Map<string, PendingSession>()

  constructor(private readonly dependencies: BackgroundApprovalDependencies) {}

  requested(request: BackgroundApprovalRequest): void {
    if (this.pendingById.has(request.approvalId)) return
    const manifest = this.dependencies.readManifest(request.sessionId)
    if (!manifest) return
    let session = this.pendingBySession.get(request.sessionId)
    if (!session) {
      session = {
        previousStatus: manifest.status,
        previousUnread: manifest.unreadKind,
        approvals: new Set(),
        denied: false
      }
      this.pendingBySession.set(request.sessionId, session)
    }
    session.approvals.add(request.approvalId)
    this.pendingById.set(request.approvalId, {
      request,
      origin: resolveRunOrigin(this.dependencies, request)
    })
    this.emit(request, 'approval_requested', {
      toolName: request.toolName,
      summary: request.summary
    })
    this.dependencies.updateManifest(request.sessionId, {
      status: 'needs_approval',
      unreadKind: 'approval'
    })
    this.dependencies.onChange()
  }

  async resolved(approvalId: string, decision: Decision): Promise<void> {
    const pending = this.pendingById.get(approvalId)
    if (!pending) return
    this.pendingById.delete(approvalId)
    const { request } = pending
    const session = this.pendingBySession.get(request.sessionId)
    if (!session) return
    this.emit(request, `approval_${decision}`)
    const origin = await pending.origin
    session.approvals.delete(approvalId)
    if (decision === 'denied' && origin !== 'host') session.denied = true
    if (session.approvals.size > 0) return
    this.pendingBySession.delete(request.sessionId)
    const manifest = this.dependencies.readManifest(request.sessionId)
    if (manifest?.status === 'needs_approval') {
      this.dependencies.updateManifest(
        request.sessionId,
        session.denied
          ? { status: 'failed', unreadKind: 'failed', lastRunOutcome: 'failed' }
          : { status: session.previousStatus, unreadKind: session.previousUnread }
      )
    }
    this.dependencies.onChange()
  }

  /** A parent turn can finish while its background specialist is waiting for approval. */
  afterParentRunSettled(sessionId: string): void {
    const pending = this.pendingBySession.get(sessionId)
    if (!pending) return
    const manifest = this.dependencies.readManifest(sessionId)
    if (!manifest) return
    pending.previousStatus = manifest.status
    pending.previousUnread = manifest.unreadKind
    this.dependencies.updateManifest(sessionId, {
      status: 'needs_approval',
      unreadKind: 'approval'
    })
    this.dependencies.onChange()
  }

  private emit(
    request: BackgroundApprovalRequest,
    type: string,
    metadata: Record<string, unknown> = {}
  ): void {
    const event = this.dependencies.appendEvent(request.sessionId, {
      type,
      runId: request.agentRunId,
      agentRunId: request.agentRunId,
      approvalId: request.approvalId,
      cwd: request.cwd,
      ...metadata
    })
    this.dependencies.onEvent(request.sessionId, event)
  }
}
