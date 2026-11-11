import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction
} from 'react'

import type { PlanRunState, PlanRunTimelineSnapshot } from '../../../../../shared/planRunTypes'
import type { AgentEventSummary, RendererApi } from '../../../types'
import {
  latestPlanRun,
  planRunSnapshot,
  planRunSnapshotFromUnknown,
  upsertPlanRun
} from '../lib/planRunView'
import { createPlanRunDetailsLoader } from '../lib/planRunDetailsLoader'
import { planCopy } from '../lib/planCopy'
import { planReplanRecoveryStore } from '../lib/planReplanRecoveryStore'
import {
  deliverPlanReplanPrompt,
  PlanReplanCancellationError,
  retryPlanReplanCancellation,
  type OnReplanPrompt,
  type PendingReplanCancellation
} from '../lib/planReplanDelivery'

export type { OnReplanPrompt } from '../lib/planReplanDelivery'

type PlanRunApi = Pick<
  RendererApi,
  | 'onAgentEvent'
  | 'listPlanRuns'
  | 'getPlanRun'
  | 'pausePlanRun'
  | 'resumePlanRun'
  | 'stopPlanRun'
  | 'retryPlanRunStep'
  | 'skipPlanRunStep'
  | 'requestPlanRunReplan'
  | 'cancelPlanRunReplan'
  | 'getPendingPlanRunReplan'
>

export type PlanRunsController = {
  run: PlanRunTimelineSnapshot | null
  details: PlanRunState | null
  loading: boolean
  pendingAction: string | null
  error: string | null
  loadDetails: (runId: string, updatedAt: string) => Promise<PlanRunState | null>
  pause: () => Promise<void>
  resume: () => Promise<void>
  stop: () => Promise<void>
  retryStep: (stepId: string) => Promise<void>
  skipStep: (stepId: string) => Promise<void>
  replan?: () => Promise<void>
  rollbackPending?: boolean
  replanPending?: boolean
  retryCancellation?: () => Promise<void>
}

type PlanRunFeed = Pick<PlanRunsController, 'run' | 'details' | 'loading' | 'error'> & {
  setError: Dispatch<SetStateAction<string | null>>
  remember: (state: PlanRunState) => boolean
}

type PlanRunActions = Pick<
  PlanRunsController,
  'pendingAction' | 'loadDetails' | 'pause' | 'resume' | 'stop' | 'retryStep' | 'skipStep'
> &
  Pick<PlanRunsController, 'replan' | 'rollbackPending' | 'replanPending' | 'retryCancellation'>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function eventBelongsToSession(event: AgentEventSummary, sessionId: string): boolean {
  return !event.phiSessionId || event.phiSessionId === sessionId
}

function runIsStopped(
  latest: MutableRefObject<PlanRunTimelineSnapshot | null>,
  runId: string
): boolean {
  const run = latest.current
  return run?.id === runId && run.status === 'stopped'
}

function withoutRunDetails(
  details: Record<string, PlanRunState>,
  runId: string
): Record<string, PlanRunState> {
  if (!(runId in details)) return details
  const next = { ...details }
  delete next[runId]
  return next
}

type FeedSetters = {
  setRuns: Dispatch<SetStateAction<PlanRunTimelineSnapshot[]>>
  setDetails: Dispatch<SetStateAction<Record<string, PlanRunState>>>
  setLoadedSessionId: Dispatch<SetStateAction<string | null>>
  setLoading: Dispatch<SetStateAction<boolean>>
  setError: Dispatch<SetStateAction<string | null>>
  freshness: MutableRefObject<Map<string, string>>
}

function recordFreshness(
  freshness: MutableRefObject<Map<string, string>>,
  snapshot: PlanRunTimelineSnapshot
): boolean {
  const current = freshness.current.get(snapshot.id)
  if (current && current > snapshot.updatedAt) return false
  freshness.current.set(snapshot.id, snapshot.updatedAt)
  return true
}

function usePlanRunEvents(api: PlanRunApi, sessionId: string | null, setters: FeedSetters): void {
  const { setRuns, setDetails, setLoadedSessionId, setLoading, setError, freshness } = setters
  useEffect(() => {
    let active = true
    freshness.current.clear()
    setRuns([])
    setDetails({})
    setLoadedSessionId(sessionId)
    setError(null)
    setLoading(Boolean(sessionId))
    if (!sessionId) return undefined
    const unsubscribe = api.onAgentEvent((event) => {
      if (!active || !eventBelongsToSession(event, sessionId)) return
      if (event.type !== 'plan_run_updated' && event.type !== 'plan_run_finished') return
      const snapshot = planRunSnapshotFromUnknown(event.state)
      if (!snapshot || !recordFreshness(freshness, snapshot)) return
      setRuns((current) => upsertPlanRun(current, snapshot))
      setDetails((current) => {
        const details = current[snapshot.id]
        return details && details.updatedAt >= snapshot.updatedAt
          ? current
          : withoutRunDetails(current, snapshot.id)
      })
    })
    void api
      .listPlanRuns(sessionId)
      .then((states) => {
        if (!active) return
        const snapshots = states
          .map(planRunSnapshot)
          .filter((snapshot) => recordFreshness(freshness, snapshot))
        setRuns((current) => snapshots.reduce(upsertPlanRun, current))
      })
      .catch((cause: unknown) => active && setError(errorText(cause)))
      .finally(() => active && setLoading(false))
    return () => {
      active = false
      unsubscribe()
    }
  }, [api, freshness, sessionId, setDetails, setError, setLoadedSessionId, setLoading, setRuns])
}

function usePlanRunFeed(api: PlanRunApi, sessionId: string | null): PlanRunFeed {
  const [runs, setRuns] = useState<PlanRunTimelineSnapshot[]>([])
  const [detailsByRun, setDetailsByRun] = useState<Record<string, PlanRunState>>({})
  const [loadedSessionId, setLoadedSessionId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const freshness = useRef(new Map<string, string>())
  usePlanRunEvents(api, sessionId, {
    setRuns,
    setDetails: setDetailsByRun,
    setLoadedSessionId,
    setLoading,
    setError,
    freshness
  })
  const run = useMemo(
    () => latestPlanRun(loadedSessionId === sessionId ? runs : []),
    [loadedSessionId, runs, sessionId]
  )
  const details = run ? (detailsByRun[run.id] ?? null) : null
  const remember = useCallback(
    (state: PlanRunState): boolean => {
      const snapshot = planRunSnapshot(state)
      if (!recordFreshness(freshness, snapshot)) return false
      setDetailsByRun((current) => ({ ...current, [state.id]: state }))
      setRuns((current) => upsertPlanRun(current, snapshot))
      return true
    },
    [freshness]
  )

  return { run, details, loading, error, setError, remember }
}

function useCurrentSession(sessionId: string | null): MutableRefObject<string | null> {
  const sessionRef = useRef(sessionId)
  useLayoutEffect(() => {
    sessionRef.current = sessionId
    return () => {
      sessionRef.current = null
    }
  }, [sessionId])
  return sessionRef
}

function usePlanRunDetails(
  api: PlanRunApi,
  sessionId: string | null,
  feed: PlanRunFeed,
  currentSession: MutableRefObject<string | null>
): PlanRunsController['loadDetails'] {
  const { remember, setError } = feed
  const loader = useMemo(
    () => createPlanRunDetailsLoader((session, runId) => api.getPlanRun(session, runId)),
    [api]
  )
  return useCallback(
    (runId: string, updatedAt: string): Promise<PlanRunState | null> => {
      if (!sessionId) return Promise.resolve(null)
      setError(null)
      return loader.load({
        sessionId,
        runId,
        updatedAt,
        isCurrent: () => currentSession.current === sessionId,
        accept: remember,
        onError: (cause) => setError(errorText(cause))
      })
    },
    [currentSession, loader, remember, sessionId, setError]
  )
}

type PendingAction = { sessionId: string; key: string } | null
type ReplanActionContext = {
  api: PlanRunApi
  sessionId: string | null
  run: PlanRunTimelineSnapshot | null
  onReplanPrompt?: OnReplanPrompt
  pendingAction: string | null
  setPending: Dispatch<SetStateAction<PendingAction>>
  setError: PlanRunFeed['setError']
  currentSession: MutableRefObject<string | null>
  latestRun: MutableRefObject<PlanRunTimelineSnapshot | null>
}

function useRetryReplanCancellation(
  context: ReplanActionContext,
  rollback: PendingReplanCancellation | undefined,
  cancellationKey: string | null
): () => Promise<void> {
  const { api, currentSession, latestRun, pendingAction, setError, setPending } = context
  return useCallback(async (): Promise<void> => {
    if (!rollback || !cancellationKey || pendingAction !== null) return
    const key = `cancel-replan:${rollback.requestId}`
    setPending({ sessionId: rollback.phiSessionId, key })
    try {
      await retryPlanReplanCancellation(rollback, api.cancelPlanRunReplan)
      planReplanRecoveryStore.delete(cancellationKey)
      if (currentSession.current === rollback.phiSessionId) setError(null)
    } catch {
      if (
        currentSession.current === rollback.phiSessionId &&
        !runIsStopped(latestRun, rollback.runId)
      ) {
        setError(planCopy.replanCancelFailed)
      }
    } finally {
      setPending((current) =>
        current?.sessionId === rollback.phiSessionId && current.key === key ? null : current
      )
    }
  }, [
    api.cancelPlanRunReplan,
    cancellationKey,
    currentSession,
    latestRun,
    pendingAction,
    rollback,
    setError,
    setPending
  ])
}

function useServerPendingReplan(
  api: PlanRunApi,
  sessionId: string | null,
  runId: string | undefined,
  setError: PlanRunFeed['setError']
): { pending: boolean; markPending: () => void; markCleared: () => void } {
  const [serverReplan, setServerReplan] = useState<{ key: string; pending: boolean } | null>(null)
  const replanRevision = useRef(0)
  useEffect(() => {
    if (!sessionId || !runId) return undefined
    const key = `${sessionId}:${runId}`
    let active = true
    let reading = false
    const refresh = async (): Promise<void> => {
      if (reading) return
      reading = true
      const revision = replanRevision.current
      try {
        const pending = await api.getPendingPlanRunReplan(sessionId, runId)
        if (active && revision === replanRevision.current)
          setServerReplan({ key, pending: pending !== null })
      } catch (cause) {
        if (active && revision === replanRevision.current) {
          setServerReplan({ key, pending: true })
          setError(errorText(cause))
        }
      } finally {
        reading = false
      }
    }
    void refresh()
    const timer = setInterval(() => void refresh(), 1000)
    return () => {
      active = false
      clearInterval(timer)
    }
  }, [api, runId, sessionId, setError])
  const key = sessionId && runId ? `${sessionId}:${runId}` : null
  const markPending = useCallback(() => {
    if (!key) return
    replanRevision.current += 1
    setServerReplan({ key, pending: true })
  }, [key])
  const markCleared = useCallback(() => {
    if (!key) return
    replanRevision.current += 1
    setServerReplan({ key, pending: false })
  }, [key])
  return {
    pending: Boolean(key && (serverReplan?.key !== key || serverReplan.pending)),
    markPending,
    markCleared
  }
}

function usePendingRollback(key: string | null): PendingReplanCancellation | undefined {
  useSyncExternalStore(
    planReplanRecoveryStore.subscribe,
    planReplanRecoveryStore.snapshot,
    planReplanRecoveryStore.snapshot
  )
  return key ? planReplanRecoveryStore.get(key) : undefined
}

type PlanReplanActions = Pick<
  PlanRunActions,
  'replan' | 'rollbackPending' | 'replanPending' | 'retryCancellation'
> & { clearAfterStop: () => void }

function usePlanReplanActions(context: ReplanActionContext): PlanReplanActions {
  const {
    api,
    sessionId,
    run,
    onReplanPrompt,
    pendingAction,
    setPending,
    setError,
    currentSession,
    latestRun
  } = context
  const cancellationKey = sessionId && run ? `${sessionId}:${run.id}` : null
  const rollback = usePendingRollback(cancellationKey)
  const serverReplan = useServerPendingReplan(
    api,
    sessionId,
    run?.status === 'paused' ? run.id : undefined,
    setError
  )
  const replanPending = Boolean(
    rollback ||
    pendingAction?.startsWith('replan:') ||
    pendingAction?.startsWith('cancel-replan:') ||
    serverReplan.pending
  )
  const clearAfterStop = useCallback((): void => {
    if (cancellationKey) planReplanRecoveryStore.delete(cancellationKey)
    serverReplan.markCleared()
    setError(null)
  }, [cancellationKey, serverReplan, setError])
  const replan = useCallback(async (): Promise<void> => {
    if (!sessionId || !run || !onReplanPrompt || pendingAction !== null || replanPending) return
    const actionSession = sessionId
    const actionRun = run.id
    const key = `replan:${actionRun}`
    setPending({ sessionId: actionSession, key })
    setError(null)
    try {
      const request = await api.requestPlanRunReplan(actionSession, actionRun)
      serverReplan.markPending()
      const accepted = await deliverPlanReplanPrompt({
        request,
        phiSessionId: actionSession,
        isCurrent: () => currentSession.current === actionSession,
        send: onReplanPrompt,
        cancel: (requestId) => api.cancelPlanRunReplan(actionSession, actionRun, requestId)
      })
      if (accepted === 'stopped') {
        clearAfterStop()
        return
      }
      if (!accepted) {
        throw new Error(planCopy.replanSendFailed)
      }
    } catch (cause) {
      if (cause instanceof PlanReplanCancellationError) {
        const key = `${cause.pending.phiSessionId}:${cause.pending.runId}`
        planReplanRecoveryStore.set(key, cause.pending)
      }
      if (currentSession.current === actionSession && !runIsStopped(latestRun, actionRun)) {
        setError(
          cause instanceof PlanReplanCancellationError
            ? planCopy.replanCancelFailed
            : errorText(cause)
        )
      }
    } finally {
      setPending((current) =>
        current?.sessionId === actionSession && current.key === key ? null : current
      )
    }
  }, [
    api,
    clearAfterStop,
    currentSession,
    latestRun,
    onReplanPrompt,
    pendingAction,
    replanPending,
    serverReplan,
    run,
    sessionId,
    setError,
    setPending
  ])
  const retryCancellation = useRetryReplanCancellation(context, rollback, cancellationKey)
  return {
    rollbackPending: Boolean(rollback),
    replanPending,
    retryCancellation,
    clearAfterStop,
    ...(onReplanPrompt ? { replan } : {})
  }
}

function usePlanRunActions(
  api: PlanRunApi,
  sessionId: string | null,
  feed: PlanRunFeed,
  onReplanPrompt?: OnReplanPrompt
): PlanRunActions {
  const [pending, setPending] = useState<PendingAction>(null)
  const { run, remember, setError } = feed
  const currentSession = useCurrentSession(sessionId)
  const latestRun = useRef(run)
  useLayoutEffect(() => {
    latestRun.current = run
  }, [run])
  const loadDetails = usePlanRunDetails(api, sessionId, feed, currentSession)
  const pendingAction = pending?.sessionId === sessionId ? pending.key : null
  const replanActions = usePlanReplanActions({
    api,
    sessionId,
    run,
    onReplanPrompt,
    pendingAction,
    setPending,
    setError,
    currentSession,
    latestRun
  })
  const { clearAfterStop, ...publicReplanActions } = replanActions
  const perform = useCallback(
    async (
      key: string,
      action: (session: string, runId: string) => Promise<PlanRunState>
    ): Promise<PlanRunState | null> => {
      if (!sessionId || !run) return null
      const actionSession = sessionId
      setPending({ sessionId: actionSession, key })
      setError(null)
      try {
        const state = await action(actionSession, run.id)
        if (currentSession.current === actionSession) remember(state)
        return state
      } catch (cause) {
        if (currentSession.current === actionSession) setError(errorText(cause))
        return null
      } finally {
        setPending((current) =>
          current?.sessionId === actionSession && current.key === key ? null : current
        )
      }
    },
    [currentSession, remember, run, sessionId, setError]
  )
  const stop = useCallback(async (): Promise<void> => {
    const state = await perform('stop', api.stopPlanRun)
    if (state?.status === 'stopped') clearAfterStop()
  }, [api.stopPlanRun, clearAfterStop, perform])
  const settle = async (
    key: string,
    action: (session: string, runId: string) => Promise<PlanRunState>
  ): Promise<void> => {
    await perform(key, action)
  }
  return {
    pendingAction,
    loadDetails,
    pause: () => settle('pause', api.pausePlanRun),
    resume: () => settle('resume', api.resumePlanRun),
    stop,
    retryStep: (stepId) =>
      settle(`retry:${stepId}`, (session, runId) => api.retryPlanRunStep(session, runId, stepId)),
    skipStep: (stepId) =>
      settle(`skip:${stepId}`, (session, runId) => api.skipPlanRunStep(session, runId, stepId)),
    ...publicReplanActions
  }
}

export function usePlanRuns(
  api: PlanRunApi,
  sessionId: string | null,
  onReplanPrompt?: OnReplanPrompt
): PlanRunsController {
  const feed = usePlanRunFeed(api, sessionId)
  const actions = usePlanRunActions(api, sessionId, feed, onReplanPrompt)
  return {
    run: feed.run,
    details: feed.details,
    loading: feed.loading,
    error: feed.error,
    ...actions
  }
}
