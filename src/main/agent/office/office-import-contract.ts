export type OfficeDelimitedFormat = 'csv' | 'tsv'
export type OfficeImportCellValue = string | number

export type OfficeImportErrorCode =
  | 'invalid_extension'
  | 'source_not_found'
  | 'source_not_file'
  | 'source_not_allowed'
  | 'symlink_escape'
  | 'private_draft_path'
  | 'unsupported_encoding'
  | 'invalid_delimited_text'
  | 'import_too_large'
  | 'source_changed_during_import'
  | 'import-cancelled'
  | 'import_failed'
  | 'import_verification_failed'

export class OfficeImportError extends Error {
  constructor(
    readonly code: OfficeImportErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = 'OfficeImportError'
  }
}

export interface ParsedOfficeDelimitedData {
  readonly format: OfficeDelimitedFormat
  readonly delimiter: ',' | '\t'
  readonly values: readonly (readonly string[])[]
  readonly rows: number
  readonly columns: number
}

export interface OfficeImportExecutionControl {
  readonly signal?: AbortSignal
  readonly onResidentPid?: (pid: number) => void
  readonly onArtifactDir?: (artifactDir: string) => void
  readonly onDraftPath?: (draftPath: string) => void
}
