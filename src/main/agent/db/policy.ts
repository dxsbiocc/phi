import { createHash } from 'node:crypto'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

import type { DbConnectorAuth, DbConnectorManifest, DbConnectorRetryPolicy } from './manifest-types'
import type { DefaultProxyMode } from '../../../shared/appSettingsTypes'
import { DEFAULT_PROXY_MODE } from '../../../shared/appSettingsTypes'
import { getPhiAgentDir } from '../runtime-paths'
import { getDbConnectorAuditLogPath } from './store'

export interface RetryDecisionInput {
  status?: number
  errorName?: string
  policyBlocked?: boolean
  validationFailed?: boolean
}

export interface RetryPolicyConfig {
  maxAttempts: number
  baseDelayMs: number
  maxDelayMs: number
}

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

interface DbHttpErrorOptions {
  code: string
  retryable: boolean
  attempts: number
  redactedUrl: string
  transportName: string
  status?: number
  lastStatus?: number
  nextSuggestedWaitMs?: number
  cause?: unknown
}

export class DbHttpError extends Error {
  readonly code: string
  readonly retryable: boolean
  readonly attempts: number
  readonly status?: number
  readonly lastStatus?: number
  readonly nextSuggestedWaitMs?: number
  readonly safeDetails: {
    redactedUrl: string
    transportName: string
  }

  constructor(message: string, options: DbHttpErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'DbHttpError'
    this.code = options.code
    this.retryable = options.retryable
    this.attempts = options.attempts
    this.status = options.status
    this.lastStatus = options.lastStatus
    this.nextSuggestedWaitMs = options.nextSuggestedWaitMs
    this.safeDetails = {
      redactedUrl: options.redactedUrl,
      transportName: options.transportName
    }
  }
}

export const DEFAULT_DB_RETRY_POLICY: RetryPolicyConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 5000
}

export const DEFAULT_DB_REQUEST_TIMEOUT_MS = 20_000
export const DEFAULT_DB_RESPONSE_MAX_BYTES = 5_000_000
export const DEFAULT_DB_RESPONSE_CACHE_TTL_MS = 60_000

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])
const NON_RETRYABLE_STATUS = new Set([400, 401, 403, 404, 409, 413, 422])
const SECRET_QUERY_PARAM_NAMES = new Set([
  'api_key',
  'apikey',
  'key',
  'token',
  'access_token',
  'auth',
  'authorization'
])
const MAX_REDIRECTS = 5

interface DbResponseCacheEntry {
  expiresAt: number
  status: number
  statusText: string
  headers: Array<[string, string]>
  body: ArrayBuffer
}

interface DbAuditEvent {
  timestamp: string
  database: string
  method: string
  redactedUrl: string
  transportName: string
  defaultProxyMode: DefaultProxyMode
  outcome: 'success' | 'error' | 'cache_hit'
  status?: number
  code?: string
  attempts: number
  cached?: boolean
}

const RESPONSE_CACHE = new Map<string, DbResponseCacheEntry>()
const RATE_LIMIT_NEXT_AT = new Map<string, number>()

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

export function isRetryableDbFailure(input: RetryDecisionInput): boolean {
  if (input.policyBlocked || input.validationFailed) return false
  if (input.status !== undefined) {
    if (NON_RETRYABLE_STATUS.has(input.status)) return false
    return RETRYABLE_STATUS.has(input.status)
  }
  return input.errorName === 'TimeoutError' || input.errorName === 'TypeError'
}

export function retryDelayMs(
  attempt: number,
  policy: RetryPolicyConfig = DEFAULT_DB_RETRY_POLICY,
  retryAfterMs?: number
): number {
  if (retryAfterMs !== undefined) return Math.min(retryAfterMs, policy.maxDelayMs)
  const exponent = Math.max(0, attempt - 1)
  const delay = policy.baseDelayMs * 2 ** exponent
  return Math.min(delay, policy.maxDelayMs)
}

export function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const dateMs = Date.parse(value)
  if (!Number.isFinite(dateMs)) return undefined
  return Math.max(0, dateMs - Date.now())
}

export function redactDbRequestUrl(url: URL): string {
  const redacted = new URL(url.toString())
  for (const key of Array.from(redacted.searchParams.keys())) {
    const normalized = key.toLowerCase()
    if (SECRET_QUERY_PARAM_NAMES.has(normalized) || normalized.includes('token')) {
      redacted.searchParams.set(key, 'REDACTED')
    }
  }
  redacted.username = ''
  redacted.password = ''
  return redacted.toString()
}

export function buildDbRequestUrl(
  manifest: DbConnectorManifest,
  path: string,
  searchParams?: DbHttpRequestOptions['searchParams']
): URL {
  const url = absoluteUrl(path) ? new URL(path) : appendPath(new URL(manifest.baseUrl), path)

  if (searchParams instanceof URLSearchParams) {
    for (const [key, value] of searchParams) url.searchParams.append(key, value)
  } else if (searchParams) {
    for (const [key, value] of Object.entries(searchParams)) {
      if (value !== undefined) url.searchParams.append(key, String(value))
    }
  }

  applyQueryAuth(manifest.auth, url)
  return url
}

export function validateDbRequestUrl(manifest: DbConnectorManifest, url: URL): void {
  const redactedUrl = redactDbRequestUrl(url)
  if (url.protocol !== 'https:') {
    throw new DbHttpError('DB connector request blocked: only https URLs are allowed', {
      code: 'DB_POLICY_BLOCKED',
      retryable: false,
      attempts: 0,
      redactedUrl,
      transportName: 'policy'
    })
  }
  if (url.username || url.password) {
    throw new DbHttpError('DB connector request blocked: URL credentials are not allowed', {
      code: 'DB_POLICY_BLOCKED',
      retryable: false,
      attempts: 0,
      redactedUrl,
      transportName: 'policy'
    })
  }
  if (isBlockedDbHostname(url.hostname)) {
    throw new DbHttpError('DB connector request blocked: localhost/private hosts are not allowed', {
      code: 'DB_POLICY_BLOCKED',
      retryable: false,
      attempts: 0,
      redactedUrl,
      transportName: 'policy'
    })
  }
  const allowedHosts = new Set(
    manifest.networkPolicy.allowedHosts.map((host) => host.toLowerCase())
  )
  if (!allowedHosts.has(url.hostname.toLowerCase())) {
    throw new DbHttpError('DB connector request blocked by allowedHosts policy', {
      code: 'DB_POLICY_BLOCKED',
      retryable: false,
      attempts: 0,
      redactedUrl,
      transportName: 'policy'
    })
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
  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_DB_RESPONSE_CACHE_TTL_MS
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
    cacheTtlMs > 0 && idempotent && init.method === 'GET'
      ? dbResponseCacheKey({
          database: options.manifest.id,
          method: init.method,
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
      const response = await enforceDbResponseSize(
        await fetchWithPolicy({
          manifest: options.manifest,
          transport,
          url: requestUrl,
          init,
          timeoutMs,
          signal
        }),
        {
          maxBytes: maxResponseBytes,
          attempts,
          redactedUrl,
          transportName
        }
      )
      lastStatus = response.status
      if (response.ok) {
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

function normalizeRetryPolicy(policy?: DbConnectorRetryPolicy): RetryPolicyConfig {
  return {
    maxAttempts: Math.max(
      1,
      Math.floor(policy?.maxAttempts ?? DEFAULT_DB_RETRY_POLICY.maxAttempts)
    ),
    baseDelayMs: Math.max(0, policy?.baseDelayMs ?? DEFAULT_DB_RETRY_POLICY.baseDelayMs),
    maxDelayMs: Math.max(0, policy?.maxDelayMs ?? DEFAULT_DB_RETRY_POLICY.maxDelayMs)
  }
}

function dbResponseCacheKey(input: {
  database: string
  method: string
  url: string
  headersDigest: string
  body?: string
}): string {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex')
}

function dbHeadersCacheDigest(headers: Headers): string {
  return createHash('sha256')
    .update(JSON.stringify(Array.from(headers.entries()).sort()))
    .digest('hex')
}

function readDbResponseCache(cacheKey: string, now: DbNow): Response | undefined {
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

async function writeDbResponseCache(
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

async function waitForDbRateLimit(options: {
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

function writeDbAuditEvent(agentDir: string, event: DbAuditEvent): void {
  try {
    const auditLogPath = getDbConnectorAuditLogPath(agentDir)
    mkdirSync(dirname(auditLogPath), { recursive: true })
    appendFileSync(auditLogPath, `${JSON.stringify(event)}\n`, 'utf-8')
  } catch {
    // Audit must not make read-only database access fail.
  }
}

function writeDbAuditError(
  agentDir: string,
  database: string,
  method: string,
  redactedUrl: string,
  options: {
    error: DbHttpError
    transportName: string
    defaultProxyMode: DefaultProxyMode
    now?: DbNow
  }
): void {
  writeDbAuditEvent(agentDir, {
    timestamp: new Date((options.now ?? Date.now)()).toISOString(),
    database,
    method,
    redactedUrl,
    transportName: options.transportName,
    defaultProxyMode: options.defaultProxyMode,
    outcome: 'error',
    status: options.error.status,
    code: options.error.code,
    attempts: options.error.attempts
  })
}

function absoluteUrl(value: string): boolean {
  try {
    new URL(value)
    return true
  } catch {
    return false
  }
}

function appendPath(baseUrl: URL, path: string): URL {
  if (!path) return baseUrl
  const basePath = baseUrl.pathname.endsWith('/') ? baseUrl.pathname : `${baseUrl.pathname}/`
  const requestPath = path.startsWith('/') ? path.slice(1) : path
  baseUrl.pathname = `${basePath}${requestPath}`.replace(/\/{2,}/g, '/')
  return baseUrl
}

function applyQueryAuth(auth: DbConnectorAuth | undefined, url: URL): void {
  if (auth?.type !== 'api_key_query_param' || !auth.envVar || !auth.paramName) return
  const secret = process.env[auth.envVar]
  if (secret) url.searchParams.set(auth.paramName, secret)
}

function applyHeaderAuth(auth: DbConnectorAuth | undefined, headers: Headers): void {
  if (!auth?.envVar) return
  const secret = process.env[auth.envVar]
  if (!secret) return
  if (auth.type === 'api_key_header') {
    headers.set(auth.headerName ?? 'X-API-Key', secret)
  } else if (auth.type === 'bearer_token') {
    headers.set('Authorization', `Bearer ${secret}`)
  }
}

function isBlockedDbHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (normalized === 'localhost' || normalized.endsWith('.localhost')) return true
  const octets = parseIpv4(normalized)
  if (octets) {
    const [first, second] = octets
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168)
    )
  }
  if (normalized === '::1' || normalized === '0:0:0:0:0:0:0:1') return true
  if (normalized.startsWith('fe80:')) return true
  const firstHextet = Number.parseInt(normalized.split(':', 1)[0], 16)
  return Number.isFinite(firstHextet) && (firstHextet & 0xfe00) === 0xfc00
}

function parseIpv4(hostname: string): [number, number, number, number] | undefined {
  const parts = hostname.split('.')
  if (parts.length !== 4) return undefined
  const octets = parts.map((part) => Number(part))
  if (
    octets.some(
      (octet, index) =>
        !Number.isInteger(octet) || octet < 0 || octet > 255 || String(octet) !== parts[index]
    )
  ) {
    return undefined
  }
  return octets as [number, number, number, number]
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
  const abortFromCaller = (): void => controller.abort()
  options.signal?.addEventListener('abort', abortFromCaller, { once: true })

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
      transport.fetch(url, { ...init, signal: controller.signal }),
      timeoutPromise
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
    options.signal?.removeEventListener('abort', abortFromCaller)
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
