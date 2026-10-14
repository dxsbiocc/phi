// Local-path stat caches and hooks backing file-vs-directory icon resolution.
import { useEffect, useMemo, useState } from 'react'
import type { LocalPathKind } from './markdownLocalPathReferences'
import type { LocalPathStat } from '../types'
import type { RemoteProjectFileContextValue } from './remoteProjectFileContext'

export const HOVER_PREVIEW_OPEN_DELAY_MS = 350

const LOCAL_PATH_STAT_CACHE_LIMIT = 512
const LOCAL_PATH_STAT_MISSING_TTL_MS = 30_000

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

export function canStatLocalPaths(): boolean {
  return localPathStatApi() !== null
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
  paths: string[],
  enabled = true
): ReadonlyMap<string, LocalPathKind> {
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!enabled) return
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
  }, [cwd, enabled, paths])

  return useMemo(() => {
    void revision
    const kinds = new Map<string, LocalPathKind>()
    if (!enabled) return kinds
    for (const path of paths) {
      const kind = cachedLocalPathStat(cwd, path)
      if (kind === 'file' || kind === 'directory') {
        kinds.set(path, kind)
      }
    }
    return kinds
  }, [cwd, enabled, paths, revision])
}

type RemotePathStatScope = Pick<
  RemoteProjectFileContextValue,
  'sessionId' | 'projectId' | 'canonicalRoot'
>

const REMOTE_PATH_STAT_CACHE_LIMIT = 512
const REMOTE_PATH_STAT_TTL_MS = 15_000
const REMOTE_PATH_STAT_BATCH_LIMIT = 64
const remotePathStatCache = new Map<string, { kind: LocalPathStat['kind']; checkedAt: number }>()

function remotePathStatApi(): {
  statRemoteWorkspacePaths: (request: {
    sessionId: string
    projectId: string
    paths: string[]
  }) => Promise<LocalPathStat[]>
} | null {
  if (typeof window === 'undefined') return null
  const api = (
    window as unknown as {
      api?: { statRemoteWorkspacePaths?: unknown }
    }
  ).api
  return typeof api?.statRemoteWorkspacePaths === 'function'
    ? {
        statRemoteWorkspacePaths: api.statRemoteWorkspacePaths as (request: {
          sessionId: string
          projectId: string
          paths: string[]
        }) => Promise<LocalPathStat[]>
      }
    : null
}

function remotePathStatCacheKey(scope: RemotePathStatScope, path: string): string {
  return `${scope.sessionId}\0${scope.projectId}\0${scope.canonicalRoot}\0${path}`
}

function cachedRemotePathStat(
  scope: RemotePathStatScope,
  path: string
): LocalPathStat['kind'] | null {
  const key = remotePathStatCacheKey(scope, path)
  const cached = remotePathStatCache.get(key)
  if (!cached) return null
  if (Date.now() - cached.checkedAt > REMOTE_PATH_STAT_TTL_MS) {
    remotePathStatCache.delete(key)
    return null
  }
  remotePathStatCache.delete(key)
  remotePathStatCache.set(key, cached)
  return cached.kind
}

function rememberRemotePathStats(scope: RemotePathStatScope, stats: LocalPathStat[]): void {
  const checkedAt = Date.now()
  for (const stat of stats) {
    remotePathStatCache.set(remotePathStatCacheKey(scope, stat.path), {
      kind: stat.kind,
      checkedAt
    })
  }
  while (remotePathStatCache.size > REMOTE_PATH_STAT_CACHE_LIMIT) {
    const oldestPath = remotePathStatCache.keys().next().value
    if (!oldestPath) break
    remotePathStatCache.delete(oldestPath)
  }
}

export async function loadRemotePathStats(
  scope: RemotePathStatScope,
  paths: string[]
): Promise<boolean> {
  if (!scope.sessionId || !scope.projectId) return false
  const pendingPaths = paths
    .filter((path) => cachedRemotePathStat(scope, path) === null)
    .slice(0, REMOTE_PATH_STAT_BATCH_LIMIT)
  if (pendingPaths.length === 0) return true
  const api = remotePathStatApi()
  if (!api) return false
  const requested = new Set(pendingPaths)
  const stats = (
    await api.statRemoteWorkspacePaths({
      sessionId: scope.sessionId,
      projectId: scope.projectId,
      paths: pendingPaths
    })
  ).filter(
    (stat) =>
      requested.has(stat.path) &&
      (stat.kind === 'file' || stat.kind === 'directory' || stat.kind === 'missing')
  )
  rememberRemotePathStats(scope, stats)
  return true
}

export function useRemotePathKinds(
  scope: RemotePathStatScope | null,
  paths: string[]
): ReadonlyMap<string, LocalPathKind> {
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    if (!scope || paths.every((path) => cachedRemotePathStat(scope, path) !== null)) return
    let cancelled = false
    void loadRemotePathStats(scope, paths)
      .then((loaded) => {
        if (loaded && !cancelled) setRevision((value) => value + 1)
      })
      .catch((error) => console.error('Failed to stat remote path references:', error))
    return () => {
      cancelled = true
    }
  }, [paths, scope])

  return useMemo(() => {
    void revision
    const kinds = new Map<string, LocalPathKind>()
    if (!scope) return kinds
    for (const path of paths) {
      const kind = cachedRemotePathStat(scope, path)
      if (kind === 'file' || kind === 'directory') kinds.set(path, kind)
    }
    return kinds
  }, [paths, revision, scope])
}
