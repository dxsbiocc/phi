import { OFFICE_CONTENT_LIMITS } from './office-limits'
import type {
  OfficeAddParagraphOperation,
  OfficeDocxBefore,
  OfficeDocxSnapshot,
  OfficeSetParagraphTextOperation
} from './office-docx-contract'
import type {
  OfficeAddSlideOperation,
  OfficePptxBefore,
  OfficePptxSnapshot,
  OfficeSetSlideTextOperation
} from './office-pptx-contract'

export const OFFICE_WRITE_ERROR_CODES = [
  'no_target',
  'target_missing',
  'session_mismatch',
  'invalid_sheet',
  'sheet_exists',
  'too_many_sheets',
  'invalid_cell',
  'invalid_value',
  'range_out_of_bounds',
  'range_too_large',
  'formula_not_supported',
  'formula_invalid',
  'revision_conflict',
  'document_frozen',
  'document_read_only',
  'unsupported_document_kind',
  'operation_not_supported_for_kind',
  'paragraph_not_found',
  'paragraph_not_plain',
  'slide_not_found',
  'element_not_found',
  'element_not_plain',
  'too_many_slides',
  'stale_target',
  'write_failed',
  'write_verification_failed',
  'save_failed',
  'write_cancelled',
  'write_unknown',
  'write_not_applied',
  'reconcile_indeterminate',
  'reconcile_failed',
  'missing_operation_id',
  'operation_conflict',
  'operation_log_corrupt',
  'approval_changed'
] as const

export type OfficeWriteErrorCode = (typeof OFFICE_WRITE_ERROR_CODES)[number]

export class OfficeWriteError extends Error {
  constructor(
    readonly code: OfficeWriteErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message)
    this.name = 'OfficeWriteError'
  }
}

export type OfficeCellValue = string | number | boolean

export const OFFICE_WRITE_LIMITS = Object.freeze({
  maxCells: OFFICE_CONTENT_LIMITS.maxCellsPerOperation,
  maxRows: OFFICE_CONTENT_LIMITS.maxWorkbookRows,
  maxColumns: OFFICE_CONTENT_LIMITS.maxWorkbookColumns,
  maxBatchBytes: OFFICE_CONTENT_LIMITS.maxPayloadBytes,
  maxCellTextLength: OFFICE_CONTENT_LIMITS.maxCellTextLength,
  maxPreviewCells: OFFICE_CONTENT_LIMITS.maxPreviewCells,
  maxPreviewValueCharacters: OFFICE_CONTENT_LIMITS.maxPreviewValueCharacters,
  maxApprovalSummaryCharacters: OFFICE_CONTENT_LIMITS.maxApprovalSummaryCharacters
})

export interface OfficeCellEditParams {
  readonly sheet: string
  readonly cell: string
  readonly value: OfficeCellValue
  readonly baseRevision: number
}

export interface OfficeDescribeCellEditParams {
  readonly sheet: string
  readonly cell: string
  readonly value: OfficeCellValue
}

export interface OfficeRangeEditParams {
  readonly sheet: string
  readonly range: string
  readonly values: readonly (readonly OfficeCellValue[])[]
  readonly rowCount: number
  readonly columnCount: number
  readonly cellCount: number
  readonly baseRevision: number
}

export interface OfficeFormulaEditParams {
  readonly sheet: string
  readonly cell: string
  readonly formula: string
  readonly baseRevision: number
}

export interface OfficeSetCellOperation {
  readonly type: 'set_cell'
  readonly sheet: string
  readonly cell: string
  readonly value: OfficeCellValue
}

export interface OfficeSetRangeOperation {
  readonly type: 'set_range'
  readonly sheet: string
  readonly range: string
  readonly values: readonly (readonly OfficeCellValue[])[]
  readonly rowCount: number
  readonly columnCount: number
  readonly cellCount: number
}

export interface OfficeSetFormulaOperation {
  readonly type: 'set_formula'
  readonly sheet: string
  readonly cell: string
  readonly formula: string
}

export interface OfficeClearCellOperation {
  readonly type: 'clear_cell'
  readonly sheet: string
  readonly cell: string
}

export type OfficeHorizontalAlign = 'left' | 'center' | 'right'

export interface OfficeRangeFormat {
  readonly bold?: boolean
  readonly fill?: string
  readonly horizontalAlign?: OfficeHorizontalAlign
  readonly numberFormat?: string
}

export interface OfficeFormatRangeParams {
  readonly sheet: string
  readonly range: string
  readonly format: OfficeRangeFormat
  readonly rowCount: number
  readonly columnCount: number
  readonly cellCount: number
  readonly baseRevision: number
}

export interface OfficeFormatRangeOperation {
  readonly type: 'format_range'
  readonly sheet: string
  readonly range: string
  readonly format: OfficeRangeFormat
  readonly rowCount: number
  readonly columnCount: number
  readonly cellCount: number
}

export interface OfficeAddSheetOperation {
  readonly type: 'add_sheet'
  readonly name: string
}

export type OfficeWriteOperation =
  | OfficeSetCellOperation
  | OfficeSetRangeOperation
  | OfficeSetFormulaOperation
  | OfficeFormatRangeOperation
  | OfficeAddSheetOperation
  | OfficeAddParagraphOperation
  | OfficeSetParagraphTextOperation
  | OfficeAddSlideOperation
  | OfficeSetSlideTextOperation

export type OfficeInternalWriteOperation = OfficeWriteOperation | OfficeClearCellOperation

export interface OfficeWriteRequest {
  readonly operation: OfficeWriteOperation
  readonly baseRevision: number
}

export interface OfficeWriteSnapshotCell {
  readonly ref: string
  readonly value: OfficeCellValue | null
  readonly valueType: 'empty' | 'string' | 'number' | 'boolean' | 'date' | 'error' | 'unknown'
  readonly formula?: string
  readonly evaluated?: boolean
  readonly format?: OfficeCellFormatState
}

export interface OfficeCellFormatState {
  readonly bold?: boolean
  readonly fill?: string | null
  readonly horizontalAlign?: OfficeHorizontalAlign | null
  readonly numberFormat?: string
}

export interface OfficeWriteSnapshot {
  readonly cells: readonly OfficeWriteSnapshotCell[]
  readonly rowCount: number
  readonly columnCount: number
  readonly sheetNames?: readonly string[]
  readonly addedSheetEmpty?: boolean
  readonly docx?: OfficeDocxSnapshot
  readonly docxBefore?: OfficeDocxBefore
  readonly pptx?: OfficePptxSnapshot
  readonly pptxBefore?: OfficePptxBefore
}

export interface OfficeSheetBefore {
  readonly sheetNames: readonly string[]
}

export interface OfficeRangeBeforeValue {
  readonly value: OfficeCellValue | null
  readonly valueType: OfficeWriteSnapshotCell['valueType']
}

export interface OfficeFormulaBeforeValue {
  readonly value: OfficeCellValue | null
  readonly valueType: OfficeWriteSnapshotCell['valueType']
  readonly formula?: string
  readonly evaluated?: boolean
}

export interface OfficeClearBeforeValue extends OfficeFormulaBeforeValue {
  readonly format?: OfficeCellFormatState
}

export type OfficeWriteBefore =
  | OfficeCellValue
  | null
  | OfficeFormulaBeforeValue
  | OfficeClearBeforeValue
  | readonly (readonly OfficeRangeBeforeValue[])[]
  | readonly OfficeFormatBeforeCell[]
  | OfficeSheetBefore
  | OfficeDocxBefore
  | OfficePptxBefore

export interface OfficeFormatBeforeCell {
  readonly ref: string
  readonly value: OfficeCellValue | null
  readonly valueType: OfficeWriteSnapshotCell['valueType']
  readonly formula?: string
  readonly evaluated?: boolean
  readonly format: OfficeCellFormatState
}

export interface OfficeRangePreviewCell {
  readonly cell: string
  readonly before: OfficeCellValue | null
  readonly after: OfficeCellValue
}

export interface OfficeRangeEditDescription {
  readonly type: 'set_range'
  readonly documentName: string
  readonly sheet: string
  readonly range: string
  readonly rowCount: number
  readonly columnCount: number
  readonly cellCount: number
  readonly changedCells: number
  readonly preview: readonly OfficeRangePreviewCell[]
  readonly revision: number
}

export interface OfficeRangeEditResult {
  readonly applied: boolean
  readonly saved: boolean
  readonly revision: number
  readonly sheet: string
  readonly range: string
  readonly rowCount: number
  readonly columnCount: number
  readonly changedCells: number
  readonly preview: readonly OfficeRangePreviewCell[]
  readonly beforeHash: string
  readonly afterHash: string
  readonly previewConfirmed: boolean
  readonly warnings?: readonly string[]
  readonly deduplicated?: true
  readonly reconciled?: true
}

export interface OfficeFormatRangeDescription {
  readonly type: 'format_range'
  readonly documentName: string
  readonly sheet: string
  readonly range: string
  readonly rowCount: number
  readonly columnCount: number
  readonly cellCount: number
  readonly changedCells: number
  readonly format: OfficeRangeFormat
  readonly revision: number
}

export interface OfficeFormatRangeResult {
  readonly applied: boolean
  readonly saved: boolean
  readonly revision: number
  readonly sheet: string
  readonly range: string
  readonly rowCount: number
  readonly columnCount: number
  readonly changedCells: number
  readonly appliedFormat: OfficeRangeFormat
  readonly previewConfirmed: boolean
  readonly warnings?: readonly string[]
  readonly deduplicated?: true
  readonly reconciled?: true
}

export interface OfficeFormulaEditDescription {
  readonly type: 'set_formula'
  readonly documentName: string
  readonly sheet: string
  readonly cell: string
  readonly formula: string
  readonly before: OfficeFormulaBeforeValue
  readonly revision: number
}

export interface OfficeFormulaEditResult {
  readonly applied: true
  readonly saved: boolean
  readonly revision: number
  readonly sheet: string
  readonly cell: string
  readonly formula: string
  readonly computedValue: OfficeCellValue
  readonly valueType: OfficeWriteSnapshotCell['valueType']
  readonly previewConfirmed: boolean
  readonly warnings?: readonly string[]
  readonly deduplicated?: true
  readonly reconciled?: true
}

export type OfficeFormulaInvalidReason =
  | 'formula_mismatch'
  | 'invalid_syntax'
  | 'unsupported_function'
  | 'not_evaluated'
  | 'error_value'
  | 'circular_reference'
  | 'reference_graph_too_large'

export interface OfficeFormulaStatus {
  readonly formula?: string
  readonly evaluated: boolean
  readonly computedValue: OfficeCellValue | null
  readonly valueType: OfficeWriteSnapshotCell['valueType']
}

export interface OfficeFormulaInvalidResult {
  readonly applied: false
  readonly saved: true
  readonly revision: number
  readonly sheet: string
  readonly cell: string
  readonly formula: string
  readonly formulaStatus: OfficeFormulaStatus
  readonly reason: OfficeFormulaInvalidReason
  readonly previewConfirmed: false
  readonly deduplicated?: true
}

export interface OfficeAddSheetDescription {
  readonly type: 'add_sheet'
  readonly documentName: string
  readonly name: string
  readonly sheetCount: number
  readonly revision: number
}

export interface OfficeAddSheetResult {
  readonly applied: true
  readonly saved: boolean
  readonly revision: number
  readonly sheet: string
  readonly path: string
  readonly sheetCount: number
  readonly sheetNames: readonly string[]
  readonly previewConfirmed: boolean
  readonly warnings?: readonly string[]
  readonly deduplicated?: true
  readonly reconciled?: true
}

export interface OfficeAddParagraphDescription {
  readonly type: 'add_paragraph'
  readonly documentName: string
  readonly text: string
  readonly position: 'end' | { readonly after: string; readonly index: number }
  readonly revision: number
}

export interface OfficeSetParagraphTextDescription {
  readonly type: 'set_paragraph_text'
  readonly documentName: string
  readonly paraId: string
  readonly index: number
  readonly before: string
  readonly after: string
  readonly revision: number
}

export interface OfficeAddParagraphResult {
  readonly applied: true
  readonly saved: boolean
  readonly revision: number
  readonly paraId: string
  readonly path: string
  readonly index: number
  readonly text: string
  readonly previewConfirmed: boolean
  readonly warnings?: readonly string[]
  readonly deduplicated?: true
  readonly reconciled?: true
}

export interface OfficeSetParagraphTextResult {
  readonly applied: true
  readonly saved: boolean
  readonly revision: number
  readonly paraId: string
  readonly path: string
  readonly index: number
  readonly before: string
  readonly after: string
  readonly previewConfirmed: boolean
  readonly warnings?: readonly string[]
  readonly deduplicated?: true
  readonly reconciled?: true
}

export type OfficeDocxWriteDescription =
  OfficeAddParagraphDescription | OfficeSetParagraphTextDescription

export type OfficeDocxWriteResult = OfficeAddParagraphResult | OfficeSetParagraphTextResult

export interface OfficeAddSlideDescription {
  readonly type: 'add_slide'
  readonly documentName: string
  readonly title: string
  readonly body?: string
  readonly position: 'end' | { readonly after: string; readonly index: number }
  readonly revision: number
}

export interface OfficeSetSlideTextDescription {
  readonly type: 'set_slide_text'
  readonly documentName: string
  readonly slideId: string
  readonly elementId: string
  readonly index: number
  readonly kind: 'title' | 'body' | 'text'
  readonly before: string
  readonly after: string
  readonly revision: number
}

export type OfficePptxWriteDescription = OfficeAddSlideDescription | OfficeSetSlideTextDescription

export interface OfficeAddSlideResult {
  readonly applied: true
  readonly saved: boolean
  readonly revision: number
  readonly slideId: string
  readonly path: string
  readonly index: number
  readonly title: string
  readonly body?: string
  readonly previewConfirmed: boolean
  readonly layoutWarning?: 'text_may_overflow'
  readonly warnings?: readonly string[]
  readonly deduplicated?: true
  readonly reconciled?: true
}

export interface OfficeSetSlideTextResult {
  readonly applied: true
  readonly saved: boolean
  readonly revision: number
  readonly slideId: string
  readonly elementId: string
  readonly path: string
  readonly index: number
  readonly kind: 'title' | 'body' | 'text'
  readonly before: string
  readonly after: string
  readonly previewConfirmed: boolean
  readonly layoutWarning?: 'text_may_overflow'
  readonly warnings?: readonly string[]
  readonly deduplicated?: true
  readonly reconciled?: true
}

export type OfficePptxWriteResult = OfficeAddSlideResult | OfficeSetSlideTextResult

export type OfficeWriteDescription =
  | OfficeCellEditDescription
  | OfficeRangeEditDescription
  | OfficeFormulaEditDescription
  | OfficeFormatRangeDescription
  | OfficeAddSheetDescription
  | OfficeDocxWriteDescription
  | OfficePptxWriteDescription
export type OfficeWriteResult =
  | OfficeCellEditResult
  | OfficeRangeEditResult
  | OfficeFormulaEditResult
  | OfficeFormatRangeResult
  | OfficeAddSheetResult
  | OfficeDocxWriteResult
  | OfficePptxWriteResult
export type OfficeWriteReceiptResult = OfficeWriteResult | OfficeFormulaInvalidResult

export interface OfficeCellEditOptions {
  readonly signal?: AbortSignal
  readonly operationId?: string
  readonly authorize?: () => boolean | Promise<boolean>
}

interface OfficeCellEditChange {
  readonly sheet: string
  readonly cell: string
  readonly before: OfficeCellValue | null
  readonly after: OfficeCellValue | null
  readonly revision: number
}

export interface OfficeCellEditDescription extends OfficeCellEditChange {
  readonly documentName: string
}

export interface OfficeCellEditResult extends OfficeCellEditChange {
  readonly applied: boolean
  readonly saved: boolean
  readonly previewConfirmed: boolean
  readonly warnings?: readonly string[]
  readonly deduplicated?: true
  readonly reconciled?: true
}

export interface OfficeWriteContext {
  readonly binaryPath: string
  readonly draftPath: string
  readonly signal?: AbortSignal
  readonly onSpawn?: () => void
}

export interface OfficePreviewConfirmation {
  readonly promise: Promise<boolean>
  readonly cancel: () => void
  readonly markDispatched?: () => void
}

export * from './office-write-validation'
