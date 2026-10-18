import { createHash, randomUUID } from 'node:crypto'
import { constants, createWriteStream, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { desktopFetch } from '../../../desktop-fetch'
import { hashLocalFile } from '../../../transfer/ssh-data-plane-local'

import { RemoteOmpDeploymentError, type RemoteOmpAsset } from './types'

interface CacheOptions {
  cacheDir: string
  version: string
  platform: string
  asset: RemoteOmpAsset
  signal?: AbortSignal
  fetchImpl?: typeof fetch
  onProgress?: (bytes: number, total?: number) => void
}

const activeCacheWrites = new Map<string, Promise<void>>()

function assertOwnedCacheEntry(info: Stats, path: string, directory: boolean): void {
  const uid = process.getuid?.()
  if (
    (directory ? !info.isDirectory() : !info.isFile() || info.nlink !== 1) ||
    (uid !== undefined && info.uid !== uid)
  ) {
    throw new RemoteOmpDeploymentError(
      'PERMISSION_DENIED',
      `OMP cache entry must be an owned, non-symbolic ${directory ? 'directory' : 'regular file'}: ${path}`
    )
  }
}

async function secureCacheEntry(path: string, directory: boolean): Promise<void> {
  assertOwnedCacheEntry(await lstat(path), path, directory)
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0)
  )
  try {
    assertOwnedCacheEntry(await handle.stat(), path, directory)
    await handle.chmod(directory ? 0o700 : 0o600)
  } finally {
    await handle.close()
  }
}

async function ensurePrivateDirectory(path: string, recursive = false): Promise<void> {
  try {
    await mkdir(path, { recursive, mode: 0o700 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  await secureCacheEntry(path, true)
}

async function waitForCacheWrite(pending: Promise<void>, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  if (!signal) return pending
  let abort!: () => void
  try {
    await Promise.race([
      pending,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      })
    ])
  } finally {
    signal.removeEventListener('abort', abort)
  }
}

async function* responseChunks(body: NonNullable<Response['body']>): AsyncGenerator<Uint8Array> {
  const reader = body.getReader()
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) return
      yield chunk.value
    }
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

async function matchesHash(path: string, sha256: string, signal?: AbortSignal): Promise<boolean> {
  const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  if (!info) return false
  await secureCacheEntry(path, false)
  return (await hashLocalFile(path, 1024 * 1024, undefined, signal)) === sha256
}

/** Binary bytes are streamed to disk and hashed incrementally, including cache reuse. */
export async function ensureCachedRemoteOmp(options: CacheOptions): Promise<{
  localPath: string
  size: number
}> {
  options.signal?.throwIfAborted()
  if (!isAbsolute(options.cacheDir)) {
    throw new RemoteOmpDeploymentError('INVALID_ARGUMENT', 'OMP cache directory must be absolute.')
  }
  // Validate the selected Phi-owned root itself, not system ancestors such as /var.
  const selectedRoot = resolve(options.cacheDir)
  await ensurePrivateDirectory(selectedRoot, true)
  const canonicalRoot = await realpath(selectedRoot)
  const directory = join(canonicalRoot, 'omp', options.version, options.platform)
  // Include physical identity so equivalent paths through system ancestor symlinks share a lock.
  while (activeCacheWrites.has(directory)) {
    await waitForCacheWrite(activeCacheWrites.get(directory)!, options.signal)
  }
  options.signal?.throwIfAborted()
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  activeCacheWrites.set(directory, pending)
  try {
    let managed = canonicalRoot
    for (const segment of ['omp', options.version, options.platform]) {
      managed = join(managed, segment)
      await ensurePrivateDirectory(managed)
    }
    return await populateCache(options, directory)
  } finally {
    activeCacheWrites.delete(directory)
    release()
  }
}

async function populateCache(
  options: CacheOptions,
  directory: string
): Promise<{ localPath: string; size: number }> {
  const localPath = join(directory, 'omp')
  if (await matchesHash(localPath, options.asset.sha256, options.signal)) {
    return { localPath, size: (await stat(localPath)).size }
  }
  const staging = join(directory, `.omp-${randomUUID()}.part`)
  try {
    const response = await desktopFetch(options.fetchImpl)(options.asset.url, {
      signal: options.signal,
      redirect: 'follow',
      credentials: 'omit'
    })
    if (!response.ok || !response.body) {
      await response.body?.cancel()
      throw new RemoteOmpDeploymentError(
        'DOWNLOAD_FAILED',
        `OMP download failed with HTTP ${response.status}.`
      )
    }
    const contentLength = Number(response.headers.get('content-length'))
    const total =
      Number.isSafeInteger(contentLength) && contentLength > 0 ? contentLength : undefined
    const hash = createHash('sha256')
    let bytes = 0
    const meter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        try {
          hash.update(chunk)
          bytes += chunk.length
          options.onProgress?.(bytes, total)
          callback(null, chunk)
        } catch (error) {
          callback(error as Error)
        }
      }
    })
    await pipeline(
      Readable.from(responseChunks(response.body)),
      meter,
      createWriteStream(staging, { flags: 'wx', mode: 0o600 }),
      { signal: options.signal }
    )
    options.signal?.throwIfAborted()
    if (hash.digest('hex') !== options.asset.sha256) {
      throw new RemoteOmpDeploymentError(
        'HASH_MISMATCH',
        'Downloaded OMP SHA256 does not match its release manifest.'
      )
    }
    await rename(staging, localPath)
    return { localPath, size: bytes }
  } catch (error) {
    options.signal?.throwIfAborted()
    if (error instanceof RemoteOmpDeploymentError) throw error
    throw new RemoteOmpDeploymentError(
      'DOWNLOAD_FAILED',
      'Could not stream the OMP release into the desktop cache.',
      { cause: error }
    )
  } finally {
    await rm(staging, { force: true })
  }
}
