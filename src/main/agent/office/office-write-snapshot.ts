import { createHash } from 'node:crypto'

import { columnName, type OfficeReadCell } from './office-read-contract'
import {
  OFFICE_WRITE_LIMITS,
  OfficeWriteError,
  type OfficeCellValue,
  type OfficeRangeBeforeValue,
  type OfficeRangePreviewCell,
  type OfficeFormatRangeOperation,
  type OfficeSetRangeOperation,
  type OfficeWriteSnapshot,
  type OfficeWriteSnapshotCell
} from './office-write-contract'
import type { OfficeBatchCommand } from './office-write-operation-types'

export function rangeCells(
  operation: OfficeSetRangeOperation | OfficeFormatRangeOperation
): readonly string[] {
  const start = /^([A-Z]+)([1-9]\d*)(?::|$)/.exec(operation.range)
  if (!start) throw new OfficeWriteError('invalid_value', '写入范围无效')
  const startColumn = columnNumber(start[1])
  const startRow = Number(start[2])
  return Object.freeze(
    Array.from({ length: operation.cellCount }, (_, index) => {
      const row = Math.floor(index / operation.columnCount)
      const column = index % operation.columnCount
      return `${columnName(startColumn + column)}${startRow + row}`
    })
  )
}

export function batchCommand(
  sheet: string,
  ref: string,
  value: OfficeCellValue
): OfficeBatchCommand {
  return Object.freeze({
    command: 'set',
    path: `/${sheet}/${ref}`,
    props: Object.freeze({ value, type: valueType(value) })
  })
}

export function snapshotCell(ref: string, value: OfficeCellValue | null): OfficeWriteSnapshotCell {
  return Object.freeze({ ref, value, valueType: value === null ? 'empty' : valueType(value) })
}

export function readSnapshotCell(cell: OfficeReadCell): OfficeWriteSnapshotCell {
  const value = cell.value
  if (!validCellValue(value)) throw invalidReadback()
  return Object.freeze({
    ref: cell.ref,
    value,
    valueType: cell.valueType ?? (value === null ? 'empty' : valueType(value))
  })
}

export function snapshotOf(
  cells: readonly OfficeWriteSnapshotCell[],
  rowCount: number,
  columnCount: number
): OfficeWriteSnapshot {
  return Object.freeze({ cells: Object.freeze([...cells]), rowCount, columnCount })
}

export function classifySnapshots(
  before: OfficeWriteSnapshot,
  current: OfficeWriteSnapshot,
  expected: OfficeWriteSnapshot
): 'applied' | 'not_applied' | 'indeterminate' | 'applied_no_change' {
  if (sameSnapshot(before, expected)) {
    return sameSnapshot(current, expected) ? 'applied_no_change' : 'indeterminate'
  }
  if (sameSnapshot(current, expected)) return 'applied'
  return sameSnapshot(current, before) ? 'not_applied' : 'indeterminate'
}

export function sameSnapshot(left: OfficeWriteSnapshot, right: OfficeWriteSnapshot): boolean {
  if (left.cells.length !== right.cells.length) return false
  return left.cells.every((cell, index) => sameCell(cell, right.cells[index]))
}

export function changedCellCount(before: OfficeWriteSnapshot, after: OfficeWriteSnapshot): number {
  return before.cells.reduce(
    (count, cell, index) => count + (sameCell(cell, after.cells[index]) ? 0 : 1),
    0
  )
}

export function previewCells(
  before: OfficeWriteSnapshot,
  after: OfficeWriteSnapshot
): readonly OfficeRangePreviewCell[] {
  return Object.freeze(
    before.cells
      .flatMap((cell, index) => previewCell(cell, after.cells[index]))
      .slice(0, OFFICE_WRITE_LIMITS.maxPreviewCells)
      .map((cell) => Object.freeze(cell))
  )
}

export function snapshotHash(snapshot: OfficeWriteSnapshot): string {
  return createHash('sha256').update(JSON.stringify(snapshot.cells)).digest('hex')
}

export function validBeforeValue(value: unknown): value is OfficeRangeBeforeValue {
  if (!isRecord(value) || !hasOnlyKeys(value, ['value', 'valueType'])) return false
  return (
    validCellValue(value.value) &&
    ['empty', 'string', 'number', 'boolean', 'date', 'error', 'unknown'].includes(
      String(value.valueType)
    )
  )
}

export function invalidEvidence(): OfficeWriteError {
  return new OfficeWriteError('write_unknown', '写入前状态无法验证，文档已冻结等待核对')
}

export function invalidReadback(): OfficeWriteError {
  return new OfficeWriteError('write_verification_failed', 'Office 返回了不完整的区域内容')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function columnNumber(value: string): number {
  let result = 0
  for (const character of value) result = result * 26 + character.charCodeAt(0) - 64
  return result
}

function valueType(value: OfficeCellValue): 'string' | 'number' | 'boolean' {
  if (typeof value === 'string') return 'string'
  if (typeof value === 'number') return 'number'
  return 'boolean'
}

function validCellValue(value: unknown): value is OfficeCellValue | null {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
}

function previewCell(
  before: OfficeWriteSnapshotCell,
  after: OfficeWriteSnapshotCell | undefined
): readonly OfficeRangePreviewCell[] {
  if (!after || sameCell(before, after)) return []
  return [
    {
      cell: before.ref,
      before: previewValue(before.value),
      after: previewValue(after.value as OfficeCellValue) as OfficeCellValue
    }
  ]
}

function previewValue(value: OfficeCellValue | null): OfficeCellValue | null {
  if (typeof value !== 'string') return value
  const characters = [...value]
  if (characters.length <= OFFICE_WRITE_LIMITS.maxPreviewValueCharacters) return value
  return `${characters.slice(0, OFFICE_WRITE_LIMITS.maxPreviewValueCharacters).join('')}…`
}

function sameCell(
  left: OfficeWriteSnapshotCell,
  right: OfficeWriteSnapshotCell | undefined
): boolean {
  return left.ref === right?.ref && left.valueType === right.valueType && left.value === right.value
}
