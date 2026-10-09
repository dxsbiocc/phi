import type {
  CreateBlankOfficeDraftInput,
  CreateOfficeDraftInput,
  OfficeArtifact,
  OfficeBlankArtifact,
  OfficeCreatedArtifact,
  OfficeImportedArtifact
} from './office-files'
import type { CreateImportedOfficeDraftInput } from './office-import-files'
import type { OfficeImportExecutionControl } from './office-import-contract'
import type { OfficeRuntimeStatus } from './office-runtime'
import type { OfficeResolvedSelection } from './office-selection-resolver'
import type {
  OfficeReadCell,
  OfficeReadContext,
  OfficeReadParams,
  OfficeReadResponse
} from './office-read-contract'
import type { OfficeDocxReadResult } from './office-docx-read'
import type { OfficePptxReadResult } from './office-pptx-read'
import type {
  OfficeDocxBefore,
  OfficeDocxOperation,
  OfficeDocxSnapshot,
  OfficeDocxWriteReceipt
} from './office-docx-contract'
import type {
  OfficePptxBefore,
  OfficePptxOperation,
  OfficePptxSnapshot,
  OfficePptxWriteReceipt
} from './office-pptx-contract'
import type { OfficeDocumentOperationQueue } from './office-operation-queue'
import type { OfficeOperationLogState } from './office-operation-log'
import type { OfficeReconcileResult } from './office-reconcile'
import type {
  OfficeCellEditParams,
  OfficePreviewConfirmation,
  OfficeWriteContext,
  OfficeWriteOperation
} from './office-write-contract'
import type { OfficeHumanEditSummary } from './office-human-edit-status'
import type { OfficeSaveStatus } from './office-save-state'
import type { OfficeSavedFileVerification } from './office-save'
import type { OfficeOutputLogState } from './office-output-log'
import type { OfficeDraftResolution } from './office-draft-registry'
import type { OfficeDraftIntegrityResult } from './office-draft-integrity'
import type { OfficeResidentHealthState } from './office-resident-health'
import type { OfficeDeliveryCheckInput, OfficeDeliveryCheckResult } from './office-deliver-checks'

export type OfficeOpenRequest = CreateOfficeDraftInput & { readonly fresh?: boolean }
export interface OfficeCreateRequest extends CreateBlankOfficeDraftInput {
  requestId: string
}
export interface OfficeImportRequest extends CreateImportedOfficeDraftInput {
  requestId: string
}

export interface OfficeProcessOwnership {
  residentPid: number
}

export interface OfficePreviewOwnership {
  watchPid: number
  watchPort: number
  gatewayPort: number
  previewUrl: string
  previewState?: 'ready' | 'preview_failed'
  previewError?: string
  slideCount?: number
}

export type OfficeRestoreNotice =
  | { readonly kind: 'recovered'; readonly hasUnsavedChanges: boolean }
  | { readonly kind: 'source_changed' }
  | { readonly kind: 'draft_hash_mismatch' }
  | { readonly kind: 'operation_log_corrupt' }

export type OfficeDocumentStatus =
  | { state: 'preparing'; sourcePath: string }
  | {
      state: 'ready'
      document: OfficeArtifact & OfficeProcessOwnership & OfficePreviewOwnership
      freezeState?: 'unknown'
      readOnly: boolean
      needsSave?: boolean
      saveState: OfficeSaveStatus['saveState']
      lastSavedRevision: number
      lastSavedAt?: string
      restoreNotice?: OfficeRestoreNotice
      lastReconciliation?: Pick<OfficeReconcileResult, 'conclusion' | 'message'>
      lastHumanEdit?: OfficeHumanEditSummary
    }
  | {
      state: 'error'
      sourcePath: string
      code: string
      message: string
      canRecreateFromSource?: boolean
      freshSourcePath?: string
    }

export type OfficeCreateStatus =
  | { state: 'preparing'; requestId: string }
  | {
      state: 'ready'
      document: OfficeBlankArtifact & OfficeProcessOwnership & OfficePreviewOwnership
      readOnly: boolean
      freezeState?: 'unknown'
      needsSave?: boolean
      saveState: OfficeSaveStatus['saveState']
      lastSavedRevision: number
      lastSavedAt?: string
    }
  | { state: 'error'; requestId: string; code: string; message: string }

export type OfficeImportStatus =
  | { state: 'preparing'; requestId: string }
  | {
      state: 'ready'
      document: OfficeImportedArtifact & OfficeProcessOwnership & OfficePreviewOwnership
      readOnly: boolean
      freezeState?: 'unknown'
      needsSave?: boolean
      saveState: OfficeSaveStatus['saveState']
      lastSavedRevision: number
      lastSavedAt?: string
    }
  | { state: 'error'; requestId: string; code: string; message: string }

export interface OfficeServiceDependencies {
  detectRuntime: () => Promise<OfficeRuntimeStatus>
  prepareDraft: (request: OfficeOpenRequest, binaryPath: string) => Promise<OfficeArtifact>
  prepareBlankDraft: (
    request: OfficeCreateRequest,
    binaryPath: string
  ) => Promise<OfficeBlankArtifact>
  prepareImportedDraft?: (
    request: OfficeImportRequest,
    binaryPath: string,
    control: OfficeImportExecutionControl
  ) => Promise<OfficeImportedArtifact>
  forceTerminateImportedDraft?: (draftPath: string, knownPids: readonly number[]) => Promise<void>
  startDocument: (binaryPath: string, artifact: OfficeArtifact) => Promise<OfficeProcessOwnership>
  adoptCreatedDocument: (
    binaryPath: string,
    artifact: OfficeCreatedArtifact
  ) => Promise<OfficeProcessOwnership>
  startPreview: (binaryPath: string, artifact: OfficeArtifact) => Promise<OfficePreviewOwnership>
  stopPreview: (document: OfficeArtifact & Partial<OfficePreviewOwnership>) => Promise<void>
  closeDocument: (
    binaryPath: string,
    artifact: OfficeArtifact & OfficeProcessOwnership
  ) => Promise<void>
  removeBlankDraft: (artifact: OfficeBlankArtifact) => Promise<void>
  removeCreatedDraft?: (artifact: OfficeCreatedArtifact) => Promise<void>
  validateRegisteredDraft: (artifact: OfficeArtifact) => Promise<void>
  prepareRegisteredDraftForOpen?: (
    binaryPath: string,
    artifact: OfficeArtifact
  ) => Promise<OfficeDraftIntegrityResult>
  recordClosedDraftHash?: (artifact: OfficeArtifact) => Promise<void>
  resolveRegisteredDraft?: (request: OfficeOpenRequest) => Promise<OfficeDraftResolution>
  resolveRegisteredDraftByArtifactId?: (
    sessionId: string,
    artifactId: string
  ) => Promise<OfficeArtifact | undefined>
  assertNotOfficeArtifactPath: (path: string) => Promise<void>
  resolveSelection: (
    binaryPath: string,
    draftPath: string
  ) => Promise<OfficeResolvedSelection | null>
  clearSelection: (watchPort: number) => Promise<void>
  readRange: (context: OfficeReadContext, params: OfficeReadParams) => Promise<OfficeReadResponse>
  readExportRange?: (
    context: OfficeReadContext,
    sheet: string,
    range: string
  ) => Promise<readonly OfficeReadCell[]>
  readParagraphs?: (
    context: OfficeReadContext,
    params: OfficeReadParams
  ) => Promise<OfficeDocxReadResult>
  readSlides?: (
    context: OfficeReadContext,
    params: OfficeReadParams
  ) => Promise<OfficePptxReadResult>
  readWorkbookSnapshot?: (
    context: OfficeWriteContext,
    addedSheet?: string
  ) => Promise<import('./office-write-contract').OfficeWriteSnapshot>
  applyCellValue: (context: OfficeWriteContext, params: OfficeCellEditParams) => Promise<void>
  applyWriteOperation?: (
    context: OfficeWriteContext,
    operation: OfficeWriteOperation
  ) => Promise<void>
  restoreWriteOperation?: (
    context: OfficeWriteContext,
    operation: OfficeWriteOperation,
    before: import('./office-write-contract').OfficeWriteBefore
  ) => Promise<void>
  readDocxSnapshot?: (context: OfficeWriteContext) => Promise<OfficeDocxSnapshot>
  applyDocxOperation?: (
    context: OfficeWriteContext,
    operation: OfficeDocxOperation,
    snapshot: OfficeDocxSnapshot
  ) => Promise<OfficeDocxWriteReceipt>
  restoreDocxOperation?: (
    context: OfficeWriteContext,
    operation: OfficeDocxOperation,
    before: OfficeDocxBefore,
    receipt: OfficeDocxWriteReceipt
  ) => Promise<void>
  readPptxSnapshot?: (context: OfficeWriteContext) => Promise<OfficePptxSnapshot>
  applyPptxOperation?: (
    context: OfficeWriteContext,
    operation: OfficePptxOperation,
    snapshot: OfficePptxSnapshot
  ) => Promise<OfficePptxWriteReceipt>
  restorePptxOperation?: (
    context: OfficeWriteContext,
    operation: OfficePptxOperation,
    before: OfficePptxBefore,
    receipt: OfficePptxWriteReceipt
  ) => Promise<void>
  saveDraft: (context: OfficeWriteContext) => Promise<void>
  verifySavedDraft?: (context: OfficeWriteContext) => Promise<OfficeSavedFileVerification>
  verifyOutputFile?: (
    path: string,
    context: Pick<OfficeWriteContext, 'binaryPath' | 'signal'>
  ) => Promise<OfficeSavedFileVerification>
  armPreviewConfirmation: (
    artifactId: string,
    sheet: string,
    cell: string
  ) => OfficePreviewConfirmation
  armPreviewConfirmationSet?: (
    artifactId: string,
    sheet: string,
    cells: readonly string[]
  ) => OfficePreviewConfirmation
  armSheetPreviewConfirmation?: (artifactId: string, sheet: string) => OfficePreviewConfirmation
  armDocumentPreviewConfirmation?: (artifactId: string, text: string) => OfficePreviewConfirmation
  publishConfirmedWrite?: (artifactId: string, operation: OfficeWriteOperation) => void
  setPreviewPreferences?: (
    artifactId: string,
    preferences: import('./office-watch').OfficePreviewPreferences
  ) => boolean
  loadOperationLog?: (draftPath: string) => Promise<OfficeOperationLogState>
  persistOperationLog?: (draftPath: string, state: OfficeOperationLogState) => Promise<void>
  loadOutputLog?: (draftPath: string) => Promise<OfficeOutputLogState>
  persistOutputLog?: (draftPath: string, state: OfficeOutputLogState) => Promise<void>
  checkDeliveredOutput?: (input: OfficeDeliveryCheckInput) => Promise<OfficeDeliveryCheckResult>
  outputId?: () => string
  logOperationWarning?: (
    event: string,
    metadata: Readonly<Record<string, string | number | boolean>>
  ) => void
  isProcessAlive?: (pid: number) => boolean
  recoverDocument?: (
    owned: OwnedOfficeDocument,
    state: OfficeResidentHealthState,
    signal: AbortSignal
  ) => Promise<OfficeProcessOwnership & OfficePreviewOwnership>
  reconcileTimeoutMs?: number
  now?: () => Date
}

export interface OwnedOfficeDocument {
  key: string
  binaryPath: string
  panelReferences: number
  lastActivityAt: number
  contentRevision: number
  freezeState?: 'unknown'
  readOnly: boolean
  needsSave: boolean
  saveStatus: OfficeSaveStatus
  lastHumanEdit?: OfficeHumanEditSummary
  operationLog: OfficeOperationLogState
  restoreNotice?: OfficeRestoreNotice
  operations: OfficeDocumentOperationQueue
  document: OfficeArtifact & OfficeProcessOwnership & OfficePreviewOwnership
}

export interface DraftCreationControl<T> {
  sessionId: string
  cancelled: boolean
  promise?: Promise<T>
  abort?: AbortController
  processPids?: Set<number>
  artifactDir?: string
  draftPath?: string
  registered?: boolean
}

export interface PendingOfficeCleanup {
  binaryPath: string
  artifact: OfficeArtifact
  process?: OfficeProcessOwnership
  preview?: OfficePreviewOwnership
  removeDraft: boolean
  previewStopped: boolean
  residentClosed: boolean
}

export class OfficeServiceError extends Error {
  constructor(
    readonly code: string,
    message: string
  ) {
    super(message)
    this.name = 'OfficeServiceError'
  }
}

export function sourceKey(sessionId: string, sourcePath: string): string {
  return `${sessionId}\0${sourcePath}`
}

export function creationKey(sessionId: string, requestId: string): string {
  return `${sessionId}\0${requestId}`
}

export function importKey(sessionId: string, requestId: string): string {
  return `${sessionId}\0import\0${requestId}`
}

export function creationError(requestId: string, error: unknown): OfficeCreateStatus {
  const value = error as { code?: unknown; message?: unknown }
  const code = typeof value?.code === 'string' ? value.code : 'create-failed'
  return {
    state: 'error',
    requestId,
    code,
    message:
      code !== 'create-failed' && typeof value?.message === 'string'
        ? value.message
        : '空白 Office 草稿创建失败'
  }
}

export function importError(requestId: string, error: unknown): OfficeImportStatus {
  const value = error as { code?: unknown; message?: unknown }
  const code = typeof value?.code === 'string' ? value.code : 'import_failed'
  return {
    state: 'error',
    requestId,
    code,
    message:
      code !== 'import_failed' && typeof value?.message === 'string'
        ? value.message
        : 'CSV/TSV 导入 Excel 草稿失败'
  }
}

export function runtimeMessage(
  status: Exclude<OfficeRuntimeStatus, { state: 'available' }>
): string {
  if (status.state === 'missing') return `Office 支持尚未安装。${status.hint}`
  if (status.state === 'unsupported-platform') return `当前平台暂不支持 Office：${status.platform}`
  if (status.state === 'version-mismatch') {
    return `OfficeCLI 版本不匹配：需要 ${status.expected}，当前为 ${status.found}`
  }
  if (status.state === 'incompatible') return `OfficeCLI 缺少所需能力：${status.missing.join('、')}`
  if (status.state === 'unusable') return 'OfficeCLI 无法使用，请检查运行环境'
  return 'OfficeCLI 完整性校验失败，请重新获取运行环境'
}

export function operationError(sourcePath: string, error: unknown): OfficeDocumentStatus {
  const value = error as {
    code?: unknown
    message?: unknown
    canRecreateFromSource?: unknown
    recreateSourcePath?: unknown
  }
  return {
    state: 'error',
    sourcePath,
    code: typeof value?.code === 'string' ? value.code : 'preview-failed',
    message: typeof value?.message === 'string' ? value.message : 'Office 实时预览启动失败',
    ...(value?.canRecreateFromSource === true ? { canRecreateFromSource: true } : {}),
    ...(typeof value?.recreateSourcePath === 'string'
      ? { freshSourcePath: value.recreateSourcePath }
      : {})
  }
}
