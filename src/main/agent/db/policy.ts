import type { DbConnectorManifest, DbConnectorRetryPolicy } from './manifest-types'
import type { DefaultProxyMode } from '../../../shared/appSettingsTypes'
import { DEFAULT_PROXY_MODE } from '../../../shared/appSettingsTypes'
import { getPhiAgentDir } from '../runtime-paths'
import { writeDbAuditError, writeDbAuditEvent } from './policy-audit'
import {
  dbHeadersCacheDigest,
  dbResponseCacheKey,
  readDbResponseCache,
  writeDbResponseCache
} from './policy-cache'
import { DbHttpError } from './policy-error'
import { waitForDbRateLimit } from './policy-rate-limit'
import {
  isRetryableDbFailure,
  normalizeRetryPolicy,
  parseRetryAfterMs,
  retryDelayMs
} from './policy-retry'
import {
  applyHeaderAuth,
  buildDbRequestUrl,
  redactDbRequestUrl,
  validateDbRequestUrl
} from './policy-url'

export {
  DEFAULT_DB_RETRY_POLICY,
  isRetryableDbFailure,
  parseRetryAfterMs,
  retryDelayMs,
  type RetryDecisionInput,
  type RetryPolicyConfig
} from './policy-retry'
export { DbHttpError } from './policy-error'
export { buildDbRequestUrl, redactDbRequestUrl, validateDbRequestUrl } from './policy-url'

export type DbSleep = (ms: number, signal?: AbortSignal) => Promise<void>
export type DbFetch = (input: URL, init: RequestInit) => Promise<Response>
export type DbNow = () => number

export interface DbEgressTransport {
  name?: string
  fetch: DbFetch
}

export interface ResolvedDbEgressTransport {
  transport: DbEgressTransport
  transportName: string
  defaultProxyMode: DefaultProxyMode
}

export interface DbHttpRequestOptions {
  manifest: DbConnectorManifest
  path: string
  searchParams?: URLSearchParams | Record<string, string | number | boolean | undefined>
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
  maxResponseBytes?: number
  /** Return the response body as a stream; the caller must enforce the byte limit while reading. */
  streamResponse?: boolean
  /** Return a redirect response so a caller can validate its next destination separately. */
  allowRedirectResponse?: boolean
  cacheTtlMs?: number
  agentDir?: string
  now?: DbNow
  retryPolicy?: DbConnectorRetryPolicy
  defaultProxyMode?: DefaultProxyMode
  transport?: DbEgressTransport
  proxyTransport?: DbEgressTransport
  sleep?: DbSleep
  idempotent?: boolean
}

export interface DbHttpResponse {
  response: Response
  attempts: number
  retried: boolean
  lastStatus: number
  redactedUrl: string
  transportName: string
  defaultProxyMode: DefaultProxyMode
  cached?: boolean
}

export const DEFAULT_DB_REQUEST_TIMEOUT_MS = 20_000
export const DEFAULT_DB_RESPONSE_MAX_BYTES = 5_000_000
export const DEFAULT_DB_RESPONSE_CACHE_TTL_MS = 60_000

const MAX_REDIRECTS = 5

const SYSTEM_EGRESS_TRANSPORT: DbEgressTransport = {
  name: 'system',
  fetch(input, init) {
    return fetch(input, init)
  }
}

export function resolveDbEgressTransport({
  defaultProxyMode = DEFAULT_PROXY_MODE,
  transport,
  proxyTransport,
  redactedUrl = ''
}: {
  defaultProxyMode?: DefaultProxyMode
  transport?: DbEgressTransport
  proxyTransport?: DbEgressTransport
  redactedUrl?: string
}): ResolvedDbEgressTransport {
  if (transport) {
    return {
      transport,
      transportName: transport.name ?? 'custom',
      defaultProxyMode
    }
  }

  if (defaultProxyMode === 'disabled') {
    return {
      transport: SYSTEM_EGRESS_TRANSPORT,
      transportName: SYSTEM_EGRESS_TRANSPORT.name ?? 'system',
      defaultProxyMode
    }
  }

  if (proxyTransport) {
    return {
      transport: proxyTransport,
      transportName: proxyTransport.name ?? 'proxy',
      defaultProxyMode
    }
  }

  if (defaultProxyMode === 'enabled') {
    throw new DbHttpError(
      'DB connector proxy mode is enabled, but no proxy transport is configured',
      {
        code: 'DB_PROXY_UNAVAILABLE',
        retryable: false,
        attempts: 0,
        redactedUrl,
        transportName: 'proxy'
      }
    )
  }

  return {
    transport: SYSTEM_EGRESS_TRANSPORT,
    transportName: SYSTEM_EGRESS_TRANSPORT.name ?? 'system',
    defaultProxyMode
  }
}

export async function executeDbHttpRequest(options: DbHttpRequestOptions): Promise<DbHttpResponse> {
  const retryPolicy = normalizeRetryPolicy(options.retryPolicy ?? options.manifest.retryPolicy)
  const method = options.method ?? 'GET'
  const now = options.now ?? Date.now
  const agentDir = options.agentDir ?? getPhiAgentDir()
  const requestUrl = buildDbRequestUrl(options.manifest, options.path, options.searchParams)
  const redactedUrl = redactDbRequestUrl(requestUrl)
  const requestedProxyMode = options.defaultProxyMode ?? DEFAULT_PROXY_MODE

  try {
    validateDbRequestUrl(options.manifest, requestUrl)
  } catch (error) {
    if (error instanceof DbHttpError) {
      writeDbAuditError(agentDir, options.manifest.id, method, redactedUrl, {
        error,
        transportName: 'policy',
        defaultProxyMode: requestedProxyMode,
        now
      })
    }
    throw error
  }

  let resolvedTransport: ResolvedDbEgressTransport
  try {
    resolvedTransport = resolveDbEgressTransport({
      defaultProxyMode: options.defaultProxyMode,
      transport: options.transport,
      proxyTransport: options.proxyTransport,
      redactedUrl
    })
  } catch (error) {
    if (error instanceof DbHttpError) {
      writeDbAuditError(agentDir, options.manifest.id, method, redactedUrl, {
        error,
        transportName: error.safeDetails.transportName,
        defaultProxyMode: requestedProxyMode,
        now
      })
    }
    throw error
  }

  const { transport, transportName, defaultProxyMode } = resolvedTransport

  const headers = new Headers(options.headers)
  applyHeaderAuth(options.manifest.auth, headers)
  const timeoutMs = options.timeoutMs ?? DEFAULT_DB_REQUEST_TIMEOUT_MS
  const maxResponseBytes = options.maxResponseBytes ?? DEFAULT_DB_RESPONSE_MAX_BYTES
  const cacheTtlMs = options.streamResponse
    ? 0
    : (options.cacheTtlMs ?? DEFAULT_DB_RESPONSE_CACHE_TTL_MS)
  const sleep = options.sleep ?? defaultDbSleep
  const signal = options.signal
  const init: RequestInit = {
    method,
    headers,
    body: options.body,
    redirect: options.manifest.networkPolicy.allowRedirects ? 'manual' : 'error'
  }
  const headersDigest = dbHeadersCacheDigest(headers)
  const idempotent = options.idempotent ?? init.method === 'GET'
  const cacheKey =
    cacheTtlMs > 0 && idempotent
      ? dbResponseCacheKey({
          database: options.manifest.id,
          method,
          url: requestUrl.toString(),
          headersDigest,
          body: options.body
        })
      : undefined

  if (signal?.aborted) {
    const error = new DbHttpError('DB connector request cancelled', {
      code: 'DB_REQUEST_CANCELLED',
      retryable: false,
      attempts: 0,
      redactedUrl,
      transportName
    })
    writeDbAuditError(agentDir, options.manifest.id, init.method ?? 'GET', redactedUrl, {
      error,
      transportName,
      defaultProxyMode,
      now
    })
    throw error
  }

  const cachedResponse = cacheKey ? readDbResponseCache(cacheKey, now) : undefined
  if (cachedResponse) {
    writeDbAuditEvent(agentDir, {
      timestamp: new Date(now()).toISOString(),
      database: options.manifest.id,
      method: init.method ?? 'GET',
      redactedUrl,
      transportName,
      defaultProxyMode,
      outcome: 'cache_hit',
      status: cachedResponse.status,
      attempts: 0,
      cached: true
    })
    return {
      response: cachedResponse,
      attempts: 0,
      retried: false,
      lastStatus: cachedResponse.status,
      redactedUrl,
      transportName,
      defaultProxyMode,
      cached: true
    }
  }

  let attempts = 0
  let retried = false
  let lastStatus: number | undefined

  while (attempts < retryPolicy.maxAttempts) {
    attempts += 1

    try {
      await waitForDbRateLimit({
        manifest: options.manifest,
        sleep,
        signal,
        now
      })
      const rawResponse = await fetchWithPolicy({
        manifest: options.manifest,
        transport,
        url: requestUrl,
        init,
        timeoutMs,
        signal
      })
      const response = options.streamResponse
        ? enforceDbResponseHeaderSize(rawResponse, {
            maxBytes: maxResponseBytes,
            attempts,
            redactedUrl,
            transportName
          })
        : await enforceDbResponseSize(rawResponse, {
            maxBytes: maxResponseBytes,
            attempts,
            redactedUrl,
            transportName
          })
      lastStatus = response.status
      if (response.ok || (options.allowRedirectResponse && isRedirect(response.status))) {
        if (cacheKey && cacheTtlMs > 0) {
          await writeDbResponseCache(cacheKey, response, cacheTtlMs, now)
        }
        writeDbAuditEvent(agentDir, {
          timestamp: new Date(now()).toISOString(),
          database: options.manifest.id,
          method: init.method ?? 'GET',
          redactedUrl,
          transportName,
          defaultProxyMode,
          outcome: 'success',
          status: response.status,
          attempts
        })
        return {
          response,
          attempts,
          retried,
          lastStatus,
          redactedUrl,
          transportName,
          defaultProxyMode
        }
      }

      const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'))
      const retryable =
        idempotent &&
        isRetryableDbFailure({ status: response.status }) &&
        attempts < retryPolicy.maxAttempts
      if (retryable) {
        retried = true
        await sleep(retryDelayMs(attempts, retryPolicy, retryAfterMs), signal)
        continue
      }

      throw new DbHttpError(`DB connector request failed with HTTP ${response.status}`, {
        code: 'DB_HTTP_STATUS',
        retryable: idempotent && isRetryableDbFailure({ status: response.status }),
        attempts,
        status: response.status,
        lastStatus,
        nextSuggestedWaitMs: retryAfterMs,
        redactedUrl,
        transportName
      })
    } catch (error) {
      if (error instanceof DbHttpError) {
        writeDbAuditError(agentDir, options.manifest.id, init.method ?? 'GET', redactedUrl, {
          error,
          transportName,
          defaultProxyMode,
          now
        })
        throw error
      }

      const errorName = error instanceof Error ? error.name : undefined
      const retryable =
        idempotent &&
        !signal?.aborted &&
        isRetryableDbFailure({ errorName }) &&
        attempts < retryPolicy.maxAttempts
      if (retryable) {
        retried = true
        await sleep(retryDelayMs(attempts, retryPolicy), signal)
        continue
      }

      const dbError = new DbHttpError(
        signal?.aborted ? 'DB connector request cancelled' : 'DB connector request failed',
        {
          code: signal?.aborted ? 'DB_REQUEST_CANCELLED' : 'DB_REQUEST_FAILED',
          retryable: idempotent && !signal?.aborted && isRetryableDbFailure({ errorName }),
          attempts,
          lastStatus,
          redactedUrl,
          transportName,
          cause: error
        }
      )
      writeDbAuditError(agentDir, options.manifest.id, init.method ?? 'GET', redactedUrl, {
        error: dbError,
        transportName,
        defaultProxyMode,
        now
      })
      throw dbError
    }
  }

  const exhausted = new DbHttpError('DB connector request failed after retries', {
    code: 'DB_RETRIES_EXHAUSTED',
    retryable: true,
    attempts,
    lastStatus,
    redactedUrl,
    transportName
  })
  writeDbAuditError(agentDir, options.manifest.id, init.method ?? 'GET', redactedUrl, {
    error: exhausted,
    transportName,
    defaultProxyMode,
    now
  })
  throw exhausted
}

async function enforceDbResponseSize(
  response: Response,
  options: {
    maxBytes: number
    attempts: number
    redactedUrl: string
    transportName: string
  }
): Promise<Response> {
  enforceDbResponseHeaderSize(response, options)
  const body = await response.arrayBuffer()
  if (body.byteLength > options.maxBytes) {
    throw new DbHttpError('DB connector response exceeded maximum size', {
      code: 'DB_RESPONSE_TOO_LARGE',
      retryable: false,
      attempts: options.attempts,
      status: response.status,
      lastStatus: response.status,
      redactedUrl: options.redactedUrl,
      transportName: options.transportName
    })
  }

  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

function enforceDbResponseHeaderSize(
  response: Response,
  options: {
    maxBytes: number
    attempts: number
    redactedUrl: string
    transportName: string
  }
): Response {
  const contentLength = parseContentLength(response.headers.get('content-length'))
  if (contentLength !== undefined && contentLength > options.maxBytes) {
    throw new DbHttpError('DB connector response exceeded maximum size', {
      code: 'DB_RESPONSE_TOO_LARGE',
      retryable: false,
      attempts: options.attempts,
      status: response.status,
      lastStatus: response.status,
      redactedUrl: options.redactedUrl,
      transportName: options.transportName
    })
  }

  return response
}

function parseContentLength(value: string | null): number | undefined {
  if (!value) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined
}

async function fetchWithPolicy(options: {
  manifest: DbConnectorManifest
  transport: DbEgressTransport
  url: URL
  init: RequestInit
  timeoutMs: number
  signal?: AbortSignal
}): Promise<Response> {
  let currentUrl = options.url
  for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
    validateDbRequestUrl(options.manifest, currentUrl)
    const response = await fetchWithTimeout(options.transport, currentUrl, options.init, {
      timeoutMs: options.timeoutMs,
      signal: options.signal
    })
    if (!options.manifest.networkPolicy.allowRedirects || !isRedirect(response.status)) {
      return response
    }

    const location = response.headers.get('location')
    if (!location) return response
    currentUrl = new URL(location, currentUrl)
  }

  throw new DbHttpError('DB connector request blocked: too many redirects', {
    code: 'DB_POLICY_BLOCKED',
    retryable: false,
    attempts: 0,
    redactedUrl: redactDbRequestUrl(options.url),
    transportName: options.transport.name ?? 'custom'
  })
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400
}

async function fetchWithTimeout(
  transport: DbEgressTransport,
  url: URL,
  init: RequestInit,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<Response> {
  throwIfAborted(options.signal)
  const controller = new AbortController()
  const requestSignal = options.signal
    ? AbortSignal.any([controller.signal, options.signal])
    : controller.signal

  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    const timeoutPromise = new Promise<Response>((_, reject) => {
      timeout = setTimeout(() => {
        controller.abort()
        const error = new Error('DB connector request timed out')
        error.name = 'TimeoutError'
        reject(error)
      }, options.timeoutMs)
      const maybeUnref = timeout as { unref?: () => void }
      maybeUnref.unref?.()
    })
    return await Promise.race([
      transport.fetch(url, { ...init, signal: requestSignal }),
      timeoutPromise
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

async function defaultDbSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (ms <= 0) return
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(onResolve, ms)
    const maybeUnref = timeout as { unref?: () => void }
    maybeUnref.unref?.()
    signal?.addEventListener('abort', onAbort, { once: true })

    function onAbort(): void {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
      reject(abortError())
    }

    function onResolve(): void {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }
  })
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError()
}

function abortError(): Error {
  const error = new Error('DB connector request cancelled')
  error.name = 'AbortError'
  return error
}
