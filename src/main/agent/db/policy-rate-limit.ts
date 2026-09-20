import type { DbConnectorAuth, DbConnectorManifest } from './manifest-types'
import type { DbNow, DbSleep } from './policy'

const RATE_LIMIT_NEXT_AT = new Map<string, number>()

export async function waitForDbRateLimit(options: {
  manifest: DbConnectorManifest
  sleep: DbSleep
  signal?: AbortSignal
  now: DbNow
}): Promise<void> {
  const rateLimit = rateLimitFor(options.manifest)
  const requestsPerSecond = rateLimit?.requestsPerSecond
  if (!Number.isFinite(requestsPerSecond) || requestsPerSecond === undefined) return
  if (requestsPerSecond <= 0) return

  const authenticated = dbRequestUsesAuth(options.manifest.auth)
  const key = `${options.manifest.id}:${authenticated ? 'auth' : 'anon'}`
  const current = options.now()
  const nextAt = RATE_LIMIT_NEXT_AT.get(key) ?? current
  if (nextAt > current) {
    await options.sleep(nextAt - current, options.signal)
  }

  RATE_LIMIT_NEXT_AT.set(key, Math.max(options.now(), nextAt) + 1000 / requestsPerSecond)
}

function rateLimitFor(manifest: DbConnectorManifest): { requestsPerSecond: number } | undefined {
  if (!manifest.rateLimit) return undefined
  if (dbRequestUsesAuth(manifest.auth)) {
    return manifest.rateLimit.withAuth ?? manifest.rateLimit.withoutAuth
  }
  return manifest.rateLimit.withoutAuth ?? manifest.rateLimit.withAuth
}

function dbRequestUsesAuth(auth: DbConnectorAuth | undefined): boolean {
  return Boolean(auth && auth.type !== 'none' && auth.envVar && process.env[auth.envVar])
}
