import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync
} from 'node:fs'
import { isAbsolute, join, relative, sep, win32 } from 'node:path'

import { parseTarGz, type TarEntry } from '../../packages/archive'

export const MAX_ARTIFACT_BYTES = 512 * 1024 * 1024
export const MAX_EXPANDED_ARCHIVE_BYTES = 512 * 1024 * 1024
const MAX_INSTALLATION_ASSET_BYTES = 16 * 1024 * 1024
const artifactLocks = new Map<string, Promise<void>>()

export interface ArtifactPin {
  url: string
  size?: number
  sha256?: string
  integrity?: string
}

export interface VerifiedArtifact {
  path: string
  key: string
  sha256: string
  size: number
}

export interface ArtifactFetchOptions {
  signal?: AbortSignal
  fetch?: typeof globalThis.fetch
}

/** Revalidate the bytes consumed by a provider after the cache lookup completes. */
export function readVerifiedArtifact(artifact: VerifiedArtifact): Buffer {
  const data = readBoundedRegularFile(artifact.path, MAX_ARTIFACT_BYTES)
  if (
    data.length !== artifact.size ||
    createHash('sha256').update(data).digest('hex') !== artifact.sha256
  ) {
    throw new Error('application artifact changed after verification')
  }
  return data
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error('application installation aborted')
    error.name = 'AbortError'
    throw error
  }
}

export function assertArtifactUrl(value: string): URL {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error('application artifact URL must use HTTPS without credentials or fragment')
  }
  return url
}

function pinDigest(pin: ArtifactPin): { algorithm: 'sha256' | 'sha512'; digest: string } {
  if ((pin.sha256 === undefined) === (pin.integrity === undefined)) {
    throw new Error('application artifact requires exactly one integrity pin')
  }
  if (pin.sha256 !== undefined) {
    if (!/^[a-f0-9]{64}$/i.test(pin.sha256)) throw new Error('invalid artifact sha256')
    return { algorithm: 'sha256', digest: pin.sha256.toLowerCase() }
  }
  const match = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(pin.integrity ?? '')
  if (!match) throw new Error('application artifact requires one SHA512 SRI digest')
  const bytes = Buffer.from(match[1], 'base64')
  if (bytes.length !== 64 || bytes.toString('base64') !== match[1]) {
    throw new Error('invalid artifact SHA512 SRI digest')
  }
  return { algorithm: 'sha512', digest: bytes.toString('hex') }
}

/** Content-addressed bytes are verified on every reuse and published only after verification. */
export async function fetchArtifact(
  root: string,
  pin: ArtifactPin,
  options: ArtifactFetchOptions = {}
): Promise<VerifiedArtifact> {
  assertArtifactUrl(pin.url)
  const digest = pinDigest(pin)
  if (
    pin.size !== undefined &&
    (!Number.isSafeInteger(pin.size) || pin.size < 1 || pin.size > MAX_ARTIFACT_BYTES)
  ) {
    throw new Error('application artifact size is outside the supported bounds')
  }
  throwIfAborted(options.signal)
  const directory = artifactDirectory(root)
  const key = `${digest.algorithm}-${digest.digest}`
  const path = join(directory, key)
  return withArtifactLock(path, options.signal, async () => {
    const cached = verifyCachedArtifact(path, pin, digest)
    if (cached) return { ...cached, key, path }
    const temporary = join(directory, `.${key}.${randomUUID()}.partial`)
    try {
      const metadata = await downloadArtifact(temporary, pin, digest, options)
      throwIfAborted(options.signal)
      renameSync(temporary, path)
      return { path, key, ...metadata }
    } finally {
      rmSync(temporary, { force: true })
    }
  })
}

/** Preserve already verified signed installer inputs as content-addressed offline snapshots. */
export async function cacheVerifiedArtifact(
  root: string,
  bytes: Buffer
): Promise<VerifiedArtifact> {
  if (!bytes.length || bytes.length > MAX_ARTIFACT_BYTES)
    throw new Error('application artifact size is outside the supported bounds')
  const data = Buffer.from(bytes)
  const sha256 = createHash('sha256').update(data).digest('hex')
  const key = `sha256-${sha256}`
  const directory = artifactDirectory(root)
  const path = join(directory, key)
  return withArtifactLock(path, undefined, async () => {
    if (verifyCachedArtifact(path, { size: data.length }, { algorithm: 'sha256', digest: sha256 }))
      return { path, key, sha256, size: data.length }
    const temporary = join(directory, `.${key}.${randomUUID()}.partial`)
    try {
      writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, path)
    } finally {
      rmSync(temporary, { force: true })
    }
    return { path, key, sha256, size: data.length }
  })
}

function artifactDirectory(root: string): string {
  const directory = join(root, 'artifacts')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('application artifact cache must be a regular directory')
  return directory
}

async function withArtifactLock<T>(
  key: string,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>
): Promise<T> {
  const predecessor = artifactLocks.get(key) ?? Promise.resolve()
  let release!: () => void
  const gate = new Promise<void>((resolveGate) => (release = resolveGate))
  const tail = predecessor.then(() => gate)
  artifactLocks.set(key, tail)
  void tail.then(() => {
    if (artifactLocks.get(key) === tail) artifactLocks.delete(key)
  })
  try {
    await abortable(predecessor, signal)
    throwIfAborted(signal)
    return await operation()
  } finally {
    release()
  }
}

function verifyCachedArtifact(
  path: string,
  pin: Pick<ArtifactPin, 'size'>,
  digest: ReturnType<typeof pinDigest>
): { sha256: string; size: number } | undefined {
  let stat
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return undefined
    throw error
  }
  if (stat.isDirectory()) throw new Error('application artifact cache contains a directory')
  if (
    stat.isFile() &&
    stat.size <= MAX_ARTIFACT_BYTES &&
    (pin.size === undefined || stat.size === pin.size)
  ) {
    const bytes = readBoundedRegularFile(path, MAX_ARTIFACT_BYTES)
    if (
      (pin.size === undefined || bytes.length === pin.size) &&
      createHash(digest.algorithm).update(bytes).digest('hex') === digest.digest
    ) {
      return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
    }
  }
  rmSync(path, { force: true })
  return undefined
}

async function downloadArtifact(
  temporary: string,
  pin: ArtifactPin,
  digest: ReturnType<typeof pinDigest>,
  options: ArtifactFetchOptions
): Promise<{ sha256: string; size: number }> {
  const response = await artifactResponse(pin.url, options)
  const length = response.headers.get('content-length')
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > (pin.size ?? MAX_ARTIFACT_BYTES))
  ) {
    void response.body?.cancel().catch(() => undefined)
    throw new Error('application artifact content length exceeds its size bound')
  }
  if (!response.body) throw new Error('application artifact response has no body')
  const reader = response.body.getReader()
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL,
    0o600
  )
  const checksum = createHash(digest.algorithm)
  const sha256 = createHash('sha256')
  let size = 0
  try {
    while (true) {
      const chunk = await abortable(reader.read(), options.signal)
      throwIfAborted(options.signal)
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > (pin.size ?? MAX_ARTIFACT_BYTES))
        throw new Error('application artifact exceeds its size bound')
      checksum.update(chunk.value)
      sha256.update(chunk.value)
      let offset = 0
      while (offset < chunk.value.byteLength) {
        offset += writeSync(descriptor, chunk.value, offset, chunk.value.byteLength - offset)
      }
    }
    if (pin.size !== undefined && size !== pin.size)
      throw new Error('application artifact size mismatch')
    if (checksum.digest('hex') !== digest.digest)
      throw new Error(`application artifact ${digest.algorithm} mismatch`)
    return { sha256: sha256.digest('hex'), size }
  } finally {
    closeSync(descriptor)
    // Do not wait for a stalled transport to acknowledge cancellation.
    void reader.cancel().catch(() => undefined)
  }
}

async function artifactResponse(url: string, options: ArtifactFetchOptions): Promise<Response> {
  const request = options.fetch ?? globalThis.fetch
  let current = url
  for (let redirects = 0; redirects <= 5; redirects++) {
    throwIfAborted(options.signal)
    assertArtifactUrl(current)
    const response = await abortable(
      request(current, { signal: options.signal, redirect: 'manual' }),
      options.signal
    )
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      void response.body?.cancel().catch(() => undefined)
      if (!location || redirects === 5)
        throw new Error('application artifact redirect limit exceeded')
      current = new URL(location, current).href
      continue
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined)
      throw new Error(`application artifact download failed: HTTP ${response.status}`)
    }
    if (response.url) assertArtifactUrl(response.url)
    return response
  }
  throw new Error('application artifact redirect limit exceeded')
}

function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal?.aborted) void operation.catch(() => undefined)
  throwIfAborted(signal)
  if (!signal) return operation
  return new Promise<T>((resolveValue, reject) => {
    const abort = (): void => {
      try {
        throwIfAborted(signal)
      } catch (error) {
        reject(error)
      }
    }
    signal.addEventListener('abort', abort, { once: true })
    operation
      .then(resolveValue, reject)
      .finally(() => signal.removeEventListener('abort', abort))
      .catch(() => undefined)
  })
}

export function safeApplicationRelativePath(value: string): string {
  const normalized = value.startsWith('./') ? value.slice(2) : value
  if (
    !normalized ||
    normalized.includes('\\') ||
    normalized.includes('\0') ||
    normalized.includes('\uFFFD') ||
    isAbsolute(normalized) ||
    win32.isAbsolute(normalized) ||
    normalized
      .split('/')
      .some((part) => !part || part === '.' || part === '..' || part.includes(':'))
  )
    throw new Error(`unsafe application asset path: ${value}`)
  return normalized
}

/** Read a pinned installer input without following a symlink in its relative path. */
export function readVerifiedInstallationAsset(
  sourceDir: string,
  path: string,
  sha256: string
): Buffer {
  if (!/^[a-f0-9]{64}$/i.test(sha256)) throw new Error('invalid installation asset sha256')
  const name = safeApplicationRelativePath(path)
  if (!lstatSync(sourceDir).isDirectory() || lstatSync(sourceDir).isSymbolicLink())
    throw new Error('installation source must be a regular directory')
  const base = realpathSync(sourceDir)
  let candidate = base
  const parts = name.split('/')
  for (let index = 0; index < parts.length; index++) {
    candidate = join(candidate, parts[index])
    const stat = lstatSync(candidate)
    if (
      stat.isSymbolicLink() ||
      (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
    ) {
      throw new Error('installation asset must be a regular file without symlinks')
    }
  }
  const suffix = relative(base, realpathSync(candidate))
  if (!suffix || suffix.startsWith(`..${sep}`) || suffix === '..' || isAbsolute(suffix))
    throw new Error('installation asset escapes source directory')
  const bytes = readBoundedRegularFile(candidate, MAX_INSTALLATION_ASSET_BYTES)
  if (createHash('sha256').update(bytes).digest('hex') !== sha256.toLowerCase())
    throw new Error('installation asset sha256 mismatch')
  return bytes
}

function readBoundedRegularFile(path: string, limit: number): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const stat = fstatSync(descriptor)
    if (!stat.isFile() || stat.size > limit)
      throw new Error('application asset exceeds its size bound')
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, limit - total + 1))
      const length = readSync(descriptor, chunk, 0, chunk.length, null)
      if (!length) return Buffer.concat(chunks, total)
      total += length
      if (total > limit) throw new Error('application asset exceeds its size bound')
      chunks.push(chunk.subarray(0, length))
    }
  } finally {
    closeSync(descriptor)
  }
}

export function installationSpecSha256(spec: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalValue(spec)))
    .digest('hex')
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalValue(item)])
    )
  }
  return value
}

/** Validate all tar members before a provider writes or inspects any member. */
export function readTarEntries(
  archive: Buffer,
  maxExpandedBytes = MAX_EXPANDED_ARCHIVE_BYTES
): TarEntry[] {
  if (archive.length > MAX_ARTIFACT_BYTES)
    throw new Error('application archive exceeds its size bound')
  const entries = parseTarGz(archive, maxExpandedBytes)
  if (entries.length > 10000) throw new Error('application archive has too many members')
  const paths = new Map<string, TarEntry['type']>()
  for (const entry of entries) {
    if (entry.type !== 'file' && entry.type !== 'directory')
      throw new Error('application archive contains a link or special file')
    entry.path = safeApplicationRelativePath(entry.path.replace(/\/$/, ''))
    if (entry.type === 'directory' && entry.size !== 0)
      throw new Error('application archive directory contains data')
    if (paths.has(entry.path)) throw new Error('application archive contains duplicate members')
    paths.set(entry.path, entry.type)
  }
  for (const path of paths.keys()) {
    const parts = path.split('/')
    for (let index = 1; index < parts.length; index++) {
      if (paths.get(parts.slice(0, index).join('/')) === 'file')
        throw new Error('application archive member collides with a file')
    }
  }
  return entries
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : undefined
}
