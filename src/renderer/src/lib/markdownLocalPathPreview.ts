// Non-component helpers shared by MarkdownContent and MarkdownHoverPreview:
// the local-path stat cache/hook backing file-vs-directory icon resolution,
// and the tooltip styling both use for local-file hover previews. Kept out
// of MarkdownHoverPreview.tsx (a component file) because react-refresh only
// supports fast-refreshing files that export components alone.
import { useEffect, useMemo, useState } from 'react'
import type { LocalPathKind } from './markdownLocalPathReferences'
import type { LocalPathStat } from '../types'

export const HOVER_PREVIEW_OPEN_DELAY_MS = 350

const LOCAL_PATH_STAT_CACHE_LIMIT = 512
const LOCAL_PATH_STAT_MISSING_TTL_MS = 30_000

export const localPathTooltipSlotProps = {
  tooltip: {
    sx: {
      bgcolor: 'background.paper',
      border: 1,
      borderColor: 'divider',
      boxShadow: 3,
      color: 'text.primary',
      fontFamily: 'var(--font-mono)',
      fontSize: '0.75rem',
      lineHeight: 1.45,
      maxWidth: 420,
      overflowWrap: 'anywhere'
    }
  },
  arrow: {
    sx: {
      color: 'background.paper',
      '&::before': {
        border: '1px solid',
        borderColor: 'divider',
        boxSizing: 'border-box'
      }
    }
  }
} as const

const localPathStatCache = new Map<string, { kind: LocalPathStat['kind']; checkedAt: number }>()

function localPathStatApi(): {
  statLocalPaths: (cwd: string, paths: string[]) => Promise<LocalPathStat[]>
} | null {
  if (typeof window === 'undefined') return null

  const api = (window as unknown as { api?: { statLocalPaths?: unknown } }).api
  return typeof api?.statLocalPaths === 'function'
    ? {
        statLocalPaths: api.statLocalPaths as (
          cwd: string,
          paths: string[]
        ) => Promise<LocalPathStat[]>
      }
    : null
}

function localPathStatCacheKey(cwd: string, path: string): string {
  return `${cwd}\0${path}`
}

function cachedLocalPathStat(cwd: string, path: string): LocalPathStat['kind'] | null {
  const key = localPathStatCacheKey(cwd, path)
  const cached = localPathStatCache.get(key)
  if (!cached) return null
  if (cached.kind === 'missing' && Date.now() - cached.checkedAt > LOCAL_PATH_STAT_MISSING_TTL_MS) {
    localPathStatCache.delete(key)
    return null
  }

  localPathStatCache.delete(key)
  localPathStatCache.set(key, cached)
  return cached.kind
}

function rememberLocalPathStats(cwd: string, stats: LocalPathStat[]): void {
  for (const stat of stats) {
    localPathStatCache.set(localPathStatCacheKey(cwd, stat.path), {
      kind: stat.kind,
      checkedAt: Date.now()
    })
  }
  while (localPathStatCache.size > LOCAL_PATH_STAT_CACHE_LIMIT) {
    const oldestPath = localPathStatCache.keys().next().value
    if (!oldestPath) break
    localPathStatCache.delete(oldestPath)
  }
}

export function useLocalPathKinds(
  cwd: string,
  paths: string[]
): ReadonlyMap<string, LocalPathKind> {
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    const pendingPaths = paths.filter((path) => cachedLocalPathStat(cwd, path) === null)
    if (pendingPaths.length === 0) return

    const api = localPathStatApi()
    if (!api) return

    let cancelled = false
    void api
      .statLocalPaths(cwd, pendingPaths)
      .then((stats) => {
        rememberLocalPathStats(cwd, stats)
        if (!cancelled) setRevision((value) => value + 1)
      })
      .catch((error) => {
        console.error('Failed to stat local path references:', error)
      })

    return () => {
      cancelled = true
    }
  }, [cwd, paths])

  return useMemo(() => {
    void revision
    const kinds = new Map<string, LocalPathKind>()
    for (const path of paths) {
      const kind = cachedLocalPathStat(cwd, path)
      if (kind === 'file' || kind === 'directory') {
        kinds.set(path, kind)
      }
    }
    return kinds
  }, [cwd, paths, revision])
}
