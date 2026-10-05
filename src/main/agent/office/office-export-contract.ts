import { OFFICE_WORKBOOK_ADMISSION_LIMITS } from './office-limits'

export type OfficeExportFormat = 'csv' | 'tsv'
export type OfficeExportCellValue = string | number | boolean | null

export const OFFICE_EXPORT_LIMITS = Object.freeze({
  maxRows: OFFICE_WORKBOOK_ADMISSION_LIMITS.maxRows,
  maxColumns: OFFICE_WORKBOOK_ADMISSION_LIMITS.maxColumns,
  maxCells: OFFICE_WORKBOOK_ADMISSION_LIMITS.maxCells,
  maxPageCells: 2_000,
  maxFileBytes: 16 * 1024 * 1024
})

export type OfficeExportErrorCode =
  | 'invalid_export'
  | 'unsupported_document_kind'
  | 'invalid_sheet'
  | 'export_too_large'
  | 'computed_value_unavailable'
  | 'revision_changed'
  | 'export_cancelled'
  | 'export_verification_failed'
  | 'export_failed'

export class OfficeExportError extends Error {
  constructor(
    readonly code: OfficeExportErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message)
    this.name = 'OfficeExportError'
  }
}

export interface OfficeExportSheetData {
  readonly revision: number
  readonly sheet: string
  readonly rows: number
  readonly columns: number
  readonly values: readonly (readonly OfficeExportCellValue[])[]
}
