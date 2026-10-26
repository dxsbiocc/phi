import { createHash, randomUUID } from 'node:crypto'
import { closeSync, constants, fsyncSync, openSync, writeSync } from 'node:fs'
import { chmod, lstat, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'

import type {
  HistoryMigrationState,
  SessionAdoptParams
} from '../../shared/kernel-protocol/history'
import { writeManifestAtomic } from './persistence'
import { readAndHashJournal, type AdoptionSourceInspection } from './source-journal'
import {
  SESSION_MANIFEST_SCHEMA_VERSION,
  type SessionManifest,
  type SessionMigrationRecord
} from './types'

export * from './source-journal'

const MIGRATION_SCHEMA_VERSION = 1 as const
const MIGRATION_VERSION = 1 as const
const MAX_MIGRATION_BYTES = 128 * 1024
const COPY_BUFFER_BYTES = 256 * 1024
const migrationStates = new Set<HistoryMigrationState>([
  'started',
  'copied',
  'verified',
  'complete'
])
const thinkingLevels = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const migrationTimestampCount: Record<HistoryMigrationState, number> = {
  started: 0,
  copied: 1,
  verified: 2,
  complete: 3
}

export type MigrationPaths = {
  directory: string
  journal: string
  sourceBackup: string
  migration: string
  manifest: string
  receipts: string
}

export type ContinueMigrationOptions = {
  validateJournal?: (path: string, cwd: string) => Promise<void>
  pauseAfterState?: (
    state: Exclude<HistoryMigrationState, 'complete'> | 'complete',
    record: SessionMigrationRecord
  ) => void | Promise<void>
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function fsCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined
}

function validIso(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}

export function adoptedSessionId(phiSessionId: string, sourceSha256: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([1, phiSessionId, sourceSha256]))
    .digest('hex')
  return `adopt-${digest.slice(0, 48)}`
}

export function createMigrationRecord(
  params: SessionAdoptParams,
  source: AdoptionSourceInspection,
  at = new Date().toISOString()
): SessionMigrationRecord {
  return {
    schemaVersion: MIGRATION_SCHEMA_VERSION,
    migrationVersion: MIGRATION_VERSION,
    source: {
      kind: 'omp-journal',
      path: source.path,
      cwd: params.source.cwd,
      size: source.size,
      mtime: source.mtime,
      sha256: source.sha256,
      origin: params.source.origin,
      phiSessionId: params.source.phiSessionId,
      ompSessionId: source.header.id,
      headerVersion: source.header.version,
      headerTimestamp: source.header.timestamp
    },
    target: {
      ...(params.title ? { title: params.title } : {}),
      ...(params.model ? { model: { ...params.model } } : {}),
      ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {})
    },
    backup: 'source-backup.jsonl',
    state: 'started',
    startedAt: at
  }
}

function validMigrationSourceFile(source: Record<string, unknown>): boolean {
  if (
    !hasOnlyKeys(source, [
      'kind',
      'path',
      'cwd',
      'size',
      'mtime',
      'sha256',
      'origin',
      'phiSessionId',
      'ompSessionId',
      'headerVersion',
      'headerTimestamp'
    ])
  ) {
    return false
  }
  if (source.kind !== 'omp-journal') return false
  if (typeof source.path !== 'string' || !isAbsolute(source.path)) return false
  if (typeof source.cwd !== 'string' || !isAbsolute(source.cwd)) return false
  if (!Number.isSafeInteger(source.size) || (source.size as number) < 0) return false
  return validIso(source.mtime)
}

function validMigrationSourceIdentity(source: Record<string, unknown>): boolean {
  if (typeof source.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(source.sha256)) return false
  if (source.origin !== 'desktop-local' && source.origin !== 'rpc-remote') return false
  if (typeof source.phiSessionId !== 'string' || !source.phiSessionId) return false
  return typeof source.ompSessionId === 'string' && source.ompSessionId.length > 0
}

function validMigrationSourceHeader(source: Record<string, unknown>): boolean {
  return (
    Number.isInteger(source.headerVersion) &&
    (source.headerVersion as number) > 0 &&
    validIso(source.headerTimestamp)
  )
}

function validMigrationTarget(target: Record<string, unknown>): boolean {
  if (!hasOnlyKeys(target, ['title', 'model', 'thinkingLevel'])) return false
  if (target.title !== undefined && (typeof target.title !== 'string' || !target.title))
    return false
  if (
    target.thinkingLevel !== undefined &&
    (typeof target.thinkingLevel !== 'string' || !thinkingLevels.has(target.thinkingLevel))
  )
    return false
  if (target.model === undefined) return true
  const model = record(target.model)
  if (
    !model ||
    !hasOnlyKeys(model, ['provider', 'id']) ||
    typeof model.provider !== 'string' ||
    !model.provider
  )
    return false
  return typeof model.id === 'string' && model.id.length > 0
}

function validMigrationTimestamps(migration: Record<string, unknown>): boolean {
  if (!validIso(migration.startedAt)) return false
  if (migration.copiedAt !== undefined && !validIso(migration.copiedAt)) return false
  if (migration.verifiedAt !== undefined && !validIso(migration.verifiedAt)) return false
  if (migration.completedAt !== undefined && !validIso(migration.completedAt)) return false
  const expected = migrationTimestampCount[migration.state as HistoryMigrationState]
  const timestamps = [migration.copiedAt, migration.verifiedAt, migration.completedAt]
  return timestamps.every((value, index) => (index < expected ? value !== undefined : !value))
}

function parseMigration(value: unknown): SessionMigrationRecord {
  const migration = record(value)
  if (!migration) throw new Error('session migration record is corrupt')
  const source = record(migration.source)
  const target = record(migration.target)
  const allowedEnvelope = hasOnlyKeys(migration, [
    'schemaVersion',
    'migrationVersion',
    'source',
    'target',
    'backup',
    'state',
    'startedAt',
    'copiedAt',
    'verifiedAt',
    'completedAt'
  ])
  const validEnvelope =
    allowedEnvelope &&
    migration.schemaVersion === MIGRATION_SCHEMA_VERSION &&
    migration.migrationVersion === MIGRATION_VERSION &&
    migration.backup === 'source-backup.jsonl' &&
    typeof migration.state === 'string' &&
    migrationStates.has(migration.state as HistoryMigrationState)
  if (!validEnvelope || !source || !target) {
    throw new Error('session migration record is corrupt')
  }
  if (
    !validMigrationSourceFile(source) ||
    !validMigrationSourceIdentity(source) ||
    !validMigrationSourceHeader(source) ||
    !validMigrationTarget(target) ||
    !validMigrationTimestamps(migration)
  ) {
    throw new Error('session migration record is corrupt')
  }
  return migration as unknown as SessionMigrationRecord
}

async function fsyncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

export async function writeMigrationAtomic(
  path: string,
  migration: SessionMigrationRecord
): Promise<void> {
  const temporary = `${path}.tmp.${randomUUID()}`
  const handle = await open(temporary, 'wx', 0o600)
  let published = false
  try {
    await handle.writeFile(`${JSON.stringify(migration)}\n`, 'utf8')
    await handle.sync()
    await handle.close()
    await rename(temporary, path)
    await chmod(path, 0o600)
    await fsyncDirectory(dirname(path))
    published = true
  } finally {
    await handle.close().catch(() => undefined)
    if (!published) await rm(temporary, { force: true }).catch(() => undefined)
  }
}

export async function readMigration(path: string): Promise<SessionMigrationRecord | undefined> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    if (fsCode(error) === 'ENOENT') return undefined
    throw error
  }
  if (Buffer.byteLength(content) > MAX_MIGRATION_BYTES) {
    throw new Error('session migration record exceeds its size limit')
  }
  try {
    return parseMigration(JSON.parse(content))
  } catch (error) {
    throw new Error('session migration record is corrupt', { cause: error })
  }
}

async function writeAll(handle: Awaited<ReturnType<typeof open>>, chunk: Buffer): Promise<void> {
  let offset = 0
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset)
    if (bytesWritten < 1) throw new Error('copy made no progress')
    offset += bytesWritten
  }
}

async function copySourceTwice(
  sourcePath: string,
  paths: Pick<MigrationPaths, 'directory' | 'sourceBackup' | 'journal'>,
  expected: Pick<SessionMigrationRecord['source'], 'size' | 'mtime' | 'sha256'>
): Promise<void> {
  const suffix = randomUUID()
  const backupTemporary = `${paths.sourceBackup}.tmp.${suffix}`
  const journalTemporary = `${paths.journal}.tmp.${suffix}`
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0)
  const source = await open(sourcePath, constants.O_RDONLY | noFollow)
  const backup = await open(backupTemporary, 'wx', 0o600)
  const journal = await open(journalTemporary, 'wx', 0o600)
  let published = false
  try {
    const before = await source.stat()
    if (
      !before.isFile() ||
      before.size !== expected.size ||
      before.mtime.toISOString() !== expected.mtime
    ) {
      throw new Error('source journal changed since migration started')
    }
    const hash = createHash('sha256')
    const buffer = Buffer.alloc(COPY_BUFFER_BYTES)
    let position = 0
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) break
      const chunk = buffer.subarray(0, bytesRead)
      hash.update(chunk)
      await Promise.all([writeAll(backup, chunk), writeAll(journal, chunk)])
      position += bytesRead
    }
    const after = await source.stat()
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      position !== expected.size ||
      hash.digest('hex') !== expected.sha256
    ) {
      throw new Error('source journal changed while migration copied it')
    }
    await Promise.all([backup.sync(), journal.sync()])
    await Promise.all([backup.close(), journal.close()])
    await rename(backupTemporary, paths.sourceBackup)
    await rename(journalTemporary, paths.journal)
    await Promise.all([chmod(paths.sourceBackup, 0o600), chmod(paths.journal, 0o600)])
    await fsyncDirectory(paths.directory)
    published = true
  } finally {
    await Promise.all([
      source.close().catch(() => undefined),
      backup.close().catch(() => undefined),
      journal.close().catch(() => undefined)
    ])
    if (!published) {
      await Promise.all([
        rm(backupTemporary, { force: true }).catch(() => undefined),
        rm(journalTemporary, { force: true }).catch(() => undefined)
      ])
    }
  }
}

async function sha256File(path: string): Promise<string> {
  const inspection = await readAndHashJournal(path)
  return inspection.sha256
}

async function validateCopies(
  paths: Pick<MigrationPaths, 'sourceBackup' | 'journal'>,
  sourceSha256: string
): Promise<void> {
  const [backupSha256, journalSha256] = await Promise.all([
    sha256File(paths.sourceBackup),
    sha256File(paths.journal)
  ])
  if (backupSha256 !== sourceSha256 || journalSha256 !== sourceSha256) {
    throw new Error('migrated journal copies do not match the source hash')
  }
}

async function ensureEmptyReceipts(path: string): Promise<void> {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink() || !info.isFile() || info.size !== 0) {
      throw new Error('adopted session run receipts are invalid')
    }
    return
  } catch (error) {
    if (fsCode(error) !== 'ENOENT') throw error
  }
  const handle = await open(path, 'wx', 0o600)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
}

function nextRecord(
  migration: SessionMigrationRecord,
  state: HistoryMigrationState,
  at = new Date().toISOString()
): SessionMigrationRecord {
  return {
    ...migration,
    state,
    ...(state === 'copied' ? { copiedAt: at } : {}),
    ...(state === 'verified' ? { verifiedAt: at } : {}),
    ...(state === 'complete' ? { completedAt: at } : {})
  }
}

function envPauseAfterState(
  state: HistoryMigrationState,
  paths: Pick<MigrationPaths, 'directory'>
): void {
  if (process.env.PHI_KERNEL_HISTORY_TEST_PAUSE !== state) return
  const markerPath = `${paths.directory}/history-test-pause-${state}.marker`
  const marker = openSync(markerPath, 'w', 0o600)
  try {
    writeSync(marker, `${process.pid}\n`)
    fsyncSync(marker)
  } finally {
    closeSync(marker)
  }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0)
}

async function pause(
  state: HistoryMigrationState,
  migration: SessionMigrationRecord,
  paths: MigrationPaths,
  options: ContinueMigrationOptions
): Promise<void> {
  envPauseAfterState(state, paths)
  await options.pauseAfterState?.(state, migration)
}

async function refreshStartedSource(
  migration: SessionMigrationRecord,
  migrationPath: string
): Promise<SessionMigrationRecord> {
  const current = await readAndHashJournal(migration.source.path)
  if (current.sha256 !== migration.source.sha256) {
    throw new Error('source journal content changed since migration started')
  }
  const refreshed: SessionMigrationRecord = {
    ...migration,
    source: {
      ...migration.source,
      size: current.size,
      mtime: current.mtime,
      ompSessionId: current.header.id,
      headerVersion: current.header.version,
      headerTimestamp: current.header.timestamp
    }
  }
  await writeMigrationAtomic(migrationPath, refreshed)
  return refreshed
}

export async function continueMigration(
  sessionId: string,
  paths: MigrationPaths,
  initial: SessionMigrationRecord,
  options: ContinueMigrationOptions = {}
): Promise<SessionMigrationRecord> {
  let migration = initial
  if (migration.state === 'started') {
    // Mtime is evidence, not identity. A backup/touch operation may change it
    // after the started record; the immutable content hash remains authoritative.
    migration = await refreshStartedSource(migration, paths.migration)
    await copySourceTwice(migration.source.path, paths, migration.source)
    migration = nextRecord(migration, 'copied')
    await writeMigrationAtomic(paths.migration, migration)
    await pause('copied', migration, paths, options)
  }
  if (migration.state === 'copied') {
    await validateCopies(paths, migration.source.sha256)
    migration = nextRecord(migration, 'verified')
    await writeMigrationAtomic(paths.migration, migration)
    await pause('verified', migration, paths, options)
  }
  if (migration.state === 'verified') {
    if (!options.validateJournal) {
      throw new Error('OMP journal validation is unavailable for migration recovery')
    }
    await options.validateJournal(paths.journal, migration.source.cwd)
    await ensureEmptyReceipts(paths.receipts)
    const journalInfo = await stat(paths.journal)
    const manifest: SessionManifest = {
      schemaVersion: SESSION_MANIFEST_SCHEMA_VERSION,
      sessionId,
      cwd: migration.source.cwd,
      createdAt: migration.source.headerTimestamp,
      updatedAt: journalInfo.mtime.toISOString(),
      ...(migration.target.model ? { model: { ...migration.target.model } } : {}),
      ...(migration.target.thinkingLevel ? { thinkingLevel: migration.target.thinkingLevel } : {}),
      ...(migration.target.title ? { title: migration.target.title } : {}),
      journal: 'journal.jsonl'
    }
    await writeManifestAtomic(paths.manifest, manifest)
    migration = nextRecord(migration, 'complete')
    await writeMigrationAtomic(paths.migration, migration)
    await pause('complete', migration, paths, options)
  }
  return migration
}

export async function startMigration(
  paths: MigrationPaths,
  migration: SessionMigrationRecord,
  options: ContinueMigrationOptions = {}
): Promise<SessionMigrationRecord> {
  await writeMigrationAtomic(paths.migration, migration)
  await pause('started', migration, paths, options)
  return continueMigration(
    adoptedSessionId(migration.source.phiSessionId, migration.source.sha256),
    paths,
    migration,
    options
  )
}
