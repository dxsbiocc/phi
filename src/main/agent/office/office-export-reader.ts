import {
  OFFICE_EXPORT_LIMITS,
  OfficeExportError,
  type OfficeExportCellValue,
  type OfficeExportSheetData
} from './office-export-contract'
import {
  columnName,
  columnNumber,
  parseOfficeRange,
  validOfficeSheetName,
  type OfficeReadCell,
  type OfficeReadContext,
  type OfficeReadParams,
  type OfficeReadResponse,
  type OfficeReadResult
} from './office-read-contract'

interface OfficeExportSheetReaderDependencies {
  readonly read: (
    context: OfficeReadContext,
    params: OfficeReadParams
  ) => Promise<OfficeReadResponse>
  readonly readExactRange?: (
    context: OfficeReadContext,
    sheet: string,
    range: string
  ) => Promise<readonly OfficeReadCell[]>
}

const MAX_EXPORT_TILE_COLUMNS = 4

export class OfficeExportSheetReader {
  constructor(private readonly dependencies: OfficeExportSheetReaderDependencies) {}

  async read(context: OfficeReadContext, sheet: string): Promise<OfficeExportSheetData> {
    if (!validOfficeSheetName(sheet)) {
      throw new OfficeExportError('invalid_sheet', '工作表名称无效')
    }
    try {
      return await this.readSheet(withoutSelection(context), sheet)
    } catch (error) {
      if (context.signal?.aborted) {
        throw new OfficeExportError('export_cancelled', '导出操作已取消')
      }
      if ((error as { code?: unknown }).code === 'invalid_sheet') {
        throw new OfficeExportError('invalid_sheet', '指定的工作表不存在')
      }
      throw error
    }
  }

  private async readSheet(
    context: OfficeReadContext,
    sheet: string
  ): Promise<OfficeExportSheetData> {
    const overview = await this.dependencies.read(context, { sheet })
    assertRevision(overview, context.revision)
    if (!('sheets' in overview)) throw readFailure('导出无法读取工作簿概览')
    const selected = overview.sheets.find((candidate) => candidate.name === sheet)
    if (!selected) throw new OfficeExportError('invalid_sheet', '指定的工作表不存在')
    assertDimensions(selected.rowCount, selected.columnCount)
    if (!selected.usedRange || selected.rowCount === 0 || selected.columnCount === 0) {
      return freezeSheet(context.revision, sheet, [])
    }
    const values = await this.readSlabs(context, sheet, selected.rowCount, selected.columnCount)
    return freezeSheet(context.revision, sheet, trimTrailingEmpty(values))
  }

  private async readSlabs(
    context: OfficeReadContext,
    sheet: string,
    rows: number,
    columns: number
  ): Promise<OfficeExportCellValue[][]> {
    const values = Array.from({ length: rows }, () =>
      Array.from({ length: columns }, () => null as OfficeExportCellValue)
    )
    const seen = new Set<string>()
    for (let startColumn = 1; startColumn <= columns; startColumn += MAX_EXPORT_TILE_COLUMNS) {
      const endColumn = Math.min(columns, startColumn + MAX_EXPORT_TILE_COLUMNS - 1)
      const tileColumns = endColumn - startColumn + 1
      const rowsPerSlab = Math.max(1, Math.floor(OFFICE_EXPORT_LIMITS.maxPageCells / tileColumns))
      for (let startRow = 1; startRow <= rows; startRow += rowsPerSlab) {
        const endRow = Math.min(rows, startRow + rowsPerSlab - 1)
        const range = `${columnName(startColumn)}${startRow}:${columnName(endColumn)}${endRow}`
        const cells = await this.readTile(context, sheet, range, tileColumns)
        placeCells(values, seen, cells, { startRow, endRow, startColumn, endColumn })
      }
    }
    if (seen.size !== rows * columns) throw readFailure('导出读取的单元格数量不完整')
    return values
  }

  private readTile(
    context: OfficeReadContext,
    sheet: string,
    range: string,
    columns: number
  ): Promise<readonly OfficeReadCell[]> {
    return this.dependencies.readExactRange
      ? this.readAdaptiveExact(context, sheet, range)
      : this.readSlab(context, sheet, range, columns)
  }

  private async readAdaptiveExact(
    context: OfficeReadContext,
    sheet: string,
    range: string
  ): Promise<readonly OfficeReadCell[]> {
    try {
      return await this.dependencies.readExactRange!(context, sheet, range)
    } catch (error) {
      const parsed = parseOfficeRange(range)
      if (!splittableReadError(error) || parsed.cellCount === 1) throw error
      const [first, second] = splitRange(parsed)
      const left = await this.readAdaptiveExact(context, sheet, first)
      const right = await this.readAdaptiveExact(context, sheet, second)
      return [...left, ...right]
    }
  }

  private async readSlab(
    context: OfficeReadContext,
    sheet: string,
    range: string,
    columns: number
  ): Promise<readonly OfficeReadCell[]> {
    const expected = parseOfficeRange(range)
    const cells: OfficeReadCell[] = []
    const cursors = new Set<string>()
    let params: OfficeReadParams = { sheet, range, maxCells: OFFICE_EXPORT_LIMITS.maxPageCells }
    while (true) {
      const page = await this.dependencies.read(context, params)
      assertRangePage(page, context.revision, sheet, expected.range, columns)
      cells.push(...page.cells)
      if (page.complete) break
      if (!page.nextCursor || cursors.has(page.nextCursor)) {
        throw readFailure('导出分页标记无效')
      }
      cursors.add(page.nextCursor)
      params = { cursor: page.nextCursor }
    }
    if (cells.length !== expected.cellCount) throw readFailure('导出读取的单元格数量不完整')
    return cells
  }
}

function withoutSelection(context: OfficeReadContext): OfficeReadContext {
  return {
    artifactId: context.artifactId,
    binaryPath: context.binaryPath,
    draftPath: context.draftPath,
    revision: context.revision,
    ...(context.signal ? { signal: context.signal } : {})
  }
}

function assertRangePage(
  response: OfficeReadResponse,
  revision: number,
  sheet: string,
  range: string,
  columns: number
): asserts response is OfficeReadResult {
  assertRevision(response, revision)
  if (
    !('cells' in response) ||
    response.sheet !== sheet ||
    response.range !== range ||
    response.columnCount !== columns ||
    response.cells.length === 0 ||
    response.cells.length % columns !== 0 ||
    (response.complete && response.truncated) ||
    (!response.complete && !response.truncated)
  ) {
    throw readFailure('导出分页结果不完整')
  }
}

function assertRevision(response: OfficeReadResponse, revision: number): void {
  if (response.revision !== revision) {
    throw new OfficeExportError('revision_changed', '读取期间工作簿版本发生变化')
  }
}

function assertDimensions(rows: number, columns: number): void {
  const cells = rows * columns
  if (
    !Number.isSafeInteger(rows) ||
    !Number.isSafeInteger(columns) ||
    rows < 0 ||
    columns < 0 ||
    rows > OFFICE_EXPORT_LIMITS.maxRows ||
    columns > OFFICE_EXPORT_LIMITS.maxColumns ||
    cells > OFFICE_EXPORT_LIMITS.maxCells
  ) {
    throw new OfficeExportError('export_too_large', '工作表超过导出上限', {
      rows,
      columns,
      cells
    })
  }
}

function placeCells(
  values: OfficeExportCellValue[][],
  seen: Set<string>,
  cells: readonly OfficeReadCell[],
  bounds: {
    readonly startRow: number
    readonly endRow: number
    readonly startColumn: number
    readonly endColumn: number
  }
): void {
  for (const cell of cells) {
    const match = /^([A-Z]+)([1-9]\d*)$/u.exec(cell.ref)
    const row = match ? Number(match[2]) : 0
    const column = match ? columnNumber(match[1]) : 0
    if (
      !match ||
      row < bounds.startRow ||
      row > bounds.endRow ||
      column < bounds.startColumn ||
      column > bounds.endColumn ||
      seen.has(cell.ref)
    ) {
      throw readFailure('导出读取的单元格坐标无效')
    }
    seen.add(cell.ref)
    values[row - 1]![column - 1] = exportCellValue(cell)
  }
}

function splittableReadError(error: unknown): boolean {
  const code = (error as { code?: unknown }).code
  return code === 'read_failed' || code === 'range_too_large'
}

function splitRange(range: ReturnType<typeof parseOfficeRange>): readonly [string, string] {
  if (range.rowCount > 1) {
    const middle = Math.floor((range.startRow + range.endRow) / 2)
    return [
      `${columnName(range.startColumn)}${range.startRow}:${columnName(range.endColumn)}${middle}`,
      `${columnName(range.startColumn)}${middle + 1}:${columnName(range.endColumn)}${range.endRow}`
    ]
  }
  const middle = Math.floor((range.startColumn + range.endColumn) / 2)
  return [
    `${columnName(range.startColumn)}${range.startRow}:${columnName(middle)}${range.endRow}`,
    `${columnName(middle + 1)}${range.startRow}:${columnName(range.endColumn)}${range.endRow}`
  ]
}

function exportCellValue(cell: OfficeReadCell): OfficeExportCellValue {
  if (
    cell.valueType === 'error' ||
    (cell.formula !== undefined && (cell.evaluated !== true || cell.value === null))
  ) {
    throw new OfficeExportError(
      'computed_value_unavailable',
      `公式单元格 ${cell.ref} 没有可用的计算结果`
    )
  }
  if (typeof cell.value === 'number' && !Number.isFinite(cell.value)) {
    throw new OfficeExportError('computed_value_unavailable', `单元格 ${cell.ref} 不是有限数值`)
  }
  return cell.value
}

function trimTrailingEmpty(
  values: readonly (readonly OfficeExportCellValue[])[]
): OfficeExportCellValue[][] {
  let lastRow = values.length - 1
  while (lastRow >= 0 && values[lastRow]!.every(emptyCell)) lastRow -= 1
  if (lastRow < 0) return []
  let lastColumn = values[0]?.length ?? 0
  while (
    lastColumn > 0 &&
    values.slice(0, lastRow + 1).every((row) => emptyCell(row[lastColumn - 1] ?? null))
  ) {
    lastColumn -= 1
  }
  return values.slice(0, lastRow + 1).map((row) => [...row.slice(0, lastColumn)])
}

function emptyCell(value: OfficeExportCellValue): boolean {
  return value === null || value === ''
}

function freezeSheet(
  revision: number,
  sheet: string,
  values: readonly (readonly OfficeExportCellValue[])[]
): OfficeExportSheetData {
  const frozen = Object.freeze(values.map((row) => Object.freeze([...row])))
  return Object.freeze({
    revision,
    sheet,
    rows: frozen.length,
    columns: frozen[0]?.length ?? 0,
    values: frozen
  })
}

function readFailure(message: string): OfficeExportError {
  return new OfficeExportError('export_failed', message)
}
