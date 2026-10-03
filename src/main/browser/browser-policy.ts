import type { BrowserError } from '../../shared/browserTypes'

export interface BrowserPolicyContext {
  applicationOrigins?: readonly string[]
}

export type BrowserUrlPolicyResult = { ok: true; url: string } | { ok: false; error: BrowserError }

const HOST_WITH_PORT_PATTERN = /^[^/?#\s:@[\]]+:\d+(?:[/?#]|$)/
const DANGEROUS_SCHEME_PATTERN = /^(?:file|javascript|data|blob|devtools|chrome):/i

function invalidUrl(): BrowserUrlPolicyResult {
  return {
    ok: false,
    error: {
      code: 'INVALID_URL',
      message: '请输入有效的网址',
      retryable: false
    }
  }
}

function blockedUrl(): BrowserUrlPolicyResult {
  return {
    ok: false,
    error: {
      code: 'SCHEME_BLOCKED',
      message: '此地址不能在应用内浏览器中打开',
      retryable: false
    }
  }
}

export function isLoopbackBrowserHostname(hostname: string): boolean {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const octets = hostname.split('.')
  return (
    octets.length === 4 &&
    octets[0] === '127' &&
    octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)
  )
}

function canonicalOrigin(url: URL): string {
  const hostname = url.hostname.endsWith('.') ? url.hostname.slice(0, -1) : url.hostname
  const port = url.port ? `:${url.port}` : ''
  return `${url.protocol}//${hostname}${port}`
}

function applicationOrigins(context: BrowserPolicyContext): Set<string> {
  const origins = new Set<string>()
  for (const value of context.applicationOrigins ?? []) {
    try {
      origins.add(canonicalOrigin(new URL(value)))
    } catch {
      // Invalid configuration cannot grant access to an application origin.
    }
  }
  return origins
}

export function normalizeBrowserUrl(
  input: string,
  policyContext: BrowserPolicyContext
): BrowserUrlPolicyResult {
  const value = input.trim()
  if (!value) return invalidUrl()
  if (DANGEROUS_SCHEME_PATTERN.test(value)) return blockedUrl()

  try {
    const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(value) && !HOST_WITH_PORT_PATTERN.test(value)
    const url = new URL(hasScheme ? value : `https://${value}`)

    if (url.protocol !== 'https:' && url.protocol !== 'http:') return blockedUrl()
    if (url.username || url.password) return invalidUrl()
    if (applicationOrigins(policyContext).has(canonicalOrigin(url))) return blockedUrl()
    if (url.protocol === 'http:' && !isLoopbackBrowserHostname(url.hostname)) {
      return blockedUrl()
    }

    return { ok: true, url: url.href }
  } catch {
    return invalidUrl()
  }
}
