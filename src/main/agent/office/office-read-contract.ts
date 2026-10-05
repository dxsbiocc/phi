import { OFFICE_CONTENT_LIMITS, OFFICE_FORMAT_LIMITS } from './office-limits'

export const OFFICE_READ_LIMITS = Object.freeze({
  maxCells: OFFICE_CONTENT_LIMITS.maxCellsPerOperation,
  maxBytes: OFFICE_CONTENT_LIMITS.maxPayloadBytes,
  maxRangeCells: 50_000,
  maxRows: OFFICE_FORMAT_LIMITS.maxRows,
  maxColumns: OFFICE_FORMAT_LIMITS.maxColumns
})

export const OFFICE_READ_RESPONSE_LIMITS = Object.freeze({
  maxCells: OFFICE_READ_LIMITS.maxCells,
  maxBytes: OFFICE_READ_LIMITS.maxBytes
})

// The Agent tool adds a small untrusted-data envelope around this response.
export const OFFICE_READ_ENVELOPE_HEADROOM_BYTES = 512

export type OfficeReadErrorCode =
  | 'no_target'
  | 'target_missing'
  | 'session_mismatch'
  | 'invalid_sheet'
  | 'invalid_range'
  | 'range_out_of_bounds'
  | 'range_too_large'
  | 'invalid_cursor'
  | 'read_timeout'
  | 'read_cancelled'
  | 'read_failed'
  | 'unsupported_document_kind'
  | 'invalid_arguments'
  | 'workbook_busy'

export class OfficeReadError extends Error {
  constructor(
    readonly code: OfficeReadErrorCode,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>
  ) {
    super(message)
    this.name = 'OfficeReadError'
  }
}

export interface ParsedOfficeRange {
  readonly range: string
  readonly startRow: number
  readonly endRow: number
  readonly startColumn: number
  readonly endColumn: number
  readonly rowCount: number
  readonly columnCount: number
  readonly cellCount: number
}

export interface OfficeReadParams {
  readonly sheet?: string
  readonly range?: string
  readonly cursor?: string
  readonly maxCells?: number
  readonly from?: number
  readonly limit?: number
}

export interface OfficeReadContext {
  readonly artifactId: string
  readonly binaryPath: string
  readonly draftPath: string
  readonly revision: number
  readonly selection?: { readonly sheet?: string; readonly range?: string }
  readonly signal?: AbortSignal
}

export type OfficeReadValueType =
  'empty' | 'number' | 'string' | 'boolean' | 'date' | 'error' | 'unknown'

export interface OfficeReadCellFormat {
  readonly bold?: true
  readonly fill?: string
  readonly horizontalAlign?: 'left' | 'center' | 'right'
  readonly numberFormat?: string
}

export interface OfficeReadCell {
  readonly ref: string
  readonly value: string | number | boolean | null
  readonly formula?: string
  readonly valueType?: OfficeReadValueType
  readonly evaluated?: boolean
  readonly error?: 'unsupported_function'
  readonly format?: OfficeReadCellFormat
}

export interface OfficeReadResult {
  readonly revision: number
  readonly sheet: string
  readonly range: string
  readonly cells: readonly OfficeReadCell[]
  readonly rowCount: number
  readonly columnCount: number
  readonly complete: boolean
  readonly truncated: boolean
  readonly nextCursor?: string
  readonly limits: { readonly maxCells: number; readonly maxBytes: number }
  readonly warnings?: readonly string[]
}

export interface OfficeReadOverview {
  readonly revision: number
  readonly sheets: readonly {
    readonly name: string
    readonly usedRange: string | null
    readonly rowCount: number
    readonly columnCount: number
  }[]
  readonly complete: false
  readonly truncated: false
  readonly hint: string
  readonly limits: { readonly maxCells: number; readonly maxBytes: number }
  readonly warnings?: readonly string[]
}

export type OfficeReadResponse = OfficeReadResult | OfficeReadOverview

interface CellAddress {
  row: number
  column: number
}

export function columnNumber(letters: string): number {
  let value = 0
  for (const letter of letters) value = value * 26 + letter.charCodeAt(0) - 64
  return value
}

export function columnName(column: number): string {
  let value = column
  let name = ''
  while (value > 0) {
    value -= 1
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26)
  }
  return name
}

function parseCellAddress(value: string): CellAddress {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(value)
  if (!match) throw new OfficeReadError('invalid_range', '单元格范围必须使用 A1 记法')
  const column = columnNumber(match[1])
  const row = Number(match[2])
  if (column > OFFICE_READ_LIMITS.maxColumns || row > OFFICE_READ_LIMITS.maxRows) {
    throw new OfficeReadError('range_out_of_bounds', '读取范围超出工作表边界，请缩小范围')
  }
  return { row, column }
}

export function parseOfficeRange(value: string): ParsedOfficeRange {
  if (typeof value !== 'string' || value.length > 64) {
    throw new OfficeReadError('invalid_range', '单元格范围无效，请使用 A1 记法')
  }
  const parts = value.trim().toUpperCase().split(':')
  if (parts.length < 1 || parts.length > 2 || parts.some((part) => part.length === 0)) {
    throw new OfficeReadError('invalid_range', '单元格范围无效，请使用 A1 记法')
  }
  const first = parseCellAddress(parts[0])
  const second = parseCellAddress(parts[1] ?? parts[0])
  const startRow = Math.min(first.row, second.row)
  const endRow = Math.max(first.row, second.row)
  const startColumn = Math.min(first.column, second.column)
  const endColumn = Math.max(first.column, second.column)
  const start = `${columnName(startColumn)}${startRow}`
  const end = `${columnName(endColumn)}${endRow}`
  const rowCount = endRow - startRow + 1
  const columnCount = endColumn - startColumn + 1
  return Object.freeze({
    range: start === end ? start : `${start}:${end}`,
    startRow,
    endRow,
    startColumn,
    endColumn,
    rowCount,
    columnCount,
    cellCount: rowCount * columnCount
  })
}

export type OfficeSheetNameIssue =
  | 'empty'
  | 'length'
  | 'surrounding_whitespace'
  | 'surrounding_apostrophe'
  | 'forbidden_character'
  | 'control_character'

export function officeSheetNameIssue(sheet: string): OfficeSheetNameIssue | undefined {
  if (sheet.length === 0 || sheet.trim().length === 0) return 'empty'
  if ([...sheet].length > 31) return 'length'
  if (sheet !== sheet.trim()) return 'surrounding_whitespace'
  if (sheet.startsWith("'") || sheet.endsWith("'")) return 'surrounding_apostrophe'
  const forbidden = new Set(['\\', '/', '?', '*', '[', ']', ':'])
  for (const character of sheet) {
    const code = character.charCodeAt(0)
    if (code < 32 || code === 127 || (code >= 0x80 && code <= 0x9f)) {
      return 'control_character'
    }
    if (forbidden.has(character)) return 'forbidden_character'
  }
  return undefined
}

export function validOfficeSheetName(sheet: string): boolean {
  return officeSheetNameIssue(sheet) === undefined
}
