import { officeCliEnv, runOfficeCli, type OfficeCliRunResult } from './office-driver'
import {
  OfficeImportError,
  type OfficeImportCellValue,
  type OfficeImportExecutionControl
} from './office-import-contract'
import { OFFICE_IMPORT_LIMITS } from './office-import-limits'
import { columnName, parseOfficeRange, type OfficeReadCell } from './office-read-contract'
import { parseOfficeReadJson, parseRangeCells } from './office-read-parser'

interface OfficeImportVerifierDependencies {
  readonly run?: typeof runOfficeCli
}

function assertCell(
  cell: OfficeReadCell,
  expected: OfficeImportCellValue,
  row: number,
  column: number
): void {
  const empty = expected === '' && cell.value === null && cell.valueType === 'empty'
  const text =
    typeof expected === 'string' &&
    expected !== '' &&
    cell.value === expected &&
    cell.valueType === 'string' &&
    cell.formula === undefined
  const number =
    typeof expected === 'number' &&
    cell.value === expected &&
    cell.valueType === 'number' &&
    cell.formula === undefined
  if (empty || text || number) return
  throw new OfficeImportError(
    'import_verification_failed',
    `导入读回校验在第 ${row} 行第 ${column} 列不一致`,
    {
      row,
      column,
      cell: cell.ref,
      expectedType: typeof expected,
      actualType: cell.valueType,
      formula: cell.formula !== undefined
    }
  )
}

function parsedRead(result: OfficeCliRunResult): unknown {
  try {
    return parseOfficeReadJson(result)
  } catch (error) {
    throw new OfficeImportError(
      'import_verification_failed',
      '无法完整读回导入后的工作簿',
      undefined,
      { cause: error }
    )
  }
}

export class OfficeImportWorkbookVerifier {
  private readonly run: typeof runOfficeCli

  constructor(dependencies: OfficeImportVerifierDependencies = {}) {
    this.run = dependencies.run ?? runOfficeCli
  }

  async verify(
    binaryPath: string,
    draftPath: string,
    sheet: string,
    values: readonly (readonly OfficeImportCellValue[])[],
    control: OfficeImportExecutionControl = {}
  ): Promise<void> {
    const columns = values[0]?.length ?? 0
    if (values.length === 0 || columns === 0) return
    const rowsPerPage = Math.max(1, Math.floor(OFFICE_IMPORT_LIMITS.maxBatchCells / columns))
    for (let startRow = 1; startRow <= values.length; startRow += rowsPerPage) {
      const endRow = Math.min(values.length, startRow + rowsPerPage - 1)
      await this.verifyPage(
        binaryPath,
        draftPath,
        sheet,
        values,
        startRow,
        endRow,
        columns,
        control
      )
    }
  }

  private async verifyPage(
    binaryPath: string,
    draftPath: string,
    sheet: string,
    values: readonly (readonly OfficeImportCellValue[])[],
    startRow: number,
    endRow: number,
    columns: number,
    control: OfficeImportExecutionControl
  ): Promise<void> {
    const range = `A${startRow}:${columnName(columns)}${endRow}`
    const result = await this.run(binaryPath, ['get', draftPath, `/${sheet}/${range}`, '--json'], {
      timeoutMs: 30_000,
      env: officeCliEnv(),
      signal: control.signal
    })
    const cells = parseRangeCells(parsedRead(result), parseOfficeRange(range))
    cells.forEach((cell, index) => {
      const row = startRow + Math.floor(index / columns)
      const column = (index % columns) + 1
      assertCell(cell, values[row - 1]![column - 1]!, row, column)
    })
  }
}
