import { lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { removeTree } from './ensure'
import { isLockedByLiveProcess, tryAcquireEnvironmentLock } from './lock'
import {
  deleteEnvironmentEntry,
  readEnvironmentIndex,
  type EnvironmentIndexEntry
} from './index-store'
import { ensureMambarc, ensureRuntimeLayout, runMicromamba } from './runtime'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const TEMP_RETENTION_DAYS = 1
const REMOVABLE_STATUSES = new Set(['ready', 'failed', 'drifted'])

export interface GarbageCollectionResult {
  removed: string[]
  orphans: string[]
  skipped: { envId: string; reason: 'building' | 'locked' }[]
  logsRemoved: number
}

interface GarbageCollectionOptions {
  dryRun?: boolean
  now?: Date
  logRetentionDays?: number
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) return String(error.code)
  return undefined
}

function isRemovable(entry: EnvironmentIndexEntry): boolean {
  return entry.referrers.length === 0 && REMOVABLE_STATUSES.has(entry.status)
}

function stillRemovable(root: string, envId: string): EnvironmentIndexEntry | undefined {
  const entry = readEnvironmentIndex(root).environments[envId]
  if (!entry || !isRemovable(entry)) return undefined
  return entry
}

function listNames(directory: string): string[] {
  try {
    return readdirSync(directory)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return []
    throw error
  }
}

function isRealDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory)
    return stat.isDirectory() && !stat.isSymbolicLink()
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false
    throw error
  }
}

function sweepFiles(directory: string, cutoffMs: number, dryRun: boolean): number {
  let removed = 0
  for (const name of listNames(directory)) {
    const file = join(directory, name)
    let stat: ReturnType<typeof lstatSync>
    try {
      stat = lstatSync(file)
    } catch (error) {
      if (errorCode(error) === 'ENOENT') continue
      throw error
    }
    if (stat.isSymbolicLink() || stat.mtimeMs >= cutoffMs) continue
    if (!stat.isFile() && !stat.isDirectory()) continue
    removed += 1
    if (dryRun) continue
    // Directories are temp trees left by an interrupted source-package install.
    if (stat.isDirectory()) removeTree(file)
    else unlinkSync(file)
  }
  return removed
}

export function collectGarbage(
  root: string,
  options: GarbageCollectionOptions = {}
): GarbageCollectionResult {
  const dryRun = options.dryRun === true
  const now = options.now ?? new Date()
  const logRetentionDays = options.logRetentionDays ?? 30
  const index = readEnvironmentIndex(root)
  const removed: string[] = []
  const orphans: string[] = []
  const skipped: GarbageCollectionResult['skipped'] = []

  for (const [envId, entry] of Object.entries(index.environments)) {
    if (entry.status === 'building') {
      skipped.push({ envId, reason: 'building' })
      continue
    }
    if (!isRemovable(entry)) continue
    if (dryRun) {
      if (isLockedByLiveProcess(root, envId)) {
        skipped.push({ envId, reason: 'locked' })
        continue
      }
      removed.push(envId)
      continue
    }
    const lock = tryAcquireEnvironmentLock(root, envId)
    if (!lock) {
      skipped.push({ envId, reason: 'locked' })
      continue
    }
    try {
      const current = stillRemovable(root, envId)
      if (!current) continue
      removeTree(current.prefix)
      deleteEnvironmentEntry(root, envId)
      removed.push(envId)
    } finally {
      lock.release()
    }
  }

  const indexed = new Set(Object.keys(readEnvironmentIndex(root).environments))
  for (const name of listNames(join(root, 'envs'))) {
    if (indexed.has(name)) continue
    const directory = join(root, 'envs', name)
    if (!isRealDirectory(directory)) continue
    if (dryRun) {
      if (isLockedByLiveProcess(root, name)) {
        skipped.push({ envId: name, reason: 'locked' })
        continue
      }
      orphans.push(name)
      continue
    }
    const lock = tryAcquireEnvironmentLock(root, name)
    if (!lock) {
      skipped.push({ envId: name, reason: 'locked' })
      continue
    }
    try {
      if (readEnvironmentIndex(root).environments[name]) continue
      removeTree(directory)
      orphans.push(name)
    } finally {
      lock.release()
    }
  }

  const logsRemoved =
    sweepFiles(join(root, 'logs'), now.getTime() - logRetentionDays * MS_PER_DAY, dryRun) +
    sweepFiles(join(root, 'state', 'tmp'), now.getTime() - TEMP_RETENTION_DAYS * MS_PER_DAY, dryRun)

  removed.sort()
  orphans.sort()
  return { removed, orphans, skipped, logsRemoved }
}

/** `micromamba clean --tarballs --yes` (2.9.0). Extracted packages stay in the cache. */
export async function trimPackageCache(
  root: string,
  options: { signal?: AbortSignal } = {}
): Promise<void> {
  const layout = ensureRuntimeLayout(root)
  const runtimeRoot = realpathSync(layout.root)
  ensureMambarc(runtimeRoot)
  const result = await runMicromamba(['clean', '--tarballs', '--yes'], {
    root: runtimeRoot,
    signal: options.signal
  })
  if (options.signal?.aborted || result.code === null) throw new Error('package cache trim aborted')
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0]
    throw new Error(
      detail
        ? `micromamba clean failed (${result.code}): ${detail}`
        : `micromamba clean failed (${result.code})`
    )
  }
}
