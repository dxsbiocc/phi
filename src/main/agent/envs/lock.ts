import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { join } from 'node:path'

/**
 * Per-environment lock shared by build, repair, and garbage collection:
 * `<root>/state/locks/<envId>.lock` created exclusively and holding `{ pid, startedAt }`.
 * A holder whose pid is no longer alive is stale and may be replaced.
 */

const LOCK_POLL_INTERVAL_MS = 500

export interface EnvironmentLock {
  release(): void
}

function errorCode(error: unknown): string | undefined {
  if (error instanceof Error && 'code' in error) return String(error.code)
  return undefined
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new Error('environment build aborted')
}

export function environmentLockPath(root: string, envId: string): string {
  return join(root, 'state', 'locks', `${envId}.lock`)
}

function delay(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('environment build aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    function onAbort(): void {
      clearTimeout(timer)
      reject(new Error('environment build aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
  })
}

interface LockHolder {
  kind: 'missing' | 'stale' | 'held'
  pid?: number
}

function readLockHolder(lockPath: string): LockHolder {
  let text: string
  try {
    text = readFileSync(lockPath, 'utf8')
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { kind: 'missing' }
    return { kind: 'stale' }
  }
  try {
    const parsed = JSON.parse(text) as { pid?: unknown }
    if (typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0) {
      return { kind: 'held', pid: parsed.pid }
    }
  } catch {
    // Unreadable contents cannot be a live holder.
  }
  return { kind: 'stale' }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) === 'EPERM'
  }
}

function removeLockFile(lockPath: string): void {
  try {
    unlinkSync(lockPath)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') throw error
  }
}

function tryCreateLock(lockPath: string): boolean {
  const payload = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })
  let fd: number | undefined
  try {
    fd = openSync(lockPath, 'wx')
    writeSync(fd, payload)
    return true
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return false
    if (fd !== undefined) removeLockFile(lockPath)
    throw error
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

export async function acquireEnvironmentLock(input: {
  root: string
  envId: string
  signal?: AbortSignal
  onWait?: () => void
}): Promise<EnvironmentLock> {
  mkdirSync(join(input.root, 'state', 'locks'), { recursive: true })
  return acquireLockFile(environmentLockPath(input.root, input.envId), input)
}

/**
 * Serialises micromamba operations that write the shared package cache (`create`,
 * `clean`). micromamba itself fails at once with "Could not set lock" when another
 * process holds the cache, and its `lock_timeout` setting is not reliable. The lock file
 * lives inside the (real) pkgs directory, so runtime roots that share one cache through a
 * symlink are serialised too.
 */
export async function acquirePackageCacheLock(input: {
  root: string
  signal?: AbortSignal
  onWait?: () => void
}): Promise<EnvironmentLock> {
  const pkgs = join(input.root, 'pkgs')
  mkdirSync(pkgs, { recursive: true })
  return acquireLockFile(join(realpathSync(pkgs), '.phi-cache.lock'), input)
}

async function acquireLockFile(
  lockPath: string,
  input: { signal?: AbortSignal; onWait?: () => void }
): Promise<EnvironmentLock> {
  let announced = false

  for (;;) {
    throwIfAborted(input.signal)
    if (tryCreateLock(lockPath)) {
      return {
        release() {
          removeLockFile(lockPath)
        }
      }
    }
    const holder = readLockHolder(lockPath)
    if (holder.kind === 'missing') continue
    if (holder.kind === 'stale' || holder.pid === undefined || !isPidAlive(holder.pid)) {
      removeLockFile(lockPath)
      continue
    }
    if (!announced) {
      announced = true
      input.onWait?.()
    }
    await delay(LOCK_POLL_INTERVAL_MS, input.signal)
  }
}

/** Non-waiting variant: undefined when a live process holds the lock. */
export function tryAcquireEnvironmentLock(
  root: string,
  envId: string
): EnvironmentLock | undefined {
  mkdirSync(join(root, 'state', 'locks'), { recursive: true })
  const lockPath = environmentLockPath(root, envId)
  for (let attempt = 0; attempt < 5; attempt += 1) {
    if (tryCreateLock(lockPath)) {
      return {
        release() {
          removeLockFile(lockPath)
        }
      }
    }
    const holder = readLockHolder(lockPath)
    if (holder.kind === 'missing') continue
    if (holder.kind === 'stale' || holder.pid === undefined || !isPidAlive(holder.pid)) {
      removeLockFile(lockPath)
      continue
    }
    return undefined
  }
  return undefined
}

export function isLockedByLiveProcess(root: string, envId: string): boolean {
  const holder = readLockHolder(environmentLockPath(root, envId))
  return holder.kind === 'held' && holder.pid !== undefined && isPidAlive(holder.pid)
}
