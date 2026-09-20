import {
  buildWrapperRunFinishedEvent,
  isWrapperRunEndState,
  wrapperRunNotice,
  type WrapperRunFinishedEvent
} from '../../../../shared/wrapperRunNotice'
import type { WrapperRun } from '../types'

/**
 * Tells the user a background wrapper run has ended: a notice in the
 * conversation that started it (persisted, so it is still there when they
 * switch back) and, when Phi is not in the foreground, an OS notification.
 * Everything that touches the app is injected; failures in one channel never
 * stop the other.
 */
export interface WrapperRunNotifyDeps {
  /** Maps the runtime session that started the run to its Phi conversation, if it is still known. */
  resolveSession: (
    originSessionId: string | undefined
  ) => { phiSessionId: string; cwd: string } | undefined
  /** Persists an event in that conversation's timeline and returns the stored form. */
  appendToSession: (phiSessionId: string, event: WrapperRunFinishedEvent) => Record<string, unknown>
  sendToWindow: (payload: Record<string, unknown>) => void
  isAppFocused: () => boolean
  showOsNotification: (notification: { title: string; body: string }) => void
  /**
   * Called when the conversation that started the run is known, so it can decide to
   * wake the agent (see `job-continue.ts`). Optional; a throw here is contained.
   */
  continueConversation?: (
    phiSessionId: string,
    event: WrapperRunFinishedEvent,
    run: WrapperRun
  ) => void
}

export function deliverWrapperRunFinished(
  run: WrapperRun,
  status: { elapsedSeconds: number; missingOutputs?: string[] },
  deps: WrapperRunNotifyDeps
): void {
  if (!isWrapperRunEndState(run.state)) return
  const event = buildWrapperRunFinishedEvent(run, status)

  const origin = deps.resolveSession(run.originSessionId)
  if (origin) {
    try {
      const stored = deps.appendToSession(origin.phiSessionId, event)
      deps.sendToWindow({
        source: 'phi',
        ...stored,
        phiSessionId: origin.phiSessionId,
        cwd: origin.cwd
      })
    } catch {
      // The OS notification below still tells the user.
    }
    try {
      deps.continueConversation?.(origin.phiSessionId, event, run)
    } catch {
      // Waking the agent is an extra; never let it get in the way of telling the user.
    }
  }

  // A user who just cancelled a run knows it ended; only unexpected endings pop up.
  if (event.state === 'cancelled' || deps.isAppFocused()) return
  try {
    deps.showOsNotification(wrapperRunNotice(event))
  } catch {
    // Notifications are best-effort (unsupported platform, permission denied).
  }
}
