import { readlink } from 'node:fs/promises'
import { basename } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

import { WRITER_BUSY_MESSAGES } from '../protocol/errors'
import {
  acquireSessionWriterLock,
  SessionWriterBusyError,
  sessionWriterLockHolder
} from './writer-lock'

/**
 * Sent to a kernel of an older build that holds a session this kernel needs. Its default action
 * is to ignore, so a build from before this handshake keeps running instead of being killed.
 */
export const SUPERSEDE_SIGNAL = 'SIGWINCH'

const WAIT_MS = 15_000
const POLL_MS = 250

export type SupersedeOptions = {
  waitMs?: number
  pollMs?: number
  /** The executable a process runs, or undefined when it cannot be read. */
  executableOf?: (pid: number) => Promise<string | undefined>
  signal?: (pid: number) => void
  ownExecutable?: string
}

async function procExecutable(pid: number): Promise<string | undefined> {
  return readlink(`/proc/${pid}/exe`).catch(() => undefined)
}

/** The lock holder when it is a kernel of another build on this host. */
async function olderBuildHolder(
  path: string,
  options: SupersedeOptions
): Promise<number | undefined> {
  const holder = await sessionWriterLockHolder(path)
  if (!holder) return undefined
  const own = options.ownExecutable ?? process.execPath
  const executable = await (options.executableOf ?? procExecutable)(holder)
  return executable && executable !== own && basename(executable) === basename(own)
    ? holder
    : undefined
}

async function retryUntilReleased<T>(
  acquire: () => Promise<T>,
  options: SupersedeOptions
): Promise<T> {
  const deadline = Date.now() + (options.waitMs ?? WAIT_MS)
  while (Date.now() < deadline) {
    await delay(options.pollMs ?? POLL_MS)
    try {
      return await acquire()
    } catch (error) {
      if (!(error instanceof SessionWriterBusyError)) throw error
    }
  }
  throw new SessionWriterBusyError(WRITER_BUSY_MESSAGES.older_kernel_busy)
}

/**
 * After an upgrade, the kernel of the previous build keeps its sessions for its whole grace
 * period. When it holds a lock this kernel needs, ask it to stand down: it exits only when no
 * desktop is attached and no run is active, so a busy one keeps its session.
 */
export async function acquireFromOlderBuild<T>(
  path: string,
  acquire: () => Promise<T>,
  options: SupersedeOptions = {}
): Promise<T> {
  try {
    return await acquire()
  } catch (error) {
    if (!(error instanceof SessionWriterBusyError)) throw error
    const holder = await olderBuildHolder(path, options)
    if (!holder) throw error
    try {
      ;(options.signal ?? ((pid) => process.kill(pid, SUPERSEDE_SIGNAL)))(holder)
    } catch {
      throw error
    }
    return retryUntilReleased(acquire, options)
  }
}

export function acquireWriterLockFromOlderBuild(
  options: Parameters<typeof acquireSessionWriterLock>[0]
): ReturnType<typeof acquireSessionWriterLock> {
  return acquireFromOlderBuild(options.path, () => acquireSessionWriterLock(options))
}

export { SessionWriterBusyError }
