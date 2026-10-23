import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { hashLocalFile } from '../../../transfer/ssh-data-plane-local'

import {
  downloadRemoteOmpArtifact,
  DownloadResponseError,
  REMOTE_OMP_PRESEED_GUIDANCE,
  type ArtifactDownloadStorage,
  type ArtifactPartialPaths,
  type RemoteOmpDownloadOptions
} from './artifact-download'
import { RemoteOmpDeploymentError, type RemoteOmpAsset } from './types'

export type { RemoteOmpDownloadProgress } from './artifact-download'

export interface RemoteOmpCacheOptions extends RemoteOmpDownloadOptions {
  cacheDir: string
  version: string
  platform: string
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

async function cacheEntry(path: string): Promise<Stats | undefined> {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
}

async function secureCacheEntry(path: string, directory: boolean): Promise<Stats> {
  const entry = await lstat(path)
  assertOwnedCacheEntry(entry, path, directory)
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (directory ? constants.O_DIRECTORY : 0)
  )
  try {
    const info = await handle.stat()
    assertOwnedCacheEntry(info, path, directory)
    await handle.chmod(directory ? 0o700 : 0o600)
    return info
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

async function matchesHash(path: string, sha256: string, signal?: AbortSignal): Promise<boolean> {
  if (!(await cacheEntry(path))) return false
  await secureCacheEntry(path, false)
  return (await hashLocalFile(path, 1024 * 1024, undefined, signal)) === sha256
}

async function secureAndRemove(paths: readonly string[]): Promise<void> {
  const existing: string[] = []
  for (const path of paths) {
    if (!(await cacheEntry(path))) continue
    await secureCacheEntry(path, false)
    existing.push(path)
  }
  await Promise.all(existing.map((path) => rm(path)))
}

async function discardPartial(paths: ArtifactPartialPaths): Promise<void> {
  await secureAndRemove([paths.file, paths.metadata])
}

async function publishPartial(
  paths: ArtifactPartialPaths,
  localPath: string,
  asset: RemoteOmpAsset,
  signal?: AbortSignal
): Promise<number> {
  signal?.throwIfAborted()
  const info = await secureCacheEntry(paths.file, false)
  if (asset.size !== undefined && info.size !== asset.size) {
    throw new DownloadResponseError(`received ${info.size} bytes but expected ${asset.size}`)
  }
  if ((await hashLocalFile(paths.file, 1024 * 1024, undefined, signal)) !== asset.sha256) {
    await discardPartial(paths)
    throw new RemoteOmpDeploymentError(
      'HASH_MISMATCH',
      `Downloaded OMP checksum does not match the pinned release manifest. ${REMOTE_OMP_PRESEED_GUIDANCE}`
    )
  }
  await rename(paths.file, localPath)
  await secureAndRemove([paths.metadata])
  return info.size
}

const downloadStorage: ArtifactDownloadStorage = {
  cacheEntry,
  secureFile: (path) => secureCacheEntry(path, false),
  assertFile: (info, path) => assertOwnedCacheEntry(info, path, false),
  discard: discardPartial,
  publish: publishPartial
}

async function populateCache(
  options: RemoteOmpCacheOptions,
  directory: string
): Promise<{ localPath: string; size: number }> {
  const localPath = join(directory, 'omp')
  if (await matchesHash(localPath, options.asset.sha256, options.signal)) {
    return { localPath, size: (await stat(localPath)).size }
  }
  const paths = {
    file: join(directory, 'omp.partial'),
    metadata: join(directory, 'omp.partial.json')
  }
  const size = await downloadRemoteOmpArtifact(options, paths, localPath, downloadStorage)
  return { localPath, size }
}

/** Binary bytes are resumed into a private partial and verified before atomic cache publication. */
export async function ensureCachedRemoteOmp(options: RemoteOmpCacheOptions): Promise<{
  localPath: string
  size: number
}> {
  options.signal?.throwIfAborted()
  if (!isAbsolute(options.cacheDir)) {
    throw new RemoteOmpDeploymentError('INVALID_ARGUMENT', 'OMP cache directory must be absolute.')
  }
  const selectedRoot = resolve(options.cacheDir)
  await ensurePrivateDirectory(selectedRoot, true)
  const canonicalRoot = await realpath(selectedRoot)
  const directory = join(canonicalRoot, 'omp', options.version, options.platform)
  while (activeCacheWrites.has(directory)) {
    await waitForCacheWrite(activeCacheWrites.get(directory)!, options.signal)
  }
  options.signal?.throwIfAborted()
  let release!: () => void
  const pending = new Promise<void>((resolvePending) => {
    release = resolvePending
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
