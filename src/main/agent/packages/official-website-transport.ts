export const OFFICIAL_WEBSITE_BASE_URL = 'https://phi.omicsagent.cn'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_TIMEOUT_MS = 60_000

/** HTTP status carried by a non-ok website response; callers can distinguish 404 from failures. */
export class OfficialWebsiteHttpError extends Error {
  readonly status: number

  constructor(status: number, pathname: string) {
    super(`official website request failed: ${pathname}`)
    this.name = 'OfficialWebsiteHttpError'
    this.status = status
  }
}

export interface OfficialWebsiteRequestOptions {
  /** Application transport; callers cannot select an arbitrary endpoint. */
  fetch?: typeof fetch
  /** Trusted configuration/test origin, without a path, credentials, query, or fragment. */
  baseUrl?: string
  timeoutMs?: number
  signal?: AbortSignal
}

/**
 * Bounded JSON transport shared by website catalog search and detail clients.
 * It rejects redirects to another origin, oversized bodies, stalled reads and malformed UTF-8/JSON.
 */
export async function fetchOfficialWebsiteJson(
  relativeUrl: string,
  maxBytes: number,
  options: OfficialWebsiteRequestOptions = {}
): Promise<unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error('invalid official website response limit')
  }
  const origin = officialWebsiteOrigin(options.baseUrl ?? OFFICIAL_WEBSITE_BASE_URL)
  const url = officialWebsiteUrl(relativeUrl, origin)
  const timeoutMs = requestTimeout(options.timeoutMs)
  const controller = new AbortController()
  const abort = (): void => controller.abort(options.signal?.reason)
  options.signal?.addEventListener('abort', abort, { once: true })
  let rejectOnAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectOnAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', rejectOnAbort, { once: true })
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    options.signal?.throwIfAborted()
    const response = await Promise.race([
      (options.fetch ?? fetch)(url.href, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
        signal: controller.signal
      }),
      aborted,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error(`official website request timed out: ${url.pathname}`))
        }, timeoutMs)
      })
    ])
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    options.signal?.throwIfAborted()
    validateResponse(response, url, origin, maxBytes)
    return await readJsonBody(response, maxBytes, timeoutMs, controller, options.signal)
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    if (rejectOnAbort) controller.signal.removeEventListener('abort', rejectOnAbort)
  }
}

function validateResponse(response: Response, url: URL, origin: string, maxBytes: number): void {
  if (!response.ok) throw new OfficialWebsiteHttpError(response.status, url.pathname)
  if (response.url && new URL(response.url).origin !== origin) {
    throw new Error('unexpected official website response origin')
  }
  const declaredSize = response.headers.get('content-length')
  if (declaredSize && (!/^\d+$/.test(declaredSize) || Number(declaredSize) > maxBytes)) {
    void response.body?.cancel().catch(() => {})
    throw new Error('official website response exceeds size limit')
  }
}

export function officialWebsiteOrigin(value: string): string {
  const url = new URL(value)
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  ) {
    throw new Error('invalid official website origin')
  }
  return url.origin
}

function officialWebsiteUrl(relativeUrl: string, origin: string): URL {
  if (
    typeof relativeUrl !== 'string' ||
    relativeUrl.length > 8_192 ||
    !relativeUrl.startsWith('/api/') ||
    relativeUrl.includes('#')
  ) {
    throw new Error('invalid official website API path')
  }
  const url = new URL(relativeUrl, origin)
  if (url.origin !== origin || !url.pathname.startsWith('/api/')) {
    throw new Error('invalid official website API URL')
  }
  return url
}

function requestTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_TIMEOUT_MS
  if (!Number.isFinite(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error('invalid official website request timeout')
  }
  return timeoutMs
}

async function readJsonBody(
  response: Response,
  maxBytes: number,
  timeoutMs: number,
  controller: AbortController,
  externalSignal?: AbortSignal
): Promise<unknown> {
  if (!response.body) throw new Error('empty official website response')
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let body = ''
  try {
    while (true) {
      const chunk = await readWithTimeout(reader, timeoutMs, controller, externalSignal)
      externalSignal?.throwIfAborted()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maxBytes) throw new Error('official website response exceeds size limit')
      body += decoder.decode(chunk.value, { stream: true })
    }
    body += decoder.decode()
    return JSON.parse(body)
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  controller: AbortController,
  externalSignal?: AbortSignal
): Promise<ReadableStreamReadResult<Uint8Array>> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let abort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(externalSignal?.reason)
    externalSignal?.addEventListener('abort', abort, { once: true })
  })
  try {
    return await Promise.race([
      reader.read(),
      aborted,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new Error('official website response read timed out'))
        }, timeoutMs)
      })
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    if (abort) externalSignal?.removeEventListener('abort', abort)
  }
}
