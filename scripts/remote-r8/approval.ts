import type { SessionRunnerRegistry } from '../../src/main/agent/session/session-runner-registry'
import type { ApprovalPolicy } from './application-types'

/** Denies everything that needs approval until a case installs its own policy. */
export const DENY_WRITES: ApprovalPolicy = {
  shouldGate: (request) => ['write', 'bash'].includes(request.toolName),
  requestToolApproval: () => 'denied'
}

/**
 * The production approval wiring: gating and decisions come from the current policy, and the
 * Runner records every approval event exactly like the application's single Main writer.
 */
export function runnerApproval(
  runners: SessionRunnerRegistry,
  current: () => ApprovalPolicy
): ApprovalPolicy {
  return {
    shouldGate: (request) => current().shouldGate(request),
    requestToolApproval: (request, signal) => current().requestToolApproval(request, signal),
    onEvent: (event) => {
      const run = runners.getActiveRun(event.sessionId)
      if (!run || run.runId !== event.runId) return
      if (event.type === 'approval_requested')
        runners.markNeedsApproval(event.sessionId, event.approvalId, {
          toolName: event.request.toolName,
          summary: event.request.summary
        })
      else if (event.type === 'approval_approved')
        runners.markApprovalApproved(event.sessionId, event.approvalId)
      else if (event.type === 'approval_denied')
        runners.markApprovalDenied(event.sessionId, event.approvalId)
      else runners.markApprovalCancelled(event.sessionId, event.approvalId)
      return current().onEvent?.(event)
    }
  }
}
