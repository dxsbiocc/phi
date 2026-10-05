import {
  OFFICE_READ_LIMITS,
  OFFICE_READ_ENVELOPE_HEADROOM_BYTES,
  OfficeReadError,
  type OfficeReadCell,
  type OfficeReadResult,
  type ParsedOfficeRange
} from './office-read-contract'
import type { WorkbookSheet } from './office-read-parser'

interface OfficeReadPageOptions {
  revision: number
  sheet: string
  range: ParsedOfficeRange
  startRow: number
  cells: readonly OfficeReadCell[]
  maxCells: number
  used: WorkbookSheet
  warnings?: readonly string[]
  cursorFor(nextRow: number): string
}

function outsideUsedRange(range: ParsedOfficeRange, used: WorkbookSheet): boolean {
  return (
    used.rows === 0 ||
    used.columns === 0 ||
    range.startRow > used.rows ||
    range.startColumn > used.columns
  )
}

function candidate(
  options: OfficeReadPageOptions,
  rows: number,
  warnings: readonly string[] | undefined
): OfficeReadResult {
  const cellCount = rows * options.range.columnCount
  const nextRow = options.startRow + rows
  const complete = nextRow > options.range.endRow
  const cells = Object.freeze(options.cells.slice(0, cellCount))
  return Object.freeze({
    revision: options.revision,
    sheet: options.sheet,
    range: options.range.range,
    cells,
    rowCount: options.range.rowCount,
    columnCount: options.range.columnCount,
    complete,
    truncated: !complete,
    ...(complete ? {} : { nextCursor: options.cursorFor(nextRow) }),
    limits: Object.freeze({ maxCells: options.maxCells, maxBytes: OFFICE_READ_LIMITS.maxBytes }),
    ...(warnings ? { warnings } : {})
  })
}

function responseBytes(value: OfficeReadResult): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8')
}

export function createOfficeReadPage(options: OfficeReadPageOptions): OfficeReadResult {
  const availableRows = options.cells.length / options.range.columnCount
  if (!Number.isSafeInteger(availableRows) || availableRows < 1) {
    throw new OfficeReadError('read_failed', 'Office 返回的分页结果不完整')
  }
  const warningValues = [...(options.warnings ?? [])]
  if (outsideUsedRange(options.range, options.used)) {
    warningValues.push('读取范围位于工作表的已用范围之外，返回空单元格')
  }
  const warnings = warningValues.length ? Object.freeze(warningValues) : undefined
  let low = 1
  let high = availableRows
  let best: OfficeReadResult | undefined
  while (low <= high) {
    const rows = Math.floor((low + high) / 2)
    const value = candidate(options, rows, warnings)
    if (responseBytes(value) <= OFFICE_READ_LIMITS.maxBytes - OFFICE_READ_ENVELOPE_HEADROOM_BYTES) {
      best = value
      low = rows + 1
    } else high = rows - 1
  }
  if (!best) {
    throw new OfficeReadError('range_too_large', '单行读取结果超过返回上限，请缩小列范围')
  }
  return best
}
