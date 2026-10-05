import { formatRangeApprovalSummary } from './office-approval-summary'
import type { OfficeReadCell } from './office-read-contract'
import {
  OFFICE_WRITE_LIMITS,
  OfficeWriteError,
  validateRangeEditParams,
  type OfficeRangeEditDescription,
  type OfficeRangeEditParams,
  type OfficeRangeEditResult,
  type OfficeSetRangeOperation,
  type OfficeWriteBefore,
  type OfficeWriteRequest,
  type OfficeWriteSnapshot,
  type OfficeWriteSnapshotCell
} from './office-write-contract'
import type { OfficeWriteOperationStrategy } from './office-write-operation-types'
import {
  batchCommand,
  changedCellCount,
  classifySnapshots,
  hasOnlyKeys,
  invalidEvidence,
  invalidReadback,
  isRecord,
  previewCells,
  rangeCells,
  readSnapshotCell,
  snapshotHash,
  snapshotCell,
  snapshotOf,
  validBeforeValue
} from './office-write-snapshot'

export const setRangeStrategy: OfficeWriteOperationStrategy = {
  type: 'set_range',
  validate(operation, baseRevision) {
    if (!isRecord(operation) || !hasOnlyKeys(operation, ['type', 'sheet', 'range', 'values'])) {
      throw new OfficeWriteError('invalid_value', 'set_range 操作字段无效')
    }
    return rangeWriteRequest(
      validateRangeEditParams({
        sheet: operation.sheet,
        range: operation.range,
        values: operation.values,
        baseRevision
      })
    )
  },
  digestInput(request) {
    const operation = request.operation as OfficeSetRangeOperation
    return {
      operation: {
        type: operation.type,
        sheet: operation.sheet,
        range: operation.range,
        values: operation.values
      },
      baseRevision: request.baseRevision
    }
  },
  affectedCells(operation) {
    return rangeCells(operation as OfficeSetRangeOperation)
  },
  readRange(operation) {
    return (operation as OfficeSetRangeOperation).range
  },
  expected(operation) {
    return expectedRange(operation as OfficeSetRangeOperation)
  },
  commands(operation) {
    const range = operation as OfficeSetRangeOperation
    return expectedRange(range).cells.map((cell) =>
      batchCommand(range.sheet, cell.ref, cell.value!)
    )
  },
  previewCondition(operation) {
    const range = operation as OfficeSetRangeOperation
    return { kind: 'cells', sheet: range.sheet, cells: rangeCells(range) }
  },
  snapshot(operation, cells) {
    return snapshotFromRead(operation as OfficeSetRangeOperation, cells)
  },
  before(operation, snapshot) {
    return beforeEvidence(operation as OfficeSetRangeOperation, snapshot)
  },
  restoreBefore(operation, before) {
    return restoreBefore(operation as OfficeSetRangeOperation, before)
  },
  describe(request, before, documentName, revision) {
    const range = request.operation as OfficeSetRangeOperation
    const expected = expectedRange(range)
    return Object.freeze({
      type: 'set_range',
      documentName,
      sheet: range.sheet,
      range: range.range,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
      cellCount: range.cellCount,
      changedCells: changedCellCount(before, expected),
      preview: previewCells(before, expected),
      revision
    }) satisfies OfficeRangeEditDescription
  },
  approvalSummary(description) {
    return formatRangeApprovalSummary(description as OfficeRangeEditDescription)
  },
  result(request, before, revision, saved, previewConfirmed) {
    const range = request.operation as OfficeSetRangeOperation
    const expected = expectedRange(range)
    return Object.freeze({
      applied: true,
      saved,
      revision,
      sheet: range.sheet,
      range: range.range,
      rowCount: range.rowCount,
      columnCount: range.columnCount,
      changedCells: changedCellCount(before, expected),
      preview: previewCells(before, expected),
      beforeHash: snapshotHash(before),
      afterHash: snapshotHash(expected),
      previewConfirmed,
      ...(previewConfirmed ? {} : { warnings: Object.freeze(['preview_not_confirmed']) })
    }) satisfies OfficeRangeEditResult
  },
  classify(operation, before, current) {
    return classifySnapshots(before, current, expectedRange(operation as OfficeSetRangeOperation))
  }
}

export function rangeWriteRequest(params: OfficeRangeEditParams): OfficeWriteRequest {
  const input = validateRangeEditParams({
    sheet: params.sheet,
    range: params.range,
    values: params.values,
    baseRevision: params.baseRevision
  })
  const operation: OfficeSetRangeOperation = Object.freeze({
    type: 'set_range',
    sheet: input.sheet,
    range: input.range,
    values: input.values,
    rowCount: input.rowCount,
    columnCount: input.columnCount,
    cellCount: input.cellCount
  })
  const body = JSON.stringify(setRangeStrategy.commands(operation))
  if (Buffer.byteLength(body, 'utf8') > OFFICE_WRITE_LIMITS.maxBatchBytes) {
    throw new OfficeWriteError(
      'range_too_large',
      '批处理命令体超过 256 KiB，请缩小范围或减少单元格文本'
    )
  }
  return Object.freeze({ operation, baseRevision: input.baseRevision })
}

function expectedRange(operation: OfficeSetRangeOperation): OfficeWriteSnapshot {
  const refs = rangeCells(operation)
  return snapshotOf(
    refs.map((ref, index) =>
      snapshotCell(
        ref,
        operation.values[Math.floor(index / operation.columnCount)]![index % operation.columnCount]!
      )
    ),
    operation.rowCount,
    operation.columnCount
  )
}

function snapshotFromRead(
  operation: OfficeSetRangeOperation,
  cells: readonly OfficeReadCell[]
): OfficeWriteSnapshot {
  const refs = rangeCells(operation)
  if (cells.length !== refs.length) throw invalidReadback()
  const normalized = cells.map((cell, index) => {
    if (cell.ref !== refs[index]) throw invalidReadback()
    return readSnapshotCell(cell)
  })
  return snapshotOf(normalized, operation.rowCount, operation.columnCount)
}

function beforeEvidence(
  operation: OfficeSetRangeOperation,
  snapshot: OfficeWriteSnapshot
): OfficeWriteBefore {
  return Object.freeze(
    Array.from({ length: operation.rowCount }, (_, row) =>
      Object.freeze(
        Array.from({ length: operation.columnCount }, (_, column) => {
          const cell = snapshot.cells[row * operation.columnCount + column]!
          return Object.freeze({ value: cell.value, valueType: cell.valueType })
        })
      )
    )
  )
}

function restoreBefore(
  operation: OfficeSetRangeOperation,
  before: OfficeWriteBefore
): OfficeWriteSnapshot {
  if (!Array.isArray(before) || before.length !== operation.rowCount) throw invalidEvidence()
  const refs = rangeCells(operation)
  const cells: OfficeWriteSnapshotCell[] = []
  for (let row = 0; row < operation.rowCount; row += 1) {
    const values = before[row]
    if (!Array.isArray(values) || values.length !== operation.columnCount) throw invalidEvidence()
    for (const value of values) {
      if (!validBeforeValue(value)) throw invalidEvidence()
      cells.push(Object.freeze({ ref: refs[cells.length]!, ...value }))
    }
  }
  return snapshotOf(cells, operation.rowCount, operation.columnCount)
}
