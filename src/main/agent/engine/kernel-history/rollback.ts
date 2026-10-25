import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { copyFile, link, lstat, open, readFile, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

import { readManifestFile, writeManifestFile } from '../../session/manifest-file'
import type { PhiSessionManifest } from '../../session/session-store'
import { assertRegularFile, isMissingFile, syncDirectory } from './atomic-file'
import { readOmpJournalHeader } from './journal-header'
import {
  readKernelOwner,
  removeKernelOwner,
  writeKernelOwner,
  type KernelOwnerRecord,
  type KernelRollbackProgress,
  type RollbackProgressState
} from './ownership'

export interface RollbackCompatibilityInputs {
  readonly kernelSdkVersion: string
  readonly oldAppSdkVersion: string
  readonly oldAppJournalVersion: number
}

export type RollbackPauseStep =
  'state-started' | 'journal-exported' | 'manifest-backed-up' | 'manifest-repointed'

export interface RollbackAdoptedSessionInput {
  readonly phiSessionDirectory: string
  readonly originalRuntimeSessionPath: string
  readonly kernelJournalPath: string
  readonly compatibility: RollbackCompatibilityInputs
  readonly now?: () => Date
  /** Fault-injection seam. Production callers omit it. */
  readonly afterStep?: (step: RollbackPauseStep) => void | Promise<void>
}

export type RollbackAdoptedSessionResult =
  | {
      readonly status: 'rolled-back'
      readonly exportPath: string
      readonly resumed: boolean
      readonly alreadyComplete: boolean
    }
  | {
      readonly status: 'incompatible'
      readonly reason: string
    }

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

async function fileSha256(path: string): Promise<string> {
  return sha256(await readFile(path))
}

async function assertRollbackBinding(
  input: RollbackAdoptedSessionInput,
  owner: KernelOwnerRecord,
  manifest: PhiSessionManifest
): Promise<void> {
  const expectedKernelJournal = join(
    owner.runtimeRoot,
    'phi-kernel',
    'sessions',
    owner.kernelSessionId,
    'journal.jsonl'
  )
  if (resolve(input.kernelJournalPath) !== resolve(expectedKernelJournal)) {
    throw new Error('Kernel journal path does not match the recorded owner')
  }
  const allowedManifestPaths = new Set([
    resolve(input.originalRuntimeSessionPath),
    ...(owner.rollback ? [resolve(owner.rollback.exportPath)] : [])
  ])
  if (
    manifest.runtimeSessionPath &&
    !allowedManifestPaths.has(resolve(manifest.runtimeSessionPath))
  ) {
    throw new Error('Phi manifest runtime path does not match the rollback source')
  }
  if (!manifest.runtimeSessionPath && !manifest.runtimeRef) {
    throw new Error('Phi manifest has no adopted runtime identity')
  }

  await assertRegularFile(input.originalRuntimeSessionPath)
  if ((await fileSha256(input.originalRuntimeSessionPath)) !== owner.sourceSha256) {
    throw new Error('Original journal hash does not match the recorded owner')
  }
  const [originalHeader, kernelHeader] = await Promise.all([
    readOmpJournalHeader(input.originalRuntimeSessionPath),
    readOmpJournalHeader(input.kernelJournalPath)
  ])
  if (
    originalHeader.id !== kernelHeader.id ||
    originalHeader.cwd !== kernelHeader.cwd ||
    originalHeader.version !== kernelHeader.version
  ) {
    throw new Error('Kernel journal identity does not match the adopted source')
  }
}

async function rawManifest(phiSessionDirectory: string): Promise<{
  bytes: Buffer
  manifest: PhiSessionManifest
}> {
  const path = join(phiSessionDirectory, 'manifest.json')
  const bytes = await readFile(path)
  const candidate = JSON.parse(bytes.toString('utf8')) as { sessionId?: unknown }
  if (typeof candidate.sessionId !== 'string' || !candidate.sessionId) {
    throw new Error('Phi session manifest has no identity')
  }
  return { bytes, manifest: readManifestFile(path, candidate.sessionId) }
}

function rollbackTimestamp(date: Date): string {
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid rollback timestamp')
  return date.toISOString().replace(/[-:.]/gu, '')
}

function exportedPath(original: string, date: Date): string {
  return `${original}.kernel-${rollbackTimestamp(date)}.jsonl`
}

function completedExportPath(
  manifest: PhiSessionManifest,
  originalRuntimeSessionPath: string
): string | undefined {
  const path = manifest.runtimeSessionPath
  const prefix = `${originalRuntimeSessionPath}.kernel-`
  return path?.startsWith(prefix) && path.endsWith('.jsonl') ? path : undefined
}

function rollbackManifest(
  manifest: PhiSessionManifest,
  runtimeSessionPath: string,
  updatedAt: string
): PhiSessionManifest {
  const document: Record<string, unknown> = {
    ...manifest,
    runtimeSessionPath,
    updatedAt
  }
  delete document.runtimeRef
  delete document.runtimeRecoveryError
  delete document.remoteRuntime
  return document as unknown as PhiSessionManifest
}

async function existingFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path)
    return info.isFile() && !info.isSymbolicLink()
  } catch (error) {
    if (isMissingFile(error)) return false
    throw error
  }
}

async function copyExclusiveAtomic(source: string, target: string): Promise<void> {
  await assertRegularFile(source)
  if (await existingFile(target)) return
  const temporary = `${target}.tmp.${process.pid}.${randomUUID()}`
  try {
    await copyFile(source, temporary, constants.COPYFILE_EXCL)
    const handle = await open(temporary, 'r')
    try {
      await handle.sync()
    } finally {
      await handle.close()
    }
    await link(temporary, target)
    await syncDirectory(dirname(target))
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined)
  }
}

async function updateProgress(
  phiSessionDirectory: string,
  owner: KernelOwnerRecord,
  progress: KernelRollbackProgress,
  state: RollbackProgressState
): Promise<KernelOwnerRecord> {
  const next: KernelOwnerRecord = {
    ...owner,
    readOnly: true,
    reason: 'rollback in progress',
    rollback: { ...progress, state }
  }
  await writeKernelOwner(phiSessionDirectory, next)
  return next
}

function incompatibilityReason(
  headerVersion: number | undefined,
  compatibility: RollbackCompatibilityInputs
): string | undefined {
  if (compatibility.kernelSdkVersion !== compatibility.oldAppSdkVersion) {
    return `rollback incompatible: SDK ${compatibility.kernelSdkVersion} does not match old app SDK ${compatibility.oldAppSdkVersion}`
  }
  if (headerVersion !== compatibility.oldAppJournalVersion) {
    return `rollback incompatible: journal version ${String(headerVersion)} does not match old app journal version ${compatibility.oldAppJournalVersion}`
  }
  return undefined
}

async function verifyOrCopy(source: string, target: string, expectedHash: string): Promise<void> {
  if (await existingFile(target)) {
    if ((await fileSha256(target)) !== expectedHash) {
      throw new Error(`Rollback target already exists with different content: ${target}`)
    }
    return
  }
  await copyExclusiveAtomic(source, target)
  if ((await fileSha256(target)) !== expectedHash) {
    throw new Error(`Rollback copy verification failed: ${target}`)
  }
}

interface ActiveRollback {
  readonly owner: KernelOwnerRecord
  readonly progress: KernelRollbackProgress
}

async function completedRollback(
  input: RollbackAdoptedSessionInput,
  manifest: PhiSessionManifest
): Promise<RollbackAdoptedSessionResult> {
  const exportPath = completedExportPath(manifest, input.originalRuntimeSessionPath)
  if (!exportPath || !(await existingFile(exportPath))) {
    throw new Error('Session is not owned by the kernel and has not completed rollback')
  }
  return { status: 'rolled-back', exportPath, resumed: true, alreadyComplete: true }
}

async function startRollback(
  input: RollbackAdoptedSessionInput,
  owner: KernelOwnerRecord,
  manifestBytes: Buffer
): Promise<ActiveRollback> {
  const recorded = owner.rollback
  if (recorded && recorded.originalRuntimeSessionPath !== input.originalRuntimeSessionPath) {
    throw new Error('Rollback source path differs from the recorded rollback')
  }
  if (recorded) return { owner, progress: recorded }
  const startedAt = (input.now ?? (() => new Date()))().toISOString()
  const progress: KernelRollbackProgress = {
    state: 'started',
    originalRuntimeSessionPath: input.originalRuntimeSessionPath,
    exportPath: exportedPath(input.originalRuntimeSessionPath, new Date(startedAt)),
    originalManifestSha256: sha256(manifestBytes),
    startedAt
  }
  const nextOwner = await updateProgress(input.phiSessionDirectory, owner, progress, 'started')
  await input.afterStep?.('state-started')
  return { owner: nextOwner, progress }
}

async function exportJournal(
  input: RollbackAdoptedSessionInput,
  active: ActiveRollback,
  kernelHash: string
): Promise<ActiveRollback> {
  if (active.progress.state !== 'started') {
    if ((await fileSha256(active.progress.exportPath)) !== kernelHash) {
      throw new Error('Kernel journal changed after rollback export')
    }
    return active
  }
  await verifyOrCopy(input.kernelJournalPath, active.progress.exportPath, kernelHash)
  if ((await fileSha256(input.kernelJournalPath)) !== kernelHash) {
    throw new Error('Kernel journal changed while it was being exported')
  }
  const owner = await updateProgress(
    input.phiSessionDirectory,
    active.owner,
    active.progress,
    'exported'
  )
  await input.afterStep?.('journal-exported')
  return { owner, progress: owner.rollback as KernelRollbackProgress }
}

async function backupManifest(
  input: RollbackAdoptedSessionInput,
  active: ActiveRollback
): Promise<ActiveRollback> {
  const backupPath = join(input.phiSessionDirectory, 'manifest.json.pre-rollback')
  if (active.progress.state !== 'exported') {
    if ((await fileSha256(backupPath)) !== active.progress.originalManifestSha256) {
      throw new Error('Rollback manifest backup does not match its recorded source')
    }
    return active
  }
  const current = await rawManifest(input.phiSessionDirectory)
  if (sha256(current.bytes) !== active.progress.originalManifestSha256) {
    throw new Error('Phi session manifest changed during rollback')
  }
  await verifyOrCopy(
    join(input.phiSessionDirectory, 'manifest.json'),
    backupPath,
    active.progress.originalManifestSha256
  )
  const owner = await updateProgress(
    input.phiSessionDirectory,
    active.owner,
    active.progress,
    'manifest-backed-up'
  )
  await input.afterStep?.('manifest-backed-up')
  return { owner, progress: owner.rollback as KernelRollbackProgress }
}

async function publishManifest(
  input: RollbackAdoptedSessionInput,
  active: ActiveRollback
): Promise<ActiveRollback> {
  if (active.progress.state !== 'manifest-backed-up') return active
  const current = await rawManifest(input.phiSessionDirectory)
  if (current.manifest.runtimeSessionPath !== active.progress.exportPath) {
    if (sha256(current.bytes) !== active.progress.originalManifestSha256) {
      throw new Error('Phi session manifest changed before rollback publication')
    }
    const next = rollbackManifest(
      current.manifest,
      active.progress.exportPath,
      (input.now ?? (() => new Date()))().toISOString()
    )
    writeManifestFile(input.phiSessionDirectory, next)
  }
  await input.afterStep?.('manifest-repointed')
  const owner = await updateProgress(
    input.phiSessionDirectory,
    active.owner,
    active.progress,
    'manifest-repointed'
  )
  return { owner, progress: owner.rollback as KernelRollbackProgress }
}

async function finishRollback(
  input: RollbackAdoptedSessionInput,
  active: ActiveRollback,
  resumed: boolean
): Promise<RollbackAdoptedSessionResult> {
  if (active.progress.state !== 'manifest-repointed') {
    throw new Error('Rollback did not reach its terminal publication state')
  }
  const finalManifest = await rawManifest(input.phiSessionDirectory)
  const exported = await existingFile(active.progress.exportPath)
  const sameSize =
    exported &&
    (await stat(active.progress.exportPath)).size === (await stat(input.kernelJournalPath)).size
  if (finalManifest.manifest.runtimeSessionPath !== active.progress.exportPath || !sameSize) {
    throw new Error('Rollback publication could not be verified')
  }
  await removeKernelOwner(input.phiSessionDirectory)
  await syncDirectory(input.phiSessionDirectory)
  return {
    status: 'rolled-back',
    exportPath: active.progress.exportPath,
    resumed,
    alreadyComplete: false
  }
}

export async function rollbackAdoptedSession(
  input: RollbackAdoptedSessionInput
): Promise<RollbackAdoptedSessionResult> {
  const initial = await rawManifest(input.phiSessionDirectory)
  const owner = await readKernelOwner(input.phiSessionDirectory)
  if (!owner) return completedRollback(input, initial.manifest)

  await assertRegularFile(input.kernelJournalPath)
  await assertRollbackBinding(input, owner, initial.manifest)
  const header = await readOmpJournalHeader(input.kernelJournalPath)
  const incompatible = incompatibilityReason(header.version, input.compatibility)
  if (incompatible) {
    await writeKernelOwner(input.phiSessionDirectory, {
      ...owner,
      readOnly: true,
      reason: incompatible
    })
    return { status: 'incompatible', reason: incompatible }
  }

  const resumed = Boolean(owner.rollback)
  let active = await startRollback(input, owner, initial.bytes)
  active = await exportJournal(input, active, await fileSha256(input.kernelJournalPath))
  active = await backupManifest(input, active)
  active = await publishManifest(input, active)
  return finishRollback(input, active, resumed)
}
