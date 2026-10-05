import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OfficeExportSheetReader } from '../src/main/agent/office/office-export-reader'
import {
  columnName,
  parseOfficeRange,
  type OfficeReadCell,
  type OfficeReadContext,
  type OfficeReadParams,
  type OfficeReadResponse
} from '../src/main/agent/office/office-read-contract'

const context: OfficeReadContext = {
  artifactId: 'artifact-1',
  binaryPath: '/officecli',
  draftPath: '/private/draft.xlsx',
  revision: 7,
  selection: { sheet: 'Wrong', range: 'A1' }
}

function overview(rows: number, columns: number, revision = 7): OfficeReadResponse {
  return {
    revision,
    sheets: [
      {
        name: 'Data',
        usedRange: rows && columns ? `A1:${columnName(columns)}${rows}` : null,
        rowCount: rows,
        columnCount: columns
      }
    ],
    complete: false,
    truncated: false,
    hint: 'choose range',
    limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
  }
}

function page(
  range: string,
  cells: readonly OfficeReadCell[],
  options: { revision?: number; complete?: boolean; nextCursor?: string } = {}
): OfficeReadResponse {
  const parsed = parseOfficeRange(range)
  const complete = options.complete ?? true
  return {
    revision: options.revision ?? 7,
    sheet: 'Data',
    range: parsed.range,
    cells,
    rowCount: parsed.rowCount,
    columnCount: parsed.columnCount,
    complete,
    truncated: !complete,
    ...(options.nextCursor ? { nextCursor: options.nextCursor } : {}),
    limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
  }
}

function cellsForRange(
  range: string,
  valueAt?: (row: number, column: number) => unknown
): OfficeReadCell[] {
  const parsed = parseOfficeRange(range)
  const cells: OfficeReadCell[] = []
  for (let row = parsed.startRow; row <= parsed.endRow; row += 1) {
    for (let column = parsed.startColumn; column <= parsed.endColumn; column += 1) {
      const value = valueAt?.(row, column) ?? null
      cells.push({
        ref: `${columnName(column)}${row}`,
        value: value as string | number | boolean | null,
        valueType: value === null ? 'empty' : typeof value === 'number' ? 'number' : 'string'
      })
    }
  }
  return cells
}

test('complete export reads all 1000 by 80 cells in bounded slabs', async () => {
  const ranges: string[] = []
  const reader = new OfficeExportSheetReader({
    read: async (_context, params) => {
      if (!params.range) return overview(1_000, 80)
      ranges.push(params.range)
      return page(
        params.range,
        cellsForRange(params.range, (row, column) =>
          row === 1_000 && column === 80 ? 'last' : null
        )
      )
    }
  })

  const result = await reader.read(context, 'Data')

  assert.equal(ranges.length, 40)
  assert.equal(result.rows, 1_000)
  assert.equal(result.columns, 80)
  assert.equal(result.values[999]?.[79], 'last')
})

test('internal export reading inspects once and tiles a wide maximum-length row by columns', async () => {
  let overviewCalls = 0
  const ranges: string[] = []
  const long = '文'.repeat(32_767)
  const reader = new OfficeExportSheetReader({
    read: async () => {
      overviewCalls += 1
      return overview(1, 10)
    },
    readExactRange: async (_context, _sheet, range) => {
      ranges.push(range)
      return cellsForRange(range, () => long)
    }
  })

  const result = await reader.read(context, 'Data')

  assert.equal(overviewCalls, 1)
  assert.equal(ranges.length, 3)
  assert.ok(ranges.every((range) => parseOfficeRange(range).columnCount <= 4))
  assert.equal(result.values[0]?.length, 10)
  assert.equal(result.values[0]?.[9], long)
})

test('internal export reading recursively splits a driver-truncated tile without losing coordinates', async () => {
  const reader = new OfficeExportSheetReader({
    read: async () => overview(2, 4),
    readExactRange: async (_context, _sheet, range) => {
      const parsed = parseOfficeRange(range)
      if (parsed.cellCount > 2) throw Object.assign(new Error('truncated'), { code: 'read_failed' })
      return cellsForRange(range, (row, column) => `${row}:${column}`)
    }
  })

  assert.deepEqual((await reader.read(context, 'Data')).values, [
    ['1:1', '1:2', '1:3', '1:4'],
    ['2:1', '2:2', '2:3', '2:4']
  ])
})

test('complete export follows byte-limited cursors and preserves middle empty rows and columns', async () => {
  const calls: OfficeReadParams[] = []
  const firstCells = cellsForRange('A1:D1', (_row, column) => (column === 1 ? 'left' : null))
  const secondCells = cellsForRange('A2:D4', (row, column) =>
    row === 3 && column === 3 ? 'right' : null
  )
  const reader = new OfficeExportSheetReader({
    read: async (_context, params) => {
      calls.push(params)
      if (!params.range && !params.cursor) return overview(4, 4)
      if (params.range) return page(params.range, firstCells, { complete: false, nextCursor: 'c2' })
      return page('A1:D4', secondCells)
    }
  })

  const result = await reader.read(context, 'Data')

  assert.deepEqual(calls.at(-1), { cursor: 'c2' })
  assert.deepEqual(result.values, [
    ['left', null, null],
    [null, null, null],
    [null, null, 'right']
  ])
})

test('complete export rejects revision changes and unavailable computed formulas', async () => {
  const revisionReader = new OfficeExportSheetReader({
    read: async (_context, params) =>
      params.range
        ? page(params.range, cellsForRange(params.range), { revision: 8 })
        : overview(1, 1)
  })
  await assert.rejects(revisionReader.read(context, 'Data'), { code: 'revision_changed' })

  const formulaReader = new OfficeExportSheetReader({
    read: async (_context, params) =>
      params.range
        ? page(params.range, [
            {
              ref: 'A1',
              value: null,
              formula: '=NOSUCHFN()',
              valueType: 'error',
              evaluated: false,
              error: 'unsupported_function'
            }
          ])
        : overview(1, 1)
  })
  await assert.rejects(formulaReader.read(context, 'Data'), {
    code: 'computed_value_unavailable'
  })
})

test('complete export rejects dimensions above every admission limit', async () => {
  for (const [rows, columns] of [
    [1_001, 1],
    [1, 101],
    [1_000, 81]
  ]) {
    const reader = new OfficeExportSheetReader({
      read: async () => overview(rows, columns)
    })
    await assert.rejects(reader.read(context, 'Data'), { code: 'export_too_large' })
  }
})

test('empty and all-empty sheets export as a zero by zero matrix', async () => {
  const empty = new OfficeExportSheetReader({ read: async () => overview(0, 0) })
  assert.deepEqual(await empty.read(context, 'Data'), {
    revision: 7,
    sheet: 'Data',
    rows: 0,
    columns: 0,
    values: []
  })

  const blank = new OfficeExportSheetReader({
    read: async (_context, params) =>
      params.range ? page(params.range, cellsForRange(params.range)) : overview(2, 2)
  })
  assert.deepEqual(await blank.read(context, 'Data'), {
    revision: 7,
    sheet: 'Data',
    rows: 0,
    columns: 0,
    values: []
  })
})
