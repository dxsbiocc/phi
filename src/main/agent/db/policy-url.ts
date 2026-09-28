import { resolveDbAuthSecret } from './credential-store'
import type { DbConnectorAuth, DbConnectorManifest } from './manifest-types'
import { DbHttpError } from './policy-error'

type DbRequestSearchParams = URLSearchParams | Record<string, string | number | boolean | undefined>

const SECRET_QUERY_PARAM_NAMES = new Set([
  'api_key',
  'apikey',
  'accesskey',
  'key',
  'token',
  'access_token',
  'auth',
  'authorization'
])

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
  searchParams?: DbRequestSearchParams
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

export function applyHeaderAuth(auth: DbConnectorAuth | undefined, headers: Headers): void {
  if (!auth || auth.type === 'none' || !auth.envVar) return
  const secret = resolveDbAuthSecret(auth.envVar)
  if (!secret) {
    if (auth.required) {
      throw new DbHttpError(
        `DB connector requires API key (${auth.envVar}). Configure it in Settings → Databases.`,
        {
          code: 'DB_AUTH_REQUIRED',
          retryable: false,
          attempts: 0,
          redactedUrl: 'about:blank',
          transportName: 'policy'
        }
      )
    }
    return
  }
  if (auth.type === 'api_key_header') {
    headers.set(auth.headerName ?? 'X-API-Key', secret)
  } else if (auth.type === 'bearer_token') {
    headers.set('Authorization', `Bearer ${secret}`)
  }
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
  const secret = resolveDbAuthSecret(auth.envVar)
  if (!secret) {
    if (auth.required) {
      throw new DbHttpError(
        `DB connector requires API key (${auth.envVar}). Configure it in Settings → Databases.`,
        {
          code: 'DB_AUTH_REQUIRED',
          retryable: false,
          attempts: 0,
          redactedUrl: redactDbRequestUrl(url),
          transportName: 'policy'
        }
      )
    }
    return
  }
  url.searchParams.set(auth.paramName, secret)
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
