import { OFFICE_WORKBOOK_ADMISSION_LIMITS } from './office-limits'
import { OfficeImportError } from './office-import-contract'
import { OFFICE_IMPORT_RULES } from '../../../shared/officeProtocol'

export const OFFICE_IMPORT_LIMITS = Object.freeze({
  maxFileBytes: OFFICE_IMPORT_RULES.maxFileBytes,
  maxRows: OFFICE_WORKBOOK_ADMISSION_LIMITS.maxRows,
  maxColumns: OFFICE_WORKBOOK_ADMISSION_LIMITS.maxColumns,
  maxCells: OFFICE_WORKBOOK_ADMISSION_LIMITS.maxCells,
  maxCellTextLength: OFFICE_IMPORT_RULES.maxCellTextLength,
  // Import chunks are internal transactions, not Agent/human edit authorization limits.
  maxBatchCells: 2_000,
  maxBatchBytes: 256 * 1024
})

export function assertOfficeImportFileSize(bytes: number): void {
  if (bytes <= OFFICE_IMPORT_LIMITS.maxFileBytes) return
  throw new OfficeImportError(
    'import_too_large',
    `导入文件为 ${bytes} 字节，超过 ${OFFICE_IMPORT_LIMITS.maxFileBytes} 字节上限`,
    { bytes, maxBytes: OFFICE_IMPORT_LIMITS.maxFileBytes }
  )
}

export function assertOfficeImportDimensions(rows: number, columns: number): void {
  const cells = rows * columns
  const validIntegers = [rows, columns, cells].every(Number.isSafeInteger)
  if (
    validIntegers &&
    rows >= 0 &&
    columns >= 0 &&
    rows <= OFFICE_IMPORT_LIMITS.maxRows &&
    columns <= OFFICE_IMPORT_LIMITS.maxColumns &&
    cells <= OFFICE_IMPORT_LIMITS.maxCells
  ) {
    return
  }
  throw new OfficeImportError(
    'import_too_large',
    `导入数据为 ${rows} 行 × ${columns} 列（${cells} 格），上限为 ${OFFICE_IMPORT_LIMITS.maxRows} 行 × ${OFFICE_IMPORT_LIMITS.maxColumns} 列且不超过 ${OFFICE_IMPORT_LIMITS.maxCells} 格`,
    {
      rows,
      columns,
      cells,
      maxRows: OFFICE_IMPORT_LIMITS.maxRows,
      maxColumns: OFFICE_IMPORT_LIMITS.maxColumns,
      maxCells: OFFICE_IMPORT_LIMITS.maxCells
    }
  )
}

export function assertOfficeImportCellLength(value: string, row: number, column: number): void {
  const characters = [...value].length
  if (characters <= OFFICE_IMPORT_LIMITS.maxCellTextLength) return
  throw new OfficeImportError(
    'import_too_large',
    `第 ${row} 行第 ${column} 列包含 ${characters} 个字符，超过单元格 ${OFFICE_IMPORT_LIMITS.maxCellTextLength} 字符上限`,
    { row, column, characters, maxCharacters: OFFICE_IMPORT_LIMITS.maxCellTextLength }
  )
}
