import {
  OFFICE_READ_LIMITS,
  OfficeReadError,
  columnNumber,
  parseOfficeRange,
  validOfficeSheetName
} from './office-read-contract'
import {
  OFFICE_WRITE_LIMITS,
  OfficeWriteError,
  type OfficeCellEditParams,
  type OfficeCellValue,
  type OfficeDescribeCellEditParams,
  type OfficeRangeEditParams
} from './office-write-contract'

function hasInvalidCellText(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0)
    if (
      (code < 32 && code !== 9 && code !== 10) ||
      code === 127 ||
      (code >= 0x80 && code <= 0x9f)
    ) {
      return true
    }
  }
  return false
}

function assertSheet(sheet: unknown): asserts sheet is string {
  if (
    typeof sheet !== 'string' ||
    !validOfficeSheetName(sheet) ||
    [...sheet].some((character) => {
      const code = character.charCodeAt(0)
      return code >= 0x80 && code <= 0x9f
    })
  ) {
    throw new OfficeWriteError('invalid_sheet', '工作表名称无效')
  }
}

function normalizedCell(cell: unknown): string {
  if (typeof cell !== 'string' || cell !== cell.trim()) {
    throw new OfficeWriteError('invalid_cell', '单元格必须使用单个 A1 地址')
  }
  const normalized = cell.toUpperCase()
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(normalized)
  if (
    !match ||
    columnNumber(match[1]) > OFFICE_READ_LIMITS.maxColumns ||
    Number(match[2]) > OFFICE_READ_LIMITS.maxRows
  ) {
    throw new OfficeWriteError('invalid_cell', '单元格必须使用有效的单个 A1 地址')
  }
  return normalized
}

export function normalizeOfficeWriteTarget(
  sheet: unknown,
  cell: unknown
): Readonly<{ sheet: string; cell: string }> {
  assertSheet(sheet)
  return Object.freeze({ sheet, cell: normalizedCell(cell) })
}

export function normalizeOfficeWriteRevision(baseRevision: unknown): number {
  if (!Number.isSafeInteger(baseRevision) || Number(baseRevision) < 0) {
    throw new OfficeWriteError('revision_conflict', '内容版本无效，请先重新读取文档')
  }
  return Number(baseRevision)
}

function assertValue(value: unknown): asserts value is OfficeCellValue {
  if (typeof value === 'string') {
    if (value.startsWith('=')) {
      throw new OfficeWriteError(
        'formula_not_supported',
        '以 = 开头的字面文本当前不支持；要写公式请使用 set_formula'
      )
    }
    if (value.length > OFFICE_WRITE_LIMITS.maxCellTextLength || hasInvalidCellText(value)) {
      throw new OfficeWriteError('invalid_value', '单元格文本过长或包含不支持的控制字符')
    }
    return
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new OfficeWriteError('invalid_value', '单元格数值必须是有限数')
    }
    return
  }
  if (typeof value !== 'boolean') {
    throw new OfficeWriteError('invalid_value', '单元格值必须是文本、数字或布尔值')
  }
}

function assertRangeValue(value: unknown): asserts value is OfficeCellValue {
  assertValue(value)
  if (value === '') {
    throw new OfficeWriteError('invalid_value', '范围写入不支持空字符串；请缩小或改用非空值')
  }
}

function parsedWriteRange(range: unknown): ReturnType<typeof parseOfficeRange> {
  if (typeof range !== 'string' || range !== range.trim()) {
    throw new OfficeWriteError('invalid_value', '写入范围必须使用 A1:B2 形式的矩形范围')
  }
  const match = /^([A-Za-z]+)([1-9]\d*):([A-Za-z]+)([1-9]\d*)$/.exec(range)
  if (!match) throw new OfficeWriteError('invalid_value', '写入范围必须使用 A1:B2 形式的矩形范围')
  const parsed = readWriteRange(range)
  if (
    columnNumber(match[1].toUpperCase()) > columnNumber(match[3].toUpperCase()) ||
    Number(match[2]) > Number(match[4])
  ) {
    throw new OfficeWriteError('invalid_value', '写入范围起点必须位于终点左上方')
  }
  assertWriteRangeLimits(parsed)
  return parsed
}

function readWriteRange(range: string): ReturnType<typeof parseOfficeRange> {
  try {
    return parseOfficeRange(range)
  } catch (error) {
    if (error instanceof OfficeReadError && error.code === 'range_out_of_bounds') {
      throw new OfficeWriteError(
        'range_out_of_bounds',
        '写入范围超出准入边界，请缩小到 A1:J1000 内'
      )
    }
    throw new OfficeWriteError('invalid_value', '写入范围必须使用 A1:B2 形式的矩形范围')
  }
}

function assertWriteRangeLimits(parsed: ReturnType<typeof parseOfficeRange>): void {
  if (
    parsed.endRow > OFFICE_WRITE_LIMITS.maxRows ||
    parsed.endColumn > OFFICE_WRITE_LIMITS.maxColumns
  ) {
    throw new OfficeWriteError('range_out_of_bounds', '写入范围超出准入边界，请缩小到 A1:J1000 内')
  }
  if (parsed.cellCount > OFFICE_WRITE_LIMITS.maxCells) {
    throw new OfficeWriteError('range_too_large', '单次最多写入 2000 个单元格，请缩小范围')
  }
  if (parsed.cellCount === 1) {
    throw new OfficeWriteError('invalid_value', '单个单元格请使用 set_cell')
  }
}

function normalizedRangeValues(
  values: unknown,
  rowCount: number,
  columnCount: number
): readonly (readonly OfficeCellValue[])[] {
  if (!Array.isArray(values) || values.length !== rowCount) {
    throw new OfficeWriteError('invalid_value', 'values 行数必须与写入范围严格一致')
  }
  return Object.freeze(
    values.map((row) => {
      if (!Array.isArray(row) || row.length !== columnCount) {
        throw new OfficeWriteError('invalid_value', 'values 每行列数必须与写入范围严格一致')
      }
      return Object.freeze(
        row.map((value, index) => {
          if (!Object.hasOwn(row, index)) {
            throw new OfficeWriteError('invalid_value', 'values 必须是完整的行优先二维数组')
          }
          assertRangeValue(value)
          return value
        })
      )
    })
  )
}

export function validateRangeEditParams(params: unknown): OfficeRangeEditParams {
  if (!isRecord(params)) throw new OfficeWriteError('invalid_value', '范围写入参数必须是对象')
  if (
    Object.keys(params).some((key) => !['sheet', 'range', 'values', 'baseRevision'].includes(key))
  ) {
    throw new OfficeWriteError('invalid_value', '范围写入参数包含不支持的字段')
  }
  assertSheet(params.sheet)
  const parsed = parsedWriteRange(params.range)
  const values = normalizedRangeValues(params.values, parsed.rowCount, parsed.columnCount)
  const baseRevision = normalizeOfficeWriteRevision(params.baseRevision)
  return Object.freeze({
    sheet: params.sheet,
    range: parsed.range,
    values,
    rowCount: parsed.rowCount,
    columnCount: parsed.columnCount,
    cellCount: parsed.cellCount,
    baseRevision
  })
}

export function validateCellEditParams(params: unknown): OfficeCellEditParams {
  if (!isRecord(params)) {
    throw new OfficeWriteError('invalid_value', '单元格写入参数必须是对象')
  }
  assertSheet(params.sheet)
  const cell = normalizedCell(params.cell)
  assertValue(params.value)
  return Object.freeze({
    sheet: params.sheet,
    cell,
    value: params.value,
    baseRevision: normalizeOfficeWriteRevision(params.baseRevision)
  })
}

export function validateCellDescriptionParams(params: unknown): OfficeDescribeCellEditParams {
  if (!isRecord(params)) {
    throw new OfficeWriteError('invalid_value', '单元格写入参数必须是对象')
  }
  assertSheet(params.sheet)
  const cell = normalizedCell(params.cell)
  assertValue(params.value)
  return Object.freeze({ sheet: params.sheet, cell, value: params.value })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
