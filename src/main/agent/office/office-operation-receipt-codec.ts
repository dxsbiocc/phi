import {
  OFFICE_WRITE_ERROR_CODES,
  type OfficeCellEditResult,
  type OfficeCellValue,
  type OfficeFormulaEditResult,
  type OfficeFormulaInvalidReason,
  type OfficeFormulaInvalidResult,
  type OfficeFormatRangeResult,
  type OfficeRangeEditResult,
  type OfficeWriteErrorCode,
  type OfficeWriteReceiptResult
} from './office-write-contract'
import type { OfficeOperationReceipt } from './office-operation-log'
import { decodeAddSheetResult, validOfficeSheetNames } from './office-sheet-receipt-codec'
import { decodeOfficeDocxResult } from './office-docx-receipt-codec'
import { decodeOfficePptxResult } from './office-pptx-receipt-codec'

export function decodeOfficeOperationReceipt(value: unknown): OfficeOperationReceipt {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new Error('invalid operation receipt')
  }
  if (value.ok) {
    if (!hasOnlyKeys(value, ['ok', 'value'])) throw new Error('invalid success receipt fields')
    const result = decodedResult(value.value)
    if (result.applied !== true) throw new Error('invalid success receipt result')
    return { ok: true, value: result }
  }
  if (!hasOnlyKeys(value, ['ok', 'error'])) throw new Error('invalid failure receipt fields')
  if (!isRecord(value.error) || !validErrorCode(value.error.code)) {
    throw new Error('invalid operation error')
  }
  if (!hasOnlyKeys(value.error, ['code', 'result', 'currentRevision', 'sheetNames'])) {
    throw new Error('invalid operation error fields')
  }
  if (value.error.currentRevision !== undefined && !validRevision(value.error.currentRevision)) {
    throw new Error('invalid operation error revision')
  }
  if (value.error.sheetNames !== undefined && !validOfficeSheetNames(value.error.sheetNames)) {
    throw new Error('invalid operation error sheet names')
  }
  return {
    ok: false,
    error: {
      code: value.error.code,
      ...(value.error.result === undefined ? {} : { result: decodedResult(value.error.result) }),
      ...(validRevision(value.error.currentRevision)
        ? { currentRevision: value.error.currentRevision }
        : {}),
      ...(Array.isArray(value.error.sheetNames) ? { sheetNames: value.error.sheetNames } : {})
    }
  }
}

function decodedResult(value: unknown): OfficeWriteReceiptResult {
  if (!isRecord(value) || !validRevision(value.revision)) throw new Error('invalid write result')
  if (Object.hasOwn(value, 'slideId')) return decodeOfficePptxResult(value)
  if (Object.hasOwn(value, 'paraId')) return decodeOfficeDocxResult(value)
  if (Object.hasOwn(value, 'sheetNames')) return decodeAddSheetResult(value)
  if (Object.hasOwn(value, 'formula')) return decodedFormulaResult(value)
  if (Object.hasOwn(value, 'appliedFormat')) return decodedFormatResult(value)
  return Object.hasOwn(value, 'range') ? decodedRangeResult(value) : decodedCellResult(value)
}

function decodedFormatResult(value: Record<string, unknown>): OfficeFormatRangeResult {
  if (
    !hasOnlyKeys(value, [
      'applied',
      'saved',
      'revision',
      'sheet',
      'range',
      'rowCount',
      'columnCount',
      'changedCells',
      'appliedFormat',
      'previewConfirmed',
      'warnings',
      'deduplicated',
      'reconciled'
    ]) ||
    typeof value.sheet !== 'string' ||
    typeof value.range !== 'string' ||
    typeof value.applied !== 'boolean' ||
    typeof value.saved !== 'boolean' ||
    !validRevision(value.revision) ||
    !positiveInteger(value.rowCount) ||
    !positiveInteger(value.columnCount) ||
    !nonnegativeInteger(value.changedCells) ||
    !validFormat(value.appliedFormat) ||
    typeof value.previewConfirmed !== 'boolean' ||
    (value.warnings !== undefined && !validWarnings(value.warnings)) ||
    (value.deduplicated !== undefined && value.deduplicated !== true) ||
    (value.reconciled !== undefined && value.reconciled !== true)
  ) {
    throw new Error('invalid format write result')
  }
  return {
    applied: value.applied,
    saved: value.saved,
    revision: value.revision,
    sheet: value.sheet,
    range: value.range,
    rowCount: value.rowCount,
    columnCount: value.columnCount,
    changedCells: value.changedCells,
    appliedFormat: value.appliedFormat,
    previewConfirmed: value.previewConfirmed,
    ...(value.warnings ? { warnings: value.warnings } : {}),
    ...(value.deduplicated === true ? { deduplicated: true } : {}),
    ...(value.reconciled === true ? { reconciled: true } : {})
  }
}

function validFormat(value: unknown): value is OfficeFormatRangeResult['appliedFormat'] {
  if (!isRecord(value) || Object.keys(value).length === 0) return false
  if (!hasOnlyKeys(value, ['bold', 'fill', 'horizontalAlign', 'numberFormat'])) return false
  if (value.bold !== undefined && typeof value.bold !== 'boolean') return false
  if (
    value.fill !== undefined &&
    (typeof value.fill !== 'string' || !/^#[0-9A-F]{6}$/u.test(value.fill))
  ) {
    return false
  }
  if (
    value.horizontalAlign !== undefined &&
    !['left', 'center', 'right'].includes(String(value.horizontalAlign))
  ) {
    return false
  }
  return (
    value.numberFormat === undefined ||
    ['General', '0', '0.00', '#,##0', '#,##0.00'].includes(String(value.numberFormat))
  )
}

function decodedFormulaResult(
  value: Record<string, unknown>
): OfficeFormulaEditResult | OfficeFormulaInvalidResult {
  return value.applied === false ? decodedFormulaInvalidResult(value) : decodedFormulaSuccess(value)
}

function decodedFormulaSuccess(value: Record<string, unknown>): OfficeFormulaEditResult {
  if (
    !hasOnlyKeys(value, [
      'applied',
      'saved',
      'revision',
      'sheet',
      'cell',
      'formula',
      'computedValue',
      'valueType',
      'previewConfirmed',
      'warnings',
      'deduplicated',
      'reconciled'
    ]) ||
    value.applied !== true ||
    typeof value.saved !== 'boolean' ||
    value.previewConfirmed === undefined ||
    typeof value.previewConfirmed !== 'boolean' ||
    !validRevision(value.revision) ||
    typeof value.sheet !== 'string' ||
    typeof value.cell !== 'string' ||
    typeof value.formula !== 'string' ||
    !validCellValue(value.computedValue, false) ||
    !validValueType(value.valueType) ||
    (value.warnings !== undefined && !validWarnings(value.warnings)) ||
    (value.deduplicated !== undefined && value.deduplicated !== true) ||
    (value.reconciled !== undefined && value.reconciled !== true)
  )
    throw new Error('invalid formula write result')
  return {
    applied: true,
    saved: value.saved,
    revision: value.revision,
    sheet: value.sheet,
    cell: value.cell,
    formula: value.formula,
    computedValue: value.computedValue,
    valueType: value.valueType,
    previewConfirmed: value.previewConfirmed,
    ...(value.warnings ? { warnings: value.warnings } : {}),
    ...(value.deduplicated === true ? { deduplicated: true } : {}),
    ...(value.reconciled === true ? { reconciled: true } : {})
  }
}

function decodedFormulaInvalidResult(value: Record<string, unknown>): OfficeFormulaInvalidResult {
  if (
    !hasOnlyKeys(value, [
      'applied',
      'saved',
      'revision',
      'sheet',
      'cell',
      'formula',
      'formulaStatus',
      'reason',
      'previewConfirmed',
      'deduplicated'
    ]) ||
    value.applied !== false ||
    value.saved !== true ||
    value.previewConfirmed !== false ||
    !validRevision(value.revision) ||
    typeof value.sheet !== 'string' ||
    typeof value.cell !== 'string' ||
    typeof value.formula !== 'string' ||
    !validFormulaStatus(value.formulaStatus) ||
    !validFormulaReason(value.reason) ||
    (value.deduplicated !== undefined && value.deduplicated !== true)
  )
    throw new Error('invalid formula failure result')
  return {
    applied: false,
    saved: true,
    revision: value.revision,
    sheet: value.sheet,
    cell: value.cell,
    formula: value.formula,
    formulaStatus: value.formulaStatus,
    reason: value.reason,
    previewConfirmed: false,
    ...(value.deduplicated === true ? { deduplicated: true } : {})
  }
}

function validFormulaStatus(value: unknown): value is OfficeFormulaInvalidResult['formulaStatus'] {
  return (
    isRecord(value) &&
    hasOnlyKeys(value, ['formula', 'evaluated', 'computedValue', 'valueType']) &&
    (value.formula === undefined || typeof value.formula === 'string') &&
    typeof value.evaluated === 'boolean' &&
    validCellValue(value.computedValue, true) &&
    validValueType(value.valueType)
  )
}

function validFormulaReason(value: unknown): value is OfficeFormulaInvalidReason {
  return (
    typeof value === 'string' &&
    [
      'formula_mismatch',
      'invalid_syntax',
      'unsupported_function',
      'not_evaluated',
      'error_value',
      'circular_reference',
      'reference_graph_too_large'
    ].includes(value)
  )
}

function validValueType(value: unknown): value is OfficeFormulaEditResult['valueType'] {
  return ['empty', 'string', 'number', 'boolean', 'date', 'error', 'unknown'].includes(
    String(value)
  )
}

function decodedCellResult(value: Record<string, unknown>): OfficeCellEditResult {
  if (
    !validRevision(value.revision) ||
    !hasOnlyKeys(value, [
      'applied',
      'saved',
      'revision',
      'sheet',
      'cell',
      'before',
      'after',
      'previewConfirmed',
      'warnings',
      'deduplicated',
      'reconciled'
    ]) ||
    typeof value.sheet !== 'string' ||
    typeof value.cell !== 'string' ||
    !validCellValue(value.before, true) ||
    !validCellValue(value.after, true) ||
    typeof value.applied !== 'boolean' ||
    typeof value.saved !== 'boolean' ||
    typeof value.previewConfirmed !== 'boolean' ||
    (value.warnings !== undefined && !validWarnings(value.warnings)) ||
    (value.deduplicated !== undefined && value.deduplicated !== true) ||
    (value.reconciled !== undefined && value.reconciled !== true)
  ) {
    throw new Error('invalid cell write result')
  }
  return {
    applied: value.applied,
    saved: value.saved,
    revision: value.revision,
    sheet: value.sheet,
    cell: value.cell,
    before: value.before,
    after: value.after,
    previewConfirmed: value.previewConfirmed,
    ...(value.warnings ? { warnings: value.warnings } : {}),
    ...(value.deduplicated === true ? { deduplicated: true } : {}),
    ...(value.reconciled === true ? { reconciled: true } : {})
  }
}

function decodedRangeResult(value: Record<string, unknown>): OfficeRangeEditResult {
  if (
    !hasOnlyKeys(value, [
      'applied',
      'saved',
      'revision',
      'sheet',
      'range',
      'rowCount',
      'columnCount',
      'changedCells',
      'preview',
      'beforeHash',
      'afterHash',
      'previewConfirmed',
      'warnings',
      'deduplicated',
      'reconciled'
    ]) ||
    typeof value.sheet !== 'string' ||
    typeof value.range !== 'string' ||
    typeof value.applied !== 'boolean' ||
    typeof value.saved !== 'boolean' ||
    !validRevision(value.revision) ||
    !positiveInteger(value.rowCount) ||
    !positiveInteger(value.columnCount) ||
    !nonnegativeInteger(value.changedCells) ||
    !validRangePreview(value.preview) ||
    !/^[a-f0-9]{64}$/u.test(String(value.beforeHash)) ||
    !/^[a-f0-9]{64}$/u.test(String(value.afterHash)) ||
    typeof value.previewConfirmed !== 'boolean' ||
    (value.warnings !== undefined && !validWarnings(value.warnings)) ||
    (value.deduplicated !== undefined && value.deduplicated !== true) ||
    (value.reconciled !== undefined && value.reconciled !== true)
  ) {
    throw new Error('invalid range write result')
  }
  return {
    applied: value.applied,
    saved: value.saved,
    revision: value.revision,
    sheet: value.sheet,
    range: value.range,
    rowCount: value.rowCount,
    columnCount: value.columnCount,
    changedCells: value.changedCells,
    preview: value.preview,
    beforeHash: value.beforeHash as string,
    afterHash: value.afterHash as string,
    previewConfirmed: value.previewConfirmed,
    ...(value.warnings ? { warnings: value.warnings } : {}),
    ...(value.deduplicated === true ? { deduplicated: true } : {}),
    ...(value.reconciled === true ? { reconciled: true } : {})
  }
}

function validRangePreview(value: unknown): value is OfficeRangeEditResult['preview'] {
  return (
    Array.isArray(value) &&
    value.length <= 6 &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        hasOnlyKeys(entry, ['cell', 'before', 'after']) &&
        typeof entry.cell === 'string' &&
        validCellValue(entry.before, true) &&
        validCellValue(entry.after, false)
    )
  )
}

function validRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function nonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function validCellValue(value: unknown, allowNull: false): value is OfficeCellValue
function validCellValue(value: unknown, allowNull: true): value is OfficeCellValue | null
function validCellValue(value: unknown, allowNull: boolean): value is OfficeCellValue | null {
  return (
    (allowNull && value === null) ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}

function validWarnings(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
}

function validErrorCode(value: unknown): value is OfficeWriteErrorCode {
  return (
    typeof value === 'string' && (OFFICE_WRITE_ERROR_CODES as readonly string[]).includes(value)
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}
