import { randomUUID } from 'node:crypto'
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  type Stats,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import { teamPackError } from './errors'
import { assertManagedDirectory } from './files'

export const ADMIN_PUBLISH_LOCK_FILE = '.phi-team-publish.lock'

const DEFAULT_WAIT_MS = 30_000
const DEFAULT_RETRY_MS = 50
const DEFAULT_STALE_MS = 15 * 60_000
const MAX_LOCK_BYTES = 16 * 1024

interface PublishLockRecord {
  version: 1
  token: string
  hostname: string
  pid: number
  createdAt: string
}

interface StaleLockIdentity {
  device: number
  inode: number
}

export interface AdminPublishLockOptions {
  teamId: string
  storeDir: string
  waitMs?: number
  retryMs?: number
  staleMs?: number
  now?: () => Date
}

const processQueues = new Map<string, Promise<void>>()

export async function withAdminPublishLock<T>(
  options: AdminPublishLockOptions,
  action: () => Promise<T>
): Promise<T> {
  const previous = processQueues.get(options.teamId) ?? Promise.resolve()
  let releaseQueue!: () => void
  const current = new Promise<void>((resolve) => {
    releaseQueue = resolve
  })
  const tail = previous.catch(() => undefined).then(() => current)
  processQueues.set(options.teamId, tail)

  await previous.catch(() => undefined)
  try {
    const releaseFile = await acquirePublishFileLock(options)
    try {
      return await action()
    } finally {
      releaseFile()
    }
  } finally {
    releaseQueue()
    if (processQueues.get(options.teamId) === tail) processQueues.delete(options.teamId)
  }
}

async function acquirePublishFileLock(options: AdminPublishLockOptions): Promise<() => void> {
  const waitMs = boundedDuration(options.waitMs, DEFAULT_WAIT_MS, 1, 5 * 60_000)
  const retryMs = boundedDuration(options.retryMs, DEFAULT_RETRY_MS, 1, 1_000)
  const staleMs = boundedDuration(options.staleMs, DEFAULT_STALE_MS, 1_000, 24 * 60 * 60_000)
  const now = options.now ?? (() => new Date())
  const deadline = Date.now() + waitMs

  mkdirSync(options.storeDir, { recursive: true })
  assertManagedDirectory(options.storeDir, '团队包存储目录')
  const path = join(options.storeDir, ADMIN_PUBLISH_LOCK_FILE)
  const record: PublishLockRecord = {
    version: 1,
    token: randomUUID(),
    hostname: hostname(),
    pid: process.pid,
    createdAt: now().toISOString()
  }

  while (true) {
    const release = tryCreatePublishFileLock(path, record)
    if (release) return release

    const staleLock = stalePublishFileLock(path, staleMs)
    if (staleLock) {
      removeStalePublishFileLock(path, staleLock)
      continue
    }
    if (Date.now() >= deadline) {
      throw teamPackError('STORE_UNAVAILABLE', '团队正在由另一个进程发布，请稍后重试')
    }
    await delay(Math.min(retryMs, Math.max(1, deadline - Date.now())))
  }
}

function tryCreatePublishFileLock(path: string, record: PublishLockRecord): (() => void) | null {
  let descriptor: number
  try {
    descriptor = openSync(path, 'wx', 0o600)
  } catch (error) {
    if (errorCode(error) === 'EEXIST') return null
    throw teamPackError('STORE_UNAVAILABLE', '无法创建团队发布锁', error)
  }
  try {
    writeFileSync(descriptor, `${JSON.stringify(record)}\n`)
  } catch (error) {
    closeQuietly(descriptor)
    unlinkQuietly(path)
    throw teamPackError('STORE_UNAVAILABLE', '无法写入团队发布锁', error)
  }
  closeSync(descriptor)
  return () => releasePublishFileLock(path, record.token)
}

function removeStalePublishFileLock(path: string, expected: StaleLockIdentity): void {
  try {
    const current = lstatSync(path)
    if (current.dev !== expected.device || current.ino !== expected.inode) return
    unlinkSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return
    throw teamPackError('STORE_UNAVAILABLE', '无法清理陈旧的团队发布锁', error)
  }
}

function stalePublishFileLock(path: string, staleMs: number): StaleLockIdentity | null {
  let stat: ReturnType<typeof lstatSync>
  try {
    stat = lstatSync(path)
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { device: -1, inode: -1 }
    throw teamPackError('STORE_UNAVAILABLE', '无法检查团队发布锁', error)
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw teamPackError('INVALID_FORMAT', '团队发布锁必须是普通文件')
  }
  if (stat.size < 1 || stat.size > MAX_LOCK_BYTES) {
    return Date.now() - stat.mtimeMs > staleMs ? lockIdentity(stat) : null
  }

  const record = readPublishLockRecord(path)
  if (!record) return Date.now() - stat.mtimeMs > staleMs ? lockIdentity(stat) : null
  if (record.hostname !== hostname()) {
    return Date.now() - Date.parse(record.createdAt) > staleMs ? lockIdentity(stat) : null
  }
  return isLiveProcess(record.pid) ? null : lockIdentity(stat)
}

function lockIdentity(stat: Stats): StaleLockIdentity {
  return { device: stat.dev, inode: stat.ino }
}

function readPublishLockRecord(path: string): PublishLockRecord | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return isPublishLockRecord(value) ? value : undefined
  } catch {
    return undefined
  }
}

function isPublishLockRecord(value: unknown): value is PublishLockRecord {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.token === 'string' &&
    typeof value.hostname === 'string' &&
    Number.isSafeInteger(value.pid) &&
    (value.pid as number) > 0 &&
    typeof value.createdAt === 'string' &&
    Number.isFinite(Date.parse(value.createdAt))
  )
}

function releasePublishFileLock(path: string, token: string): void {
  try {
    const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (!isRecord(value) || value.token !== token) return
    unlinkSync(path)
  } catch (error) {
    if (errorCode(error) !== 'ENOENT') {
      // The publication is already committed. A later acquire can recover a stale lock.
    }
  }
}

function closeQuietly(descriptor: number): void {
  try {
    closeSync(descriptor)
  } catch {
    // Best-effort cleanup after a failed lock write.
  }
}

function unlinkQuietly(path: string): void {
  try {
    unlinkSync(path)
  } catch {
    // Best-effort cleanup; stale-lock recovery handles any remainder.
  }
}

function isLiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return errorCode(error) !== 'ESRCH'
  }
}

function boundedDuration(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number
): number {
  if (value === undefined) return fallback
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw teamPackError('INVALID_FORMAT', '团队发布锁等待时间无效')
  }
  return value
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function errorCode(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
