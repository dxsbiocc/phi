import { randomBytes } from 'node:crypto'

import { officeCliEnv, runOfficeCli } from './office-driver'
import {
  OFFICE_READ_LIMITS,
  OfficeReadError,
  columnName,
  parseOfficeRange,
  validOfficeSheetName,
  type OfficeReadContext,
  type OfficeReadCell,
  type OfficeReadParams,
  type OfficeReadResponse,
  type ParsedOfficeRange
} from './office-read-contract'
import { OfficeReadCursorCodec, type OfficeReadCursorPayload } from './office-read-cursor'
import { createOfficeReadPage } from './office-read-page'
import {
  createOverviewResponse,
  parseOfficeReadJson,
  parseRangeCells,
  parseWorkbookSheets,
  type WorkbookSheet
} from './office-read-parser'

export * from './office-read-contract'

interface OfficeRangeReaderDependencies {
  readonly run?: typeof runOfficeCli
  readonly cursorSecret?: Buffer
  readonly now?: () => number
}

interface WorkbookInspection {
  sheets: WorkbookSheet[]
  warnings: string[]
}

interface ResolvedReadPage {
  sheet: string
  range: ParsedOfficeRange
  pageRange: ParsedOfficeRange
  startRow: number
  maxCells: number
  used: WorkbookSheet
}

function assertReadParams(params: OfficeReadParams): void {
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    throw new OfficeReadError('invalid_range', '读取参数必须是对象')
  }
  if (params.sheet !== undefined && typeof params.sheet !== 'string') {
    throw new OfficeReadError('invalid_sheet', '工作表名称必须是字符串')
  }
  if (params.range !== undefined && typeof params.range !== 'string') {
    throw new OfficeReadError('invalid_range', '单元格范围必须是字符串')
  }
  if (params.cursor !== undefined && typeof params.cursor !== 'string') {
    throw new OfficeReadError('invalid_cursor', '继续读取标记无效')
  }
  if (
    params.maxCells !== undefined &&
    (!Number.isSafeInteger(params.maxCells) || params.maxCells <= 0)
  ) {
    throw new OfficeReadError('invalid_range', 'maxCells 必须是正整数')
  }
}

export class OfficeRangeReader {
  private readonly run: typeof runOfficeCli
  private readonly cursors: OfficeReadCursorCodec

  constructor(dependencies: OfficeRangeReaderDependencies = {}) {
    this.run = dependencies.run ?? runOfficeCli
    this.cursors = new OfficeReadCursorCodec(
      dependencies.cursorSecret ?? randomBytes(32),
      dependencies.now ?? Date.now
    )
  }

  async read(context: OfficeReadContext, params: OfficeReadParams): Promise<OfficeReadResponse> {
    assertReadParams(params)
    const inspection = await this.inspectWorkbook(context)
    const cursor = params.cursor !== undefined ? this.cursors.decode(params.cursor) : undefined
    this.assertCursorContext(cursor, context, params)
    const sheet = this.resolveSheet(cursor, context, params, inspection.sheets)
    const selectionRange = context.selection?.sheet === sheet ? context.selection.range : undefined
    const requestedRange = cursor?.range ?? params.range ?? selectionRange
    if (!requestedRange) {
      return createOverviewResponse(context.revision, inspection.sheets, inspection.warnings)
    }
    const page = this.resolvePage(cursor, params, sheet, requestedRange, inspection.sheets)
    const cliRange = `${columnName(page.pageRange.startColumn)}${page.pageRange.startRow}:${columnName(page.pageRange.endColumn)}${page.pageRange.endRow}`
    const read = await this.runJson(context, [
      'get',
      context.draftPath,
      `/${sheet}/${cliRange}`,
      '--json'
    ])
    if (read.retried && inspection.warnings.length === 0) {
      inspection.warnings.push('读取曾超时，已自动重试一次')
    }
    const cells = parseRangeCells(read.value, page.pageRange)
    return createOfficeReadPage({
      revision: context.revision,
      sheet,
      range: page.range,
      startRow: page.startRow,
      cells,
      maxCells: page.maxCells,
      used: page.used,
      warnings: inspection.warnings,
      cursorFor: (nextRow) => this.cursorFor(context, sheet, page.range.range, nextRow)
    })
  }

  async readExactRange(
    context: OfficeReadContext,
    sheet: string,
    range: string
  ): Promise<readonly OfficeReadCell[]> {
    if (!validOfficeSheetName(sheet)) {
      throw new OfficeReadError('invalid_sheet', '指定的工作表不存在或名称无效')
    }
    const parsed = parseOfficeRange(range)
    if (parsed.cellCount > OFFICE_READ_LIMITS.maxCells) {
      throw new OfficeReadError('range_too_large', '内部导出读取块超过单页上限')
    }
    const cliRange = `${columnName(parsed.startColumn)}${parsed.startRow}:${columnName(parsed.endColumn)}${parsed.endRow}`
    const read = await this.runJson(context, [
      'get',
      context.draftPath,
      `/${sheet}/${cliRange}`,
      '--json'
    ])
    return parseRangeCells(read.value, parsed)
  }

  private resolvePage(
    cursor: OfficeReadCursorPayload | undefined,
    params: OfficeReadParams,
    sheet: string,
    requestedRange: string,
    sheets: readonly WorkbookSheet[]
  ): ResolvedReadPage {
    const range = parseOfficeRange(requestedRange)
    if (range.cellCount > OFFICE_READ_LIMITS.maxRangeCells) {
      throw new OfficeReadError('range_too_large', '读取范围超过 50,000 个单元格，请缩小范围')
    }
    const maxCells = this.maxCells(params.maxCells)
    if (range.columnCount > maxCells) {
      throw new OfficeReadError('range_too_large', '单行超过读取上限，请缩小列范围')
    }
    const startRow = cursor?.nextRow ?? range.startRow
    if (startRow < range.startRow || startRow > range.endRow) {
      throw new OfficeReadError('invalid_cursor', '继续读取标记与当前范围不匹配')
    }
    const pageRows = Math.max(1, Math.floor(maxCells / range.columnCount))
    const endRow = Math.min(range.endRow, startRow + pageRows - 1)
    const pageRange = parseOfficeRange(
      `${columnName(range.startColumn)}${startRow}:${columnName(range.endColumn)}${endRow}`
    )
    const used = sheets.find((candidate) => candidate.name === sheet)
    if (!used) throw new OfficeReadError('invalid_sheet', '指定的工作表不存在')
    return { sheet, range, pageRange, startRow, maxCells, used }
  }

  private async inspectWorkbook(context: OfficeReadContext): Promise<WorkbookInspection> {
    const overview = await this.runJson(context, [
      'view',
      context.draftPath,
      'text',
      '--max-lines',
      '1001',
      '--json'
    ])
    return {
      sheets: parseWorkbookSheets(overview.value),
      warnings: overview.retried ? ['读取曾超时，已自动重试一次'] : []
    }
  }

  private resolveSheet(
    cursor: OfficeReadCursorPayload | undefined,
    context: OfficeReadContext,
    params: OfficeReadParams,
    sheets: readonly WorkbookSheet[]
  ): string {
    const sheet = cursor?.sheet ?? params.sheet ?? context.selection?.sheet ?? sheets[0]?.name
    if (
      typeof sheet !== 'string' ||
      !sheet ||
      !validOfficeSheetName(sheet) ||
      !sheets.some((candidate) => candidate.name === sheet)
    ) {
      throw new OfficeReadError('invalid_sheet', '指定的工作表不存在或名称无效')
    }
    return sheet
  }

  private cursorFor(
    context: OfficeReadContext,
    sheet: string,
    range: string,
    nextRow: number
  ): string {
    return this.cursors.encode({
      artifactId: context.artifactId,
      sheet,
      range,
      revision: context.revision,
      nextRow
    })
  }

  private async runJson(
    context: OfficeReadContext,
    args: readonly string[]
  ): Promise<{ value: unknown; retried: boolean }> {
    const options = { timeoutMs: 30_000, env: officeCliEnv(), signal: context.signal }
    const first = await this.run(context.binaryPath, args, options)
    try {
      return { value: parseOfficeReadJson(first), retried: false }
    } catch (error) {
      if (
        !(error instanceof OfficeReadError) ||
        error.code !== 'read_timeout' ||
        context.signal?.aborted
      ) {
        throw error
      }
      const second = await this.run(context.binaryPath, args, options)
      return { value: parseOfficeReadJson(second), retried: true }
    }
  }

  private maxCells(value: number | undefined): number {
    if (value === undefined) return OFFICE_READ_LIMITS.maxCells
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new OfficeReadError('invalid_range', 'maxCells 必须是正整数')
    }
    return Math.min(value, OFFICE_READ_LIMITS.maxCells)
  }

  private assertCursorContext(
    cursor: OfficeReadCursorPayload | undefined,
    context: OfficeReadContext,
    params: OfficeReadParams
  ): void {
    if (!cursor) return
    const suppliedRange = params.range ? parseOfficeRange(params.range).range : undefined
    if (
      cursor.artifactId !== context.artifactId ||
      cursor.revision !== context.revision ||
      (params.sheet !== undefined && params.sheet !== cursor.sheet) ||
      (suppliedRange !== undefined && suppliedRange !== cursor.range)
    ) {
      throw new OfficeReadError('invalid_cursor', '继续读取标记与当前文档或范围不匹配')
    }
  }
}
