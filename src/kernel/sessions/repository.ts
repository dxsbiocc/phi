import { randomUUID } from 'node:crypto'
import { open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  RunCompletedPayload,
  SessionCreateParams,
  SessionListEntry
} from '../../shared/kernel-protocol'
import type { SessionAdoptParams, SessionAdoptResult } from '../../shared/kernel-protocol/history'
import {
  adoptedSessionId,
  continueMigration,
  createMigrationRecord,
  inspectAdoptionSource,
  readMigration,
  startMigration,
  type ContinueMigrationOptions
} from './migration'
import { discardIncompleteMigrationLocked } from './migration-cleanup'
import {
  kernelSessionMigrationPaths,
  kernelSessionPaths,
  kernelSessionsRoot,
  isKernelSessionId
} from './paths'
import {
  appendReceipt,
  ensurePrivateDirectory,
  readManifest,
  readReceipts,
  repairReceiptTail,
  reconcileManifestReceipts,
  reconstructManifest,
  writeManifestAtomic
} from './persistence'
import {
  SESSION_MANIFEST_SCHEMA_VERSION,
  type AcceptedRunReceipt,
  type AcquireProcessLockGuard,
  type DuplicateRun,
  type PersistentSession,
  type RunReceipt,
  type RunReceiptState,
  type SessionManifest,
  type SessionMigrationRecord,
  type SessionWriterLock,
  type TerminalRunReceipt
} from './types'
import { acquireSessionWriterLock, SessionWriterBusyError } from './writer-lock'

function sameLastRun(left: SessionManifest, right: SessionManifest): boolean {
  return (
    left.updatedAt === right.updatedAt &&
    left.lastRun?.runId === right.lastRun?.runId &&
    left.lastRun?.status === right.lastRun?.status
  )
}

function indexReceipts(receipts: readonly RunReceipt[]): {
  runs: Map<string, RunReceiptState>
  clientRuns: Map<string, RunReceiptState>
} {
  const runs = new Map<string, RunReceiptState>()
  const clientRuns = new Map<string, RunReceiptState>()
  let unresolved: RunReceiptState | undefined
  for (const receipt of receipts) {
    if (receipt.state === 'accepted') {
      if (unresolved) throw new Error('run receipts contain concurrent accepted runs')
      if (runs.has(receipt.runId)) throw new Error('run receipt repeats an accepted run id')
      if (receipt.clientRunKey && clientRuns.has(receipt.clientRunKey)) {
        throw new Error('run receipt repeats a client run key')
      }
      const state = { accepted: receipt }
      runs.set(receipt.runId, state)
      if (receipt.clientRunKey) clientRuns.set(receipt.clientRunKey, state)
      unresolved = state
      continue
    }
    const state = runs.get(receipt.runId)
    if (!state || state.terminal || state !== unresolved) {
      throw new Error('run receipt has an unmatched terminal state')
    }
    state.terminal = receipt
    unresolved = undefined
  }
  return { runs, clientRuns }
}

function manifestSummary(manifest: SessionManifest, loaded: boolean): SessionListEntry {
  return {
    sessionId: manifest.sessionId,
    cwd: manifest.cwd,
    ...(manifest.title ? { title: manifest.title } : {}),
    createdAt: manifest.createdAt,
    updatedAt: manifest.updatedAt,
    loaded,
    ...(manifest.lastRun ? { lastRun: manifest.lastRun } : {})
  }
}

function summary(session: PersistentSession, loaded: boolean): SessionListEntry {
  return manifestSummary(session.manifest, loaded)
}

function corrupt(sessionId: string, message: string): SessionListEntry {
  return { sessionId, error: { code: 'CORRUPT_SESSION', message } }
}

function persistedSessionPolicy(
  params: SessionCreateParams
): NonNullable<SessionManifest['policy']> {
  const requiresTrustedResources =
    params.resourceOptions !== undefined ||
    params.phiAgents !== undefined ||
    params.personaMarkdown !== undefined ||
    params.memory !== undefined ||
    params.contextFiles !== undefined ||
    params.mcpServers !== undefined ||
    params.desktopMcp !== undefined ||
    params.environment !== undefined
  return {
    projectBound: params.projectBound === true,
    requiresTrustedResources,
    sessionPolicy: {
      noTools: params.noTools ?? false,
      workMode: params.workMode ?? 'direct',
      enableToolApproval: params.enableToolApproval === true,
      ...(params.resourceVersion ? { resourceVersion: params.resourceVersion } : {}),
      ...(params.autoCompaction
        ? { autoCompaction: { enabled: params.autoCompaction.enabled } }
        : {})
    }
  }
}

export class KernelSessionRepository {
  private readonly root: string
  private readonly loaded = new Map<string, PersistentSession>()
  private readonly opening = new Map<string, Promise<PersistentSession>>()
  private migrationJournalValidator: ContinueMigrationOptions['validateJournal']

  constructor(
    private readonly agentDir: string,
    private readonly kernelInstanceId: string = randomUUID(),
    private readonly acquireGuard?: AcquireProcessLockGuard,
    private readonly processStartedAt?: string,
    validateMigrationJournal?: ContinueMigrationOptions['validateJournal']
  ) {
    this.root = kernelSessionsRoot(agentDir)
    this.migrationJournalValidator = validateMigrationJournal
  }

  configureMigrationJournalValidator(
    validateJournal: NonNullable<ContinueMigrationOptions['validateJournal']>
  ): void {
    if (this.migrationJournalValidator && this.migrationJournalValidator !== validateJournal) {
      throw new Error('migration journal validator is already configured')
    }
    this.migrationJournalValidator = validateJournal
  }

  get(sessionId: string): PersistentSession | undefined {
    return this.loaded.get(sessionId)
  }

  private async acquireLock(sessionId: string, path: string): Promise<SessionWriterLock> {
    let guardPath: string | undefined
    if (this.acquireGuard) {
      const guardDirectory = join(this.root, '.writer-locks')
      await ensurePrivateDirectory(guardDirectory, true)
      guardPath = join(guardDirectory, `${sessionId}.lock`)
    }
    return acquireSessionWriterLock({
      path,
      kernelInstanceId: this.kernelInstanceId,
      acquireGuard: this.acquireGuard,
      startedAt: this.processStartedAt,
      ...(guardPath ? { guardPath } : {})
    })
  }

  async create(sessionId: string, params: SessionCreateParams): Promise<PersistentSession> {
    const policy = persistedSessionPolicy(params)
    return this.createWithManifest(sessionId, {
      cwd: params.cwd,
      model: { ...params.model },
      ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
      policy
    })
  }

  async createFork(sessionId: string, source: PersistentSession): Promise<PersistentSession> {
    return this.createWithManifest(sessionId, {
      cwd: source.manifest.cwd,
      ...(source.manifest.model ? { model: { ...source.manifest.model } } : {}),
      ...(source.manifest.thinkingLevel ? { thinkingLevel: source.manifest.thinkingLevel } : {}),
      ...(source.manifest.title ? { title: source.manifest.title } : {}),
      ...(source.manifest.policy ? { policy: structuredClone(source.manifest.policy) } : {})
    })
  }

  private async createWithManifest(
    sessionId: string,
    fields: Pick<SessionManifest, 'cwd' | 'model' | 'thinkingLevel' | 'title' | 'policy'>
  ): Promise<PersistentSession> {
    if (!isKernelSessionId(sessionId)) throw new TypeError('Invalid kernel session id')
    await ensurePrivateDirectory(join(this.agentDir, 'phi-kernel'), true)
    await ensurePrivateDirectory(this.root, true)
    const paths = kernelSessionPaths(this.agentDir, sessionId)
    await ensurePrivateDirectory(paths.directory)
    const lock = await this.acquireLock(sessionId, paths.lock).catch(async (error: unknown) => {
      await rm(paths.directory, { recursive: true, force: true })
      throw error
    })
    const now = new Date().toISOString()
    const manifest: SessionManifest = {
      schemaVersion: SESSION_MANIFEST_SCHEMA_VERSION,
      sessionId,
      cwd: fields.cwd,
      createdAt: now,
      updatedAt: now,
      ...(fields.model ? { model: fields.model } : {}),
      ...(fields.thinkingLevel ? { thinkingLevel: fields.thinkingLevel } : {}),
      ...(fields.title ? { title: fields.title } : {}),
      ...(fields.policy ? { policy: fields.policy } : {}),
      journal: 'journal.jsonl'
    }
    try {
      const receipts = await open(paths.receipts, 'wx', 0o600)
      await receipts.sync()
      await receipts.close()
      await writeManifestAtomic(paths.manifest, manifest)
      const session: PersistentSession = {
        directory: paths.directory,
        journalPath: paths.journal,
        receiptsPath: paths.receipts,
        manifestPath: paths.manifest,
        lock,
        manifest,
        runs: new Map(),
        clientRuns: new Map(),
        receiptTail: Promise.resolve()
      }
      this.loaded.set(sessionId, session)
      return session
    } catch (error) {
      await rm(paths.directory, { recursive: true, force: true })
      await lock.release()
      throw error
    }
  }

  async adopt(
    params: SessionAdoptParams,
    options: ContinueMigrationOptions & { allowedSourceRoots: readonly string[] }
  ): Promise<SessionAdoptResult> {
    const migrationOptions: ContinueMigrationOptions = {
      ...options,
      validateJournal: options.validateJournal ?? this.migrationJournalValidator
    }
    const source = await inspectAdoptionSource(params, options.allowedSourceRoots)
    const sessionId = adoptedSessionId(params.source.phiSessionId, source.sha256)
    await this.rollbackSupersededStartedMigrations(
      params.source.phiSessionId,
      source.path,
      source.sha256,
      sessionId
    )
    const paths = kernelSessionMigrationPaths(this.agentDir, sessionId)
    const loaded = this.loaded.get(sessionId)
    if (loaded) {
      const migration = await readMigration(paths.migration)
      this.assertSameMigration(migration, params.source.phiSessionId, source.sha256, true)
      return { sessionId, migration: { state: 'complete', sourceSha256: source.sha256 } }
    }

    await ensurePrivateDirectory(join(this.agentDir, 'phi-kernel'), true)
    await ensurePrivateDirectory(this.root, true)
    // Deterministic adoption ids intentionally revisit an interrupted or already
    // completed target. The writer lock below decides which caller may resume it.
    await ensurePrivateDirectory(paths.directory, true)
    const lock = await this.acquireLock(sessionId, paths.lock)
    try {
      let migration = await readMigration(paths.migration)
      if (migration) {
        this.assertSameMigration(migration, params.source.phiSessionId, source.sha256)
        migration = await continueMigration(sessionId, paths, migration, migrationOptions)
      } else {
        migration = await startMigration(
          paths,
          createMigrationRecord(params, source),
          migrationOptions
        )
      }
      const session = await this.hydrateLocked(sessionId, paths, lock)
      this.loaded.set(sessionId, session)
      const result: SessionAdoptResult = {
        sessionId,
        migration: { state: migration.state, sourceSha256: migration.source.sha256 }
      }
      // Adoption is a migration transaction, not an implicit session.open.
      // Release the writer so an explicit open can hydrate the worker runtime.
      await this.close(sessionId)
      return result
    } catch (error) {
      await lock.release()
      throw error
    }
  }

  private async rollbackSupersededStartedMigrations(
    phiSessionId: string,
    sourcePath: string,
    sourceSha256: string,
    targetSessionId: string
  ): Promise<void> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (
        !entry.isDirectory() ||
        !isKernelSessionId(entry.name) ||
        entry.name === targetSessionId
      ) {
        continue
      }
      const paths = kernelSessionMigrationPaths(this.agentDir, entry.name)
      const candidate = await readMigration(paths.migration).catch(() => undefined)
      if (
        candidate?.state !== 'started' ||
        candidate.source.phiSessionId !== phiSessionId ||
        candidate.source.path !== sourcePath ||
        candidate.source.sha256 === sourceSha256
      ) {
        continue
      }
      const lock = await this.acquireLock(entry.name, paths.lock)
      try {
        const current = await readMigration(paths.migration)
        if (
          current?.state === 'started' &&
          current.source.phiSessionId === phiSessionId &&
          current.source.path === sourcePath &&
          current.source.sha256 !== sourceSha256
        ) {
          await discardIncompleteMigrationLocked(paths, lock)
        }
      } finally {
        await lock.release()
      }
    }
  }

  private assertSameMigration(
    migration: SessionMigrationRecord | undefined,
    phiSessionId: string,
    sourceSha256: string,
    requireComplete = false
  ): asserts migration is SessionMigrationRecord {
    if (
      !migration ||
      migration.source.phiSessionId !== phiSessionId ||
      migration.source.sha256 !== sourceSha256
    ) {
      throw new Error('adopted session identity does not match its migration record')
    }
    if (requireComplete && migration.state !== 'complete') {
      throw new Error(`session migration is incomplete at state ${migration.state}`)
    }
  }

  async open(sessionId: string): Promise<PersistentSession> {
    if (!isKernelSessionId(sessionId)) throw new TypeError('Invalid kernel session id')
    const loaded = this.loaded.get(sessionId)
    if (loaded) return loaded
    const pending = this.opening.get(sessionId)
    if (pending) return pending
    const opening = this.openLocked(sessionId)
    this.opening.set(sessionId, opening)
    try {
      return await opening
    } finally {
      if (this.opening.get(sessionId) === opening) this.opening.delete(sessionId)
    }
  }

  private async recoverMigrationOnOpen(
    sessionId: string,
    paths: ReturnType<typeof kernelSessionMigrationPaths>,
    lock: SessionWriterLock
  ): Promise<void> {
    const migration = await readMigration(paths.migration)
    if (!migration || migration.state === 'complete') return
    try {
      await continueMigration(sessionId, paths, migration, {
        validateJournal: this.migrationJournalValidator
      })
    } catch (error) {
      const current = await readMigration(paths.migration).catch(() => undefined)
      if (current?.state !== 'started') throw error
      await discardIncompleteMigrationLocked(paths, lock)
      throw Object.assign(new Error('The incomplete session migration was rolled back.'), {
        code: 'ENOENT'
      })
    }
  }

  private async openLocked(sessionId: string): Promise<PersistentSession> {
    const paths = kernelSessionMigrationPaths(this.agentDir, sessionId)
    const lock = await this.acquireLock(sessionId, paths.lock)
    try {
      await this.recoverMigrationOnOpen(sessionId, paths, lock)
      const session = await this.hydrateLocked(sessionId, paths, lock)
      this.loaded.set(sessionId, session)
      return session
    } catch (error) {
      await lock.release()
      throw error
    }
  }

  private async hydrateLocked(
    sessionId: string,
    paths: ReturnType<typeof kernelSessionPaths>,
    lock: SessionWriterLock
  ): Promise<PersistentSession> {
    await repairReceiptTail(paths.receipts)
    const receipts = await readReceipts(paths.receipts)
    let manifest: SessionManifest
    try {
      manifest = await readManifest(paths.manifest, sessionId)
    } catch {
      manifest = await reconstructManifest({
        sessionId,
        journalPath: paths.journal,
        receipts
      })
      await writeManifestAtomic(paths.manifest, manifest)
    }
    const reconciled = reconcileManifestReceipts(manifest, receipts)
    if (!sameLastRun(manifest, reconciled)) {
      manifest = reconciled
      await writeManifestAtomic(paths.manifest, manifest)
    }
    const indexed = indexReceipts(receipts)
    const session: PersistentSession = {
      directory: paths.directory,
      journalPath: paths.journal,
      receiptsPath: paths.receipts,
      manifestPath: paths.manifest,
      lock,
      manifest,
      ...indexed,
      receiptTail: Promise.resolve()
    }
    await this.recoverInterruptedRuns(session)
    return session
  }

  findDuplicate(session: PersistentSession, clientRunKey: string): DuplicateRun | undefined {
    const state = session.clientRuns.get(clientRunKey)
    if (!state) return undefined
    return {
      runId: state.accepted.runId,
      status: state.terminal?.status ?? 'running'
    }
  }

  async acceptRun(session: PersistentSession, runId: string, clientRunKey?: string): Promise<void> {
    if ([...session.runs.values()].some((state) => !state.terminal)) {
      throw new Error('The session already has an accepted run')
    }
    if (clientRunKey && session.clientRuns.has(clientRunKey)) {
      throw new Error('The client run key is already recorded')
    }
    const at = new Date().toISOString()
    const receipt: AcceptedRunReceipt = {
      runId,
      ...(clientRunKey ? { clientRunKey } : {}),
      state: 'accepted',
      at
    }
    await this.queueReceipt(session, receipt)
    const state = { accepted: receipt }
    session.runs.set(runId, state)
    if (clientRunKey) session.clientRuns.set(clientRunKey, state)
  }

  async finishRun(
    session: PersistentSession,
    runId: string,
    status: RunCompletedPayload['status'],
    reason?: string
  ): Promise<void> {
    const state = session.runs.get(runId)
    if (!state) return
    const operation = session.receiptTail.then(async () => {
      // Shutdown and ordinary prompt completion can race. Select exactly one
      // authoritative terminal while holding the receipt tail serialization.
      if (state.terminal) return
      const at = new Date().toISOString()
      const receipt: TerminalRunReceipt = {
        runId,
        state: 'terminal',
        status,
        at,
        ...(reason ? { reason } : {})
      }
      await appendReceipt(session.receiptsPath, receipt)
      state.terminal = receipt
      session.manifest = {
        ...session.manifest,
        updatedAt: at,
        lastRun: { runId, status }
      }
      // The fsynced receipt is authoritative. A later open repairs a manifest if
      // the atomic summary publication is interrupted or temporarily unavailable.
      await writeManifestAtomic(session.manifestPath, session.manifest).catch(() => undefined)
    })
    session.receiptTail = operation.catch(() => undefined)
    await operation
  }

  private async recoverInterruptedRuns(session: PersistentSession): Promise<void> {
    for (const state of session.runs.values()) {
      if (state.terminal) continue
      await this.finishRun(
        session,
        state.accepted.runId,
        'unknown',
        'kernel exited before completion'
      )
    }
  }

  private async queueReceipt(session: PersistentSession, receipt: RunReceipt): Promise<void> {
    const operation = session.receiptTail.then(() => appendReceipt(session.receiptsPath, receipt))
    session.receiptTail = operation.catch(() => undefined)
    await operation
  }

  async close(sessionId: string): Promise<void> {
    const session = this.loaded.get(sessionId)
    if (!session) return
    this.loaded.delete(sessionId)
    await session.receiptTail
    await session.lock.release()
  }

  async abandonNew(sessionId: string): Promise<void> {
    const session = this.loaded.get(sessionId)
    if (!session) return
    this.loaded.delete(sessionId)
    await rm(session.directory, { recursive: true, force: true })
    await session.lock.release()
  }

  releaseAllSync(): void {
    for (const session of this.loaded.values()) session.lock.releaseSync()
    this.loaded.clear()
  }

  async list(): Promise<{ sessions: SessionListEntry[] }> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
        return []
      }
      throw error
    })
    const sessions = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && isKernelSessionId(entry.name))
        .map((entry) => this.listOne(entry.name))
    )
    sessions.sort((left, right) => {
      if ('error' in left || 'error' in right) return left.sessionId.localeCompare(right.sessionId)
      return right.updatedAt.localeCompare(left.updatedAt)
    })
    return { sessions }
  }

  private async repairListManifest(
    sessionId: string,
    paths: ReturnType<typeof kernelSessionPaths>
  ): Promise<SessionManifest> {
    const receipts = await readReceipts(paths.receipts)
    indexReceipts(receipts)
    let manifest: SessionManifest
    try {
      manifest = await readManifest(paths.manifest, sessionId)
    } catch {
      manifest = await reconstructManifest({
        sessionId,
        journalPath: paths.journal,
        receipts
      })
    }
    return reconcileManifestReceipts(manifest, receipts)
  }

  private async listOne(sessionId: string): Promise<SessionListEntry> {
    const loaded = this.loaded.get(sessionId)
    if (loaded) return summary(loaded, true)
    const paths = kernelSessionMigrationPaths(this.agentDir, sessionId)
    try {
      const migration = await readMigration(paths.migration)
      if (migration && migration.state !== 'complete') {
        return corrupt(sessionId, `session migration is incomplete at state ${migration.state}`)
      }
      const receipts = await readReceipts(paths.receipts)
      indexReceipts(receipts)
      let manifest: SessionManifest
      let needsRepair = false
      try {
        manifest = await readManifest(paths.manifest, sessionId)
      } catch {
        manifest = await reconstructManifest({ sessionId, journalPath: paths.journal, receipts })
        needsRepair = true
      }
      const reconciled = reconcileManifestReceipts(manifest, receipts)
      needsRepair ||= !sameLastRun(manifest, reconciled)
      if (needsRepair) {
        const lock = await this.acquireLock(sessionId, paths.lock)
        try {
          manifest = await this.repairListManifest(sessionId, paths)
          await writeManifestAtomic(paths.manifest, manifest)
        } finally {
          await lock.release()
        }
      } else {
        manifest = reconciled
      }
      return manifestSummary(manifest, false)
    } catch (error) {
      const message =
        error instanceof SessionWriterBusyError
          ? 'session metadata is corrupt or stale and the session is currently locked'
          : 'session metadata cannot be read or repaired'
      return corrupt(sessionId, message)
    }
  }
}
