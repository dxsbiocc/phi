import { persistOfficeOperationLog, type OfficeOperationLogState } from './office-operation-log'
import {
  markOfficeSaveFailed,
  markOfficeSaved,
  markOfficeSaving,
  persistedOfficeSaveStatus,
  type OfficeSaveStatus
} from './office-save-state'
import {
  assertOwnedOfficeDocumentActive,
  requireOwnedOfficeDocument
} from './office-service-guards'
import {
  OfficeServiceError,
  type OfficeServiceDependencies,
  type OwnedOfficeDocument
} from './office-service-state'
import type { OfficeWriteContext } from './office-write-contract'

export interface OfficeSavedFileVerification {
  readonly sha256: string
  readonly size: number
}

export interface OfficeSaveResult {
  readonly saved: true
  readonly revision: number
  readonly lastSavedAt: string
}

interface OfficeSaveFlowState {
  readonly dependencies: OfficeServiceDependencies
  readonly owned: ReadonlyMap<string, OwnedOfficeDocument>
  readonly closingArtifacts: ReadonlySet<string>
}

export class OfficeSaveFlow {
  private readonly inFlight = new Map<string, Promise<OfficeSaveResult>>()

  constructor(private readonly state: OfficeSaveFlowState) {}

  saveDocument(artifactId: string, sessionId: string): Promise<OfficeSaveResult> {
    const owned = requireOwnedOfficeDocument(
      this.state.owned,
      this.state.closingArtifacts,
      artifactId,
      sessionId
    )
    const existing = this.inFlight.get(artifactId)
    if (existing) return existing
    const promise = owned.operations
      .run((signal) => this.saveOwned(owned, sessionId, signal))
      .finally(() => {
        if (this.inFlight.get(artifactId) === promise) this.inFlight.delete(artifactId)
      })
    this.inFlight.set(artifactId, promise)
    return promise
  }

  private async saveOwned(
    owned: OwnedOfficeDocument,
    sessionId: string,
    signal: AbortSignal
  ): Promise<OfficeSaveResult> {
    this.assertSaveable(owned, sessionId)
    owned.saveStatus = markOfficeSaving(owned.saveStatus)
    try {
      const verified = await performVerifiedOfficeSave(this.state.dependencies, owned, signal)
      if (!verified) throw new Error('save verification unavailable')
      this.assertSaveable(owned, sessionId)
      const savedAt = (this.state.dependencies.now ?? (() => new Date()))().toISOString()
      const status = markOfficeSaved(owned.saveStatus, {
        revision: owned.contentRevision,
        savedAt,
        sha256: verified.sha256
      })
      await this.commit(owned, status, false)
      return saveResult(owned)
    } catch (error) {
      if (isSaveGuardError(error)) throw error
      owned.saveStatus = markOfficeSaveFailed(owned.saveStatus)
      owned.needsSave = true
      await this.persistFailure(owned)
      throw new OfficeServiceError('save_failed', 'Office 草稿保存失败，内容仍保留，可重试')
    }
  }

  private assertSaveable(owned: OwnedOfficeDocument, sessionId: string): void {
    assertOwnedOfficeDocumentActive(this.state.owned, this.state.closingArtifacts, owned, sessionId)
    if (owned.readOnly) throw new OfficeServiceError('document_read_only', '只读文档不能保存草稿')
    if (owned.freezeState === 'unknown') {
      throw new OfficeServiceError('document_frozen', '写入结果待核对，不能将其标记为已保存')
    }
  }

  private async commit(
    owned: OwnedOfficeDocument,
    status: OfficeSaveStatus,
    needsSave: boolean
  ): Promise<void> {
    const next = operationLogWithSaveStatus(owned.operationLog, status, needsSave)
    await (this.state.dependencies.persistOperationLog ?? persistOfficeOperationLog)(
      owned.document.draftPath,
      next
    )
    owned.operationLog = next
    owned.needsSave = needsSave
    owned.saveStatus = status
  }

  private async persistFailure(owned: OwnedOfficeDocument): Promise<void> {
    const next = operationLogWithSaveStatus(owned.operationLog, owned.saveStatus, true)
    try {
      await (this.state.dependencies.persistOperationLog ?? persistOfficeOperationLog)(
        owned.document.draftPath,
        next
      )
      owned.operationLog = next
    } catch {
      // The in-memory failure remains retryable even when its diagnostic cannot be persisted.
    }
  }
}

export async function performVerifiedOfficeSave(
  dependencies: OfficeServiceDependencies,
  owned: OwnedOfficeDocument,
  signal: AbortSignal
): Promise<OfficeSavedFileVerification | undefined> {
  await dependencies.saveDraft(writeContext(owned, signal))
  const verify = dependencies.verifySavedDraft
  if (!verify) return undefined
  const result = await verify(writeContext(owned, signal))
  if (!/^[a-f0-9]{64}$/u.test(result.sha256) || !Number.isSafeInteger(result.size)) {
    throw new Error('invalid save verification')
  }
  return result
}

export function operationLogWithSaveStatus(
  state: OfficeOperationLogState,
  status: OfficeSaveStatus,
  needsSave: boolean
): OfficeOperationLogState {
  return {
    version: state.version,
    contentRevision: state.contentRevision,
    operations: state.operations,
    ...(state.freezeState ? { freezeState: state.freezeState } : {}),
    ...(state.lastReconcile ? { lastReconcile: state.lastReconcile } : {}),
    ...(state.integrityError ? { integrityError: state.integrityError } : {}),
    ...(needsSave ? { needsSave: true } : {}),
    ...persistedOfficeSaveStatus(status)
  }
}

function saveResult(owned: OwnedOfficeDocument): OfficeSaveResult {
  return {
    saved: true,
    revision: owned.contentRevision,
    lastSavedAt: owned.saveStatus.lastSavedAt!
  }
}

function writeContext(owned: OwnedOfficeDocument, signal: AbortSignal): OfficeWriteContext {
  return { binaryPath: owned.binaryPath, draftPath: owned.document.draftPath, signal }
}

function isSaveGuardError(error: unknown): boolean {
  return error instanceof OfficeServiceError && error.code !== 'save_failed'
}
