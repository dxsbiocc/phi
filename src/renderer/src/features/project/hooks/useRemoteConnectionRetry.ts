import { useCallback } from 'react'

import { appCopy } from '../../../lib/appCopy'
import { useSessionStore } from '../../../stores/sessionStore'
import type { RendererApi } from '../../../types'

/**
 * Retries the visible remote project's connection.
 *
 * The ids are read from the store at click time, so a retry always targets the
 * conversation the user is looking at, not the one that was active when the
 * banner rendered.
 */
export function useRemoteConnectionRetry(
  rendererApi: Pick<RendererApi, 'retryRemoteProjectConnection'>,
  showSnackbarError: (error: unknown, fallback: string) => void
): () => void {
  return useCallback((): void => {
    const state = useSessionStore.getState()
    if (!state.activePhiSessionId || !state.activeProjectId) {
      showSnackbarError(new Error(appCopy.remoteChatUnavailable), appCopy.reconnectFailed)
      return
    }
    void rendererApi
      .retryRemoteProjectConnection({
        sessionId: state.activePhiSessionId,
        projectId: state.activeProjectId
      })
      .catch((error) => showSnackbarError(error, appCopy.reconnectFailed))
  }, [rendererApi, showSnackbarError])
}
