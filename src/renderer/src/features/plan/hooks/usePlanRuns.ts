import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
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
}

type PlanRunFeed = Pick<PlanRunsController, 'run' | 'details' | 'loading' | 'error'> & {
  setError: Dispatch<SetStateAction<string | null>>
  remember: (state: PlanRunState) => boolean
}

type PlanRunActions = Pick<
  PlanRunsController,
  'pendingAction' | 'loadDetails' | 'pause' | 'resume' | 'stop' | 'retryStep' | 'skipStep'
>

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function eventBelongsToSession(event: AgentEventSummary, sessionId: string): boolean {
  return !event.phiSessionId || event.phiSessionId === sessionId
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

function usePlanRunActions(
  api: PlanRunApi,
  sessionId: string | null,
  feed: PlanRunFeed
): PlanRunActions {
  const [pending, setPending] = useState<{ sessionId: string; key: string } | null>(null)
  const { run, remember, setError } = feed
  const currentSession = useCurrentSession(sessionId)
  const loadDetails = usePlanRunDetails(api, sessionId, feed, currentSession)
  const pendingAction = pending?.sessionId === sessionId ? pending.key : null

  const perform = useCallback(
    async (key: string, action: (session: string, runId: string) => Promise<PlanRunState>) => {
      if (!sessionId || !run) return
      const actionSession = sessionId
      setPending({ sessionId: actionSession, key })
      setError(null)
      try {
        const state = await action(actionSession, run.id)
        if (currentSession.current === actionSession) remember(state)
      } catch (cause) {
        if (currentSession.current === actionSession) setError(errorText(cause))
      } finally {
        setPending((current) =>
          current?.sessionId === actionSession && current.key === key ? null : current
        )
      }
    },
    [currentSession, remember, run, sessionId, setError]
  )
  return {
    pendingAction,
    loadDetails,
    pause: () => perform('pause', api.pausePlanRun),
    resume: () => perform('resume', api.resumePlanRun),
    stop: () => perform('stop', api.stopPlanRun),
    retryStep: (stepId) =>
      perform(`retry:${stepId}`, (session, runId) => api.retryPlanRunStep(session, runId, stepId)),
    skipStep: (stepId) =>
      perform(`skip:${stepId}`, (session, runId) => api.skipPlanRunStep(session, runId, stepId))
  }
}

export function usePlanRuns(api: PlanRunApi, sessionId: string | null): PlanRunsController {
  const feed = usePlanRunFeed(api, sessionId)
  const actions = usePlanRunActions(api, sessionId, feed)
  return {
    run: feed.run,
    details: feed.details,
    loading: feed.loading,
    error: feed.error,
    ...actions
  }
}
