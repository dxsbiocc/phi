import assert from 'node:assert/strict'
import { test } from 'node:test'

import { OfficeSelectionSseParser } from '../src/main/agent/office/office-selection-events'
import {
  isValidOfficeSelectionPath,
  selectionSummaryFromPaths
} from '../src/main/agent/office/office-selection-events'
import {
  OfficeSelectionError,
  resolveOfficeSelection
} from '../src/main/agent/office/office-selection-resolver'
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

test('selection-update SSE frames publish a validated range across fragmented chunks', () => {
  const updates: unknown[] = []
  const parser = new OfficeSelectionSseParser((selection) => updates.push(selection))
  const paths = ['/Sheet1/A1', '/Sheet1/B1', '/Sheet1/A2', '/Sheet1/B2', '/Sheet1/A3', '/Sheet1/B3']

  parser.push('event: update\ndata: {"action":"selection-')
  parser.push(`update","paths":${JSON.stringify(paths)}}\n\n`)

  assert.deepEqual(updates, [{ sheet: 'Sheet1', range: 'A1:B3', paths }])
})

test('selection SSE parsing recovers after an oversized unterminated frame', () => {
  const updates: unknown[] = []
  const parser = new OfficeSelectionSseParser((selection) => updates.push(selection))

  parser.push('x'.repeat(70 * 1024))
  parser.push('event: update\ndata: {"action":"selection-update","paths":["/Sheet1/A1"]}\n\n')

  assert.deepEqual(updates, [{ sheet: 'Sheet1', range: 'A1', paths: ['/Sheet1/A1'] }])
})

test('selection parsing ignores content and mark updates', () => {
  const updates: unknown[] = []
  const parser = new OfficeSelectionSseParser((selection) => updates.push(selection))

  parser.push('event: update\ndata: {"action":"excel-patch","version":2}\n\n')
  parser.push('event: update\ndata: {"action":"mark-update","version":2,"marks":[]}\n\n')

  assert.deepEqual(updates, [])
})

test('selection parsing ignores oversized upstream path sets', () => {
  const updates: unknown[] = []
  const parser = new OfficeSelectionSseParser((selection) => updates.push(selection))

  parser.push(
    `event: update\ndata: ${JSON.stringify({
      action: 'selection-update',
      paths: Array.from({ length: 201 }, () => '/Sheet1/A1')
    })}\n\n`
  )

  assert.deepEqual(updates, [])
})

test('an empty selection-update clears the displayed selection', () => {
  const updates: unknown[] = []
  const parser = new OfficeSelectionSseParser((selection) => updates.push(selection))

  parser.push('event: update\ndata: {"action":"selection-update","paths":[]}\n\n')

  assert.deepEqual(updates, [null])
})

test('a real page A1:B3 cell set is normalized to one rectangular display range', () => {
  const paths = ['/Sheet1/A1', '/Sheet1/B1', '/Sheet1/A2', '/Sheet1/B2', '/Sheet1/A3', '/Sheet1/B3']

  assert.deepEqual(selectionSummaryFromPaths(paths), {
    sheet: 'Sheet1',
    range: 'A1:B3',
    paths
  })
})

test('selection request paths accept verified cell, range, row, and column shapes only', () => {
  for (const path of ['/Sheet 1/A1', '/Sheet 1/A1:B3', '/汇总/row[12]', '/Sheet-2/col[XFD]']) {
    assert.equal(isValidOfficeSelectionPath(path), true, path)
  }
  for (const path of ['/Sheet1/row[0]', '/Sheet1/col[XFE]', '/Sheet1/row[1]/A1']) {
    assert.equal(isValidOfficeSelectionPath(path), false, path)
  }
})

test('cross-sheet and non-rectangular selections preserve explicit paths without a fake range', () => {
  const paths = ['/Sheet1/A1', '/说明/A2']
  assert.deepEqual(selectionSummaryFromPaths(paths), { paths })
})

test('selection resolution captures the live selected cells as an immutable rectangle', async () => {
  const calls: string[][] = []
  const paths = ['/Sheet1/A1', '/Sheet1/B1', '/Sheet1/A2', '/Sheet1/B2', '/Sheet1/A3', '/Sheet1/B3']
  const selection = await resolveOfficeSelection('/officecli', '/draft.xlsx', {
    now: () => new Date('2026-10-04T12:00:00.000Z'),
    run: async (_binaryPath, args) => {
      calls.push([...args])
      return calls.length === 1
        ? cliJson({
            success: true,
            data: { matches: 6, results: paths.map((path) => ({ path, type: 'cell' })) }
          })
        : cliJson({
            success: true,
            data: {
              matches: 1,
              results: [
                {
                  path: '/',
                  type: 'workbook',
                  children: [
                    { path: '/Sheet1', type: 'sheet' },
                    { path: '/说明', type: 'sheet' }
                  ]
                }
              ]
            }
          })
    }
  })

  assert.deepEqual(calls, [
    ['get', '/draft.xlsx', 'selected', '--json'],
    ['get', '/draft.xlsx', '/', '--depth', '1', '--json']
  ])
  assert.deepEqual(selection, {
    sheet: 'Sheet1',
    range: 'A1:B3',
    paths,
    resolvedAt: '2026-10-04T12:00:00.000Z'
  })
})

test('selection resolution reports no current selection without inspecting the workbook', async () => {
  let calls = 0
  const selection = await resolveOfficeSelection('/officecli', '/draft.xlsx', {
    run: async () => {
      calls += 1
      return cliJson({ success: true, data: { matches: 0, results: [] } })
    }
  })

  assert.equal(selection, null)
  assert.equal(calls, 1)
})

test('selection resolution rejects a result from a sheet outside the draft workbook', async () => {
  let calls = 0
  await assert.rejects(
    resolveOfficeSelection('/officecli', '/draft.xlsx', {
      run: async () => {
        calls += 1
        return calls === 1
          ? cliJson({
              success: true,
              data: { matches: 1, results: [{ path: '/Other/A1', type: 'cell' }] }
            })
          : cliJson({
              success: true,
              data: {
                matches: 1,
                results: [
                  { path: '/', type: 'workbook', children: [{ path: '/Sheet1', type: 'sheet' }] }
                ]
              }
            })
      }
    }),
    (error) => error instanceof OfficeSelectionError && error.code === 'selection_unavailable'
  )
})

test('selection resolution preserves verified cross-sheet cells as explicit paths', async () => {
  let calls = 0
  const paths = ['/Sheet1/A1', '/说明/A2']
  const selection = await resolveOfficeSelection('/officecli', '/draft.xlsx', {
    now: () => new Date('2026-10-04T12:00:00.000Z'),
    run: async () => {
      calls += 1
      return calls === 1
        ? cliJson({
            success: true,
            data: { matches: 2, results: paths.map((path) => ({ path, type: 'cell' })) }
          })
        : cliJson({
            success: true,
            data: {
              matches: 1,
              results: [
                {
                  path: '/',
                  type: 'workbook',
                  children: [
                    { path: '/Sheet1', type: 'sheet' },
                    { path: '/说明', type: 'sheet' }
                  ]
                }
              ]
            }
          })
    }
  })

  assert.deepEqual(selection, {
    paths,
    resolvedAt: '2026-10-04T12:00:00.000Z'
  })
})

test('selection resolution rejects selections above 10,000 cells before binding', async () => {
  await assert.rejects(
    resolveOfficeSelection('/officecli', '/draft.xlsx', {
      run: async () =>
        cliJson({
          success: true,
          data: { matches: 1, results: [{ path: '/Sheet1/A1:J1001', type: 'range' }] }
        })
    }),
    (error) => error instanceof OfficeSelectionError && error.code === 'selection_too_large'
  )
})

test('selection resolution turns invalid CLI output into a readable selection failure', async () => {
  await assert.rejects(
    resolveOfficeSelection('/officecli', '/draft.xlsx', {
      run: async () => ({
        exitCode: 1,
        stdout: 'not json',
        stderr: 'failed',
        timedOut: false,
        truncated: false
      })
    }),
    (error) =>
      error instanceof OfficeSelectionError &&
      error.code === 'selection_unavailable' &&
      error.message === '无法读取当前选区，请重新选择或清除选区'
  )
})
