import { errorMessage } from '../../../shared/errorCodes'
import { isRecord } from '../../../shared/guards'
import type { PhiEngine, ToolApprovalRequest } from '../engine/types'

export type ToolCallHandler = (
  event: {
    type?: 'tool_call'
    toolCallId?: string
    toolName: string
    input: Record<string, unknown>
    agentRunId?: string
    outsideProject?: string
  },
  context: { signal?: AbortSignal }
) => Promise<unknown> | unknown

export function subscribeRuntimeApprovals(
  events: Pick<PhiEngine['events'], 'onToolApproval' | 'onSessionEvent' | 'respondToolApproval'>,
  sessionId: string,
  handlers: readonly ToolCallHandler[],
  sessionAbort: AbortSignal
): () => void {
  const pending = new Map<string, AbortController>()

  async function resolve(request: ToolApprovalRequest, signal: AbortSignal): Promise<void> {
    let result: unknown
    try {
      for (const handler of handlers) {
        signal.throwIfAborted()
        const decision = await handler(
          {
            type: 'tool_call',
            toolCallId: request.toolCallId ?? request.requestId,
            toolName: request.toolName ?? '',
            input: request.input ?? {},
            ...(request.agentRunId ? { agentRunId: request.agentRunId } : {}),
            ...(request.outsideProject ? { outsideProject: request.outsideProject } : {})
          },
          { signal }
        )
        if (decision !== undefined) result = decision
      }
    } catch (error) {
      result = { block: true, reason: errorMessage(error) }
    }
    await events.respondToolApproval(request.requestId, result)
  }

  const unsubscribeApproval = events.onToolApproval(sessionId, (value) => {
    const request = value as ToolApprovalRequest
    if (pending.has(request.requestId)) return
    const controller = new AbortController()
    pending.set(request.requestId, controller)
    void resolve(request, AbortSignal.any([sessionAbort, controller.signal]))
      .catch((error: unknown) =>
        console.error('Failed to return tool approval:', errorMessage(error))
      )
      .finally(() => pending.delete(request.requestId))
  })
  const unsubscribeCancellation = events.onSessionEvent(sessionId, (event) => {
    if (
      event.type === 'interaction_cancelled' &&
      isRecord(event) &&
      event.kind === 'approval' &&
      typeof event.id === 'string'
    ) {
      pending.get(event.id)?.abort()
    }
  })
  return () => {
    unsubscribeApproval()
    unsubscribeCancellation()
    for (const controller of pending.values()) controller.abort()
  }
}
