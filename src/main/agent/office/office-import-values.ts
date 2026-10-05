import type { OfficeImportCellValue } from './office-import-contract'

export const OFFICE_IMPORT_DECIMAL_PATTERN = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u
const MAX_SAFE_SIGNIFICANT_DIGITS = 15

export interface ClassifiedOfficeImportValue {
  readonly type: 'string' | 'number'
  readonly value: OfficeImportCellValue
}

function significantDigits(value: string): number {
  const digits = value.replace(/^-/, '').replace('.', '').replace(/^0+/, '')
  return digits.length
}

export function classifyOfficeImportValue(source: string): ClassifiedOfficeImportValue {
  if (!OFFICE_IMPORT_DECIMAL_PATTERN.test(source)) return { type: 'string', value: source }
  if (significantDigits(source) > MAX_SAFE_SIGNIFICANT_DIGITS) {
    return { type: 'string', value: source }
  }
  const value = Number(source)
  const underflowed = value === 0 && /[1-9]/u.test(source)
  if (
    !Number.isFinite(value) ||
    underflowed ||
    (Number.isInteger(value) && !Number.isSafeInteger(value))
  ) {
    return { type: 'string', value: source }
  }
  return { type: 'number', value }
}

export function convertOfficeImportRows(
  rows: readonly (readonly string[])[]
): readonly (readonly OfficeImportCellValue[])[] {
  return Object.freeze(
    rows.map((row) => Object.freeze(row.map((value) => classifyOfficeImportValue(value).value)))
  )
}
