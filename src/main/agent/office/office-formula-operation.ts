import { hasBalancedFormulaDelimiters, validateFormulaEditParams } from './office-formula-parser'
import { formatFormulaApprovalSummary } from './office-approval-summary'
import type { OfficeReadCell } from './office-read-contract'
import {
  OfficeWriteError,
  type OfficeCellValue,
  type OfficeFormulaBeforeValue,
  type OfficeFormulaEditDescription,
  type OfficeFormulaEditResult,
  type OfficeFormulaInvalidReason,
  type OfficeFormulaStatus,
  type OfficeSetFormulaOperation,
  type OfficeWriteBefore,
  type OfficeWriteSnapshot,
  type OfficeWriteSnapshotCell,
  type OfficeWriteRequest
} from './office-write-contract'
import type {
  OfficeBatchCommand,
  OfficeWriteOperationStrategy
} from './office-write-operation-types'

export const setFormulaStrategy: OfficeWriteOperationStrategy = {
  type: 'set_formula',
  validate(operation, baseRevision) {
    if (!isRecord(operation) || !hasOnlyKeys(operation, ['type', 'sheet', 'cell', 'formula'])) {
      throw new OfficeWriteError('invalid_value', 'set_formula 操作字段无效')
    }
    return formulaWriteRequest({
      sheet: operation.sheet,
      cell: operation.cell,
      formula: operation.formula,
      baseRevision
    })
  },
  digestInput(request) {
    const operation = request.operation as OfficeSetFormulaOperation
    return {
      operation: {
        type: operation.type,
        sheet: operation.sheet,
        cell: operation.cell,
        formula: operation.formula
      },
      baseRevision: request.baseRevision
    }
  },
  affectedCells(operation) {
    return [(operation as OfficeSetFormulaOperation).cell]
  },
  readRange(operation) {
    return (operation as OfficeSetFormulaOperation).cell
  },
  expected(operation) {
    const formula = operation as OfficeSetFormulaOperation
    return formulaSnapshot(formula.cell, null, 'unknown', formula.formula, true)
  },
  commands(operation) {
    const formula = operation as OfficeSetFormulaOperation
    return [
      Object.freeze({
        command: 'set' as const,
        path: `/${formula.sheet}/${formula.cell}`,
        props: Object.freeze({ formula: formula.formula.slice(1) })
      })
    ]
  },
  previewCondition(operation) {
    const formula = operation as OfficeSetFormulaOperation
    return { kind: 'cells', sheet: formula.sheet, cells: [formula.cell] }
  },
  restoreCommands(operation, before) {
    return restoreCommands(operation as OfficeSetFormulaOperation, before)
  },
  snapshot(operation, cells) {
    return snapshotFromRead(operation as OfficeSetFormulaOperation, cells)
  },
  before(_operation, snapshot) {
    return beforeEvidence(snapshot)
  },
  restoreBefore(operation, before) {
    return restoreBefore(operation as OfficeSetFormulaOperation, before)
  },
  describe(request, before, documentName, revision) {
    const operation = request.operation as OfficeSetFormulaOperation
    return Object.freeze({
      type: 'set_formula',
      documentName,
      sheet: operation.sheet,
      cell: operation.cell,
      formula: operation.formula,
      before: beforeEvidence(before),
      revision
    }) satisfies OfficeFormulaEditDescription
  },
  approvalSummary(description) {
    return formatFormulaApprovalSummary(description as OfficeFormulaEditDescription)
  },
  result(request, _before, revision, saved, previewConfirmed, verified) {
    const operation = request.operation as OfficeSetFormulaOperation
    const cell = verified?.cells[0]
    if (!verified || !isAppliedFormula(operation, verified) || !cell || cell.value === null) {
      throw invalidReadback()
    }
    return Object.freeze({
      applied: true,
      saved,
      revision,
      sheet: operation.sheet,
      cell: operation.cell,
      formula: operation.formula,
      computedValue: cell.value,
      valueType: cell.valueType,
      previewConfirmed,
      ...(previewConfirmed ? {} : { warnings: Object.freeze(['preview_not_confirmed']) })
    }) satisfies OfficeFormulaEditResult
  },
  classify(operation, before, current) {
    return classifyFormula(operation as OfficeSetFormulaOperation, before, current)
  }
}

export function formulaWriteRequest(params: unknown): OfficeWriteRequest {
  const input = validateFormulaEditParams(params)
  return Object.freeze({
    operation: Object.freeze({
      type: 'set_formula' as const,
      sheet: input.sheet,
      cell: input.cell,
      formula: input.formula
    }),
    baseRevision: input.baseRevision
  })
}

function snapshotFromRead(
  operation: OfficeSetFormulaOperation,
  cells: readonly OfficeReadCell[]
): OfficeWriteSnapshot {
  const cell = cells[0]
  if (cells.length !== 1 || cell?.ref !== operation.cell || !validCellValue(cell.value)) {
    throw invalidReadback()
  }
  return formulaSnapshot(
    cell.ref,
    cell.value,
    cell.valueType ?? inferredValueType(cell.value),
    cell.formula,
    cell.evaluated
  )
}

function formulaSnapshot(
  ref: string,
  value: OfficeCellValue | null,
  valueType: OfficeWriteSnapshotCell['valueType'],
  formula?: string,
  evaluated?: boolean
): OfficeWriteSnapshot {
  const cell = Object.freeze({
    ref,
    value,
    valueType,
    ...(formula === undefined ? {} : { formula }),
    ...(evaluated === undefined ? {} : { evaluated })
  })
  return Object.freeze({ cells: Object.freeze([cell]), rowCount: 1, columnCount: 1 })
}

function beforeEvidence(snapshot: OfficeWriteSnapshot): OfficeFormulaBeforeValue {
  const cell = snapshot.cells[0]
  if (snapshot.cells.length !== 1 || !cell) throw invalidEvidence()
  return Object.freeze({
    value: cell.value,
    valueType: cell.valueType,
    ...(cell.formula === undefined ? {} : { formula: cell.formula }),
    ...(cell.evaluated === undefined ? {} : { evaluated: cell.evaluated })
  })
}

function restoreBefore(
  operation: OfficeSetFormulaOperation,
  before: OfficeWriteBefore
): OfficeWriteSnapshot {
  if (!validBefore(before)) throw invalidEvidence()
  return formulaSnapshot(
    operation.cell,
    before.value,
    before.valueType,
    before.formula,
    before.evaluated
  )
}

function classifyFormula(
  operation: OfficeSetFormulaOperation,
  before: OfficeWriteSnapshot,
  current: OfficeWriteSnapshot
): 'applied' | 'not_applied' | 'indeterminate' | 'applied_no_change' {
  const wasApplied = isAppliedFormula(operation, before)
  if (isAppliedFormula(operation, current)) return wasApplied ? 'applied_no_change' : 'applied'
  return sameFormulaSnapshot(current, before) ? 'not_applied' : 'indeterminate'
}

function isAppliedFormula(
  operation: OfficeSetFormulaOperation,
  snapshot: OfficeWriteSnapshot
): boolean {
  const cell = snapshot.cells[0]
  return (
    snapshot.cells.length === 1 &&
    equivalentFormula(cell?.formula, operation.formula) &&
    cell.evaluated === true &&
    cell.valueType !== 'error' &&
    cell.value !== null
  )
}

export function formulaInvalidState(
  operation: OfficeSetFormulaOperation,
  snapshot: OfficeWriteSnapshot
):
  | {
      readonly formulaStatus: OfficeFormulaStatus
      readonly reason: OfficeFormulaInvalidReason
    }
  | undefined {
  const cell = snapshot.cells[0]
  if (!cell) return undefined
  const formulaStatus = formulaStatusFromSnapshot(snapshot)
  if (!equivalentFormula(cell.formula, operation.formula)) {
    return { formulaStatus, reason: 'formula_mismatch' }
  }
  if (!hasBalancedFormulaDelimiters(operation.formula)) {
    return { formulaStatus, reason: 'invalid_syntax' }
  }
  if (cell.evaluated !== true) {
    return {
      formulaStatus,
      reason: cell.valueType === 'error' ? 'unsupported_function' : 'not_evaluated'
    }
  }
  if (cell.valueType === 'error' || cell.value === null) {
    return { formulaStatus, reason: 'error_value' }
  }
  return undefined
}

export function formulaStatusFromSnapshot(snapshot: OfficeWriteSnapshot): OfficeFormulaStatus {
  const cell = snapshot.cells[0]
  if (!cell) throw invalidReadback()
  return Object.freeze({
    ...(cell.formula === undefined ? {} : { formula: cell.formula }),
    evaluated: cell.evaluated === true,
    computedValue: cell.value,
    valueType: cell.valueType
  })
}

function restoreCommands(
  operation: OfficeSetFormulaOperation,
  before: OfficeWriteBefore
): readonly OfficeBatchCommand[] {
  if (!validBefore(before)) throw invalidEvidence()
  const props = before.formula
    ? { formula: before.formula.slice(1) }
    : before.value === null
      ? { clear: true as const }
      : { value: before.value, type: formulaValueType(before.value) }
  return [Object.freeze({ command: 'set', path: `/${operation.sheet}/${operation.cell}`, props })]
}

function formulaValueType(value: OfficeCellValue): 'string' | 'number' | 'boolean' {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  return 'boolean'
}

function equivalentFormula(left: string | undefined, right: string): boolean {
  return left !== undefined && normalizedFormula(left) === normalizedFormula(right)
}

function normalizedFormula(formula: string): string {
  let quoted = false
  let normalized = ''
  for (let index = formula.startsWith('=') ? 1 : 0; index < formula.length; index += 1) {
    const character = formula[index]!
    if (character === '"') {
      normalized += character
      if (quoted && formula[index + 1] === '"') normalized += formula[++index]!
      else quoted = !quoted
    } else if (quoted || !/\s/u.test(character)) normalized += character
  }
  return normalized
}

function sameFormulaSnapshot(left: OfficeWriteSnapshot, right: OfficeWriteSnapshot): boolean {
  const leftCell = left.cells[0]
  const rightCell = right.cells[0]
  return (
    left.cells.length === 1 &&
    right.cells.length === 1 &&
    leftCell?.ref === rightCell?.ref &&
    leftCell?.value === rightCell?.value &&
    leftCell?.valueType === rightCell?.valueType &&
    leftCell?.formula === rightCell?.formula &&
    leftCell?.evaluated === rightCell?.evaluated
  )
}

function validBefore(value: OfficeWriteBefore): value is OfficeFormulaBeforeValue {
  if (!isRecord(value) || !hasOnlyKeys(value, ['value', 'valueType', 'formula', 'evaluated'])) {
    return false
  }
  const candidate = value as Record<string, unknown>
  return (
    validCellValue(candidate.value) &&
    validValueType(candidate.valueType) &&
    (candidate.formula === undefined || typeof candidate.formula === 'string') &&
    (candidate.evaluated === undefined || typeof candidate.evaluated === 'boolean')
  )
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

function invalidEvidence(): OfficeWriteError {
  return new OfficeWriteError('write_unknown', '写入前状态无法验证，文档已冻结等待核对')
}

function invalidReadback(): OfficeWriteError {
  return new OfficeWriteError('write_verification_failed', 'Office 返回了不完整的公式单元格内容')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}
