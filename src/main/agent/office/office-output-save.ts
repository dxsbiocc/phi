import { persistOfficeOperationLog } from './office-operation-log'
import { operationLogWithSaveStatus, performVerifiedOfficeSave } from './office-save'
import { OfficeSaveAsError } from './office-save-as-target'
import { markOfficeSaveFailed, markOfficeSaved, markOfficeSaving } from './office-save-state'
import type { OfficeSavedFileVerification } from './office-save'
import type { OfficeServiceDependencies, OwnedOfficeDocument } from './office-service-state'

interface FlushOwnedOfficeDocumentInput {
  readonly dependencies: OfficeServiceDependencies
  readonly owned: OwnedOfficeDocument
  readonly signal: AbortSignal
  readonly assertActive: () => void
}

export async function flushOwnedOfficeDocumentForOutput(
  input: FlushOwnedOfficeDocumentInput
): Promise<OfficeSavedFileVerification> {
  const { dependencies, owned, signal } = input
  owned.saveStatus = markOfficeSaving(owned.saveStatus)
  try {
    const verified = await performVerifiedOfficeSave(dependencies, owned, signal)
    if (!verified) throw new Error('save verification unavailable')
    input.assertActive()
    const savedAt = (dependencies.now ?? (() => new Date()))().toISOString()
    const status = markOfficeSaved(owned.saveStatus, {
      revision: owned.contentRevision,
      savedAt,
      sha256: verified.sha256
    })
    const next = operationLogWithSaveStatus(owned.operationLog, status, false)
    await (dependencies.persistOperationLog ?? persistOfficeOperationLog)(
      owned.document.draftPath,
      next
    )
    owned.operationLog = next
    owned.needsSave = false
    owned.saveStatus = status
    return verified
  } catch (error) {
    owned.needsSave = true
    owned.saveStatus = markOfficeSaveFailed(owned.saveStatus)
    throw error instanceof OfficeSaveAsError
      ? error
      : new OfficeSaveAsError('save_failed', 'Office 草稿刷盘失败')
  }
}
