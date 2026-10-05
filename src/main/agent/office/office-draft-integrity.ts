import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'

import {
  MAX_OFFICE_FILE_BYTES,
  type OfficeArtifact,
  OfficeFileError,
  validateRegisteredOfficeDraft
} from './office-files'
import { officeArtifactKind } from './office-document-kind'
import { officeKindAdapter } from './office-kind-adapters'
import {
  loadOfficeOperationLog,
  persistOfficeOperationLog,
  type OfficeOperationLogState
} from './office-operation-log'

export type OfficeDraftIntegrityIssue = 'draft_hash_mismatch' | 'operation_log_corrupt'

export interface OfficeDraftIntegrityResult {
  readonly operationLog: OfficeOperationLogState
  readonly issue?: OfficeDraftIntegrityIssue
}

interface OfficeDraftIntegrityDependencies {
  readonly loadOperationLog?: typeof loadOfficeOperationLog
  readonly persistOperationLog?: typeof persistOfficeOperationLog
  readonly confirmedHashBeforeClose?: string
}

export class OfficeDraftIntegrityError extends Error {
  constructor(
    readonly code:
      'draft_missing' | 'draft_corrupt' | 'draft_too_large' | 'draft_identity_mismatch',
    message: string,
    readonly canRecreateFromSource: boolean,
    options?: ErrorOptions & { readonly recreateSourcePath?: string }
  ) {
    super(message, options)
    this.name = 'OfficeDraftIntegrityError'
    this.recreateSourcePath = options?.recreateSourcePath
  }

  readonly recreateSourcePath?: string
}

function canRecreate(artifact: OfficeArtifact): boolean {
  return artifact.origin !== 'blank' && artifact.origin !== 'import'
}

function recreationOptions(
  artifact: OfficeArtifact,
  cause: unknown
): ErrorOptions & { readonly recreateSourcePath?: string } {
  return {
    cause,
    ...(canRecreate(artifact) && typeof artifact.sourcePath === 'string'
      ? { recreateSourcePath: artifact.sourcePath }
      : {})
  }
}

async function assertRegisteredIdentity(artifact: OfficeArtifact): Promise<void> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(join(dirname(artifact.draftPath), 'artifact.json'), 'utf8'))
  } catch (error) {
    throw new OfficeDraftIntegrityError(
      'draft_identity_mismatch',
      'Office 草稿登记记录无效',
      canRecreate(artifact),
      recreationOptions(artifact, error)
    )
  }
  const record = value as Record<string, unknown>
  const matches =
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    record.artifactId === artifact.artifactId &&
    record.sessionId === artifact.sessionId &&
    record.projectId === artifact.projectId &&
    officeArtifactKind(record) ===
      officeArtifactKind(artifact as unknown as Record<string, unknown>) &&
    record.draftPath === artifact.draftPath &&
    record.sourcePath === artifact.sourcePath &&
    record.sourceHash === artifact.sourceHash
  if (!matches) {
    throw new OfficeDraftIntegrityError(
      'draft_identity_mismatch',
      'Office 草稿登记身份与路径不一致',
      canRecreate(artifact)
    )
  }
}

async function draftBytes(artifact: OfficeArtifact): Promise<Buffer> {
  try {
    const details = await stat(artifact.draftPath)
    if (details.size > MAX_OFFICE_FILE_BYTES) throw draftTooLargeError(artifact)
    const bytes = await readFile(artifact.draftPath)
    if (bytes.length > MAX_OFFICE_FILE_BYTES) throw draftTooLargeError(artifact)
    const kind = officeArtifactKind(artifact as unknown as Record<string, unknown>)
    officeKindAdapter(kind).assertPackage(bytes)
    return bytes
  } catch (error) {
    if (error instanceof OfficeDraftIntegrityError) throw error
    const code = (error as NodeJS.ErrnoException).code
    throw new OfficeDraftIntegrityError(
      code === 'ENOENT' || code === 'ENOTDIR' ? 'draft_missing' : 'draft_corrupt',
      code === 'ENOENT' || code === 'ENOTDIR'
        ? 'Office 草稿文件已丢失，可从原文件重新创建'
        : 'Office 草稿文件已损坏，可从原文件重新创建',
      canRecreate(artifact),
      recreationOptions(artifact, error)
    )
  }
}

function draftTooLargeError(artifact: OfficeArtifact): OfficeDraftIntegrityError {
  return new OfficeDraftIntegrityError(
    'draft_too_large',
    'Office 草稿超过 25 MB 上限，可从原文件重新创建',
    canRecreate(artifact),
    recreationOptions(artifact, new Error('draft too large'))
  )
}

function hashMismatch(log: OfficeOperationLogState, hash: string): boolean {
  return log.saveState === 'saved' && Boolean(log.savedDraftHash) && log.savedDraftHash !== hash
}

function hasInFlightOperation(log: OfficeOperationLogState): boolean {
  return Object.values(log.operations).some((operation) => operation.status === 'in_flight')
}

export async function officeDraftFileHash(draftPath: string): Promise<string> {
  return createHash('sha256')
    .update(await readFile(draftPath))
    .digest('hex')
}

export async function recordConfirmedOfficeDraftHashAfterClose(draftPath: string): Promise<void> {
  const operationLog = await loadOfficeOperationLog(draftPath)
  if (
    operationLog.integrityError ||
    operationLog.saveState !== 'saved' ||
    !operationLog.savedDraftHash ||
    hasInFlightOperation(operationLog)
  ) {
    return
  }
  const savedDraftHash = await officeDraftFileHash(draftPath)
  if (savedDraftHash === operationLog.savedDraftHash) return
  await persistOfficeOperationLog(draftPath, { ...operationLog, savedDraftHash })
}

async function validateDraftLocation(artifact: OfficeArtifact, sessionId: string): Promise<void> {
  try {
    await validateRegisteredOfficeDraft(artifact, sessionId)
  } catch (error) {
    if (!(error instanceof OfficeFileError) || error.code !== 'draft_not_found') throw error
    throw new OfficeDraftIntegrityError(
      'draft_missing',
      'Office 草稿文件已丢失，可从原文件重新创建',
      canRecreate(artifact),
      recreationOptions(artifact, error)
    )
  }
}

async function resolveHashMismatch(
  artifact: OfficeArtifact,
  operationLog: OfficeOperationLogState,
  hash: string,
  dependencies: OfficeDraftIntegrityDependencies
): Promise<OfficeDraftIntegrityResult> {
  const persist = dependencies.persistOperationLog ?? persistOfficeOperationLog
  if (
    dependencies.confirmedHashBeforeClose === operationLog.savedDraftHash &&
    !hasInFlightOperation(operationLog)
  ) {
    const stabilized = { ...operationLog, savedDraftHash: hash }
    await persist(artifact.draftPath, stabilized)
    return { operationLog: stabilized }
  }
  const frozen = {
    ...operationLog,
    freezeState: 'unknown' as const,
    needsSave: true,
    lastReconcile: {
      conclusion: 'indeterminate' as const,
      at: new Date().toISOString(),
      reason: '草稿文件与最后一次确认保存的内容不一致，需要核对',
      revision: operationLog.contentRevision
    }
  }
  await persist(artifact.draftPath, frozen)
  return { operationLog: frozen, issue: 'draft_hash_mismatch' }
}

export async function checkRegisteredOfficeDraftIntegrity(
  artifact: OfficeArtifact,
  sessionId: string,
  dependencies: OfficeDraftIntegrityDependencies = {}
): Promise<OfficeDraftIntegrityResult> {
  await assertRegisteredIdentity(artifact)
  await validateDraftLocation(artifact, sessionId)
  const bytes = await draftBytes(artifact)
  const load = dependencies.loadOperationLog ?? loadOfficeOperationLog
  const operationLog = await load(artifact.draftPath)
  if (operationLog.integrityError) {
    return { operationLog, issue: 'operation_log_corrupt' }
  }
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (!hashMismatch(operationLog, hash)) return { operationLog }
  return resolveHashMismatch(artifact, operationLog, hash, dependencies)
}
