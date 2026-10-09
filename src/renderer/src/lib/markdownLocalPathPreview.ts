// Non-component helpers shared by MarkdownContent and MarkdownHoverPreview:
// the local-path stat cache/hook backing file-vs-directory icon resolution,
// and the tooltip styling both use for local-file hover previews. Kept out
// of MarkdownHoverPreview.tsx (a component file) because react-refresh only
// supports fast-refreshing files that export components alone.
import { useEffect, useMemo, useState } from 'react'
import type { LocalPathKind } from './markdownLocalPathReferences'
import type { LocalPathStat } from '../types'

export const HOVER_PREVIEW_OPEN_DELAY_MS = 350

export type LocalFileHoverErrorDescription = {
  title: string
  message: string
  action?: string
}

function hoverPreviewErrorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error || '无法预览文件')
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '')
    .replace(/^Error:\s*/, '')
    .trim()
}

export function describeLocalFileHoverError(error: unknown): LocalFileHoverErrorDescription {
  const message = hoverPreviewErrorMessage(error)
  if (
    message.includes('允许读取项目外文件') ||
    message.includes('Phi 保存的文件或当前项目内的文件')
  ) {
    return {
      title: '无法预览项目外文件',
      message: '为保护本地文件，Phi 默认只读取当前项目或 Phi 保存的文件。',
      action: '前往“设置 → 通用”，开启“允许读取项目外文件”后重试。'
    }
  }

  return {
    title: '无法预览文件',
    message: message || '文件暂时无法读取'
  }
}

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
