import { chatCopy } from '../lib/chatCopy'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import type {
  RuntimeRecoveryApi,
  RuntimeRecoveryModelSelection,
  RuntimeRecoveryState,
  RuntimeRecoveryTarget,
  RuntimeSummaryContinuation
} from '../../../../../shared/runtimeRecoveryTypes'
import { runtimeRecoveryViewKey } from '../lib/runtimeRecoveryState'

export function useRuntimeRecovery(
  api: RuntimeRecoveryApi,
  target: RuntimeRecoveryTarget | null,
  onRecovered?: (state: RuntimeRecoveryState) => void | Promise<void>,
  onSummaryCreated?: (result: RuntimeSummaryContinuation) => void | Promise<void>,
  refreshKey?: string
): {
  state: RuntimeRecoveryState | null
  pending: boolean
  error: string | null
  refresh(): Promise<void>
  resume(replacement?: RuntimeRecoveryModelSelection): Promise<void>
  continueFromSummary(): Promise<void>
} {
  const [state, setState] = useState<RuntimeRecoveryState | null>(null)
  const [pendingState, setPending] = useState({ key: '', value: false })
  const [errorState, setError] = useState<{ key: string; message: string | null }>({
    key: '',
    message: null
  })
  const uiRefreshError = useRef<{ key: string; message: string } | null>(null)
  const targetRef = useRef(target)
  useLayoutEffect(() => {
    const previous = targetRef.current
    targetRef.current =
      target && previous && runtimeRecoveryViewKey(target) === runtimeRecoveryViewKey(previous)
        ? {
            ...target,
            sessionGeneration: Math.max(target.sessionGeneration, previous.sessionGeneration)
          }
        : target
  }, [target])
  const request = useRef(0)
  const pendingRef = useRef(false)
  const refreshQueued = useRef(false)
  const key = runtimeRecoveryViewKey(target)
  const current = useCallback(
    (ticket: number, original: RuntimeRecoveryTarget): boolean =>
      request.current === ticket &&
      runtimeRecoveryViewKey(targetRef.current) === runtimeRecoveryViewKey(original),
    []
  )
  const refresh = useCallback(async (): Promise<void> => {
    const original = targetRef.current
    if (!original) return
    if (pendingRef.current) {
      refreshQueued.current = true
      return
    }
    refreshQueued.current = false
    const ticket = ++request.current
    try {
      const result = await api.getRuntimeRecoveryState(original)
      if (!result) return
      if (current(ticket, original)) {
        setState(result)
        const failure = uiRefreshError.current
        setError(
          failure?.key === runtimeRecoveryViewKey(original)
            ? failure
            : { key: runtimeRecoveryViewKey(original), message: null }
        )
      }
    } catch {
      if (current(ticket, original)) {
        setState(null)
        setError({
          key: runtimeRecoveryViewKey(original),
          message: chatCopy.unableToReadRecoveryStatusForThisConversationTryAgain
        })
      }
    }
  }, [api, current])
  useEffect(() => {
    request.current += 1
    pendingRef.current = false
    refreshQueued.current = false
    uiRefreshError.current = null
    return () => {
      request.current += 1
    }
  }, [key])
  useEffect(() => {
    void refresh()
  }, [key, target?.sessionGeneration, refreshKey, refresh])
  useEffect(
    () =>
      api.onSessionChanged?.((session) => {
        const original = targetRef.current
        if (
          !original ||
          session.phiSessionId !== original.sessionId ||
          (session.projectId !== undefined && session.projectId !== original.projectId)
        )
          return
        if (
          Number.isSafeInteger(session.sessionGeneration) &&
          session.sessionGeneration >= original.sessionGeneration
        )
          targetRef.current = { ...original, sessionGeneration: session.sessionGeneration }
        void refresh()
      }),
    [api, refresh]
  )
  const run = useCallback(
    async (
      operation: (
        original: RuntimeRecoveryTarget
      ) => Promise<RuntimeRecoveryState | RuntimeSummaryContinuation | null>,
      kind: 'resume' | 'summary'
    ): Promise<void> => {
      const original = targetRef.current
      if (!original || pendingRef.current) return
      const ticket = ++request.current
      pendingRef.current = true
      uiRefreshError.current = null
      setPending({ key: runtimeRecoveryViewKey(original), value: true })
      setError({ key: runtimeRecoveryViewKey(original), message: null })
      try {
        const result = await operation(original)
        if (!result) return
        const ownSummaryCompletion =
          kind === 'summary' &&
          'phiSessionId' in result &&
          result.sourceSessionId === original.sessionId &&
          targetRef.current?.sessionId === result.phiSessionId &&
          targetRef.current?.projectId === result.projectId &&
          targetRef.current?.sessionPath === result.path
        if (!current(ticket, original) && !ownSummaryCompletion) return
        if (kind === 'resume' && 'phase' in result) {
          if (!refreshQueued.current) setState(result)
          try {
            await onRecovered?.(result)
          } catch {
            if (current(ticket, original)) {
              const failure = {
                key: runtimeRecoveryViewKey(original),
                message: chatCopy.theOriginalConversationWasRecoveredButTheInterfaceCouldNot
              }
              uiRefreshError.current = failure
              setError(failure)
            }
          }
        } else if (kind === 'summary' && 'phiSessionId' in result) {
          try {
            await onSummaryCreated?.(result)
          } catch {
            if (
              current(ticket, original) ||
              (targetRef.current?.sessionId === result.phiSessionId &&
                targetRef.current?.sessionPath === result.path &&
                targetRef.current?.projectId === result.projectId)
            )
              setError({
                key: runtimeRecoveryViewKey(targetRef.current),
                message: chatCopy.aConversationWasCreatedFromTheSummaryOpenItFrom
              })
          }
        }
      } catch {
        if (current(ticket, original)) {
          setError({
            key: runtimeRecoveryViewKey(original),
            message: chatCopy.theActionDidNotCompleteCheckTheUpdatedRecoveryStatus
          })
          try {
            const latest = await api.getRuntimeRecoveryState(targetRef.current ?? original)
            if (latest && current(ticket, original)) setState(latest)
          } catch {
            /* The original identity remains visible for an explicit retry. */
          }
        }
      } finally {
        if (current(ticket, original)) {
          pendingRef.current = false
          setPending({ key: runtimeRecoveryViewKey(original), value: false })
          if (refreshQueued.current) await refresh()
        }
      }
    },
    [api, current, onRecovered, onSummaryCreated, refresh]
  )
  const visibleState = state && runtimeRecoveryViewKey(state.target) === key ? state : null
  return {
    state: visibleState,
    pending: pendingState.key === key && pendingState.value,
    error: errorState.key === key ? errorState.message : null,
    refresh,
    resume: (replacement) =>
      run((original) => api.resumeRuntimeSession(original, replacement), 'resume'),
    continueFromSummary: () => {
      const sha256 = visibleState?.summary?.provenance.sha256
      return sha256
        ? run((original) => api.continueRuntimeFromSummary(original, sha256), 'summary')
        : Promise.resolve()
    }
  }
}
