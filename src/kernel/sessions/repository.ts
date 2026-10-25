import { randomUUID } from 'node:crypto'
import { open, readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'

import type {
  RunCompletedPayload,
  SessionCreateParams,
  SessionListEntry
} from '../../shared/kernel-protocol'
import { kernelSessionPaths, kernelSessionsRoot, isKernelSessionId } from './paths'
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

export class KernelSessionRepository {
  private readonly root: string
  private readonly loaded = new Map<string, PersistentSession>()
  private readonly opening = new Map<string, Promise<PersistentSession>>()

  constructor(
    private readonly agentDir: string,
    private readonly kernelInstanceId: string = randomUUID(),
    private readonly acquireGuard?: AcquireProcessLockGuard,
    private readonly processStartedAt?: string
  ) {
    this.root = kernelSessionsRoot(agentDir)
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
      cwd: params.cwd,
      createdAt: now,
      updatedAt: now,
      model: { ...params.model },
      ...(params.thinkingLevel ? { thinkingLevel: params.thinkingLevel } : {}),
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

  private async openLocked(sessionId: string): Promise<PersistentSession> {
    const paths = kernelSessionPaths(this.agentDir, sessionId)
    const lock = await this.acquireLock(sessionId, paths.lock)
    try {
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
      this.loaded.set(sessionId, session)
      return session
    } catch (error) {
      await lock.release()
      throw error
    }
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
    if (!state || state.terminal) return
    const at = new Date().toISOString()
    const receipt: TerminalRunReceipt = {
      runId,
      state: 'terminal',
      status,
      at,
      ...(reason ? { reason } : {})
    }
    await this.queueReceipt(session, receipt)
    state.terminal = receipt
    session.manifest = {
      ...session.manifest,
      updatedAt: at,
      lastRun: { runId, status }
    }
    // The fsynced receipt is authoritative. A later open repairs a manifest if
    // the atomic summary publication is interrupted or temporarily unavailable.
    await writeManifestAtomic(session.manifestPath, session.manifest).catch(() => undefined)
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

  private async listOne(sessionId: string): Promise<SessionListEntry> {
    const loaded = this.loaded.get(sessionId)
    if (loaded) return summary(loaded, true)
    const paths = kernelSessionPaths(this.agentDir, sessionId)
    try {
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
          const currentReceipts = await readReceipts(paths.receipts)
          indexReceipts(currentReceipts)
          let currentManifest: SessionManifest
          try {
            currentManifest = await readManifest(paths.manifest, sessionId)
          } catch {
            currentManifest = await reconstructManifest({
              sessionId,
              journalPath: paths.journal,
              receipts: currentReceipts
            })
          }
          manifest = reconcileManifestReceipts(currentManifest, currentReceipts)
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
