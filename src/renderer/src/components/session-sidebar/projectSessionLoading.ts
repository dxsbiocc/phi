import type { SessionSummary } from '../../types'

type ProjectSessionLoad = {
  refreshKey: number
  promise: Promise<SessionSummary[]>
}

const projectSessionLoads = new Map<string, ProjectSessionLoad>()

export function shouldPrefetchProjectSessions(
  _expanded: boolean,
  hasSearchSessions: boolean
): boolean {
  return !hasSearchSessions
}

export function loadProjectSessionsCached(
  projectId: string,
  refreshKey: number,
  load: () => Promise<SessionSummary[]>
): Promise<SessionSummary[]> {
  const cached = projectSessionLoads.get(projectId)
  if (cached?.refreshKey === refreshKey) return cached.promise

  const promise = load().catch((error) => {
    if (projectSessionLoads.get(projectId)?.promise === promise) {
      projectSessionLoads.delete(projectId)
    }
    throw error
  })
  projectSessionLoads.set(projectId, { refreshKey, promise })
  return promise
}

export function resetProjectSessionLoadCacheForTesting(): void {
  projectSessionLoads.clear()
}
