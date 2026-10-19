import { useCallback, useRef, useState } from 'react'

import type { ManualCompactionTarget } from '../../../../../shared/contextUsageTypes'
import { appCopy } from '../../../lib/appCopy'
import type { getRendererApi } from '../../../lib/rendererApi'
import { useSessionStore } from '../../../stores/sessionStore'

/**
 * Manual context compaction for the visible session.
 *
 * Compaction is addressed by session identity, not by "whatever is active when
 * the reply arrives": a compaction started on session A must not clear session
 * B's lock, notify the wrong session, or refresh the wrong context meter. The
 * key is the identity triple the rest of the app uses.
 *
 * Two views of the same set are exposed on purpose:
 *
 * - `compactingSessions` is state, for rendering the disabled/busy UI.
 * - `isCompactingKey` reads the ref, for dispatch guards that must also see a
 *   compaction started since the last render (double click before paint).
 */
export type ManualCompactionApi = Pick<ReturnType<typeof getRendererApi>, 'compactCurrentSession'>

export type ManualCompactionDeps = {
  rendererApi: ManualCompactionApi
  refreshContextUsage: () => void
  showSnackbar: (message: string, severity?: 'error' | 'success' | 'info' | 'warning') => void
  showSnackbarError: (error: unknown, fallback: string) => void
}

export type ManualCompaction = {
  compactingSessions: Set<string>
  isCompactingKey: (key: string) => boolean
  onCompactContext: (target: ManualCompactionTarget) => Promise<void>
}

export function useManualCompaction(deps: ManualCompactionDeps): ManualCompaction {
  const { rendererApi, refreshContextUsage, showSnackbar, showSnackbarError } = deps

  const compactingSessionKeysRef = useRef(new Set<string>())
  const [compactingSessions, setCompactingSessions] = useState<Set<string>>(() => new Set())

  const isCompactingKey = useCallback(
    (key: string): boolean => compactingSessionKeysRef.current.has(key),
    []
  )

  const onCompactContext = useCallback(
    async (target: ManualCompactionTarget): Promise<void> => {
      const isCurrentTarget = (): boolean => {
        const current = useSessionStore.getState()
        return (
          (current.activePhiSessionId ?? null) === target.phiSessionId &&
          current.activeSessionPath === target.sessionPath &&
          current.activeSessionGeneration === target.sessionGeneration
        )
      }
      if (!isCurrentTarget()) return
      const key = JSON.stringify([
        target.phiSessionId,
        target.sessionPath,
        target.sessionGeneration
      ])
      if (compactingSessionKeysRef.current.has(key)) return
      compactingSessionKeysRef.current.add(key)
      setCompactingSessions((previous) => new Set(previous).add(key))
      try {
        await rendererApi.compactCurrentSession(target)
        if (!isCurrentTarget()) return
        showSnackbar(appCopy.contextCompacted, 'success')
        refreshContextUsage()
      } catch (error) {
        if (isCurrentTarget()) showSnackbarError(error, appCopy.compactFailed)
      } finally {
        compactingSessionKeysRef.current.delete(key)
        setCompactingSessions((previous) => {
          const next = new Set(previous)
          next.delete(key)
          return next
        })
      }
    },
    [refreshContextUsage, rendererApi, showSnackbar, showSnackbarError]
  )

  return { compactingSessions, isCompactingKey, onCompactContext }
}
