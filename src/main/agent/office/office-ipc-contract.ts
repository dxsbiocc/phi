import type {
  OfficeCancelCreateInput,
  OfficeCancelImportInput,
  OfficeClearSelectionInput,
  OfficeCloseInput,
  OfficeCreateInput,
  OfficeCreateState,
  OfficeDocumentState,
  OfficeOpenInput,
  OfficeImportInput,
  OfficeImportState,
  OfficePreviewPreferencesInput,
  OfficePreviewDocument
} from '../../../shared/officeProtocol'
import { officeArtifactKind } from './office-document-kind'
import type { OfficeCreateStatus, OfficeDocumentStatus } from './office-service'
import type { OfficeImportStatus } from './office-service'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function requiredString(value: unknown, key: string): string | undefined {
  if (!isRecord(value) || Object.keys(value).some((name) => name !== key)) return undefined
  const field = value[key]
  return typeof field === 'string' && field.length > 0 && field.length <= 4096 ? field : undefined
}

export function openInput(value: unknown): OfficeOpenInput | undefined {
  if (!isRecord(value)) return undefined
  if (Object.keys(value).some((key) => key !== 'sourcePath' && key !== 'fresh')) return undefined
  const sourcePath = value.sourcePath
  if (typeof sourcePath !== 'string' || sourcePath.length === 0 || sourcePath.length > 4096) {
    return undefined
  }
  if (value.fresh !== undefined && typeof value.fresh !== 'boolean') return undefined
  return { sourcePath, ...(value.fresh === true ? { fresh: true } : {}) }
}

export function closeInput(value: unknown): OfficeCloseInput | undefined {
  if (!isRecord(value)) return undefined
  if (Object.keys(value).some((key) => key !== 'artifactId' && key !== 'sessionId')) {
    return undefined
  }
  const validId = (input: unknown): input is string =>
    typeof input === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(input)
  return validId(value.artifactId) && validId(value.sessionId)
    ? { artifactId: value.artifactId, sessionId: value.sessionId }
    : undefined
}

function requestIdInput(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) return undefined
  return value
}

function validBlankName(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  return (
    trimmed.length > 0 &&
    [...trimmed].length <= 64 &&
    !/[\\/]/.test(trimmed) &&
    !/\p{Cc}/u.test(trimmed) &&
    !trimmed.includes('..')
  )
}

export function createInput(value: unknown): OfficeCreateInput | undefined {
  if (!isRecord(value)) return undefined
  if (Object.keys(value).some((key) => !['requestId', 'kind', 'name'].includes(key))) {
    return undefined
  }
  const requestId = requestIdInput(value.requestId)
  if (!requestId) return undefined
  const kind = value.kind === undefined ? 'xlsx' : value.kind
  if (kind !== 'xlsx' && kind !== 'docx' && kind !== 'pptx') return undefined
  if (value.name === undefined) return { requestId, kind }
  return validBlankName(value.name) ? { requestId, kind, name: value.name.trim() } : undefined
}

export function cancelCreateInput(value: unknown): OfficeCancelCreateInput | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'requestId')) return undefined
  const requestId = requestIdInput(value.requestId)
  return requestId ? { requestId } : undefined
}

export function importInput(value: unknown): OfficeImportInput | undefined {
  if (!isRecord(value)) return undefined
  if (Object.keys(value).some((key) => !['requestId', 'sourcePath', 'format'].includes(key))) {
    return undefined
  }
  const requestId = requestIdInput(value.requestId)
  const sourcePath = value.sourcePath
  const format = value.format
  if (
    !requestId ||
    typeof sourcePath !== 'string' ||
    sourcePath.length === 0 ||
    sourcePath.length > 4096 ||
    (format !== 'csv' && format !== 'tsv')
  ) {
    return undefined
  }
  return { requestId, sourcePath, format }
}

export function cancelImportInput(value: unknown): OfficeCancelImportInput | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'requestId')) return undefined
  const requestId = requestIdInput(value.requestId)
  return requestId ? { requestId } : undefined
}

export function clearSelectionInput(value: unknown): OfficeClearSelectionInput | undefined {
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'artifactId')) return undefined
  return typeof value.artifactId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value.artifactId)
    ? { artifactId: value.artifactId }
    : undefined
}

export function previewPreferencesInput(value: unknown): OfficePreviewPreferencesInput | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['artifactId', 'visible', 'followAi'].includes(key)) ||
    typeof value.artifactId !== 'string' ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(value.artifactId) ||
    typeof value.visible !== 'boolean' ||
    typeof value.followAi !== 'boolean'
  ) {
    return undefined
  }
  return { artifactId: value.artifactId, visible: value.visible, followAi: value.followAi }
}

export function publicDocument(status: OfficeDocumentStatus): OfficeDocumentState {
  if (status.state !== 'ready') return status
  const kind = officeArtifactKind(status.document as unknown as Record<string, unknown>)
  const document: OfficePreviewDocument = {
    artifactId: status.document.artifactId,
    sessionId: status.document.sessionId,
    projectId: status.document.projectId,
    kind,
    humanEdit: kind === 'xlsx' ? 'cells' : 'none',
    ...(kind === 'xlsx' && status.document.previewState !== 'preview_failed'
      ? { followAiControllable: true }
      : {}),
    sourcePath:
      status.document.origin === 'import'
        ? status.document.draftPath
        : (status.document.sourcePath ?? status.document.draftPath),
    sourceHash: status.document.sourceHash,
    previewUrl: status.document.previewUrl,
    ...(status.document.previewState ? { previewState: status.document.previewState } : {}),
    ...(status.document.previewError ? { previewError: status.document.previewError } : {}),
    ...(status.document.slideCount === undefined ? {} : { slideCount: status.document.slideCount }),
    ...(status.document.origin === 'import'
      ? { importSource: { ...status.document.importSource } }
      : {}),
    readOnly: status.readOnly,
    saveState: status.saveState,
    lastSavedRevision: status.lastSavedRevision,
    ...(status.lastSavedAt ? { lastSavedAt: status.lastSavedAt } : {}),
    ...(status.restoreNotice ? { restoreNotice: status.restoreNotice } : {}),
    ...(status.freezeState ? { freezeState: status.freezeState } : {}),
    ...(status.needsSave ? { needsSave: true } : {}),
    ...(status.lastReconciliation ? { lastReconciliation: status.lastReconciliation } : {}),
    ...(status.lastHumanEdit
      ? {
          lastHumanEdit: {
            type: status.lastHumanEdit.type,
            conclusion: status.lastHumanEdit.conclusion,
            code: status.lastHumanEdit.code,
            message: status.lastHumanEdit.message
          }
        }
      : {})
  }
  return { state: 'ready', document }
}

export function publicCreation(status: OfficeCreateStatus): OfficeCreateState {
  return status.state === 'ready' ? (publicDocument(status) as OfficeCreateState) : status
}

export function publicImport(status: OfficeImportStatus): OfficeImportState {
  return status.state === 'ready' ? (publicDocument(status) as OfficeImportState) : status
}
