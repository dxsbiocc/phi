import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OfficeReadError,
  OfficeRangeReader,
  parseOfficeRange
} from '../src/main/agent/office/office-read'
import type { OfficeCliRunResult } from '../src/main/agent/office/office-driver'

function cliJson(value: unknown): OfficeCliRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: '',
    timedOut: false,
    truncated: false
  }
}

function rangeEnvelope(path: string): OfficeCliRunResult {
  const target = path.slice(path.lastIndexOf('/') + 1)
  const parsed = parseOfficeRange(target)
  const children = []
  for (let row = parsed.startRow; row <= parsed.endRow; row += 1) {
    for (let column = parsed.startColumn; column <= parsed.endColumn; column += 1) {
      const ref = `${String.fromCharCode(64 + column)}${row}`
      children.push({ path: `/Sheet1/${ref}`, text: ref, format: { type: 'String' } })
    }
  }
  return cliJson({
    success: true,
    data: { matches: 1, results: [{ path, type: 'range', children }] }
  })
}

test('A1 ranges are normalized and reject worksheet bounds', () => {
  assert.deepEqual(parseOfficeRange('c5'), {
    range: 'C5',
    startRow: 5,
    endRow: 5,
    startColumn: 3,
    endColumn: 3,
    rowCount: 1,
    columnCount: 1,
    cellCount: 1
  })
  assert.deepEqual(parseOfficeRange('B2:A1'), {
    range: 'A1:B2',
    startRow: 1,
    endRow: 2,
    startColumn: 1,
    endColumn: 2,
    rowCount: 2,
    columnCount: 2,
    cellCount: 4
  })
  assert.throws(
    () => parseOfficeRange('XFE1'),
    (error) => {
      return error instanceof OfficeReadError && error.code === 'range_out_of_bounds'
    }
  )
  assert.throws(
    () => parseOfficeRange('A1048577'),
    (error) => {
      return error instanceof OfficeReadError && error.code === 'range_out_of_bounds'
    }
  )
  assert.throws(
    () => parseOfficeRange('A0'),
    (error) => {
      return error instanceof OfficeReadError && error.code === 'invalid_range'
    }
  )
})

test('range reads map calculated values, formulas, empty cells, and unsupported functions', async () => {
  const calls: string[][] = []
  const reader = new OfficeRangeReader({
    cursorSecret: Buffer.alloc(32, 7),
    run: async (_binaryPath, args) => {
      calls.push([...args])
      if (args[0] === 'view') {
        return cliJson({
          success: true,
          data: { sheets: [{ name: 'Sheet1', rows: [{ row: 3, cells: { B3: 'x' } }] }] }
        })
      }
      return cliJson({
        success: true,
        data: {
          matches: 1,
          results: [
            {
              path: '/Sheet1/A1:B3',
              type: 'range',
              children: [
                { path: '/Sheet1/A1', text: '10', format: { type: 'Number' } },
                { path: '/Sheet1/B1', text: '(empty)', format: { type: 'String' } },
                { path: '/Sheet1/A2', text: '', format: { type: 'Number', empty: true } },
                { path: '/Sheet1/B2', text: ' ', format: { type: 'String' } },
                {
                  path: '/Sheet1/A3',
                  text: '30',
                  format: {
                    type: 'Number',
                    formula: 'SUM(A1,20)',
                    computedValue: '30',
                    evaluated: true
                  }
                },
                {
                  path: '/Sheet1/B3',
                  text: '#OCLI_NOTEVAL!',
                  format: {
                    type: 'Number',
                    formula: 'NOSUCHFN(A1)',
                    evaluated: false
                  }
                }
              ]
            }
          ]
        }
      })
    }
  })

  const result = await reader.read(
    {
      artifactId: 'artifact-1',
      binaryPath: '/officecli',
      draftPath: '/private/draft.xlsx',
      revision: 0
    },
    { sheet: 'Sheet1', range: 'A1:B3' }
  )

  assert.deepEqual(calls, [
    ['view', '/private/draft.xlsx', 'text', '--max-lines', '1001', '--json'],
    ['get', '/private/draft.xlsx', '/Sheet1/A1:B3', '--json']
  ])
  assert.deepEqual(result, {
    revision: 0,
    sheet: 'Sheet1',
    range: 'A1:B3',
    cells: [
      { ref: 'A1', value: 10, valueType: 'number' },
      { ref: 'B1', value: '(empty)', valueType: 'string' },
      { ref: 'A2', value: null, valueType: 'empty' },
      { ref: 'B2', value: ' ', valueType: 'string' },
      { ref: 'A3', value: 30, formula: '=SUM(A1,20)', valueType: 'number', evaluated: true },
      {
        ref: 'B3',
        value: null,
        formula: '=NOSUCHFN(A1)',
        valueType: 'error',
        evaluated: false,
        error: 'unsupported_function'
      }
    ],
    rowCount: 3,
    columnCount: 2,
    complete: true,
    truncated: false,
    limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.cells), true)
})

test('boolean formulas use their TRUE or FALSE text instead of numeric computedValue', async () => {
  const reader = new OfficeRangeReader({
    cursorSecret: Buffer.alloc(32, 8),
    run: async (_binaryPath, args) =>
      args[0] === 'view'
        ? cliJson({ success: true, data: { sheets: [{ name: 'Sheet1', rows: [] }] } })
        : cliJson({
            success: true,
            data: {
              matches: 1,
              results: [
                {
                  path: '/Sheet1/A1:A1',
                  type: 'range',
                  children: [
                    {
                      path: '/Sheet1/A1',
                      text: 'TRUE',
                      format: {
                        type: 'Boolean',
                        formula: '1=1',
                        computedValue: '1',
                        evaluated: true
                      }
                    }
                  ]
                }
              ]
            }
          })
  })

  const result = await reader.read(
    {
      artifactId: 'artifact-boolean',
      binaryPath: '/officecli',
      draftPath: '/private/draft.xlsx',
      revision: 0
    },
    { sheet: 'Sheet1', range: 'A1' }
  )

  assert.ok('cells' in result)
  assert.deepEqual(result.cells[0], {
    ref: 'A1',
    value: true,
    formula: '=1=1',
    valueType: 'boolean',
    evaluated: true
  })
})

test('a document-level target without a range returns an incomplete workbook overview', async () => {
  const reader = new OfficeRangeReader({
    cursorSecret: Buffer.alloc(32, 3),
    run: async () =>
      cliJson({
        success: true,
        data: {
          sheets: [
            { name: 'Sheet1', rows: [{ row: 3, cells: { B3: 'last' } }] },
            { name: '资料 2026', rows: [{ row: 10, cells: { D10: 'last' } }] },
            { name: '空表', rows: [] }
          ]
        }
      })
  })

  const result = await reader.read(
    {
      artifactId: 'artifact-1',
      binaryPath: '/officecli',
      draftPath: '/private/draft.xlsx',
      revision: 0
    },
    {}
  )

  assert.deepEqual(result, {
    revision: 0,
    sheets: [
      { name: 'Sheet1', usedRange: 'A1:B3', rowCount: 3, columnCount: 2 },
      { name: '资料 2026', usedRange: 'A1:D10', rowCount: 10, columnCount: 4 },
      { name: '空表', usedRange: null, rowCount: 0, columnCount: 0 }
    ],
    complete: false,
    truncated: false,
    hint: '请指定 sheet 和 range（例如 Sheet1 与 A1:B3）后继续读取',
    limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
  })
  assert.equal(Object.isFrozen(result), true)
  assert.equal(Object.isFrozen(result.sheets), true)
})

test('cell limits paginate on whole row boundaries without omissions or duplicates', async () => {
  const getPaths: string[] = []
  const reader = new OfficeRangeReader({
    cursorSecret: Buffer.alloc(32, 11),
    run: async (_binaryPath, args) => {
      if (args[0] === 'view') {
        return cliJson({
          success: true,
          data: { sheets: [{ name: 'Sheet1', rows: [{ row: 5, cells: { B5: 'last' } }] }] }
        })
      }
      getPaths.push(args[2])
      return rangeEnvelope(args[2])
    }
  })
  const context = {
    artifactId: 'artifact-1',
    binaryPath: '/officecli',
    draftPath: '/private/draft.xlsx',
    revision: 4
  }

  const pages = []
  let cursor: string | undefined
  do {
    const result = await reader.read(
      context,
      cursor ? { cursor, maxCells: 4 } : { sheet: 'Sheet1', range: 'A1:B5', maxCells: 4 }
    )
    assert.ok('cells' in result)
    pages.push(result)
    cursor = result.nextCursor
  } while (cursor)

  assert.deepEqual(getPaths, ['/Sheet1/A1:B2', '/Sheet1/A3:B4', '/Sheet1/A5:B5'])
  assert.deepEqual(
    pages.flatMap((page) => page.cells.map((cell) => cell.ref)),
    ['A1', 'B1', 'A2', 'B2', 'A3', 'B3', 'A4', 'B4', 'A5', 'B5']
  )
  assert.deepEqual(
    pages.map((page) => ({
      range: page.range,
      rowCount: page.rowCount,
      columnCount: page.columnCount,
      complete: page.complete,
      truncated: page.truncated,
      hasCursor: typeof page.nextCursor === 'string'
    })),
    [
      {
        range: 'A1:B5',
        rowCount: 5,
        columnCount: 2,
        complete: false,
        truncated: true,
        hasCursor: true
      },
      {
        range: 'A1:B5',
        rowCount: 5,
        columnCount: 2,
        complete: false,
        truncated: true,
        hasCursor: true
      },
      {
        range: 'A1:B5',
        rowCount: 5,
        columnCount: 2,
        complete: true,
        truncated: false,
        hasCursor: false
      }
    ]
  )
})

test('cursors reject tampering, revision mismatches, and expiry', async () => {
  let now = 1_000
  const reader = new OfficeRangeReader({
    cursorSecret: Buffer.alloc(32, 19),
    now: () => now,
    run: async (_binaryPath, args) => {
      if (args[0] === 'view') {
        return cliJson({
          success: true,
          data: { sheets: [{ name: 'Sheet1', rows: [{ row: 3, cells: { A3: 'last' } }] }] }
        })
      }
      return rangeEnvelope(args[2])
    }
  })
  const context = {
    artifactId: 'artifact-1',
    binaryPath: '/officecli',
    draftPath: '/private/draft.xlsx',
    revision: 4
  }
  const first = await reader.read(context, {
    sheet: 'Sheet1',
    range: 'A1:A3',
    maxCells: 1
  })
  assert.ok('nextCursor' in first && first.nextCursor)
  const cursor = first.nextCursor
  const replacement = cursor.endsWith('A') ? 'B' : 'A'

  await assert.rejects(reader.read(context, { cursor: `${cursor.slice(0, -1)}${replacement}` }), {
    code: 'invalid_cursor'
  })
  await assert.rejects(reader.read({ ...context, revision: 5 }, { cursor }), {
    code: 'invalid_cursor'
  })
  await assert.rejects(reader.read(context, { cursor, sheet: '资料' }), {
    code: 'invalid_cursor'
  })
  now += 15 * 60 * 1_000 + 1
  await assert.rejects(reader.read(context, { cursor }), { code: 'invalid_cursor' })
})

test('the byte limit is stricter than the cell limit and still truncates at row boundaries', async () => {
  const longValue = 'x'.repeat(70_000)
  const reader = new OfficeRangeReader({
    cursorSecret: Buffer.alloc(32, 23),
    run: async (_binaryPath, args) => {
      if (args[0] === 'view') {
        return cliJson({
          success: true,
          data: { sheets: [{ name: 'Sheet1', rows: [{ row: 3, cells: { B3: 'last' } }] }] }
        })
      }
      const target = args[2].slice(args[2].lastIndexOf('/') + 1)
      const parsed = parseOfficeRange(target)
      const children = []
      for (let row = parsed.startRow; row <= parsed.endRow; row += 1) {
        for (let column = parsed.startColumn; column <= parsed.endColumn; column += 1) {
          const ref = `${String.fromCharCode(64 + column)}${row}`
          children.push({
            path: `/Sheet1/${ref}`,
            text: longValue,
            format: { type: 'String' }
          })
        }
      }
      return cliJson({
        success: true,
        data: { matches: 1, results: [{ type: 'range', children }] }
      })
    }
  })
  const context = {
    artifactId: 'artifact-1',
    binaryPath: '/officecli',
    draftPath: '/private/draft.xlsx',
    revision: 0
  }
  const pages = []
  let cursor: string | undefined
  do {
    const page = await reader.read(
      context,
      cursor ? { cursor } : { sheet: 'Sheet1', range: 'A1:B3' }
    )
    assert.ok('cells' in page)
    assert.ok(Buffer.byteLength(JSON.stringify(page), 'utf8') <= 256 * 1024)
    pages.push(page)
    cursor = page.nextCursor
  } while (cursor)

  assert.deepEqual(
    pages.map((page) => page.cells.map((cell) => cell.ref)),
    [
      ['A1', 'B1'],
      ['A2', 'B2'],
      ['A3', 'B3']
    ]
  )
  assert.deepEqual(
    pages.map((page) => [page.complete, page.truncated]),
    [
      [false, true],
      [false, true],
      [true, false]
    ]
  )
})

test('malformed parameters and hard range limits return stable error codes', async () => {
  const reader = new OfficeRangeReader({
    cursorSecret: Buffer.alloc(32, 29),
    run: async () =>
      cliJson({
        success: true,
        data: { sheets: [{ name: 'Sheet1', rows: [] }] }
      })
  })
  const context = {
    artifactId: 'artifact-1',
    binaryPath: '/officecli',
    draftPath: '/private/draft.xlsx',
    revision: 0
  }

  for (const params of [
    { sheet: '../Sheet1', range: 'A1' },
    { sheet: 7, range: 'A1' },
    { sheet: 'Missing', range: 'A1' }
  ] as unknown as Array<{ sheet: string; range: string }>) {
    await assert.rejects(reader.read(context, params), (error) => {
      return error instanceof OfficeReadError && error.code === 'invalid_sheet'
    })
  }
  await assert.rejects(reader.read(context, { sheet: 'Sheet1', range: 'A1:XFD4' }), {
    code: 'range_too_large'
  })
  await assert.rejects(reader.read(context, { sheet: 'Sheet1', range: 'A1', maxCells: 0 }), {
    code: 'invalid_range'
  })
  await assert.rejects(reader.read(context, { cursor: '' }), { code: 'invalid_cursor' })
})

test('a timed-out idempotent read retries once and never exposes process details', async () => {
  let calls = 0
  const reader = new OfficeRangeReader({
    cursorSecret: Buffer.alloc(32, 31),
    run: async (_binaryPath, args) => {
      calls += 1
      if (calls === 1) {
        return {
          exitCode: null,
          stdout: '',
          stderr: 'private path /sessions/secret.xlsx on port 43123',
          timedOut: true,
          truncated: false
        }
      }
      if (args[0] === 'view') {
        return cliJson({
          success: true,
          data: { sheets: [{ name: 'Sheet1', rows: [{ row: 1, cells: { A1: 'ok' } }] }] }
        })
      }
      return rangeEnvelope(args[2])
    }
  })
  const context = {
    artifactId: 'artifact-1',
    binaryPath: '/officecli',
    draftPath: '/sessions/secret.xlsx',
    revision: 0
  }

  const result = await reader.read(context, { sheet: 'Sheet1', range: 'A1' })
  assert.ok('cells' in result)
  assert.deepEqual(result.warnings, ['读取曾超时，已自动重试一次'])
  assert.equal(calls, 3)

  const failing = new OfficeRangeReader({
    cursorSecret: Buffer.alloc(32, 37),
    run: async () => ({
      exitCode: null,
      stdout: '',
      stderr: 'private path /sessions/secret.xlsx on port 43123',
      timedOut: false,
      truncated: false,
      spawnError: 'spawn /private/bin/officecli failed'
    })
  })
  await assert.rejects(failing.read(context, { sheet: 'Sheet1', range: 'A1' }), (error) => {
    return (
      error instanceof OfficeReadError &&
      error.code === 'read_failed' &&
      !error.message.includes('/private/') &&
      !error.message.includes('43123')
    )
  })
})

test('a legal range outside the used area returns empty cells with a warning', async () => {
  const reader = new OfficeRangeReader({
    cursorSecret: Buffer.alloc(32, 41),
    run: async (_binaryPath, args) => {
      if (args[0] === 'view') {
        return cliJson({
          success: true,
          data: { sheets: [{ name: 'Sheet1', rows: [{ row: 2, cells: { B2: 'last' } }] }] }
        })
      }
      const target = args[2].slice(args[2].lastIndexOf('/') + 1)
      const parsed = parseOfficeRange(target)
      const children = []
      for (let row = parsed.startRow; row <= parsed.endRow; row += 1) {
        for (let column = parsed.startColumn; column <= parsed.endColumn; column += 1) {
          const ref = `${String.fromCharCode(64 + column)}${row}`
          children.push({
            path: `/Sheet1/${ref}`,
            text: '',
            format: { type: 'Number', empty: true }
          })
        }
      }
      return cliJson({ success: true, data: { results: [{ children }] } })
    }
  })

  const result = await reader.read(
    {
      artifactId: 'artifact-1',
      binaryPath: '/officecli',
      draftPath: '/private/draft.xlsx',
      revision: 0
    },
    { sheet: 'Sheet1', range: 'A10:B10' }
  )
  assert.ok('cells' in result)
  assert.deepEqual(
    result.cells.map((cell) => cell.value),
    [null, null]
  )
  assert.deepEqual(result.warnings, ['读取范围位于工作表的已用范围之外，返回空单元格'])
})
