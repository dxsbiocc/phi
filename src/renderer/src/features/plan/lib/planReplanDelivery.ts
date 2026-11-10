import type { PlanRunReplanRequest } from '../../../../../shared/planRunTypes'

export type OnReplanPrompt = (phiSessionId: string, prompt: string) => Promise<boolean | 'stopped'>

export type PendingReplanCancellation = {
  phiSessionId: string
  runId: string
  requestId: string
}

export class PlanReplanCancellationError extends Error {
  constructor(
    readonly pending: PendingReplanCancellation,
    cause: unknown
  ) {
    super('Unable to cancel the pending replan request.', { cause })
    this.name = 'PlanReplanCancellationError'
  }
}

export function retryPlanReplanCancellation(
  pending: PendingReplanCancellation,
  cancel: (phiSessionId: string, runId: string, requestId: string) => Promise<void>
): Promise<void> {
  return cancel(pending.phiSessionId, pending.runId, pending.requestId)
}

export async function deliverPlanReplanPrompt({
  request,
  phiSessionId,
  isCurrent,
  send,
  cancel
}: {
  request: PlanRunReplanRequest
  phiSessionId: string
  isCurrent: () => boolean
  send: OnReplanPrompt
  cancel: (requestId: string) => Promise<unknown>
}): Promise<boolean | 'stopped'> {
  const cancelRequest = async (): Promise<void> => {
    try {
      await cancel(request.requestId)
    } catch (cause) {
      throw new PlanReplanCancellationError(
        { phiSessionId, runId: request.runId, requestId: request.requestId },
        cause
      )
    }
  }

  if (!isCurrent()) {
    await cancelRequest()
    return false
  }

  try {
    const sent = await send(phiSessionId, request.prompt)
    if (sent === 'stopped') {
      // The turn is already stopped. A failed cleanup must not turn that user action into an
      // error on the paused run; the server binding is gone with the stopped turn.
      await cancelRequest().catch(() => undefined)
      return 'stopped'
    }
    if (sent) return true
  } catch (cause) {
    await cancelRequest()
    throw cause
  }

  await cancelRequest()
  return false
}
