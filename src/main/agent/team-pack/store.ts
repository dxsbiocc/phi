import { createReadStream } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import { isTeamPackError, teamPackError } from './errors'
import { assertSafeRelativePath } from './validation'

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_REDIRECTS = 3
const MAX_TIMEOUT_MS = 2_147_483_647
const MAX_REDIRECTS = 10
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

export interface TeamPackStore {
  read(path: string, maxBytes: number): Promise<Buffer | null>
}

export interface HttpTeamPackStoreOptions {
  timeoutMs?: number
  maxRedirects?: number
  fetch?: typeof globalThis.fetch
}

export class DirectoryTeamPackStore implements TeamPackStore {
  private readonly rootDir: string

  constructor(rootDir: string) {
    if (!rootDir) throw teamPackError('INVALID_FORMAT', '存储目录不能为空')
    this.rootDir = resolve(rootDir)
  }

  async read(path: string, maxBytes: number): Promise<Buffer | null> {
    const safePath = assertSafeRelativePath(path)
    assertMaxBytes(maxBytes)
    const target = await resolveDirectoryTarget(this.rootDir, safePath)
    if (!target) return null

    const stream = createReadStream(target)
    const chunks: Buffer[] = []
    let size = 0
    try {
      for await (const value of stream) {
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
        size += chunk.length
        if (size > maxBytes) {
          throw teamPackError('INVALID_FORMAT', '存储文件超出大小限制')
        }
        chunks.push(chunk)
      }
      return Buffer.concat(chunks, size)
    } catch (error) {
      if (isMissingFileError(error)) return null
      if (isTeamPackError(error)) throw error
      throw teamPackError('STORE_UNAVAILABLE', '无法读取团队包存储')
    } finally {
      stream.destroy()
    }
  }
}

async function resolveDirectoryTarget(rootDir: string, path: string): Promise<string | null> {
  let canonicalRoot: string
  try {
    canonicalRoot = await realpath(rootDir)
  } catch {
    throw teamPackError('STORE_UNAVAILABLE', '无法访问团队包存储目录')
  }

  let target: string
  try {
    target = await realpath(resolve(rootDir, path))
  } catch (error) {
    if (isMissingFileError(error)) return null
    throw teamPackError('STORE_UNAVAILABLE', '无法读取团队包存储')
  }
  const suffix = relative(canonicalRoot, target)
  if (isAbsolute(suffix) || suffix === '..' || suffix.startsWith(`..${sep}`)) {
    throw teamPackError('INVALID_FORMAT', '存储路径越过团队包目录')
  }
  return target
}

export class HttpTeamPackStore implements TeamPackStore {
  private readonly baseUrl: URL
  private readonly timeoutMs: number
  private readonly maxRedirects: number
  private readonly fetcher: typeof globalThis.fetch

  constructor(baseUrl: string | URL, options: HttpTeamPackStoreOptions = {}) {
    this.baseUrl = parseBaseUrl(baseUrl)
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS
    assertTimeout(this.timeoutMs)
    assertRedirectCount(this.maxRedirects)
    this.fetcher = options.fetch ?? globalThis.fetch
  }

  async read(path: string, maxBytes: number): Promise<Buffer | null> {
    const safePath = assertSafeRelativePath(path)
    assertMaxBytes(maxBytes)
    const requestUrl = new URL(encodePath(safePath), this.baseUrl)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    timer.unref?.()

    try {
      const response = await this.fetchResponse(requestUrl, controller.signal)
      if (response.status === 404) {
        void response.body?.cancel().catch(() => undefined)
        return null
      }
      if (!response.ok) {
        void response.body?.cancel().catch(() => undefined)
        throw teamPackError('STORE_UNAVAILABLE', '团队包存储返回错误')
      }
      return await readResponseBody(response, maxBytes)
    } catch (error) {
      if (isTeamPackError(error)) throw error
      throw teamPackError('STORE_UNAVAILABLE', '无法访问团队包存储')
    } finally {
      clearTimeout(timer)
    }
  }

  private async fetchResponse(initialUrl: URL, signal: AbortSignal): Promise<Response> {
    let currentUrl = initialUrl
    for (let redirects = 0; ; redirects++) {
      const response = await this.fetcher(currentUrl, {
        credentials: 'omit',
        redirect: 'manual',
        signal
      })
      if (!REDIRECT_STATUSES.has(response.status)) return response

      const location = response.headers.get('location')
      void response.body?.cancel().catch(() => undefined)
      if (!location || redirects >= this.maxRedirects) {
        throw teamPackError('STORE_UNAVAILABLE', '团队包存储跳转无效')
      }
      const nextUrl = parseRedirectUrl(location, currentUrl)
      if (nextUrl.origin !== this.baseUrl.origin) {
        throw teamPackError('STORE_UNAVAILABLE', '团队包存储拒绝跨源跳转')
      }
      currentUrl = nextUrl
    }
  }
}

export function createDirectoryTeamPackStore(rootDir: string): TeamPackStore {
  return new DirectoryTeamPackStore(rootDir)
}

export function createHttpTeamPackStore(
  baseUrl: string | URL,
  options?: HttpTeamPackStoreOptions
): TeamPackStore {
  return new HttpTeamPackStore(baseUrl, options)
}

async function readResponseBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength && /^\d+$/.test(declaredLength) && Number(declaredLength) > maxBytes) {
    void response.body?.cancel().catch(() => undefined)
    throw teamPackError('INVALID_FORMAT', '存储文件超出大小限制')
  }
  if (!response.body) return Buffer.alloc(0)

  const reader = response.body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) break
      const chunk = Buffer.from(result.value)
      size += chunk.length
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined)
        throw teamPackError('INVALID_FORMAT', '存储文件超出大小限制')
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks, size)
  } finally {
    reader.releaseLock()
  }
}

function parseBaseUrl(value: string | URL): URL {
  try {
    const url = new URL(value)
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      throw new Error('invalid base URL')
    }
    if (!url.pathname.endsWith('/')) url.pathname += '/'
    return url
  } catch {
    throw teamPackError('INVALID_FORMAT', 'HTTP 存储地址无效')
  }
}

function parseRedirectUrl(location: string, currentUrl: URL): URL {
  try {
    const nextUrl = new URL(location, currentUrl)
    if (!['http:', 'https:'].includes(nextUrl.protocol) || nextUrl.username || nextUrl.password) {
      throw new Error('invalid redirect URL')
    }
    return nextUrl
  } catch {
    throw teamPackError('STORE_UNAVAILABLE', '团队包存储跳转无效')
  }
}

function encodePath(path: string): string {
  return path.split('/').map(encodeURIComponent).join('/')
}

function assertMaxBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw teamPackError('INVALID_FORMAT', '存储文件大小限制无效')
  }
}

function assertTimeout(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_TIMEOUT_MS) {
    throw teamPackError('INVALID_FORMAT', '超时时间必须为有限正整数')
  }
}

function assertRedirectCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_REDIRECTS) {
    throw teamPackError('INVALID_FORMAT', '跳转次数无效')
  }
}

function isMissingFileError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ENOENT'
  )
}
