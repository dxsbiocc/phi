import { lstatSync, readdirSync, realpathSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { removeManagedEnvironmentPrefixSync, removeTree } from './ensure'
import { removeEnvironmentCache } from './execution'
import { ownedEnvironmentPrefix, ownedRuntimeDirectory } from './ownership'
import { hasLiveEnvironmentLeases } from './leases'
import { acquirePackageCacheLock, isLockedByLiveProcess, tryAcquireEnvironmentLock } from './lock'
import {
  deleteEnvironmentEntry,
  readEnvironmentIndex,
  type EnvironmentIndexEntry
} from './index-store'
import { ensureMambarc, ensureRuntimeLayout, runMicromamba } from './runtime'
import { readWslRuntime } from './wsl'

const MS_PER_DAY = 24 * 60 * 60 * 1000
const TEMP_RETENTION_DAYS = 1
const REMOVABLE_STATUSES = new Set(['ready', 'failed', 'drifted'])

export interface GarbageCollectionResult {
  removed: string[]
  orphans: string[]
  skipped: { envId: string; reason: 'building' | 'locked' | 'in-use' }[]
  logsRemoved: number
}

interface GarbageCollectionOptions {
  dryRun?: boolean
  now?: Date
  logRetentionDays?: number
  processAlive?: (pid: number) => boolean
  /**
   * Remove shared `phi:*` environments that have no package referrer. Only an
   * explicit user cleanup sets this; package lifecycle collection must keep
   * shared environments for installed agents whose declarations are not
   * registered as referrers (including indexes written before this guard).
   */
  includeShared?: boolean
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) return String(error.code)
  return undefined
}

function isRemovable(entry: EnvironmentIndexEntry): boolean {
  return entry.referrers.length === 0 && REMOVABLE_STATUSES.has(entry.status)
}

/** Official `phi:*` specs use the `phi-` envId prefix (see computeEnvId). */
function isSharedEnvironmentId(envId: string): boolean {
  return envId.startsWith('phi-')
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
  const includeShared = options.includeShared === true
  const now = options.now ?? new Date()
  const logRetentionDays = options.logRetentionDays ?? 30
  const environmentsDirectory = ownedRuntimeDirectory(root, 'envs')
  ownedRuntimeDirectory(root, 'cache')
  ownedRuntimeDirectory(root, 'logs')
  ownedRuntimeDirectory(root, 'state', 'tmp')
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
    if (!includeShared && isSharedEnvironmentId(envId)) continue
    ownedEnvironmentPrefix(root, envId, entry.prefix)
    ownedRuntimeDirectory(root, 'cache', envId)
    if (
      hasLiveEnvironmentLeases(root, envId, {
        processAlive: options.processAlive,
        pruneStale: false
      })
    ) {
      skipped.push({ envId, reason: 'in-use' })
      continue
    }
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
      if (hasLiveEnvironmentLeases(root, envId, { processAlive: options.processAlive })) {
        skipped.push({ envId, reason: 'in-use' })
        continue
      }
      ownedRuntimeDirectory(root, 'cache', envId)
      removeManagedEnvironmentPrefixSync(
        root,
        envId,
        ownedEnvironmentPrefix(root, envId, current.prefix),
        current.platform
      )
      removeEnvironmentCache(root, envId)
      deleteEnvironmentEntry(root, envId)
      removed.push(envId)
    } finally {
      lock.release()
    }
  }

  const indexed = new Set(Object.keys(readEnvironmentIndex(root).environments))
  for (const name of listNames(environmentsDirectory)) {
    if (indexed.has(name)) continue
    if (!includeShared && isSharedEnvironmentId(name)) continue
    const directory = join(root, 'envs', name)
    if (!isRealDirectory(directory)) continue
    ownedEnvironmentPrefix(root, name, directory)
    ownedRuntimeDirectory(root, 'cache', name)
    if (
      hasLiveEnvironmentLeases(root, name, {
        processAlive: options.processAlive,
        pruneStale: false
      })
    ) {
      skipped.push({ envId: name, reason: 'in-use' })
      continue
    }
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
      if (hasLiveEnvironmentLeases(root, name, { processAlive: options.processAlive })) {
        skipped.push({ envId: name, reason: 'in-use' })
        continue
      }
      ownedRuntimeDirectory(root, 'cache', name)
      removeTree(ownedEnvironmentPrefix(root, name, directory))
      removeEnvironmentCache(root, name)
      orphans.push(name)
    } finally {
      lock.release()
    }
  }

  const logsRemoved =
    sweepFiles(
      ownedRuntimeDirectory(root, 'logs'),
      now.getTime() - logRetentionDays * MS_PER_DAY,
      dryRun
    ) +
    sweepFiles(
      ownedRuntimeDirectory(root, 'state', 'tmp'),
      now.getTime() - TEMP_RETENTION_DAYS * MS_PER_DAY,
      dryRun
    )

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
  const cacheLock = await acquirePackageCacheLock({ root: runtimeRoot, signal: options.signal })
  try {
    const wsl = process.platform === 'win32' ? readWslRuntime(runtimeRoot) : undefined
    const targets = wsl ? [undefined, wsl] : [undefined]
    for (const target of targets) {
      const result = await runMicromamba(['clean', '--tarballs', '--yes'], {
        root: runtimeRoot,
        signal: options.signal,
        ...(target ? { wsl: target } : {})
      })
      validateTrimResult(result, options.signal)
    }
  } finally {
    cacheLock.release()
  }
}

function validateTrimResult(
  result: Awaited<ReturnType<typeof runMicromamba>>,
  signal: AbortSignal | undefined
): void {
  if (signal?.aborted || result.code === null) throw new Error('package cache trim aborted')
  if (result.code !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split('\n')[0]
    throw new Error(
      detail
        ? `micromamba clean failed (${result.code}): ${detail}`
        : `micromamba clean failed (${result.code})`
    )
  }
}
