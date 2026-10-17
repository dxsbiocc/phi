import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { chmod, copyFile, lstat, mkdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type { RemoteOmpManifest } from '../../src/main/agent/engine/rpc/runtime-deployment/types'

/** Persistent, gitignored home of verified release assets (`.phi-acceptance/cache`). */
export const ASSET_CACHE_DIRECTORY = 'cache'

export interface AssetCacheReport {
  /** Persistent entries whose SHA-256 matched the manifest and were copied into the run cache. */
  readonly reused: readonly string[]
  /** Persistent entries that existed but did not match; never reused, replaced after a download. */
  readonly rejected: readonly string[]
  /** Run-cache entries (downloaded in this run, verified) saved to the persistent cache. */
  readonly stored: readonly string[]
  /** Assets the production path had to download in this run (present afterwards, not seeded). */
  readonly downloaded: readonly string[]
}

export const EMPTY_ASSET_CACHE_REPORT: AssetCacheReport = {
  reused: [],
  rejected: [],
  stored: [],
  downloaded: []
}

export async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

async function regularFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && info.nlink === 1
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Persistent layout: `<cache>/omp/<version>/<key>/omp`. */
export function persistentAssetPath(cacheDir: string, version: string, key: string): string {
  return join(cacheDir, 'omp', version, key, 'omp')
}

/** The layout of the production cache for an agent dir (`<agent>/cache/omp` + `omp/<v>/<key>/omp`). */
export function privateAssetPath(agentDir: string, version: string, key: string): string {
  return join(agentDir, 'cache', 'omp', 'omp', version, key, 'omp')
}

async function privateDirectories(path: string, root: string): Promise<void> {
  // Every level below the run's own agent dir is created 0700, as the production cache expects.
  await mkdir(path, { recursive: true, mode: 0o700 })
  for (let current = path; current.length > root.length; current = join(current, '..')) {
    await chmod(current, 0o700)
  }
}

async function copyVerified(from: string, to: string, sha256: string): Promise<void> {
  const staging = `${to}.${randomUUID()}.part`
  try {
    await copyFile(from, staging)
    await chmod(staging, 0o600)
    // Verify the copy itself, not just the source.
    if ((await sha256OfFile(staging)) !== sha256)
      throw new Error('Copied asset failed verification')
    await rename(staging, to)
  } finally {
    await rm(staging, { force: true })
  }
}

/**
 * Copies every persistent asset whose SHA-256 matches the production manifest into the run's
 * private cache before startup. A mismatching file is reported and never used.
 */
export async function seedRunAssetCache(options: {
  readonly persistentDir: string
  readonly agentDir: string
  readonly manifest: RemoteOmpManifest
}): Promise<Pick<AssetCacheReport, 'reused' | 'rejected'>> {
  const reused: string[] = []
  const rejected: string[] = []
  for (const [key, asset] of Object.entries(options.manifest.assets)) {
    const source = persistentAssetPath(options.persistentDir, options.manifest.version, key)
    if (!(await regularFile(source))) {
      try {
        await lstat(source)
        rejected.push(key)
      } catch {
        // Absent: the production path downloads it.
      }
      continue
    }
    if ((await sha256OfFile(source)) !== asset.sha256) {
      rejected.push(key)
      continue
    }
    const target = privateAssetPath(options.agentDir, options.manifest.version, key)
    await privateDirectories(join(target, '..'), options.agentDir)
    await copyVerified(source, target, asset.sha256)
    reused.push(key)
  }
  return { reused, rejected }
}

/** Saves verified assets that the run downloaded; an existing matching entry is kept as is. */
export async function storeRunAssetCache(options: {
  readonly persistentDir: string
  readonly agentDir: string
  readonly manifest: RemoteOmpManifest
  readonly seeded: readonly string[]
}): Promise<Pick<AssetCacheReport, 'stored' | 'downloaded'>> {
  const stored: string[] = []
  const downloaded: string[] = []
  for (const [key, asset] of Object.entries(options.manifest.assets)) {
    const source = privateAssetPath(options.agentDir, options.manifest.version, key)
    if (!(await regularFile(source))) continue
    if (!options.seeded.includes(key)) downloaded.push(key)
    if (options.seeded.includes(key)) continue
    if ((await sha256OfFile(source)) !== asset.sha256) continue
    const target = persistentAssetPath(options.persistentDir, options.manifest.version, key)
    await mkdir(join(target, '..'), { recursive: true, mode: 0o700 })
    await copyVerified(source, target, asset.sha256)
    stored.push(key)
  }
  return { stored, downloaded }
}
