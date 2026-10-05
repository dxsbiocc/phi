import { formatCellApprovalSummary } from './office-approval-summary'
import type { OfficeReadCell } from './office-read-contract'
import {
  OfficeWriteError,
  type OfficeCellEditDescription,
  type OfficeCellEditResult,
  type OfficeClearBeforeValue,
  type OfficeClearCellOperation,
  type OfficeWriteOperation,
  type OfficeWriteRequest,
  type OfficeWriteSnapshot,
  type OfficeWriteSnapshotCell
} from './office-write-contract'
import type { OfficeWriteOperationStrategy } from './office-write-operation-types'
import { normalizeOfficeWriteRevision, normalizeOfficeWriteTarget } from './office-write-validation'
import { classifySnapshots, hasOnlyKeys, isRecord, sameSnapshot } from './office-write-snapshot'

export const clearCellStrategy: OfficeWriteOperationStrategy = {
  type: 'clear_cell',
  validate(operation, baseRevision) {
    if (!isRecord(operation) || !hasOnlyKeys(operation, ['type', 'sheet', 'cell'])) {
      throw new OfficeWriteError('invalid_value', 'clear_cell 操作字段无效')
    }
    return clearCellWriteRequest({
      sheet: operation.sheet,
      cell: operation.cell,
      baseRevision
    })
  },
  digestInput(request) {
    const operation = request.operation as unknown as OfficeClearCellOperation
    return {
      operation: { type: operation.type, sheet: operation.sheet, cell: operation.cell },
      baseRevision: request.baseRevision
    }
  },
  affectedCells(operation) {
    return [(operation as OfficeClearCellOperation).cell]
  },
  readRange(operation) {
    return (operation as OfficeClearCellOperation).cell
  },
  expected(operation, before) {
    const clear = operation as OfficeClearCellOperation
    return snapshot(clear.cell, null, 'empty', before?.cells[0]?.format)
  },
  commands(operation) {
    const clear = operation as OfficeClearCellOperation
    return [
      Object.freeze({
        command: 'set' as const,
        path: `/${clear.sheet}/${clear.cell}`,
        props: Object.freeze({ clear: true as const })
      })
    ]
  },
  previewCondition(operation) {
    const clear = operation as OfficeClearCellOperation
    return { kind: 'cells', sheet: clear.sheet, cells: [clear.cell] }
  },
  snapshot(operation, cells) {
    const clear = operation as OfficeClearCellOperation
    const cell = cells[0]
    if (cells.length !== 1 || cell?.ref !== clear.cell) throw invalidReadback()
    return snapshot(
      cell.ref,
      cell.value,
      cell.valueType ?? inferredValueType(cell.value),
      cell.format,
      cell.formula,
      cell.evaluated
    )
  },
  before(_operation, before) {
    const cell = before.cells[0]
    if (before.cells.length !== 1 || !cell) throw invalidReadback()
    return Object.freeze({
      value: cell.value,
      valueType: cell.valueType,
      ...(cell.formula === undefined ? {} : { formula: cell.formula }),
      ...(cell.evaluated === undefined ? {} : { evaluated: cell.evaluated }),
      ...(cell.format === undefined ? {} : { format: cell.format })
    }) satisfies OfficeClearBeforeValue
  },
  restoreBefore(operation, before) {
    if (!isClearBefore(before)) throw invalidReadback()
    return snapshot(
      (operation as OfficeClearCellOperation).cell,
      before.value,
      before.valueType,
      before.format,
      before.formula,
      before.evaluated
    )
  },
  describe(request, before, documentName, revision) {
    const clear = request.operation as unknown as OfficeClearCellOperation
    return Object.freeze({
      documentName,
      sheet: clear.sheet,
      cell: clear.cell,
      before: before.cells[0]!.value,
      after: null,
      revision
    }) satisfies OfficeCellEditDescription
  },
  approvalSummary(description) {
    return formatCellApprovalSummary(description as OfficeCellEditDescription)
  },
  result(request, before, revision, saved, previewConfirmed) {
    const clear = request.operation as unknown as OfficeClearCellOperation
    return Object.freeze({
      applied: true,
      saved,
      revision,
      sheet: clear.sheet,
      cell: clear.cell,
      before: before.cells[0]!.value,
      after: null,
      previewConfirmed,
      ...(previewConfirmed ? {} : { warnings: Object.freeze(['preview_not_confirmed']) })
    }) satisfies OfficeCellEditResult
  },
  classify(operation, before, current) {
    return classifySnapshots(before, current, clearCellStrategy.expected(operation, before))
  }
}

export function clearCellWriteRequest(value: unknown): OfficeWriteRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['sheet', 'cell', 'baseRevision'])) {
    throw new OfficeWriteError('invalid_value', 'clear_cell 参数字段无效')
  }
  const target = normalizeOfficeWriteTarget(value.sheet, value.cell)
  return Object.freeze({
    operation: Object.freeze({
      type: 'clear_cell' as const,
      ...target
    }) as unknown as OfficeWriteOperation,
    baseRevision: normalizeOfficeWriteRevision(value.baseRevision)
  })
}

function snapshot(
  ref: string,
  value: OfficeWriteSnapshotCell['value'],
  valueType: OfficeWriteSnapshotCell['valueType'],
  format?: OfficeWriteSnapshotCell['format'],
  formula?: string,
  evaluated?: boolean
): OfficeWriteSnapshot {
  const cell = Object.freeze({
    ref,
    value,
    valueType,
    ...(formula === undefined ? {} : { formula }),
    ...(evaluated === undefined ? {} : { evaluated }),
    ...(format === undefined ? {} : { format })
  })
  return Object.freeze({ cells: Object.freeze([cell]), rowCount: 1, columnCount: 1 })
}

function isClearBefore(value: unknown): value is OfficeClearBeforeValue {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['value', 'valueType', 'formula', 'evaluated', 'format']) ||
    !['empty', 'string', 'number', 'boolean', 'date', 'error', 'unknown'].includes(
      String(value.valueType)
    ) ||
    (value.formula !== undefined && typeof value.formula !== 'string') ||
    (value.evaluated !== undefined && typeof value.evaluated !== 'boolean') ||
    !isClearFormat(value.format)
  ) {
    return false
  }
  const cellValue = value.value
  return (
    cellValue === null ||
    typeof cellValue === 'string' ||
    typeof cellValue === 'boolean' ||
    (typeof cellValue === 'number' && Number.isFinite(cellValue))
  )
}

function isClearFormat(value: unknown): boolean {
  if (value === undefined) return true
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, ['bold', 'fill', 'horizontalAlign', 'numberFormat'])
  ) {
    return false
  }
  return (
    (value.bold === undefined || typeof value.bold === 'boolean') &&
    (value.fill === undefined || value.fill === null || typeof value.fill === 'string') &&
    (value.horizontalAlign === undefined ||
      value.horizontalAlign === null ||
      ['left', 'center', 'right'].includes(String(value.horizontalAlign))) &&
    (value.numberFormat === undefined || typeof value.numberFormat === 'string')
  )
}

function inferredValueType(value: OfficeReadCell['value']): OfficeWriteSnapshotCell['valueType'] {
  if (value === null) return 'empty'
  if (typeof value === 'number') return 'number'
  if (typeof value === 'boolean') return 'boolean'
  return 'string'
}

function invalidReadback(): OfficeWriteError {
  return new OfficeWriteError('write_verification_failed', '单元格清除读回结果无效')
}

export { sameSnapshot }
