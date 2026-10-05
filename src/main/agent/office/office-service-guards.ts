import type { OfficeReconcileConclusion } from './office-operation-log'
import type { OfficeDocumentStatus, OwnedOfficeDocument } from './office-service-state'
import { OfficeServiceError } from './office-service-state'
import { OfficeWriteError } from './office-write-contract'

export function requireOwnedOfficeDocument(
  ownedDocuments: ReadonlyMap<string, OwnedOfficeDocument>,
  closingArtifacts: ReadonlySet<string>,
  artifactId: string,
  sessionId?: string
): OwnedOfficeDocument {
  const owned = ownedDocuments.get(artifactId)
  if (!owned || closingArtifacts.has(artifactId)) {
    throw new OfficeServiceError('target_not_found', '关联的 Office 文档已不存在或已关闭')
  }
  if (sessionId && owned.document.sessionId !== sessionId) {
    throw new OfficeServiceError('target_session_mismatch', '关联的 Office 文档不属于当前会话')
  }
  return owned
}

export function assertOwnedOfficeDocumentActive(
  ownedDocuments: ReadonlyMap<string, OwnedOfficeDocument>,
  closingArtifacts: ReadonlySet<string>,
  expected: OwnedOfficeDocument,
  sessionId?: string
): void {
  const current = requireOwnedOfficeDocument(
    ownedDocuments,
    closingArtifacts,
    expected.document.artifactId,
    sessionId
  )
  if (current !== expected) {
    throw new OfficeWriteError('reconcile_failed', '核对目标已经变化，文档继续冻结')
  }
}

export function assertOwnedOfficeDocumentWritable(owned: OwnedOfficeDocument): void {
  if (owned.readOnly) {
    throw new OfficeWriteError('document_read_only', '该文档为只读，不能编辑')
  }
  if (owned.freezeState === 'unknown') {
    throw new OfficeWriteError(
      'document_frozen',
      '该文档有待核对的写入结果，已尝试自动核对；请告知用户在右侧面板点击“重新核对”，不要重复写入'
    )
  }
}

export function assertOwnedOfficeDocumentDeliverable(owned: OwnedOfficeDocument): void {
  if (owned.freezeState === 'unknown' || owned.needsSave) {
    throw new OfficeServiceError('document_not_deliverable', 'Office 草稿尚未达到可交付状态')
  }
}

export function readyOfficeDocumentStatus(owned: OwnedOfficeDocument): OfficeDocumentStatus {
  const last = owned.operationLog.lastReconcile
  return {
    state: 'ready',
    document: owned.document,
    readOnly: owned.readOnly,
    saveState: owned.saveStatus.saveState,
    lastSavedRevision: owned.saveStatus.lastSavedRevision,
    ...(owned.saveStatus.lastSavedAt ? { lastSavedAt: owned.saveStatus.lastSavedAt } : {}),
    ...(owned.restoreNotice ? { restoreNotice: owned.restoreNotice } : {}),
    ...(owned.freezeState ? { freezeState: owned.freezeState } : {}),
    ...(owned.needsSave ? { needsSave: true } : {}),
    ...(owned.lastHumanEdit ? { lastHumanEdit: owned.lastHumanEdit } : {}),
    ...(last
      ? {
          lastReconciliation: {
            conclusion: last.conclusion,
            message: reconciliationMessage(last.conclusion, last.reason)
          }
        }
      : {})
  }
}

function reconciliationMessage(conclusion: OfficeReconcileConclusion, reason?: string): string {
  if (reason) return reason
  if (conclusion === 'applied') return '已核对：写入已生效'
  if (conclusion === 'applied_no_change') return '已核对：内容原本已是预期值'
  if (conclusion === 'not_applied') return '已核对：写入未生效，可使用新的操作重试'
  return '无法确认写入结果，文档继续冻结'
}
