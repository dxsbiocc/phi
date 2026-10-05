import { formatFormatApprovalSummary } from './office-approval-summary'
import { OFFICE_NUMBER_FORMATS, validateFormatRangeParams } from './office-format-contract'
import type { OfficeReadCell } from './office-read-contract'
import {
  OfficeWriteError,
  type OfficeCellFormatState,
  type OfficeCellValue,
  type OfficeFormatBeforeCell,
  type OfficeFormatRangeDescription,
  type OfficeFormatRangeOperation,
  type OfficeFormatRangeResult,
  type OfficeRangeFormat,
  type OfficeWriteBefore,
  type OfficeWriteRequest,
  type OfficeWriteSnapshot,
  type OfficeWriteSnapshotCell
} from './office-write-contract'
import type {
  OfficeBatchCommand,
  OfficeWriteOperationStrategy
} from './office-write-operation-types'
import {
  hasOnlyKeys,
  invalidEvidence,
  invalidReadback,
  isRecord,
  rangeCells,
  snapshotOf
} from './office-write-snapshot'

export { OFFICE_NUMBER_FORMATS }

export const formatRangeStrategy: OfficeWriteOperationStrategy = {
  type: 'format_range',
  validate(operation, baseRevision) {
    if (!isRecord(operation) || !hasOnlyKeys(operation, ['type', 'sheet', 'range', 'format'])) {
      throw new OfficeWriteError('invalid_value', 'format_range 操作字段无效')
    }
    return formatRangeWriteRequest({
      sheet: operation.sheet,
      range: operation.range,
      format: operation.format,
      baseRevision
    })
  },
  digestInput(request) {
    const operation = request.operation as OfficeFormatRangeOperation
    return {
      operation: {
        type: operation.type,
        sheet: operation.sheet,
        range: operation.range,
        format: operation.format
      },
      baseRevision: request.baseRevision
    }
  },
  affectedCells(operation) {
    return rangeCells(operation as OfficeFormatRangeOperation)
  },
  readRange(operation) {
    return (operation as OfficeFormatRangeOperation).range
  },
  expected(operation, before) {
    if (!before) throw invalidEvidence()
    return expectedSnapshot(operation as OfficeFormatRangeOperation, before)
  },
  commands(operation) {
    return [formatCommand(operation as OfficeFormatRangeOperation)]
  },
  previewCondition(operation) {
    const range = operation as OfficeFormatRangeOperation
    return { kind: 'cells', sheet: range.sheet, cells: rangeCells(range) }
  },
  snapshot(operation, cells) {
    return formatSnapshot(operation as OfficeFormatRangeOperation, cells)
  },
  verify(operation, before, current) {
    return (
      sameData(before, current) &&
      requestedFormatMatches(current, (operation as OfficeFormatRangeOperation).format)
    )
  },
  before(_operation, snapshot) {
    return formatBefore(snapshot)
  },
  restoreBefore(operation, before) {
    return restoreBefore(operation as OfficeFormatRangeOperation, before)
  },
  describe(request, before, documentName, revision) {
    const operation = request.operation as OfficeFormatRangeOperation
    return Object.freeze({
      type: 'format_range',
      documentName,
      sheet: operation.sheet,
      range: operation.range,
      rowCount: operation.rowCount,
      columnCount: operation.columnCount,
      cellCount: operation.cellCount,
      changedCells: changedFormatCells(before, operation.format),
      format: operation.format,
      revision
    }) satisfies OfficeFormatRangeDescription
  },
  approvalSummary(description) {
    return formatFormatApprovalSummary(description as OfficeFormatRangeDescription)
  },
  result(request, before, revision, saved, previewConfirmed) {
    const operation = request.operation as OfficeFormatRangeOperation
    return Object.freeze({
      applied: true,
      saved,
      revision,
      sheet: operation.sheet,
      range: operation.range,
      rowCount: operation.rowCount,
      columnCount: operation.columnCount,
      changedCells: changedFormatCells(before, operation.format),
      appliedFormat: operation.format,
      previewConfirmed,
      ...(previewConfirmed ? {} : { warnings: Object.freeze(['preview_not_confirmed']) })
    }) satisfies OfficeFormatRangeResult
  },
  classify(operation, before, current) {
    return classifyFormat(operation as OfficeFormatRangeOperation, before, current)
  }
}

export function formatRangeWriteRequest(value: unknown): OfficeWriteRequest {
  const input = validateFormatRangeParams(value)
  const operation: OfficeFormatRangeOperation = Object.freeze({
    type: 'format_range',
    sheet: input.sheet,
    range: input.range,
    format: input.format,
    rowCount: input.rowCount,
    columnCount: input.columnCount,
    cellCount: input.cellCount
  })
  return Object.freeze({ operation, baseRevision: input.baseRevision })
}

function formatCommand(operation: OfficeFormatRangeOperation): OfficeBatchCommand {
  return Object.freeze({
    command: 'set',
    path: `/${operation.sheet}/${operation.range}`,
    props: Object.freeze({
      ...(operation.format.bold === undefined
        ? {}
        : { bold: operation.format.bold ? ('true' as const) : ('false' as const) }),
      ...(operation.format.fill ? { fill: operation.format.fill } : {}),
      ...(operation.format.horizontalAlign
        ? { 'alignment.horizontal': operation.format.horizontalAlign }
        : {}),
      ...(operation.format.numberFormat ? { numfmt: operation.format.numberFormat } : {})
    })
  })
}

function formatSnapshot(
  operation: OfficeFormatRangeOperation,
  cells: readonly OfficeReadCell[]
): OfficeWriteSnapshot {
  const refs = rangeCells(operation)
  if (cells.length !== refs.length) throw invalidReadback()
  return snapshotOf(
    cells.map((cell, index) => {
      if (cell.ref !== refs[index] || !validCellValue(cell.value)) throw invalidReadback()
      return Object.freeze({
        ref: cell.ref,
        value: cell.value,
        valueType: cell.valueType ?? inferredValueType(cell.value),
        ...(cell.formula === undefined ? {} : { formula: cell.formula }),
        ...(cell.evaluated === undefined ? {} : { evaluated: cell.evaluated }),
        format: requestedFormatState(operation.format, cell.format)
      })
    }),
    operation.rowCount,
    operation.columnCount
  )
}

function requestedFormatState(
  requested: OfficeRangeFormat,
  current: OfficeReadCell['format']
): OfficeCellFormatState {
  return Object.freeze({
    ...(requested.bold === undefined ? {} : { bold: current?.bold === true }),
    ...(requested.fill === undefined ? {} : { fill: current?.fill ?? null }),
    ...(requested.horizontalAlign === undefined
      ? {}
      : { horizontalAlign: current?.horizontalAlign ?? null }),
    ...(requested.numberFormat === undefined
      ? {}
      : { numberFormat: current?.numberFormat ?? 'General' })
  })
}

function expectedSnapshot(
  operation: OfficeFormatRangeOperation,
  before: OfficeWriteSnapshot
): OfficeWriteSnapshot {
  return snapshotOf(
    before.cells.map((cell) =>
      Object.freeze({ ...cell, format: Object.freeze({ ...cell.format, ...operation.format }) })
    ),
    operation.rowCount,
    operation.columnCount
  )
}

function restoreBefore(
  operation: OfficeFormatRangeOperation,
  before: OfficeWriteBefore
): OfficeWriteSnapshot {
  if (!Array.isArray(before) || before.length !== operation.cellCount) throw invalidEvidence()
  const refs = rangeCells(operation)
  const cells = before.map((value, index) => restoredCell(value, refs[index]!, operation.format))
  return snapshotOf(cells, operation.rowCount, operation.columnCount)
}

function formatBefore(snapshot: OfficeWriteSnapshot): readonly OfficeFormatBeforeCell[] {
  return Object.freeze(
    snapshot.cells.map((cell) => {
      if (!cell.format) throw invalidEvidence()
      return Object.freeze({
        ref: cell.ref,
        value: cell.value,
        valueType: cell.valueType,
        ...(cell.formula === undefined ? {} : { formula: cell.formula }),
        ...(cell.evaluated === undefined ? {} : { evaluated: cell.evaluated }),
        format: cell.format
      })
    })
  )
}

function restoredCell(
  value: unknown,
  ref: string,
  requested: OfficeRangeFormat
): OfficeWriteSnapshotCell {
  if (!isRecord(value) || value.ref !== ref || !validBeforeCell(value)) throw invalidEvidence()
  if (!validRequestedState(value.format, requested)) throw invalidEvidence()
  const before = value as unknown as OfficeFormatBeforeCell
  return Object.freeze({
    ref,
    value: before.value,
    valueType: before.valueType,
    ...(before.formula === undefined ? {} : { formula: before.formula }),
    ...(before.evaluated === undefined ? {} : { evaluated: before.evaluated }),
    format: Object.freeze({ ...before.format })
  })
}

function validBeforeCell(value: Record<string, unknown>): boolean {
  return (
    hasOnlyKeys(value, ['ref', 'value', 'valueType', 'formula', 'evaluated', 'format']) &&
    validCellValue(value.value) &&
    validValueType(value.valueType) &&
    (value.formula === undefined || typeof value.formula === 'string') &&
    (value.evaluated === undefined || typeof value.evaluated === 'boolean') &&
    isRecord(value.format)
  )
}

function validRequestedState(value: unknown, requested: OfficeRangeFormat): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, Object.keys(requested))) return false
  if (requested.bold !== undefined && typeof value.bold !== 'boolean') return false
  if (requested.fill !== undefined && value.fill !== null && typeof value.fill !== 'string')
    return false
  if (
    requested.horizontalAlign !== undefined &&
    value.horizontalAlign !== null &&
    !['left', 'center', 'right'].includes(String(value.horizontalAlign))
  ) {
    return false
  }
  return requested.numberFormat === undefined || typeof value.numberFormat === 'string'
}

function classifyFormat(
  operation: OfficeFormatRangeOperation,
  before: OfficeWriteSnapshot,
  current: OfficeWriteSnapshot
): 'applied' | 'not_applied' | 'indeterminate' | 'applied_no_change' {
  if (!sameData(before, current)) return 'indeterminate'
  const expected = expectedSnapshot(operation, before)
  if (sameFormats(before, expected)) {
    return sameFormats(current, expected) ? 'applied_no_change' : 'indeterminate'
  }
  if (sameFormats(current, expected)) return 'applied'
  return sameFormats(current, before) ? 'not_applied' : 'indeterminate'
}

function requestedFormatMatches(snapshot: OfficeWriteSnapshot, format: OfficeRangeFormat): boolean {
  return snapshot.cells.every((cell) => requestedStateMatches(cell.format, format))
}

function requestedStateMatches(
  state: OfficeCellFormatState | undefined,
  expected: OfficeRangeFormat
): boolean {
  if (!state) return false
  return Object.entries(expected).every(
    ([key, value]) => state[key as keyof OfficeCellFormatState] === value
  )
}

function sameData(left: OfficeWriteSnapshot, right: OfficeWriteSnapshot): boolean {
  if (left.cells.length !== right.cells.length) return false
  return left.cells.every((cell, index) => {
    const other = right.cells[index]
    return (
      cell.ref === other?.ref &&
      cell.value === other.value &&
      cell.valueType === other.valueType &&
      cell.formula === other.formula &&
      cell.evaluated === other.evaluated
    )
  })
}

function sameFormats(left: OfficeWriteSnapshot, right: OfficeWriteSnapshot): boolean {
  return left.cells.every((cell, index) => sameFormatState(cell.format, right.cells[index]?.format))
}

function sameFormatState(
  left: OfficeCellFormatState | undefined,
  right: OfficeCellFormatState | undefined
): boolean {
  return JSON.stringify(left ?? {}) === JSON.stringify(right ?? {})
}

function changedFormatCells(before: OfficeWriteSnapshot, expected: OfficeRangeFormat): number {
  return before.cells.filter((cell) => !requestedStateMatches(cell.format, expected)).length
}

function validCellValue(value: unknown): value is OfficeCellValue | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}

function validValueType(value: unknown): value is OfficeWriteSnapshotCell['valueType'] {
  return ['empty', 'string', 'number', 'boolean', 'date', 'error', 'unknown'].includes(
    String(value)
  )
}

function inferredValueType(value: OfficeCellValue | null): OfficeWriteSnapshotCell['valueType'] {
  if (value === null) return 'empty'
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  return 'boolean'
}
