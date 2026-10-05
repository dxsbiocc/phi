import { formatAddSheetApprovalSummary } from './office-approval-summary'
import { validOfficeSheetName } from './office-read-contract'
import {
  OFFICE_MAX_WORKBOOK_SHEETS,
  addSheetSnapshot,
  validateAddSheetParams
} from './office-sheet-contract'
import { assertSuccessfulAddSheetBatch } from './office-sheet-parser'
import {
  OfficeWriteError,
  type OfficeAddSheetDescription,
  type OfficeAddSheetOperation,
  type OfficeAddSheetResult,
  type OfficeWriteBefore,
  type OfficeWriteRequest,
  type OfficeWriteSnapshot
} from './office-write-contract'
import type { OfficeWriteOperationStrategy } from './office-write-operation-types'
import { hasOnlyKeys, invalidEvidence, invalidReadback, isRecord } from './office-write-snapshot'

export const addSheetStrategy: OfficeWriteOperationStrategy = {
  type: 'add_sheet',
  validate(operation, baseRevision) {
    if (!isRecord(operation) || !hasOnlyKeys(operation, ['type', 'name'])) {
      throw new OfficeWriteError('invalid_value', 'add_sheet 操作字段无效')
    }
    return addSheetWriteRequest({ name: operation.name, baseRevision })
  },
  digestInput(request) {
    const operation = request.operation as OfficeAddSheetOperation
    return {
      operation: { type: operation.type, name: operation.name },
      baseRevision: request.baseRevision
    }
  },
  affectedCells() {
    return []
  },
  readRange() {
    return '/'
  },
  expected(operation, before) {
    const current = requiredSheetSnapshot(before)
    assertCanAdd(operation as OfficeAddSheetOperation, current.sheetNames!)
    return addSheetSnapshot(
      [...current.sheetNames!, (operation as OfficeAddSheetOperation).name],
      true
    )
  },
  commands(operation) {
    const sheet = operation as OfficeAddSheetOperation
    return [
      Object.freeze({
        command: 'add' as const,
        parent: '/' as const,
        type: 'sheet' as const,
        props: Object.freeze({ name: sheet.name })
      })
    ]
  },
  assertBatchResult: assertSuccessfulAddSheetBatch,
  previewCondition(operation) {
    return { kind: 'sheet', sheet: (operation as OfficeAddSheetOperation).name }
  },
  assertBefore(operation, before) {
    assertCanAdd(operation as OfficeAddSheetOperation, requiredSheetSnapshot(before).sheetNames!)
  },
  snapshot() {
    throw invalidReadback()
  },
  verify(operation, before, current) {
    return classify(operation as OfficeAddSheetOperation, before, current) === 'applied'
  },
  before(_operation, snapshot) {
    return Object.freeze({ sheetNames: requiredSheetSnapshot(snapshot).sheetNames! })
  },
  restoreBefore(_operation, before) {
    return restoreSheetBefore(before)
  },
  describe(request, before, documentName, revision) {
    const operation = request.operation as OfficeAddSheetOperation
    const names = requiredSheetSnapshot(before).sheetNames!
    assertCanAdd(operation, names)
    return Object.freeze({
      type: 'add_sheet',
      documentName,
      name: operation.name,
      sheetCount: names.length,
      revision
    }) satisfies OfficeAddSheetDescription
  },
  approvalSummary(description) {
    return formatAddSheetApprovalSummary(description as OfficeAddSheetDescription)
  },
  result(request, _before, revision, saved, previewConfirmed, verified) {
    const operation = request.operation as OfficeAddSheetOperation
    const names = requiredSheetSnapshot(verified).sheetNames!
    return Object.freeze({
      applied: true,
      saved,
      revision,
      sheet: operation.name,
      path: `/${operation.name}`,
      sheetCount: names.length,
      sheetNames: Object.freeze([...names]),
      previewConfirmed,
      ...(previewConfirmed ? {} : { warnings: Object.freeze(['preview_not_confirmed']) })
    }) satisfies OfficeAddSheetResult
  },
  classify(operation, before, current) {
    return classify(operation as OfficeAddSheetOperation, before, current)
  }
}

export function addSheetWriteRequest(params: unknown): OfficeWriteRequest {
  const input = validateAddSheetParams(params)
  return Object.freeze({
    operation: Object.freeze({ type: 'add_sheet' as const, name: input.name }),
    baseRevision: input.baseRevision
  })
}

function assertCanAdd(operation: OfficeAddSheetOperation, sheetNames: readonly string[]): void {
  if (sheetNames.some((name) => name.toUpperCase() === operation.name.toUpperCase())) {
    throw new OfficeWriteError('sheet_exists', '工作表名称已存在，请使用其它名称', {
      sheetNames: Object.freeze([...sheetNames])
    })
  }
  if (sheetNames.length >= OFFICE_MAX_WORKBOOK_SHEETS) {
    throw new OfficeWriteError(
      'too_many_sheets',
      `每个工作簿最多 ${OFFICE_MAX_WORKBOOK_SHEETS} 个工作表`,
      {
        sheetNames: Object.freeze([...sheetNames]),
        limit: OFFICE_MAX_WORKBOOK_SHEETS
      }
    )
  }
}

function classify(
  operation: OfficeAddSheetOperation,
  before: OfficeWriteSnapshot,
  current: OfficeWriteSnapshot
): 'applied' | 'not_applied' | 'indeterminate' {
  const previous = requiredSheetSnapshot(before).sheetNames!
  const present = requiredSheetSnapshot(current).sheetNames!
  if (sameNames(present, previous)) return 'not_applied'
  const expected = [...previous, operation.name]
  return sameNames(present, expected) && current.addedSheetEmpty === true
    ? 'applied'
    : 'indeterminate'
}

function restoreSheetBefore(before: OfficeWriteBefore): OfficeWriteSnapshot {
  const candidate = before as unknown as Record<string, unknown>
  if (
    !isRecord(before) ||
    !hasOnlyKeys(candidate, ['sheetNames']) ||
    !Array.isArray(candidate.sheetNames)
  ) {
    throw invalidEvidence()
  }
  if (!validSheetNames(candidate.sheetNames)) throw invalidEvidence()
  return addSheetSnapshot(candidate.sheetNames)
}

function requiredSheetSnapshot(snapshot: OfficeWriteSnapshot | undefined): OfficeWriteSnapshot {
  if (!snapshot || !Array.isArray(snapshot.sheetNames)) throw invalidEvidence()
  return snapshot
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index])
}

function validSheetNames(value: unknown[]): value is string[] {
  const names = value.filter((name): name is string => typeof name === 'string')
  if (
    value.length === 0 ||
    value.length > OFFICE_MAX_WORKBOOK_SHEETS ||
    names.length !== value.length ||
    !names.every(validOfficeSheetName)
  ) {
    return false
  }
  return new Set(names.map((name) => name.toUpperCase())).size === names.length
}
