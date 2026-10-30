import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  accessSync,
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { open, readFile, rename, rm } from 'node:fs/promises'
import { hostname } from 'node:os'
import { promisify } from 'node:util'

import type {
  AcquireProcessLockGuard,
  ProcessLockGuard,
  SessionWriterLock,
  SessionWriterLockBody
} from './types'

const execFileAsync = promisify(execFile)
const MAX_LOCK_BYTES = 4 * 1024
const DARWIN_UNVERIFIED_SELF_PREFIX = 'darwin:unverified-self:'

type DarwinProcessStartProbe = (pid: number) => Promise<string>

export class SessionWriterBusyError extends Error {
  constructor(message = 'Another kernel owns this session.') {
    super(message)
    this.name = 'SessionWriterBusyError'
  }
}

function fsCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function linuxStartTime(stat: string): string | undefined {
  const commandEnd = stat.lastIndexOf(')')
  if (commandEnd < 0) return undefined
  const fields = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/)
  const ticks = fields[19]
  return ticks && /^\d+$/.test(ticks) ? `linux:${ticks}` : undefined
}

function unverifiedDarwinSelfToken(pid: number): string {
  return `${DARWIN_UNVERIFIED_SELF_PREFIX}${pid}:${randomUUID()}`
}

function unverifiedProcessIsProvablyDead(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return fsCode(error) === 'ESRCH'
  }
}

async function defaultDarwinProcessStartProbe(pid: number): Promise<string> {
  const { stdout } = await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
    timeout: 2_000,
    env: { ...process.env, LC_ALL: 'C', LANG: 'C' }
  })
  return stdout
}

async function processStartedAt(
  pid: number,
  darwinProbe: DarwinProcessStartProbe = defaultDarwinProcessStartProbe
): Promise<string | undefined> {
  if (process.platform === 'linux') {
    try {
      return linuxStartTime(await readFile(`/proc/${pid}/stat`, 'utf8'))
    } catch (error) {
      if (fsCode(error) === 'ENOENT') return undefined
      throw error
    }
  }
  if (process.platform === 'darwin') {
    // Our own token comes from ps too: a clock-derived value can differ from
    // ps lstart by a second and make a live holder look like a reused PID.
    if (pid !== process.pid) {
      try {
        process.kill(pid, 0)
      } catch (error) {
        if (fsCode(error) === 'ESRCH') return undefined
      }
    }
    try {
      // lstart follows the caller's locale (e.g. "二 10月/27 ..." under zh_CN),
      // which Date.parse cannot read; pin it to C.
      const stdout = await darwinProbe(pid)
      const startedAt = stdout.trim()
      const epochSeconds = Date.parse(startedAt) / 1_000
      if (startedAt && Number.isFinite(epochSeconds)) {
        return `darwin:${Math.floor(epochSeconds)}`
      }
      return pid === process.pid ? unverifiedDarwinSelfToken(pid) : undefined
    } catch (error) {
      // Some packaged/sandboxed hosts permit the kernel subprocess but deny spawning ps.
      // A fresh self-only token is sufficient to own and release the new lock. It is
      // deliberately never comparable with a later verified process-start timestamp.
      if (pid === process.pid) return unverifiedDarwinSelfToken(pid)
      const code = (error as { code?: unknown }).code
      if (typeof code === 'number' && code !== 0) return undefined
      throw error
    }
  }
  try {
    process.kill(pid, 0)
    return pid === process.pid ? `pid:${pid}` : `live:${pid}`
  } catch (error) {
    if (fsCode(error) === 'ESRCH') return undefined
    return `live:${pid}`
  }
}

export async function currentProcessStartedAt(
  options: {
    darwinProbe?: DarwinProcessStartProbe
  } = {}
): Promise<string> {
  const startedAt = await processStartedAt(process.pid, options.darwinProbe)
  if (!startedAt) throw new Error('Could not identify the kernel process start time')
  return startedAt
}

function parseLockBody(value: string): SessionWriterLockBody | undefined {
  try {
    const body = JSON.parse(value) as Partial<SessionWriterLockBody>
    if (
      !Number.isSafeInteger(body.pid) ||
      (body.pid as number) < 1 ||
      typeof body.kernelInstanceId !== 'string' ||
      !body.kernelInstanceId ||
      typeof body.startedAt !== 'string' ||
      !body.startedAt ||
      typeof body.hostname !== 'string' ||
      !body.hostname
    ) {
      return undefined
    }
    return body as SessionWriterLockBody
  } catch {
    return undefined
  }
}

async function readLockBody(path: string): Promise<SessionWriterLockBody | undefined> {
  try {
    const content = await readFile(path, 'utf8')
    return Buffer.byteLength(content) <= MAX_LOCK_BYTES ? parseLockBody(content) : undefined
  } catch (error) {
    if (fsCode(error) === 'ENOENT') return undefined
    throw error
  }
}

async function holderIsProvablyDead(body: SessionWriterLockBody): Promise<boolean> {
  if (body.hostname !== hostname()) return false
  if (body.startedAt.startsWith(DARWIN_UNVERIFIED_SELF_PREFIX)) {
    // Without a verified start timestamp, a different token cannot prove PID reuse. Only
    // an OS-level absent PID is strong enough evidence to take over this fail-closed lock.
    return unverifiedProcessIsProvablyDead(body.pid)
  }
  let actual: string | undefined
  try {
    actual = await processStartedAt(body.pid)
  } catch {
    return false
  }
  if (!actual) return true
  if (process.platform === 'linux' || process.platform === 'darwin') {
    return actual !== body.startedAt
  }
  return false
}

async function createLock(path: string, body: SessionWriterLockBody): Promise<void> {
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.writeFile(`${JSON.stringify(body)}\n`, 'utf8')
    await handle.sync()
  } catch (error) {
    await handle.close().catch(() => undefined)
    await rm(path, { force: true }).catch(() => undefined)
    throw error
  }
  await handle.close()
}

function ownedBy(path: string, body: SessionWriterLockBody): boolean {
  try {
    const content = readFileSync(path, 'utf8')
    const current =
      Buffer.byteLength(content) <= MAX_LOCK_BYTES ? parseLockBody(content) : undefined
    return (
      current?.pid === body.pid &&
      current.kernelInstanceId === body.kernelInstanceId &&
      current.startedAt === body.startedAt &&
      current.hostname === body.hostname
    )
  } catch {
    return false
  }
}

async function acquireProcessGuard(options: {
  path: string
  guardPath?: string
  acquireGuard?: AcquireProcessLockGuard
}): Promise<ProcessLockGuard | undefined> {
  if (!options.acquireGuard) return undefined
  const guard = await options.acquireGuard(options.guardPath ?? `${options.path}.guard`)
  if (guard.acquired) return guard
  guard.release()
  throw new SessionWriterBusyError()
}

export async function acquireSessionWriterLock(options: {
  path: string
  kernelInstanceId: string
  startedAt?: string
  acquireGuard?: AcquireProcessLockGuard
  guardPath?: string
}): Promise<SessionWriterLock> {
  let guard = await acquireProcessGuard(options)
  try {
    const body: SessionWriterLockBody = {
      pid: process.pid,
      kernelInstanceId: options.kernelInstanceId,
      startedAt: options.startedAt ?? (await currentProcessStartedAt()),
      hostname: hostname()
    }
    let quarantined: string | undefined
    const clearQuarantine = async (): Promise<void> => {
      if (!quarantined) return
      await rm(quarantined, { force: true }).catch(() => undefined)
      quarantined = undefined
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      try {
        await createLock(options.path, body)
        await clearQuarantine()
        let released = false
        const releaseGuard = (): void => {
          guard?.release()
          guard = undefined
        }
        return {
          body: Object.freeze({ ...body }),
          path: options.path,
          async release() {
            if (released) return
            released = true
            try {
              if (ownedBy(options.path, body)) await rm(options.path, { force: true })
            } finally {
              releaseGuard()
            }
          },
          releaseSync() {
            if (released) return
            released = true
            if (ownedBy(options.path, body)) {
              try {
                unlinkSync(options.path)
              } catch {
                // Teardown is best effort; stale detection handles an interrupted release.
              }
            }
            releaseGuard()
          }
        }
      } catch (error) {
        if (fsCode(error) !== 'EEXIST') throw error
      }

      const incumbent = await readLockBody(options.path)
      if (!incumbent) {
        // An incomplete lock is fail-closed unless it disappeared during the read.
        try {
          accessSync(options.path)
        } catch (error) {
          if (fsCode(error) === 'ENOENT') continue
        }
        await clearQuarantine()
        throw new SessionWriterBusyError('The session writer lock cannot be verified.')
      }
      if (!(await holderIsProvablyDead(incumbent))) {
        await clearQuarantine()
        throw new SessionWriterBusyError()
      }

      quarantined = `${options.path}.stale.${options.kernelInstanceId}.${randomUUID()}`
      try {
        await rename(options.path, quarantined)
      } catch (error) {
        if (fsCode(error) === 'ENOENT') continue
        throw error
      }
    }
    await clearQuarantine()
    throw new SessionWriterBusyError('The session writer lock changed during takeover.')
  } catch (error) {
    guard?.release()
    throw error
  }
}

/** Test helper for constructing a fully-synced lock without exporting internal parsing. */
export function writeSessionWriterLockSync(path: string, body: SessionWriterLockBody): void {
  const fd = openSync(path, 'wx', 0o600)
  try {
    writeSync(fd, `${JSON.stringify(body)}\n`)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
