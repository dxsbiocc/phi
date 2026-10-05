import type { OfficeCliRunResult } from './office-driver'
import {
  OFFICE_READ_RESPONSE_LIMITS,
  OfficeReadError,
  columnName,
  columnNumber,
  type OfficeReadCell,
  type OfficeReadCellFormat,
  type OfficeReadOverview,
  type OfficeReadValueType,
  type ParsedOfficeRange
} from './office-read-contract'

export interface WorkbookSheet {
  name: string
  rows: number
  columns: number
}

export function parseOfficeReadJson(result: OfficeCliRunResult): unknown {
  if (result.timedOut) throw new OfficeReadError('read_timeout', '读取 Office 内容超时，请稍后重试')
  if (result.spawnError || result.truncated || result.exitCode !== 0) {
    throw new OfficeReadError('read_failed', '无法读取 Office 内容，请稍后重试')
  }
  try {
    const value = JSON.parse(result.stdout) as { success?: unknown }
    if (value.success !== true) throw new Error('unsuccessful')
    return value
  } catch (error) {
    if (error instanceof OfficeReadError) throw error
    throw new OfficeReadError('read_failed', 'Office 返回了无法识别的读取结果')
  }
}

export function parseWorkbookSheets(value: unknown): WorkbookSheet[] {
  const sheets = (value as { data?: { sheets?: unknown } }).data?.sheets
  if (!Array.isArray(sheets)) {
    throw new OfficeReadError('read_failed', 'Office 返回了无法识别的工作簿概览')
  }
  return sheets.map((sheet) => {
    const candidate = sheet as { name?: unknown; rows?: unknown }
    if (typeof candidate.name !== 'string' || !Array.isArray(candidate.rows)) {
      throw new OfficeReadError('read_failed', 'Office 返回了无法识别的工作表概览')
    }
    let rows = 0
    let columns = 0
    for (const row of candidate.rows) {
      const entry = row as { row?: unknown; cells?: unknown }
      if (Number.isSafeInteger(entry.row)) rows = Math.max(rows, Number(entry.row))
      if (!entry.cells || typeof entry.cells !== 'object') continue
      for (const ref of Object.keys(entry.cells as object)) {
        const match = /^([A-Z]+)\d+$/.exec(ref)
        if (match) columns = Math.max(columns, columnNumber(match[1]))
      }
    }
    return { name: candidate.name, rows, columns }
  })
}

function valueFromText(text: string, type: unknown): string | number | boolean {
  if (type === 'Number') {
    const number = Number(text)
    return Number.isFinite(number) ? number : text
  }
  if (type === 'Boolean') return text.toLowerCase() === 'true'
  return text
}

function valueType(type: unknown): OfficeReadValueType {
  if (type === 'Number') return 'number'
  if (type === 'String') return 'string'
  if (type === 'Boolean') return 'boolean'
  if (type === 'Date') return 'date'
  if (type === 'Error') return 'error'
  return 'unknown'
}

function readCell(value: unknown): OfficeReadCell {
  const cell = value as { path?: unknown; text?: unknown; format?: Record<string, unknown> }
  const ref = typeof cell.path === 'string' ? cell.path.slice(cell.path.lastIndexOf('/') + 1) : ''
  if (!/^[A-Z]+[1-9]\d*$/.test(ref) || typeof cell.text !== 'string' || !cell.format) {
    throw new OfficeReadError('read_failed', 'Office 返回了无法识别的单元格结果')
  }
  const formula = typeof cell.format.formula === 'string' ? `=${cell.format.formula}` : undefined
  const format = readCellFormat(cell.format)
  if (cell.format.evaluated === false || cell.text.startsWith('#OCLI_NOTEVAL!')) {
    return Object.freeze({
      ref,
      value: null,
      ...(formula ? { formula } : {}),
      valueType: 'error',
      evaluated: false,
      error: 'unsupported_function',
      ...(format ? { format } : {})
    })
  }
  if (cell.format.empty === true) {
    return Object.freeze({ ref, value: null, valueType: 'empty', ...(format ? { format } : {}) })
  }
  const source =
    cell.format.type === 'Boolean' ? cell.text : (cell.format.computedValue ?? cell.text)
  const text = typeof source === 'string' ? source : String(source)
  return Object.freeze({
    ref,
    value: valueFromText(text, cell.format.type),
    ...(formula ? { formula } : {}),
    valueType: valueType(cell.format.type),
    ...(formula ? { evaluated: cell.format.evaluated === true } : {}),
    ...(format ? { format } : {})
  })
}

function readCellFormat(value: Record<string, unknown>): OfficeReadCellFormat | undefined {
  const font = isRecord(value.font) ? value.font : undefined
  const alignment = isRecord(value.alignment) ? value.alignment : undefined
  const fill = normalizedFill(value.fill)
  const bold = value['font.bold'] === true || font?.bold === true
  const horizontalAlign = normalizedAlignment(
    value['alignment.horizontal'] ?? alignment?.horizontal
  )
  const numberFormat =
    typeof value.numberformat === 'string' && value.numberformat !== 'General'
      ? value.numberformat
      : undefined
  if (!bold && !fill && !horizontalAlign && !numberFormat) return undefined
  return Object.freeze({
    ...(bold ? { bold: true as const } : {}),
    ...(fill ? { fill } : {}),
    ...(horizontalAlign ? { horizontalAlign } : {}),
    ...(numberFormat ? { numberFormat } : {})
  })
}

function normalizedFill(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) return undefined
  return value.toUpperCase()
}

function normalizedAlignment(value: unknown): OfficeReadCellFormat['horizontalAlign'] | undefined {
  return value === 'left' || value === 'center' || value === 'right' ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseRangeCells(
  value: unknown,
  expected: ParsedOfficeRange
): readonly OfficeReadCell[] {
  const results = (value as { data?: { results?: unknown } }).data?.results
  const range = Array.isArray(results) ? (results[0] as { children?: unknown }) : undefined
  if (!Array.isArray(range?.children) || range.children.length !== expected.cellCount) {
    throw new OfficeReadError('read_failed', 'Office 返回的单元格数量与请求范围不一致')
  }
  const cells = range.children.map(readCell)
  let index = 0
  for (let row = expected.startRow; row <= expected.endRow; row += 1) {
    for (let column = expected.startColumn; column <= expected.endColumn; column += 1) {
      if (cells[index]?.ref !== `${columnName(column)}${row}`) {
        throw new OfficeReadError('read_failed', 'Office 返回的单元格顺序与请求范围不一致')
      }
      index += 1
    }
  }
  return Object.freeze(cells)
}

export function createOverviewResponse(
  revision: number,
  sheets: readonly WorkbookSheet[],
  warnings?: readonly string[]
): OfficeReadOverview {
  const summaries = sheets.map((sheet) =>
    Object.freeze({
      name: sheet.name,
      usedRange:
        sheet.rows === 0 || sheet.columns === 0
          ? null
          : `A1:${columnName(sheet.columns)}${sheet.rows}`,
      rowCount: sheet.rows,
      columnCount: sheet.columns
    })
  )
  return Object.freeze({
    revision,
    sheets: Object.freeze(summaries),
    complete: false,
    truncated: false,
    hint: '请指定 sheet 和 range（例如 Sheet1 与 A1:B3）后继续读取',
    limits: OFFICE_READ_RESPONSE_LIMITS,
    ...(warnings?.length ? { warnings: Object.freeze([...warnings]) } : {})
  })
}
