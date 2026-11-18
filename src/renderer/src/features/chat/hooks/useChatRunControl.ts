import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

import type { ManualCompactionTarget } from '../../../../../shared/contextUsageTypes'
import type { getRendererApi } from '../../../lib/rendererApi'
import { useSessionStore } from '../../../stores/sessionStore'
import { useManualCompaction } from './useManualCompaction'

/** The slice of the renderer bridge that run control talks to. */
export type ChatRunControlApi = Pick<
  ReturnType<typeof getRendererApi>,
  'stopGeneration' | 'compactCurrentSession'
>

export type ChatRunControlDeps = {
  rendererApi: ChatRunControlApi
  /** Send lifecycle token, incremented per dispatched prompt. Owned by the shell. */
  sendRequestRef: { current: number }
  /** Mirrors "a send is in flight"; owned by the shell until the send pipeline moves. */
  isSendingRef: { current: boolean }
  setIsSendingMessage: Dispatch<SetStateAction<boolean>>
  clearPendingInteractions: () => void
  showSnackbar: (message: string, severity?: 'error' | 'success' | 'info' | 'warning') => void
  showSnackbarError: (error: unknown, fallback: string) => void
}

export type ChatRunControl = {
  /** Compactions that have started, keyed by session identity. Render truth. */
  compactingSessions: Set<string>
  contextUsageRefreshKey: number
  refreshContextUsage: () => void
  onStopGeneration: () => Promise<void>
  onCompactContext: (target: ManualCompactionTarget) => Promise<void>
}

export function useChatRunControl(deps: ChatRunControlDeps): ChatRunControl {
  const {
    rendererApi,
    sendRequestRef,
    isSendingRef,
    setIsSendingMessage,
    clearPendingInteractions,
    showSnackbar,
    showSnackbarError
  } = deps

  const [contextUsageRefreshKey, setContextUsageRefreshKey] = useState(0)
  const refreshContextUsage = useCallback((): void => {
    setContextUsageRefreshKey((value) => value + 1)
  }, [])

  const { compactingSessions, onCompactContext } = useManualCompaction({
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
    contextUsageRefreshKey,
    refreshContextUsage,
    onStopGeneration,
    onCompactContext
  }
}
