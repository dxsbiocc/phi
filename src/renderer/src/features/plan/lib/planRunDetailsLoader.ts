import type { PlanRunState } from '../../../../../shared/planRunTypes'

export type PlanRunDetailRequest = {
  sessionId: string
  runId: string
  updatedAt: string
  isCurrent: () => boolean
  accept: (state: PlanRunState) => boolean
  onError: (error: unknown) => void
}

export type PlanRunDetailsLoader = {
  load: (request: PlanRunDetailRequest) => Promise<PlanRunState | null>
}

export function createPlanRunDetailsLoader(
  getPlanRun: (sessionId: string, runId: string) => Promise<PlanRunState | null>
): PlanRunDetailsLoader {
  const inFlight = new Map<string, Promise<PlanRunState | null>>()
  const latestRequested = new Map<string, string>()
  return {
    load(request) {
      const scope = `${request.sessionId}:${request.runId}`
      const key = `${scope}:${request.updatedAt}`
      const newest = latestRequested.get(scope)
      if (!newest || newest < request.updatedAt) latestRequested.set(scope, request.updatedAt)
      const existing = inFlight.get(key)
      if (existing) return existing
      const pending = getPlanRun(request.sessionId, request.runId)
        .then((state) => {
          const latest = latestRequested.get(scope)
          if (
            !request.isCurrent() ||
            !state ||
            state.updatedAt < request.updatedAt ||
            (latest !== undefined && state.updatedAt < latest)
          ) {
            return null
          }
          return request.accept(state) ? state : null
        })
        .catch((error: unknown) => {
          if (request.isCurrent()) request.onError(error)
          return null
        })
        .finally(() => inFlight.delete(key))
      inFlight.set(key, pending)
      return pending
    }
  }
}
