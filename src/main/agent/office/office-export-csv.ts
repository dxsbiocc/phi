import {
  OFFICE_EXPORT_LIMITS,
  OfficeExportError,
  type OfficeExportCellValue,
  type OfficeExportFormat,
  type OfficeExportSheetData
} from './office-export-contract'

export interface OfficeExportSerializedData {
  readonly bytes: Buffer
  readonly rows: number
  readonly columns: number
}

function textFor(value: OfficeExportCellValue): string {
  if (value === null) return ''
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE'
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new OfficeExportError('computed_value_unavailable', '导出值不是有限数值')
  }
  return String(value)
}

function escapedField(value: OfficeExportCellValue, delimiter: ',' | '\t'): string {
  const text = textFor(value)
  if (!text.includes(delimiter) && !/["\r\n]/u.test(text)) return text
  return `"${text.replaceAll('"', '""')}"`
}

function cellAt(data: OfficeExportSheetData, row: number, column: number): OfficeExportCellValue {
  return data.values[row]?.[column] ?? null
}

function populated(value: OfficeExportCellValue): boolean {
  return value !== null && value !== ''
}

function trimmedDimensions(data: OfficeExportSheetData): { rows: number; columns: number } {
  let rows = data.rows
  while (
    rows > 0 &&
    !Array.from({ length: data.columns }, (_, column) => cellAt(data, rows - 1, column)).some(
      populated
    )
  ) {
    rows -= 1
  }
  let columns = data.columns
  while (
    columns > 0 &&
    !Array.from({ length: rows }, (_, row) => cellAt(data, row, columns - 1)).some(populated)
  ) {
    columns -= 1
  }
  return { rows, columns }
}

export function serializeOfficeDelimited(
  data: OfficeExportSheetData,
  format: OfficeExportFormat
): OfficeExportSerializedData {
  const delimiter = format === 'csv' ? ',' : '\t'
  const dimensions = trimmedDimensions(data)
  const text = Array.from({ length: dimensions.rows }, (_, row) =>
    Array.from({ length: dimensions.columns }, (_, column) =>
      escapedField(cellAt(data, row, column), delimiter)
    ).join(delimiter)
  ).join('\n')
  const bytes = Buffer.from(text.length === 0 ? '' : `${text}\n`, 'utf8')
  if (bytes.length > OFFICE_EXPORT_LIMITS.maxFileBytes) {
    throw new OfficeExportError('export_too_large', '导出文件超过 16 MiB 上限')
  }
  return Object.freeze({ bytes, ...dimensions })
}
