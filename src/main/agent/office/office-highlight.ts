import type { OfficeWriteOperation } from './office-write-contract'
import {
  OfficeReadError,
  columnNumber,
  parseOfficeRange,
  validOfficeSheetName
} from './office-read-contract'

export const OFFICE_HIGHLIGHT_MAX_DETAILED_CELLS = 2_000

export interface OfficeHighlightTarget {
  readonly sheet: string
  readonly range?: string
}

export interface OfficeHighlightRange {
  readonly range: string
  readonly startRow: number
  readonly endRow: number
  readonly startColumn: number
  readonly endColumn: number
  readonly cellCount: number
  readonly boundaryOnly: boolean
}

export function officeHighlightTarget(
  operation: OfficeWriteOperation
): OfficeHighlightTarget | undefined {
  if (operation.type === 'add_sheet') {
    assertHighlightSheet(operation.name)
    return Object.freeze({ sheet: operation.name })
  }
  switch (operation.type) {
    case 'set_cell':
    case 'set_formula':
      assertHighlightSheet(operation.sheet)
      return Object.freeze({
        sheet: operation.sheet,
        range: parseOfficeHighlightRange(operation.cell).range
      })
    case 'set_range':
    case 'format_range':
      assertHighlightSheet(operation.sheet)
      return Object.freeze({
        sheet: operation.sheet,
        range: parseOfficeHighlightRange(operation.range).range
      })
    default:
      return undefined
  }
}

export function parseOfficeHighlightRange(value: string): OfficeHighlightRange {
  const match = /^([A-Za-z]+)([1-9]\d*)(?::([A-Za-z]+)([1-9]\d*))?$/.exec(value)
  if (
    !match ||
    (match[3] &&
      (columnNumber(match[1].toUpperCase()) > columnNumber(match[3].toUpperCase()) ||
        Number(match[2]) > Number(match[4])))
  ) {
    throw new Error('高亮范围无效')
  }
  try {
    const parsed = parseOfficeRange(value)
    return Object.freeze({
      range: parsed.range,
      startRow: parsed.startRow,
      endRow: parsed.endRow,
      startColumn: parsed.startColumn,
      endColumn: parsed.endColumn,
      cellCount: parsed.cellCount,
      boundaryOnly: parsed.cellCount > OFFICE_HIGHLIGHT_MAX_DETAILED_CELLS
    })
  } catch (error) {
    if (error instanceof OfficeReadError) throw new Error('高亮范围无效')
    throw error
  }
}

export function highlightRangeContainsCell(range: OfficeHighlightRange, cell: string): boolean {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(cell)
  if (!match) return false
  const column = columnNumber(match[1])
  const row = Number(match[2])
  const inside =
    row >= range.startRow &&
    row <= range.endRow &&
    column >= range.startColumn &&
    column <= range.endColumn
  if (!inside || !range.boundaryOnly) return inside
  return (
    row === range.startRow ||
    row === range.endRow ||
    column === range.startColumn ||
    column === range.endColumn
  )
}

function assertHighlightSheet(sheet: string): void {
  if (
    !validOfficeSheetName(sheet) ||
    [...sheet].some((character) => {
      const code = character.charCodeAt(0)
      return code >= 0x80 && code <= 0x9f
    })
  ) {
    throw new Error('工作表名称无效')
  }
}
