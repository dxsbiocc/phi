import type { ResourceIconRef } from '../../../../../shared/resourceIconTypes'
import type { WrapperCompositionCatalogItem } from '../../../../../shared/wrapperCompositionManifestTypes'
import type { WrapperRun } from '../../../../../shared/wrapperTypes'
import type { Project, SessionSummary } from '../../../types'

export type HomeResourceCounts = Record<
  'skills' | 'wrappers' | 'connectors' | 'plugins',
  { total: number; active: number; loading?: boolean; icons?: ResourceIconRef[] }
>

export type RankedWrapper = { id: string; name: string; count: number }
export type HomeRecentWorkItem = { session: SessionSummary; project: Project | null }

export function homeResourceIcons(
  entries: readonly { icon?: ResourceIconRef }[],
  limit = 2
): ResourceIconRef[] {
  return entries.flatMap((entry) => (entry.icon?.key ? [entry.icon] : [])).slice(0, limit)
}

function continuationPriority(session: SessionSummary): number {
  if (session.status === 'needs_approval' || session.status === 'needs_input') return 3
  if (session.status === 'failed') return 2
  if (session.status === 'running') return 1
  return 0
}

export function selectHomeRecentWork(
  ordinarySessions: readonly SessionSummary[],
  projectWork: readonly HomeRecentWorkItem[],
  lastClosedSessionPath: string | null,
  limit = 4
): HomeRecentWorkItem[] {
  const byPath = new Map<string, HomeRecentWorkItem>()
  for (const session of ordinarySessions) byPath.set(session.path, { session, project: null })
  for (const item of projectWork) byPath.set(item.session.path, item)

  return [...byPath.values()]
    .filter(({ session }) => session.messageCount > 0)
    .sort((left, right) => {
      const priority = continuationPriority(right.session) - continuationPriority(left.session)
      if (priority !== 0) return priority
      if (left.session.path === lastClosedSessionPath) return -1
      if (right.session.path === lastClosedSessionPath) return 1
      return (
        (right.session.lastActivityAt ?? right.session.modified).localeCompare(
          left.session.lastActivityAt ?? left.session.modified
        ) || left.session.path.localeCompare(right.session.path)
      )
    })
    .slice(0, limit)
}

export function rankHomeWrapperRuns(
  runs: readonly WrapperRun[],
  catalog: readonly WrapperCompositionCatalogItem[],
  limit = 3
): RankedWrapper[] {
  const names = new Map(catalog.map((wrapper) => [wrapper.id, wrapper.name]))
  const ranking = new Map<string, RankedWrapper>()

  for (const run of runs) {
    const id = run.wrapper.canonicalId
    const current = ranking.get(id)
    if (current) {
      current.count += 1
    } else {
      ranking.set(id, { id, name: names.get(id) ?? run.wrapper.shortId ?? id, count: 1 })
    }
  }

  return [...ranking.values()]
    .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'))
    .slice(0, limit)
}
