import { appendSessionEvent } from '../../session/session-store'
import type { SessionRun, SessionRunnerRegistry } from '../../session/session-runner-registry'
import { MAX_EXECUTION_CALLS } from '../phi-extension/lib/rpc-execution-protocol'
import type { RpcApprovalEvent } from './approval-bridge'

interface ChildApprovalRecord {
  readonly parent: SessionRun
  readonly childRunId: string
  readonly toolCallId: string
  readonly toolName: string
  terminal: boolean
}
export interface FacadeChildApprovalOptions {
  readonly phiSessionId: string
  readonly cwd: string
  readonly runners: SessionRunnerRegistry
  /** Notification only; this writer owns the sole durable approval record. */
  readonly notify?: (event: RpcApprovalEvent, parent: SessionRun) => void | Promise<void>
}

/** Stable child/parent identity survives late terminal notifications without changing a successor. */
export function createFacadeChildApprovalWriter(
  options: FacadeChildApprovalOptions
): (parent: SessionRun, event: RpcApprovalEvent) => void {
  const records = new Map<string, ChildApprovalRecord>()
  return (parent, event) => {
    const request = event.request
    if (
      parent.sessionId !== options.phiSessionId ||
      event.sessionId !== options.phiSessionId ||
      request.sessionId !== options.phiSessionId ||
      request.cwd !== options.cwd ||
      request.agentRunId !== event.runId ||
      request.runId !== event.runId ||
      request.requestId !== event.approvalId ||
      request.toolCallId !== event.toolCallId
    )
      throw new Error('Child approval durable identity differs from its parent')
    let record = records.get(event.approvalId)
    if (
      record &&
      (record.parent !== parent ||
        record.childRunId !== event.runId ||
        record.toolCallId !== event.toolCallId ||
        record.toolName !== request.toolName)
    )
      throw new Error('Child approval durable identity was replaced')
    if (record?.terminal || (record && event.type === 'approval_requested')) return
    if (event.type === 'approval_requested') {
      if (records.size >= MAX_EXECUTION_CALLS)
        throw new Error('Child approval record limit exceeded')
      record = {
        parent,
        childRunId: event.runId,
        toolCallId: event.toolCallId,
        toolName: request.toolName,
        terminal: false
      }
    } else if (!record) throw new Error('Child approval terminal has no persisted request')
    appendSessionEvent(options.phiSessionId, {
      type: event.type,
      runId: event.runId,
      agentRunId: event.runId,
      parentRunId: parent.runId,
      approvalId: event.approvalId,
      toolCallId: event.toolCallId,
      toolName: request.toolName,
      summary: request.summary,
      cwd: options.cwd
    })
    record.terminal = event.type !== 'approval_requested'
    records.set(event.approvalId, record)
    options.runners.setChildApprovalState(parent, event.approvalId, event.type)
    try {
      void Promise.resolve(options.notify?.(event, parent)).catch(() => undefined)
    } catch {
      /* Notification observers cannot change persistence or tool permission. */
    }
  }
}
