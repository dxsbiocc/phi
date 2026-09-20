import { createHash } from 'node:crypto'

import type { DbNow } from './policy'

interface DbResponseCacheEntry {
  expiresAt: number
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: ArrayBuffer
}

const RESPONSE_CACHE = new Map<string, DbResponseCacheEntry>()

export function dbResponseCacheKey(input: {
  database: string
  method: string
  url: string
  headersDigest: string
  body?: string
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

export function dbHeadersCacheDigest(headers: Headers): string {
  return createHash('sha256')
    .update(JSON.stringify(Array.from(headers.entries()).sort()))
    .digest('hex')
}

export function readDbResponseCache(cacheKey: string, now: DbNow): Response | undefined {
  const entry = RESPONSE_CACHE.get(cacheKey)
  if (!entry) return undefined
  if (entry.expiresAt <= now()) {
    RESPONSE_CACHE.delete(cacheKey)
    return undefined
  }

  return new Response(responseBodyInit(entry.body, entry.status), {
    status: entry.status,
    statusText: entry.statusText,
    headers: entry.headers
  })
}

export async function writeDbResponseCache(
  cacheKey: string,
  response: Response,
  cacheTtlMs: number,
  now: DbNow
): Promise<void> {
  const body = await response.clone().arrayBuffer()
  RESPONSE_CACHE.set(cacheKey, {
    expiresAt: now() + cacheTtlMs,
    status: response.status,
    statusText: response.statusText,
    headers: Array.from(response.headers.entries()),
    body
  })
}

function responseBodyInit(body: ArrayBuffer, status: number): BodyInit | null {
  if (body.byteLength === 0 && (status === 204 || status === 205 || status === 304)) return null
  return body.slice(0)
}
