import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

import type { ManualCompactionTarget } from '../../../../../shared/contextUsageTypes'
import type { getRendererApi } from '../../../lib/rendererApi'
import type { PromptTarget } from '../../../lib/sessionTypes'
import { useSessionStore } from '../../../stores/sessionStore'
import type { QueuedPrompt, SendPromptOptions } from '../lib/promptQueue'
import { useManualCompaction } from './useManualCompaction'
import { usePromptQueue } from './usePromptQueue'

/**
 * Chat run control: "is this session running, what is waiting behind it, and how
 * do I stop or compact it?"
 *
 * These answers share one lifetime. A queued prompt only exists because a run is
 * in flight; stopping a run clears the same interactions the queue waits behind;
 * compaction is the third way a session can be busy. This hook is the single
 * entry point for the shell; the queue and compaction rules live in their own
 * hooks so each stays small and testable.
 *
 * What deliberately stays in the shell for now:
 *
 * - `isBusy` is the provider-auth gate (`useProviderAuth(setIsBusy, ...)`), not a
 *   chat run flag.
 * - The send lifecycle tokens (`sendRequestRef` / `isSendingRef`) stay there until
 *   `sendPromptText` itself moves; a hook must not return refs, and the send
 *   pipeline is the only writer. The hook reads them for stop.
 * - The queue drain effect stays next to `sendPromptText`, because draining a
 *   prompt means sending it; item 4 moves both together.
 */

/** The slice of the renderer bridge that run control talks to. */
export type ChatRunControlApi = Pick<
  ReturnType<typeof getRendererApi>,
  'stopGeneration' | 'compactCurrentSession'
>

export type ChatRunControlDeps = {
  /** Draft key of the visible session; queued prompts are owned per session. */
  activeDraftKey: string
  rendererApi: ChatRunControlApi
  /** Send lifecycle token, incremented per dispatched prompt. Owned by the shell. */
  sendRequestRef: { current: number }
  /** Mirrors "a send is in flight"; owned by the shell until the send pipeline moves. */
  isSendingRef: { current: boolean }
  setIsSendingMessage: Dispatch<SetStateAction<boolean>>
  setActiveInput: (value: string) => void
  clearPendingInteractions: () => void
  showSnackbar: (message: string, severity?: 'error' | 'success' | 'info' | 'warning') => void
  showSnackbarError: (error: unknown, fallback: string) => void
}

export type ChatRunControl = {
  /** Compactions that have started, keyed by session identity. Render truth. */
  compactingSessions: Set<string>
  /** Dispatch-time guard: also sees compactions that started since the last render. */
  isCompactingKey: (key: string) => boolean
  contextUsageRefreshKey: number
  refreshContextUsage: () => void
  activeQueuedPrompts: QueuedPrompt[]
  queuePromptText: (text: string, target: PromptTarget, sendOptions?: SendPromptOptions) => void
  removeQueuedPrompt: (id: string) => void
  dequeueQueuedPrompt: (id: string) => void
  moveQueuedPromptsToSession: (targetKey: string, target: PromptTarget) => void
  onStopGeneration: () => Promise<void>
  onCompactContext: (target: ManualCompactionTarget) => Promise<void>
}

export function useChatRunControl(deps: ChatRunControlDeps): ChatRunControl {
  const {
    activeDraftKey,
    rendererApi,
    sendRequestRef,
    isSendingRef,
    setIsSendingMessage,
    setActiveInput,
    clearPendingInteractions,
    showSnackbar,
    showSnackbarError
  } = deps

  const [contextUsageRefreshKey, setContextUsageRefreshKey] = useState(0)
  const refreshContextUsage = useCallback((): void => {
    setContextUsageRefreshKey((value) => value + 1)
  }, [])

  const queue = usePromptQueue(activeDraftKey, setActiveInput)
  const { compactingSessions, isCompactingKey, onCompactContext } = useManualCompaction({
    rendererApi,
    refreshContextUsage,
    showSnackbar,
    showSnackbarError
  })

  const onStopGeneration = useCallback(async (): Promise<void> => {
    const stoppedRequest = sendRequestRef.current
    const stoppedSession = useSessionStore.getState()
    const stoppedTarget = {
      phiSessionId: stoppedSession.activePhiSessionId ?? null,
      sessionPath: stoppedSession.activeSessionPath,
      sessionGeneration: stoppedSession.activeSessionGeneration
    }
    await rendererApi.stopGeneration()
    const current = useSessionStore.getState()
    if (
      stoppedRequest === sendRequestRef.current &&
      (current.activePhiSessionId ?? null) === stoppedTarget.phiSessionId &&
      current.activeSessionPath === stoppedTarget.sessionPath &&
      current.activeSessionGeneration === stoppedTarget.sessionGeneration
    ) {
      isSendingRef.current = false
      setIsSendingMessage(false)
      clearPendingInteractions()
    }
  }, [clearPendingInteractions, isSendingRef, rendererApi, sendRequestRef, setIsSendingMessage])

  return {
    compactingSessions,
    isCompactingKey,
    contextUsageRefreshKey,
    refreshContextUsage,
    activeQueuedPrompts: queue.activeQueuedPrompts,
    queuePromptText: queue.queuePromptText,
    removeQueuedPrompt: queue.removeQueuedPrompt,
    dequeueQueuedPrompt: queue.dequeueQueuedPrompt,
    moveQueuedPromptsToSession: queue.moveQueuedPromptsToSession,
    onStopGeneration,
    onCompactContext
  }
}
