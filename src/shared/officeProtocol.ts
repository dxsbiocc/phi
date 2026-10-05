export type OfficeApplyCellValue = string | number | boolean

export type OfficeDocumentKind = 'xlsx' | 'docx' | 'pptx'
export type OfficeImportFormat = 'csv' | 'tsv'
export type OfficeExportFormat = 'csv' | 'tsv'

export const OFFICE_IMPORT_RULES = Object.freeze({
  maxFileBytes: 5 * 1024 * 1024,
  maxRows: 1_000,
  maxColumns: 100,
  maxCells: 80_000,
  maxCellTextLength: 32_767
})

export const OFFICE_EXPORT_RULES = Object.freeze({
  maxFileBytes: 16 * 1024 * 1024,
  maxRows: 1_000,
  maxColumns: 100,
  maxCells: 80_000
})

export interface OfficeImportSourceSummary {
  path: string
  format: OfficeImportFormat
  delimiter: ',' | '\t'
  rows: number
  columns: number
  sha256: string
}

export type OfficeApplyOperation =
  | {
      readonly type: 'set_cell'
      readonly sheet: string
      readonly cell: string
      readonly value: OfficeApplyCellValue
    }
  | {
      readonly type: 'set_range'
      readonly sheet: string
      readonly range: string
      readonly values: readonly (readonly OfficeApplyCellValue[])[]
    }
  | {
      readonly type: 'set_formula'
      readonly sheet: string
      readonly cell: string
      readonly formula: string
    }
  | {
      readonly type: 'format_range'
      readonly sheet: string
      readonly range: string
      readonly format: {
        readonly bold?: boolean
        readonly fill?: string
        readonly horizontalAlign?: 'left' | 'center' | 'right'
        readonly numberFormat?: 'General' | '0' | '0.00' | '#,##0' | '#,##0.00'
      }
    }
  | {
      readonly type: 'add_sheet'
      readonly name: string
    }
  | {
      readonly type: 'add_paragraph'
      readonly text: string
      readonly position?: 'end' | { readonly after: string }
    }
  | {
      readonly type: 'set_paragraph_text'
      readonly paraId: string
      readonly text: string
      readonly expectedText?: string
    }
  | {
      readonly type: 'add_slide'
      readonly title: string
      readonly body?: string
      readonly position?: 'end' | { readonly after: string }
    }
  | {
      readonly type: 'set_slide_text'
      readonly slideId: string
      readonly elementId: string
      readonly text: string
      readonly expectedText?: string
    }

export interface OfficeApplyInput {
  readonly operation: OfficeApplyOperation
  readonly baseRevision: number
}

export interface OfficePreviewDocument {
  artifactId: string
  sessionId: string
  projectId: string | null
  kind?: OfficeDocumentKind
  humanEdit?: 'cells' | 'none'
  followAiControllable?: true
  sourcePath: string
  sourceHash: string | null
  previewUrl: string
  previewState?: 'ready' | 'preview_failed'
  previewError?: string
  slideCount?: number
  readOnly: boolean
  freezeState?: 'unknown'
  needsSave?: boolean
  saveState: 'saved' | 'editing' | 'unsaved' | 'saving' | 'failed'
  lastSavedRevision: number
  lastSavedAt?: string
  lastReconciliation?: OfficeReconciliationSummary
  lastHumanEdit?: OfficeHumanEditSummary
  restoreNotice?: OfficeRestoreNotice
  importSource?: OfficeImportSourceSummary
}

export type OfficeRestoreNotice =
  | { kind: 'recovered'; hasUnsavedChanges: boolean }
  | { kind: 'source_changed' }
  | { kind: 'draft_hash_mismatch' }
  | { kind: 'operation_log_corrupt' }

export interface OfficeHumanEditSummary {
  type: 'text' | 'number' | 'boolean' | 'formula' | 'clear'
  conclusion: 'succeeded' | 'failed'
  code: string
  message: string
}

export type OfficeReconcileConclusion =
  'applied' | 'not_applied' | 'indeterminate' | 'applied_no_change'

export interface OfficeReconciliationSummary {
  conclusion: OfficeReconcileConclusion
  message: string
}

export interface OfficeReconcileInput {
  artifactId: string
}

export interface OfficeSaveInput {
  artifactId: string
}

export interface OfficeSaveResult {
  saved: true
  revision: number
  lastSavedAt: string
}

export interface OfficeSaveAsInput {
  artifactId: string
}

export interface OfficeExportInput {
  requestId: string
  artifactId: string
  sheet: string
  format: OfficeExportFormat
}

export interface OfficeCancelExportInput {
  requestId: string
}

export interface OfficeRevealOutputInput {
  artifactId: string
  outputId: string
}

export interface OfficeResolvedOutput {
  path: string
}

export interface OfficeOutputSummary {
  outputId: string
  outputPath: string
  fileName: string
  revision: number
  sha256: string
  size: number
  createdAt: string
  source: 'draft'
}

export interface OfficeExportOutputSummary extends OfficeOutputSummary {
  format: OfficeExportFormat
  sheet: string
  rows: number
  columns: number
  deduplicated?: true
}

export type OfficeSaveAsResult =
  { status: 'cancelled' } | { status: 'saved'; output: OfficeOutputSummary }

export type OfficeExportResult =
  { status: 'cancelled' } | { status: 'saved'; output: OfficeExportOutputSummary }

export interface OfficeReconcileResult extends OfficeReconciliationSummary {
  revision: number
  code?: 'reconcile_indeterminate'
  freezeState?: 'unknown'
  needsSave?: boolean
}

export interface OfficeTargetInput {
  artifactId: string
  includeSelection?: boolean
}

export interface OfficeSelectionSummary {
  sheet?: string
  range?: string
  paths: readonly string[]
}

export interface OfficeSelectionEvent {
  artifactId: string
  selection: OfficeSelectionSummary | null
}

export interface OfficeClearSelectionInput {
  artifactId: string
}

export type OfficePromptTargetErrorCode =
  'target_not_found' | 'target_session_mismatch' | 'selection_unavailable' | 'selection_too_large'

export interface OfficePromptTargetFailure {
  ok: false
  error: { code: OfficePromptTargetErrorCode; message: string }
}

export function officePromptTargetFailure(
  code: OfficePromptTargetErrorCode
): OfficePromptTargetFailure {
  return {
    ok: false,
    error: {
      code,
      message:
        code === 'selection_too_large'
          ? '当前选区超过 10,000 个单元格，请缩小选区'
          : code === 'selection_unavailable'
            ? '无法读取当前选区，请重新选择或清除选区'
            : code === 'target_session_mismatch'
              ? '关联的 Office 文档不属于当前会话'
              : '关联的 Office 文档已不存在或已关闭'
    }
  }
}

export function sanitizeOfficeTargetInput(input: unknown): OfficeTargetInput | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const artifactId = record.artifactId
  if (typeof artifactId !== 'string' || !artifactId.trim()) return undefined
  return {
    artifactId,
    ...(record.includeSelection === true ? { includeSelection: true } : {})
  }
}

export type OfficeDocumentState =
  | { state: 'preparing'; sourcePath: string }
  | { state: 'ready'; document: OfficePreviewDocument }
  | {
      state: 'error'
      sourcePath: string
      code: string
      message: string
      canRecreateFromSource?: boolean
      freshSourcePath?: string
    }

export type OfficeIpcResult<T> =
  { ok: true; value: T } | { ok: false; error: { code: string; message: string } }

export interface OfficeOpenInput {
  sourcePath: string
  fresh?: boolean
}

export interface OfficeCreateInput {
  requestId: string
  kind?: OfficeDocumentKind
  name?: string
}

export interface OfficeCancelCreateInput {
  requestId: string
}

export interface OfficeImportInput {
  requestId: string
  sourcePath: string
  format: OfficeImportFormat
}

export interface OfficeCancelImportInput {
  requestId: string
}

export type OfficeCreateState =
  | { state: 'preparing'; requestId: string }
  | { state: 'ready'; document: OfficePreviewDocument }
  | { state: 'error'; requestId: string; code: string; message: string }

export type OfficeImportState = OfficeCreateState

export interface OfficeCloseInput {
  artifactId: string
  sessionId: string
}

export interface OfficeStatusInput {
  sourcePath: string
}

export interface OfficePreviewPreferencesInput {
  artifactId: string
  visible: boolean
  followAi: boolean
}

export interface OfficeRendererBridge {
  readonly enabled: boolean
  create: (input: OfficeCreateInput) => Promise<OfficeIpcResult<OfficeCreateState>>
  cancelCreate: (input: OfficeCancelCreateInput) => Promise<OfficeIpcResult<boolean>>
  importFile?: (input: OfficeImportInput) => Promise<OfficeIpcResult<OfficeImportState>>
  cancelImport?: (input: OfficeCancelImportInput) => Promise<OfficeIpcResult<boolean>>
  open: (input: OfficeOpenInput) => Promise<OfficeIpcResult<OfficeDocumentState>>
  close: (input: OfficeCloseInput) => Promise<OfficeIpcResult<boolean>>
  clearSelection: (input: OfficeClearSelectionInput) => Promise<OfficeIpcResult<boolean>>
  reconcile: (input: OfficeReconcileInput) => Promise<OfficeIpcResult<OfficeReconcileResult>>
  save: (input: OfficeSaveInput) => Promise<OfficeIpcResult<OfficeSaveResult>>
  saveAs: (input: OfficeSaveAsInput) => Promise<OfficeIpcResult<OfficeSaveAsResult>>
  exportSheet?: (input: OfficeExportInput) => Promise<OfficeIpcResult<OfficeExportResult>>
  cancelExport?: (input: OfficeCancelExportInput) => Promise<OfficeIpcResult<boolean>>
  revealOutput: (input: OfficeRevealOutputInput) => Promise<OfficeIpcResult<boolean>>
  resolveOutput: (input: OfficeRevealOutputInput) => Promise<OfficeIpcResult<OfficeResolvedOutput>>
  status: (input: OfficeStatusInput) => Promise<OfficeIpcResult<OfficeDocumentState | null>>
  setPreviewPreferences?: (
    input: OfficePreviewPreferencesInput
  ) => Promise<OfficeIpcResult<boolean>>
  onSelection: (listener: (event: OfficeSelectionEvent) => void) => () => void
}
