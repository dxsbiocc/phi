import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  rmdirSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import type { WorkMode } from '../../../shared/sessionMode'

const FILE = 'pending-remote-auto-plan.json'
const LOCK = '.pending-remote-auto-plan.lock'
const MAX_BYTES = 4096

export interface PendingRemoteAutoPlan {
  version: 1
  phiSessionId: string
  runId: string
  sessionGeneration: number
  mode: 'plan' | 'plan_execute'
}

export type PendingRemoteAutoPlanRead =
  { state: 'none' } | { state: 'pending'; marker: PendingRemoteAutoPlan } | { state: 'invalid' }

interface FileIdentity {
  dev: string
  ino: string
  size: string
  mtimeMs: string
  ctimeMs: string
}

type MarkerRead = PendingRemoteAutoPlanRead & { identity?: FileIdentity }

function validMarker(value: unknown): value is PendingRemoteAutoPlan {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const marker = value as Record<string, unknown>
  return (
    Object.keys(marker).sort().join(',') === 'mode,phiSessionId,runId,sessionGeneration,version' &&
    marker.version === 1 &&
    typeof marker.phiSessionId === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(marker.phiSessionId) &&
    typeof marker.runId === 'string' &&
    /^[A-Za-z0-9_-]+$/.test(marker.runId) &&
    Number.isSafeInteger(marker.sessionGeneration) &&
    (marker.sessionGeneration as number) >= 0 &&
    (marker.mode === 'plan' || marker.mode === 'plan_execute')
  )
}

function syncDirectory(directory: string): void {
  const fd = openSync(directory, 'r')
  try {
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function hasLock(directory: string): boolean {
  try {
    lstatSync(join(directory, LOCK))
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT'
  }
}

function withMarkerLock<T>(directory: string, action: () => T): T {
  const lock = join(directory, LOCK)
  mkdirSync(lock, { mode: 0o700 })
  try {
    return action()
  } finally {
    rmdirSync(lock)
    syncDirectory(directory)
  }
}

function syncRegularFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Invalid session settlement file')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}

function syncSessionSettlement(directory: string): void {
  syncRegularFile(join(directory, 'messages.jsonl'))
  syncRegularFile(join(directory, 'manifest.json'))
  syncDirectory(directory)
}

function isSessionDirectory(directory: string): boolean {
  try {
    return lstatSync(directory).isDirectory()
  } catch {
    return false
  }
}

function readMarker(directory: string): MarkerRead {
  if (!isSessionDirectory(directory)) return { state: 'invalid' }
  const path = join(directory, FILE)
  let fd: number | undefined
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const stat = fstatSync(fd)
    if (!stat.isFile() || stat.size > MAX_BYTES) return { state: 'invalid' }
    const bytes = Buffer.alloc(MAX_BYTES + 1)
    let length = 0
    while (length < bytes.length) {
      const received = readSync(fd, bytes, length, bytes.length - length, length)
      if (!received) break
      length += received
    }
    if (length > MAX_BYTES) return { state: 'invalid' }
    const marker: unknown = JSON.parse(
      new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length))
    )
    return validMarker(marker)
      ? { state: 'pending', marker, identity: identity(stat) }
      : { state: 'invalid' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' && fd === undefined)
      return { state: 'none' }
    return { state: 'invalid' }
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

function identity(stat: ReturnType<typeof fstatSync>): FileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    size: String(stat.size),
    mtimeMs: String(stat.mtimeMs),
    ctimeMs: String(stat.ctimeMs)
  }
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof FileIdentity] === right[key as keyof FileIdentity]
  )
}

export function readPendingRemoteAutoPlan(directory: string): PendingRemoteAutoPlanRead {
  const read = readMarker(directory)
  if (read.state === 'pending') return { state: 'pending', marker: read.marker }
  if (read.state === 'none' && hasLock(directory)) return { state: 'invalid' }
  return { state: read.state }
}

/** Write before acknowledging enter_plan_mode. Existing unresolved authority cannot be replaced. */
export function writePendingRemoteAutoPlan(directory: string, marker: PendingRemoteAutoPlan): void {
  if (!validMarker(marker)) throw new Error('Invalid remote automatic plan marker')
  withMarkerLock(directory, () => {
    const previous = readMarker(directory)
    if (previous.state !== 'none') {
      if (
        previous.state === 'pending' &&
        JSON.stringify(previous.marker) === JSON.stringify(marker)
      )
        return
      throw new Error('An unresolved remote automatic plan marker already exists')
    }
    const temporary = join(directory, `.${FILE}.${process.pid}.${randomUUID()}.tmp`)
    const destination = join(directory, FILE)
    try {
      writeFileSync(temporary, `${JSON.stringify(marker)}\n`, { flag: 'wx', mode: 0o600 })
      const fd = openSync(temporary, 'r')
      try {
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
      // Hard-link creation is exclusive even if a non-cooperating writer races.
      linkSync(temporary, destination)
      syncDirectory(directory)
    } finally {
      rmSync(temporary, { force: true })
    }
  })
}

/** Unknown or stale evidence remains read-only until an authoritative settlement clears it. */
export function effectiveRecoveredRemoteAutoMode(input: {
  directory: string
  phiSessionId: string
  runId: string
  sessionGeneration: number
  savedMode: WorkMode
}): { mode: WorkMode; tainted: boolean } {
  const read = readPendingRemoteAutoPlan(input.directory)
  if (read.state === 'none') return { mode: input.savedMode, tainted: false }
  if (
    input.savedMode === 'auto' &&
    read.state === 'pending' &&
    read.marker.phiSessionId === input.phiSessionId &&
    read.marker.runId === input.runId &&
    read.marker.sessionGeneration === input.sessionGeneration
  )
    return { mode: read.marker.mode, tainted: true }
  return { mode: 'plan', tainted: true }
}

/** Caller must supply a verified terminal event and settled manifest for this exact run. */
export function clearPendingRemoteAutoPlanAfterTurn(input: {
  directory: string
  phiSessionId: string
  runId: string
  settledRunId: string | undefined
  terminalEventRunId: string
  /** Test seam for simulating a file replacement before the final identity check. */
  beforeUnlink?: () => void
}): boolean {
  try {
    return withMarkerLock(input.directory, () => {
      const read = readMarker(input.directory)
      if (read.state !== 'pending' || !read.identity) return false
      if (
        read.marker.phiSessionId !== input.phiSessionId ||
        read.marker.runId !== input.runId ||
        input.settledRunId !== undefined ||
        input.terminalEventRunId !== input.runId
      )
        return false
      const path = join(input.directory, FILE)
      const current = lstatSync(path)
      if (!current.isFile() || !sameIdentity(read.identity, identity(current))) return false
      input.beforeUnlink?.()
      syncSessionSettlement(input.directory)
      rmSync(path)
      syncDirectory(input.directory)
      return true
    })
  } catch {
    // Lock contention or failed settlement sync leaves the marker authoritative.
    return false
  }
}
