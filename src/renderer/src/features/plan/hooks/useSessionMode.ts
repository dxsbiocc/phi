import { useCallback, useLayoutEffect, useRef, useState } from 'react'

import type { ManualCompactionTarget } from '../../../../../shared/contextUsageTypes'
import type { SessionMode } from '../../../../../shared/sessionMode'
import type { CurrentSession } from '../../../types'

export type SessionModeApi = {
  updateCurrentSessionMode: (
    mode: SessionMode,
    target: ManualCompactionTarget
  ) => Promise<CurrentSession>
}

export function requestSessionModeUpdate(
  api: SessionModeApi,
  mode: SessionMode,
  target: ManualCompactionTarget
): Promise<CurrentSession> {
  return api.updateCurrentSessionMode(mode, target)
}

export async function applySessionModeUpdate({
  api,
  mode,
  target,
  isCurrentTarget,
  onUpdated,
  onError
}: {
  api: SessionModeApi
  mode: SessionMode
  target: ManualCompactionTarget
  isCurrentTarget: () => boolean
  onUpdated: (current: CurrentSession) => void
  onError: (error: unknown) => void
}): Promise<void> {
  try {
    const current = await requestSessionModeUpdate(api, mode, target)
    if (isCurrentTarget()) onUpdated(current)
  } catch (error) {
    if (isCurrentTarget()) onError(error)
  }
}

function sameTarget(left: ManualCompactionTarget, right: ManualCompactionTarget): boolean {
  return (
    left.sessionPath === right.sessionPath &&
    left.phiSessionId === right.phiSessionId &&
    left.sessionGeneration === right.sessionGeneration
  )
}

export function useSessionMode({
  api,
  mode,
  target,
  disabled = false,
  onUpdated,
  onError
}: {
  api: SessionModeApi
  mode: SessionMode
  target: ManualCompactionTarget
  disabled?: boolean
  onUpdated: (current: CurrentSession) => void
  onError: (error: unknown) => void
}): {
  mode: SessionMode
  updating: boolean
  selectMode: (mode: SessionMode) => Promise<void>
} {
  const [updating, setUpdating] = useState(false)
  const updatingRef = useRef(false)
  const targetRef = useRef(target)
  useLayoutEffect(() => {
    targetRef.current = target
  }, [target])
  const selectMode = useCallback(
    async (nextMode: SessionMode): Promise<void> => {
      if (disabled || updatingRef.current || nextMode === mode) return
      updatingRef.current = true
      setUpdating(true)
      try {
        await applySessionModeUpdate({
          api,
          mode: nextMode,
          target,
          isCurrentTarget: () => sameTarget(target, targetRef.current),
          onUpdated,
          onError
        })
      } finally {
        updatingRef.current = false
        setUpdating(false)
      }
    },
    [api, disabled, mode, onError, onUpdated, target]
  )
  return { mode, updating, selectMode }
}
