import type { OfficeSelectionSummary } from '../../../shared/officeProtocol'
import { validOfficeSheetName } from './office-read-contract'

const MAX_SSE_BUFFER_BYTES = 64 * 1024
export const MAX_OFFICE_SELECTION_PATHS = 200
export const MAX_OFFICE_SELECTION_PATH_CHARS = 128

interface ParsedSelectionPath {
  sheet: string
  displayRange: string
  kind: 'cell' | 'range' | 'row' | 'column'
  row?: number
  column?: number
  endRow?: number
  endColumn?: number
}

export interface OfficeCellPatch {
  readonly sheet: string
  readonly cell: string
}

function columnNumber(column: string): number {
  let value = 0
  for (const character of column) value = value * 26 + character.charCodeAt(0) - 64
  return value
}

function validCell(cell: string): boolean {
  const match = /^([A-Z]+)([1-9]\d*)$/.exec(cell)
  return Boolean(match && columnNumber(match[1]) <= 16_384 && Number(match[2]) <= 1_048_576)
}

function columnName(number: number): string {
  let value = number
  let name = ''
  while (value > 0) {
    value -= 1
    name = String.fromCharCode(65 + (value % 26)) + name
    value = Math.floor(value / 26)
  }
  return name
}

function parseSelectionPath(path: string): ParsedSelectionPath | null {
  const match = /^\/([^/]+)\/([^/]+)$/.exec(path)
  if (!match) return null
  const [, sheet, target] = match
  if (!validOfficeSheetName(sheet)) return null
  const cell = /^([A-Z]+)([1-9]\d*)$/.exec(target)
  if (cell && validCell(target)) {
    return {
      sheet,
      displayRange: target,
      kind: 'cell',
      column: columnNumber(cell[1]),
      row: Number(cell[2])
    }
  }
  const row = /^row\[([1-9]\d*)\]$/.exec(target)
  if (row && Number(row[1]) <= 1_048_576) {
    return { sheet, displayRange: `${row[1]}:${row[1]}`, kind: 'row', row: Number(row[1]) }
  }
  const column = /^col\[([A-Z]+)\]$/.exec(target)
  if (column && columnNumber(column[1]) <= 16_384) {
    return {
      sheet,
      displayRange: `${column[1]}:${column[1]}`,
      kind: 'column',
      column: columnNumber(column[1])
    }
  }
  return null
}

function parseResolvedSelectionPath(path: string): ParsedSelectionPath | null {
  const direct = parseSelectionPath(path)
  if (direct?.kind === 'cell') return direct
  const match = /^\/([^/]+)\/([^/:]+):([^/:]+)$/.exec(path)
  if (!match) return null
  const [, sheet, start, end] = match
  if (!validOfficeSheetName(sheet)) return null
  const startCell = /^([A-Z]+)([1-9]\d*)$/.exec(start)
  const endCell = /^([A-Z]+)([1-9]\d*)$/.exec(end)
  if (!startCell || !endCell || !validCell(start) || !validCell(end)) return null
  const column = columnNumber(startCell[1])
  const row = Number(startCell[2])
  const endColumn = columnNumber(endCell[1])
  const endRow = Number(endCell[2])
  if (endColumn < column || endRow < row) return null
  return { sheet, displayRange: `${start}:${end}`, kind: 'range', column, row, endColumn, endRow }
}

export function isValidOfficeSelectionPath(path: string): boolean {
  return parseSelectionPath(path) !== null || parseResolvedSelectionPath(path) !== null
}

export function selectionSummaryFromPaths(paths: readonly string[]): OfficeSelectionSummary | null {
  if (paths.length === 0) return null
  const parsed = paths.map((path) => parseSelectionPath(path) ?? parseResolvedSelectionPath(path))
  if (parsed.some((value) => value === null)) return null
  const values = parsed as ParsedSelectionPath[]
  if (values.some((value) => value.sheet !== values[0].sheet)) return { paths: [...paths] }
  const displayRange = normalizedDisplayRange(values)
  return {
    sheet: values[0].sheet,
    ...(displayRange ? { range: displayRange } : {}),
    paths: [...paths]
  }
}

export function resolvedSelectionFromPaths(
  paths: readonly string[]
): { summary: OfficeSelectionSummary; cellCount: number } | null {
  if (paths.length === 0) return null
  const values = paths.map(parseResolvedSelectionPath)
  if (values.some((value) => value === null)) return null
  const parsed = values as ParsedSelectionPath[]
  const sameSheet = parsed.every((value) => value.sheet === parsed[0].sheet)
  const displayRange = sameSheet ? normalizedDisplayRange(parsed) : undefined
  const cellCount = parsed.reduce((total, value) => total + selectionCellCount(value), 0)
  return {
    summary: {
      ...(sameSheet ? { sheet: parsed[0].sheet } : {}),
      ...(displayRange ? { range: displayRange } : {}),
      paths: [...paths]
    },
    cellCount
  }
}

function selectionCellCount(value: ParsedSelectionPath): number {
  if (value.kind === 'cell') return 1
  if (value.kind !== 'range') return 0
  return (value.endColumn! - value.column! + 1) * (value.endRow! - value.row! + 1)
}

function normalizedDisplayRange(values: readonly ParsedSelectionPath[]): string | undefined {
  if (values.length === 1) return values[0].displayRange
  if (new Set(values.map((value) => value.kind)).size !== 1) return undefined
  if (values[0].kind === 'range') return undefined
  if (values[0].kind === 'cell') return rectangularCellRange(values)
  const positions = values.map((value) =>
    values[0].kind === 'row' ? (value.row as number) : (value.column as number)
  )
  const unique = [...new Set(positions)].sort((a, b) => a - b)
  if (unique.at(-1)! - unique[0] + 1 !== unique.length) return undefined
  if (values[0].kind === 'row') return `${unique[0]}:${unique.at(-1)}`
  return `${columnName(unique[0])}:${columnName(unique.at(-1)!)}`
}

function rectangularCellRange(values: readonly ParsedSelectionPath[]): string | undefined {
  const coordinates = new Set(values.map((value) => `${value.column}:${value.row}`))
  const columns = values.map((value) => value.column as number)
  const rows = values.map((value) => value.row as number)
  const [minColumn, maxColumn] = [Math.min(...columns), Math.max(...columns)]
  const [minRow, maxRow] = [Math.min(...rows), Math.max(...rows)]
  if ((maxColumn - minColumn + 1) * (maxRow - minRow + 1) !== coordinates.size) {
    return undefined
  }
  const start = `${columnName(minColumn)}${minRow}`
  const end = `${columnName(maxColumn)}${maxRow}`
  return start === end ? start : `${start}:${end}`
}

function selectionUpdate(data: string): OfficeSelectionSummary | null | undefined {
  try {
    const value = JSON.parse(data) as { action?: unknown; paths?: unknown }
    if (value.action !== 'selection-update' || !Array.isArray(value.paths)) return undefined
    if (value.paths.length > MAX_OFFICE_SELECTION_PATHS) return undefined
    if (!value.paths.every((path): path is string => typeof path === 'string')) return undefined
    if (value.paths.some((path) => [...path].length > MAX_OFFICE_SELECTION_PATH_CHARS)) {
      return undefined
    }
    if (value.paths.length === 0) return null
    return selectionSummaryFromPaths(value.paths) ?? undefined
  } catch {
    return undefined
  }
}

function excelPatchCells(data: string): OfficeCellPatch[] {
  try {
    const value = JSON.parse(data) as { action?: unknown; patches?: unknown }
    if (value.action !== 'excel-patch' || !Array.isArray(value.patches)) return []
    const paths = new Set<string>()
    for (const patch of value.patches) {
      const html = (patch as { html?: unknown }).html
      if (typeof html !== 'string') continue
      for (const match of html.matchAll(/data-path="(\/[^"<>]+)"/g)) paths.add(match[1])
    }
    return [...paths].flatMap((path) => {
      const parsed = /^\/([^/]+)\/([A-Z]+[1-9]\d*)$/.exec(path)
      if (!parsed || !isValidOfficeSelectionPath(path)) return []
      return [{ sheet: parsed[1], cell: parsed[2] }]
    })
  } catch {
    return []
  }
}

function fullRefreshVersion(data: string): number | undefined {
  try {
    const value = JSON.parse(data) as { action?: unknown; version?: unknown }
    return value.action === 'full' &&
      typeof value.version === 'number' &&
      Number.isSafeInteger(value.version) &&
      value.version >= 0
      ? value.version
      : undefined
  } catch {
    return undefined
  }
}

function wordPatchVersion(data: string): number | undefined {
  try {
    const value = JSON.parse(data) as { action?: unknown; version?: unknown }
    return value.action === 'word-patch' &&
      typeof value.version === 'number' &&
      Number.isSafeInteger(value.version) &&
      value.version >= 0
      ? value.version
      : undefined
  } catch {
    return undefined
  }
}

function presentationMutation(
  data: string
): { readonly version: number; readonly slideCountChanged: boolean } | undefined {
  try {
    const value = JSON.parse(data) as { action?: unknown; version?: unknown }
    const action = String(value.action)
    if (
      !['add', 'replace', 'remove', 'delete', 'full'].includes(action) ||
      typeof value.version !== 'number' ||
      !Number.isSafeInteger(value.version) ||
      value.version < 0
    )
      return undefined
    return { version: value.version, slideCountChanged: action !== 'replace' }
  } catch {
    return undefined
  }
}

export class OfficeSelectionSseParser {
  private buffer = ''

  constructor(
    private readonly onSelection?: (selection: OfficeSelectionSummary | null) => void,
    private readonly onCellPatch?: (patch: OfficeCellPatch) => void,
    private readonly onFullRefresh?: (version: number) => void,
    private readonly onDocumentPatch?: (version: number) => void,
    private readonly onPresentationChange?: (version: number, slideCountChanged: boolean) => void
  ) {}

  push(chunk: string): void {
    this.buffer = `${this.buffer}${chunk}`.replaceAll('\r\n', '\n')
    if (Buffer.byteLength(this.buffer) > MAX_SSE_BUFFER_BYTES) this.buffer = ''
    let boundary = this.buffer.indexOf('\n\n')
    while (boundary >= 0) {
      this.consume(this.buffer.slice(0, boundary))
      this.buffer = this.buffer.slice(boundary + 2)
      boundary = this.buffer.indexOf('\n\n')
    }
  }

  private consume(frame: string): void {
    const data = frame
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
    if (!data) return
    const fullVersion = fullRefreshVersion(data)
    if (this.onFullRefresh && fullVersion !== undefined) {
      try {
        this.onFullRefresh(fullVersion)
      } catch {
        // A display notification must not break the upstream SSE transport.
      }
    }
    const documentVersion = wordPatchVersion(data)
    if (this.onDocumentPatch && documentVersion !== undefined) {
      try {
        this.onDocumentPatch(documentVersion)
      } catch {
        // A display notification must not break the upstream SSE transport.
      }
    }
    const selection = selectionUpdate(data)
    if (selection !== undefined && this.onSelection) {
      try {
        this.onSelection(selection)
      } catch {
        // A display notification must not break the upstream SSE transport.
      }
    }
    const presentation = presentationMutation(data)
    if (this.onPresentationChange && presentation) {
      try {
        this.onPresentationChange(presentation.version, presentation.slideCountChanged)
      } catch {
        // A display notification must not break the upstream SSE transport.
      }
    }
    if (this.onCellPatch) {
      for (const patch of excelPatchCells(data)) {
        try {
          this.onCellPatch(patch)
        } catch {
          // A display notification must not break the upstream SSE transport.
        }
      }
    }
  }
}
