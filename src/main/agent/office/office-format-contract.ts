import {
  OfficeReadError,
  columnNumber,
  parseOfficeRange,
  validOfficeSheetName
} from './office-read-contract'
import {
  OFFICE_WRITE_LIMITS,
  OfficeWriteError,
  type OfficeFormatRangeParams,
  type OfficeHorizontalAlign,
  type OfficeRangeFormat
} from './office-write-contract'

export const OFFICE_NUMBER_FORMATS = Object.freeze([
  'General',
  '0',
  '0.00',
  '#,##0',
  '#,##0.00'
] as const)

const FORMAT_KEYS = ['bold', 'fill', 'horizontalAlign', 'numberFormat'] as const

export function validateFormatRangeParams(value: unknown): OfficeFormatRangeParams {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sheet', 'range', 'format', 'baseRevision'])) {
    throw new OfficeWriteError('invalid_value', '格式写入参数字段无效')
  }
  const sheet = normalizedSheet(value.sheet)
  const range = parsedFormatRange(value.range)
  const format = normalizedFormat(value.format)
  const baseRevision = normalizedRevision(value.baseRevision)
  return Object.freeze({
    sheet,
    range: range.range,
    format,
    rowCount: range.rowCount,
    columnCount: range.columnCount,
    cellCount: range.cellCount,
    baseRevision
  })
}

function normalizedSheet(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !validOfficeSheetName(value) ||
    [...value].some((character) => {
      const code = character.charCodeAt(0)
      return code >= 0x80 && code <= 0x9f
    })
  ) {
    throw new OfficeWriteError('invalid_sheet', '工作表名称无效')
  }
  return value
}

function parsedFormatRange(value: unknown): ReturnType<typeof parseOfficeRange> {
  if (typeof value !== 'string' || value !== value.trim()) {
    throw new OfficeWriteError('invalid_value', '格式范围必须使用 A1:B2 形式的矩形范围')
  }
  const match = /^([A-Za-z]+)([1-9]\d*)(?::([A-Za-z]+)([1-9]\d*))?$/.exec(value)
  if (!match) {
    throw new OfficeWriteError('invalid_value', '格式范围必须使用 A1:B2 形式的矩形范围')
  }
  const parsed = parseRange(value)
  if (
    match[3] &&
    (columnNumber(match[1].toUpperCase()) > columnNumber(match[3].toUpperCase()) ||
      Number(match[2]) > Number(match[4]))
  ) {
    throw new OfficeWriteError('invalid_value', '格式范围起点必须位于终点左上方')
  }
  if (
    parsed.endRow > OFFICE_WRITE_LIMITS.maxRows ||
    parsed.endColumn > OFFICE_WRITE_LIMITS.maxColumns
  ) {
    throw new OfficeWriteError('range_out_of_bounds', '格式范围超出准入边界，请缩小到 A1:J1000 内')
  }
  if (parsed.cellCount > OFFICE_WRITE_LIMITS.maxCells) {
    throw new OfficeWriteError('range_too_large', '单次最多设置 2000 个单元格格式，请缩小范围')
  }
  return parsed
}

function parseRange(value: string): ReturnType<typeof parseOfficeRange> {
  try {
    return parseOfficeRange(value)
  } catch (error) {
    if (error instanceof OfficeReadError && error.code === 'range_out_of_bounds') {
      throw new OfficeWriteError(
        'range_out_of_bounds',
        '格式范围超出准入边界，请缩小到 A1:J1000 内'
      )
    }
    throw new OfficeWriteError('invalid_value', '格式范围必须使用 A1:B2 形式的矩形范围')
  }
}

function normalizedFormat(value: unknown): OfficeRangeFormat {
  if (!isRecord(value) || !hasOnlyKeys(value, FORMAT_KEYS) || Object.keys(value).length === 0) {
    throw new OfficeWriteError('invalid_value', 'format 至少包含一个受支持的格式属性')
  }
  const bold = optionalBold(value.bold)
  const fill = optionalFill(value.fill)
  const horizontalAlign = optionalAlignment(value.horizontalAlign)
  const numberFormat = optionalNumberFormat(value.numberFormat)
  return Object.freeze({
    ...(bold === undefined ? {} : { bold }),
    ...(fill === undefined ? {} : { fill }),
    ...(horizontalAlign === undefined ? {} : { horizontalAlign }),
    ...(numberFormat === undefined ? {} : { numberFormat })
  })
}

function optionalBold(value: unknown): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw invalidFormatValue('bold 必须是布尔值')
  return value
}

function optionalFill(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !/^#[0-9a-f]{6}$/iu.test(value)) {
    throw invalidFormatValue('fill 必须是 #RRGGBB 颜色')
  }
  return value.toUpperCase()
}

function optionalAlignment(value: unknown): OfficeHorizontalAlign | undefined {
  if (value === undefined) return undefined
  if (value !== 'left' && value !== 'center' && value !== 'right') {
    throw invalidFormatValue('horizontalAlign 只支持 left、center、right')
  }
  return value
}

function optionalNumberFormat(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || !(OFFICE_NUMBER_FORMATS as readonly string[]).includes(value)) {
    throw invalidFormatValue(`numberFormat 只支持 ${OFFICE_NUMBER_FORMATS.join('、')}`)
  }
  return value
}

function normalizedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new OfficeWriteError('revision_conflict', '内容版本无效，请先重新读取文档')
  }
  return Number(value)
}

function invalidFormatValue(message: string): OfficeWriteError {
  return new OfficeWriteError('invalid_value', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}
