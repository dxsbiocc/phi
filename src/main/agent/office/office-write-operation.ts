import { formatCellApprovalSummary } from './office-approval-summary'
import { addSheetStrategy, addSheetWriteRequest } from './office-sheet-operation'
import {
  formatRangeStrategy,
  formatRangeWriteRequest,
  OFFICE_NUMBER_FORMATS
} from './office-format-operation'
import { formulaWriteRequest, setFormulaStrategy } from './office-formula-operation'
import { clearCellStrategy, clearCellWriteRequest } from './office-clear-operation'
import { addParagraphStrategy, setParagraphTextStrategy } from './office-docx-operation'
import { addSlideStrategy, setSlideTextStrategy } from './office-pptx-operation'
import { rangeWriteRequest, setRangeStrategy } from './office-range-operation'
import type { OfficeReadCell } from './office-read-contract'
import {
  OfficeWriteError,
  validateCellEditParams,
  type OfficeCellEditDescription,
  type OfficeCellEditParams,
  type OfficeCellEditResult,
  type OfficeCellValue,
  type OfficeSetCellOperation,
  type OfficeInternalWriteOperation,
  type OfficeWriteRequest,
  type OfficeWriteSnapshot
} from './office-write-contract'
import type { OfficeWriteOperationStrategy } from './office-write-operation-types'
import {
  batchCommand,
  classifySnapshots,
  hasOnlyKeys,
  invalidEvidence,
  invalidReadback,
  isRecord,
  sameSnapshot,
  snapshotCell,
  snapshotHash,
  snapshotOf
} from './office-write-snapshot'

const setCellStrategy: OfficeWriteOperationStrategy = {
  type: 'set_cell',
  validate(operation, baseRevision) {
    if (!isRecord(operation) || !hasOnlyKeys(operation, ['type', 'sheet', 'cell', 'value'])) {
      throw new OfficeWriteError('invalid_value', 'set_cell 操作字段无效')
    }
    return cellWriteRequest({
      sheet: operation.sheet as string,
      cell: operation.cell as string,
      value: operation.value as OfficeCellValue,
      baseRevision: baseRevision as number
    })
  },
  digestInput: cellDigestInput,
  affectedCells(operation) {
    return [(operation as OfficeSetCellOperation).cell]
  },
  readRange(operation) {
    return (operation as OfficeSetCellOperation).cell
  },
  expected(operation) {
    const cell = operation as OfficeSetCellOperation
    return snapshotOf([snapshotCell(cell.cell, cell.value)], 1, 1)
  },
  commands(operation) {
    const cell = operation as OfficeSetCellOperation
    return [batchCommand(cell.sheet, cell.cell, cell.value)]
  },
  previewCondition(operation) {
    const cell = operation as OfficeSetCellOperation
    return { kind: 'cells', sheet: cell.sheet, cells: [cell.cell] }
  },
  snapshot(operation, cells) {
    return cellSnapshotFromRead(operation as OfficeSetCellOperation, cells)
  },
  before(_operation, snapshot) {
    return snapshot.cells[0]!.value
  },
  restoreBefore(operation, before) {
    if (Array.isArray(before)) throw invalidEvidence()
    return snapshotOf(
      [snapshotCell((operation as OfficeSetCellOperation).cell, before as OfficeCellValue | null)],
      1,
      1
    )
  },
  describe(request, before, documentName, revision) {
    const cell = request.operation as OfficeSetCellOperation
    return Object.freeze({
      documentName,
      sheet: cell.sheet,
      cell: cell.cell,
      before: before.cells[0]!.value,
      after: cell.value,
      revision
    }) satisfies OfficeCellEditDescription
  },
  approvalSummary(description) {
    return formatCellApprovalSummary(description as OfficeCellEditDescription)
  },
  result(request, before, revision, saved, previewConfirmed) {
    const cell = request.operation as OfficeSetCellOperation
    return Object.freeze({
      sheet: cell.sheet,
      cell: cell.cell,
      before: before.cells[0]!.value,
      after: cell.value,
      revision,
      applied: true,
      saved,
      previewConfirmed,
      ...(previewConfirmed ? {} : { warnings: Object.freeze(['preview_not_confirmed']) })
    }) satisfies OfficeCellEditResult
  },
  classify(operation, before, current) {
    return classifySnapshots(before, current, setCellStrategy.expected(operation))
  }
}

export function validateOfficeWriteRequest(value: unknown): OfficeWriteRequest {
  if (isRecord(value) && isRecord(value.operation) && value.operation.type === 'clear_cell') {
    throw new OfficeWriteError('invalid_value', '不支持的 Office 写操作')
  }
  return validateStoredOfficeWriteRequest(value)
}

export function validateStoredOfficeWriteRequest(value: unknown): OfficeWriteRequest {
  if (!isRecord(value) || !hasOnlyKeys(value, ['operation', 'baseRevision'])) {
    throw new OfficeWriteError('invalid_value', '写入参数字段无效')
  }
  if (!isRecord(value.operation) || typeof value.operation.type !== 'string') {
    throw new OfficeWriteError('invalid_value', '写入操作无效')
  }
  return officeWriteStrategy(value.operation.type).validate(value.operation, value.baseRevision)
}

export function officeWriteStrategy(
  value: OfficeInternalWriteOperation | string
): OfficeWriteOperationStrategy {
  const type = typeof value === 'string' ? value : value.type
  if (type === 'set_cell') return setCellStrategy
  if (type === 'set_range') return setRangeStrategy
  if (type === 'set_formula') return setFormulaStrategy
  if (type === 'clear_cell') return clearCellStrategy
  if (type === 'format_range') return formatRangeStrategy
  if (type === 'add_sheet') return addSheetStrategy
  if (type === 'add_paragraph') return addParagraphStrategy
  if (type === 'set_paragraph_text') return setParagraphTextStrategy
  if (type === 'add_slide') return addSlideStrategy
  if (type === 'set_slide_text') return setSlideTextStrategy
  throw new OfficeWriteError('invalid_value', '不支持的 Office 写操作')
}

export function cellWriteRequest(params: OfficeCellEditParams): OfficeWriteRequest {
  const input = validateCellEditParams(params)
  return Object.freeze({
    operation: Object.freeze({
      type: 'set_cell' as const,
      sheet: input.sheet,
      cell: input.cell,
      value: input.value
    }),
    baseRevision: input.baseRevision
  })
}

export function canonicalDigestInput(
  request: OfficeWriteRequest
): Readonly<Record<string, unknown>> {
  return officeWriteStrategy(request.operation).digestInput(request)
}

export function serializeOfficeWriteRequest(request: OfficeWriteRequest): string {
  return JSON.stringify(canonicalDigestInput(request))
}

function cellDigestInput(request: OfficeWriteRequest): Readonly<Record<string, unknown>> {
  const operation = request.operation as OfficeSetCellOperation
  return {
    operation: {
      type: operation.type,
      sheet: operation.sheet,
      cell: operation.cell,
      value: operation.value
    },
    baseRevision: request.baseRevision
  }
}

function cellSnapshotFromRead(
  operation: OfficeSetCellOperation,
  cells: readonly OfficeReadCell[]
): OfficeWriteSnapshot {
  const cell = cells[0]
  if (cells.length !== 1 || cell?.ref !== operation.cell) throw invalidReadback()
  return snapshotOf([snapshotCell(cell.ref, cell.value)], 1, 1)
}

export {
  formulaWriteRequest,
  formatRangeWriteRequest,
  OFFICE_NUMBER_FORMATS,
  rangeWriteRequest,
  addSheetWriteRequest,
  clearCellWriteRequest,
  sameSnapshot,
  snapshotHash
}
export type {
  OfficeBatchCommand,
  OfficeWriteOperationStrategy
} from './office-write-operation-types'
