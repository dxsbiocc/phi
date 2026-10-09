import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeSync
} from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'

import { loadEnvironment } from './execution'
import { readEnvironmentIndex } from './index-store'
import { acquireEnvironmentLock } from './lock'

const ENV_ID = /^[a-z][a-z0-9-]{0,255}-[a-f0-9]{12}$/
const TOKEN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const MAX_RECORD_BYTES = 1024
const MAX_ENVIRONMENT_LEASES = 4096

interface LeaseRecord {
  version: 1
  envId: string
  pid: number
  token: string
  createdAt: string
}

export interface EnvironmentLease {
  envId: string
  token: string
  path: string
  release(): void
}

export interface EnvironmentLeaseOptions {
  processAlive?: (pid: number) => boolean
  /** Use false for a read-only snapshot, including GC's pre-lock check. */
  pruneStale?: boolean
}

function code(error: unknown): string | undefined {
  return error instanceof Error && 'code' in error ? String(error.code) : undefined
}

function runtimeRoot(root: string): string {
  if (typeof root !== 'string' || !isAbsolute(root))
    throw new Error('environment lease requires an absolute runtime root')
  const actual = realpathSync(root)
  if (!lstatSync(actual).isDirectory())
    throw new Error('environment lease runtime root is not a directory')
  return actual
}

function assertEnvId(envId: string): void {
  if (typeof envId !== 'string' || !ENV_ID.test(envId))
    throw new Error('invalid environment lease envId')
}

function directory(root: string, segments: string[], create: boolean): string | undefined {
  let path = root
  for (const segment of segments) {
    path = join(path, segment)
    let stat
    try {
      stat = lstatSync(path)
    } catch (error) {
      if (code(error) !== 'ENOENT') throw error
      if (!create) return undefined
      try {
        mkdirSync(path, { mode: 0o700 })
      } catch (mkdirError) {
        if (code(mkdirError) !== 'EEXIST') throw mkdirError
      }
      stat = lstatSync(path)
    }
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        'environment lease directory must stay inside the runtime root without symlinks'
      )
  }
  return path
}

function removeFile(path: string): void {
  try {
    unlinkSync(path)
  } catch (error) {
    if (code(error) !== 'ENOENT') throw error
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return code(error) === 'EPERM'
  }
}

function readRecord(path: string, envId: string, token: string): LeaseRecord | undefined {
  let descriptor: number | undefined
  try {
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) return undefined
    descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.size > MAX_RECORD_BYTES) return undefined
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1)
    // Reading through the bounded file descriptor prevents oversized or symlinked records.
    const length = readSync(descriptor, bytes, 0, bytes.length, 0)
    if (length > MAX_RECORD_BYTES) return undefined
    const value: unknown = JSON.parse(bytes.subarray(0, length).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    const record = value as Record<string, unknown>
    if (
      record.version !== 1 ||
      record.envId !== envId ||
      record.token !== token ||
      typeof record.pid !== 'number' ||
      !Number.isSafeInteger(record.pid) ||
      record.pid < 1 ||
      record.pid > 2147483647 ||
      typeof record.createdAt !== 'string' ||
      record.createdAt.length > 64 ||
      !Number.isFinite(Date.parse(record.createdAt))
    )
      return undefined
    return record as unknown as LeaseRecord
  } catch (error) {
    if (code(error) && code(error) !== 'ENOENT' && code(error) !== 'ELOOP') throw error
    return undefined
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

/** Check durable active-consumer records; dead owners never keep an environment alive. */
export function hasLiveEnvironmentLeases(
  root: string,
  envId: string,
  options: EnvironmentLeaseOptions = {}
): boolean {
  // GC may encounter legacy orphans whose directory names are not valid environment IDs.
  if (!ENV_ID.test(envId)) return false
  const base = runtimeRoot(root)
  const leases = directory(base, ['state', 'leases', envId], false)
  if (!leases) return false
  const entries = readdirSync(leases, { withFileTypes: true })
  if (entries.length > MAX_ENVIRONMENT_LEASES)
    throw new Error('environment lease count exceeds its bound')
  let live = false
  for (const entry of entries) {
    const token = entry.name.endsWith('.json') ? entry.name.slice(0, -5) : ''
    if (!TOKEN.test(token)) continue
    const path = join(leases, entry.name)
    const record = readRecord(path, envId, token)
    if (record && (options.processAlive ?? processAlive)(record.pid)) live = true
    else if (options.pruneStale !== false && !entry.isDirectory()) removeFile(path)
  }
  return live
}

function validateReadyEnvironment(root: string, envId: string): void {
  const prefix = directory(root, ['envs', envId], false)
  if (!prefix) throw new Error(`environment ${envId} is not ready: managed prefix is missing`)
  const metadataDirectory = directory(prefix, ['.phi'], false)
  if (!metadataDirectory) throw new Error(`environment ${envId} is not ready: metadata is missing`)
  const metadata = lstatSync(join(metadataDirectory, 'env.json'))
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 1024 * 1024)
    throw new Error('environment lease requires bounded regular managed metadata')
  loadEnvironment(root, envId)
  const indexed = readEnvironmentIndex(root).environments[envId]
  if (indexed && (indexed.status !== 'ready' || resolve(indexed.prefix) !== prefix))
    throw new Error('environment lease requires ready state inside the managed runtime root')
}

/** Publish a lease under the GC/build lock, then release that lock before the consumer launches. */
export async function acquireEnvironmentLease(input: {
  root: string
  envId: string
  signal?: AbortSignal
  pid?: number
}): Promise<EnvironmentLease> {
  assertEnvId(input.envId)
  input.signal?.throwIfAborted()
  const root = runtimeRoot(input.root)
  const pid = input.pid ?? process.pid
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647)
    throw new Error('invalid environment lease owner PID')
  directory(root, ['state', 'locks'], true)
  const lock = await acquireEnvironmentLock({ root, envId: input.envId, signal: input.signal })
  try {
    input.signal?.throwIfAborted()
    validateReadyEnvironment(root, input.envId)
    const leases = directory(root, ['state', 'leases', input.envId], true)!
    hasLiveEnvironmentLeases(root, input.envId)
    if (readdirSync(leases).length >= MAX_ENVIRONMENT_LEASES)
      throw new Error('environment lease count exceeds its bound')
    const token = randomUUID()
    const path = join(leases, `${token}.json`)
    const temporary = join(leases, `.${token}.partial`)
    const record: LeaseRecord = {
      version: 1,
      envId: input.envId,
      pid,
      token,
      createdAt: new Date().toISOString()
    }
    let descriptor: number | undefined
    try {
      descriptor = openSync(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600
      )
      writeSync(descriptor, JSON.stringify(record))
      closeSync(descriptor)
      descriptor = undefined
      renameSync(temporary, path)
    } finally {
      if (descriptor !== undefined) closeSync(descriptor)
      removeFile(temporary)
    }
    let released = false
    return {
      envId: input.envId,
      token,
      path,
      release(): void {
        if (released) return
        directory(root, ['state', 'leases', input.envId], false)
        const current = readRecord(path, input.envId, token)
        if (!current || current.pid === pid) removeFile(path)
        released = true
      }
    }
  } finally {
    lock.release()
  }
}
