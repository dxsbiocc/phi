import type { RemoteRuntimeRootCheckResult } from '../../../shared/remoteRuntimeRootTypes'
import { checkRemoteRuntimeRoot, type RemoteRuntimeRootCheckSession } from './runtime-root-check'

export type CheckRemoteRuntimeRoot = (
  session: RemoteRuntimeRootCheckSession,
  configuredRoot: string
) => Promise<RemoteRuntimeRootCheckResult>

interface CacheEntry {
  expiresAt: number
  result: Promise<RemoteRuntimeRootCheckResult>
}

const CACHE_TTL_MS = 60_000
const MAX_CACHE_ENTRIES = 64
const cache = new Map<string, CacheEntry>()

function pruneCache(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key)
  }
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined
    if (!oldest) break
    cache.delete(oldest)
  }
}

export function cachedRemoteRuntimeRootCheck(
  scope: string,
  session: RemoteRuntimeRootCheckSession,
  configuredRoot: string,
  check: CheckRemoteRuntimeRoot = checkRemoteRuntimeRoot,
  now = Date.now()
): Promise<RemoteRuntimeRootCheckResult> {
  pruneCache(now)
  const key = `${scope}\0${configuredRoot}`
  const existing = cache.get(key)
  if (existing) return existing.result
  const result = check(session, configuredRoot).then(
    (value) => {
      if (value.status !== 'checked') cache.delete(key)
      return value
    },
    (error: unknown) => {
      cache.delete(key)
      throw error
    }
  )
  cache.set(key, { expiresAt: now + CACHE_TTL_MS, result })
  return result
}
