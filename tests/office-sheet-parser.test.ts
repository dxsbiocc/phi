import assert from 'node:assert/strict'
import test from 'node:test'

import type { OfficeCliRunResult } from '../src/main/agent/office/office-driver'
import { OfficeSheetReader } from '../src/main/agent/office/office-sheet-driver'
import { parseOfficeSheetSnapshot } from '../src/main/agent/office/office-sheet-parser'
import { OfficeWriteError } from '../src/main/agent/office/office-write-contract'

function result(value: unknown, overrides: Partial<OfficeCliRunResult> = {}): OfficeCliRunResult {
  return {
    exitCode: 0,
    stdout: JSON.stringify(value),
    stderr: '',
    timedOut: false,
    truncated: false,
    ...overrides
  }
}

function workbook(children: unknown[]): unknown {
  return {
    success: true,
    data: {
      matches: 1,
      results: [
        {
          path: '/',
          type: 'workbook',
          childCount: children.length,
          format: {},
          children
        }
      ]
    }
  }
}

function sheet(name: string, childCount = 0): unknown {
  return {
    path: `/${name}`,
    type: 'sheet',
    preview: name,
    childCount,
    format: {},
    children: childCount === 0 ? [] : [{ type: 'row' }]
  }
}

test('sheet parser preserves workbook order and proves the target sheet is empty', () => {
  assert.deepEqual(
    parseOfficeSheetSnapshot(result(workbook([sheet('Sheet1', 1), sheet('汇总 表')]))),
    {
      sheetNames: ['Sheet1', '汇总 表'],
      emptySheetNames: ['汇总 表']
    }
  )
})

test('sheet parser rejects malformed, warned, duplicated, and non-success responses', () => {
  const invalid = [
    result({ success: false }),
    result({ ...workbook([sheet('Sheet1')]), warnings: ['warning'] }),
    result(workbook([sheet('Sheet1'), sheet('sheet1')])),
    result(workbook([sheet('Bad/Name')])),
    result(workbook([sheet('Sheet1')]), { exitCode: 1 }),
    result(workbook([sheet('Sheet1')]), { timedOut: true }),
    result(workbook([sheet('Sheet1')]), { truncated: true }),
    result(workbook([sheet('Sheet1')]), { spawnError: 'secret path' })
  ]
  for (const response of invalid) {
    assert.throws(
      () => parseOfficeSheetSnapshot(response),
      (error: unknown) => error instanceof OfficeWriteError && error.code === 'write_failed'
    )
  }
})

test('sheet reader uses the exact depth-one JSON command and does not expose internal errors', async () => {
  const calls: Array<{ args: readonly string[]; signal?: AbortSignal }> = []
  const reader = new OfficeSheetReader({
    run: async (_binaryPath, args, options) => {
      calls.push({ args, signal: options.signal })
      return result(workbook([sheet('Sheet1'), sheet('汇总表')]))
    }
  })
  const signal = new AbortController().signal
  const snapshot = await reader.read(
    { binaryPath: '/private/bin/officecli', draftPath: '/private/book.xlsx', signal },
    '汇总表'
  )
  assert.deepEqual(calls, [
    {
      args: ['get', '/private/book.xlsx', '/', '--depth', '1', '--json'],
      signal
    }
  ])
  assert.deepEqual(snapshot.sheetNames, ['Sheet1', '汇总表'])
  assert.equal(snapshot.addedSheetEmpty, true)

  const failing = new OfficeSheetReader({
    run: async () => result(workbook([sheet('Sheet1')]), { spawnError: '/private/secret' })
  })
  await assert.rejects(
    () => failing.read({ binaryPath: 'x', draftPath: 'y' }),
    (error: unknown) =>
      error instanceof OfficeWriteError &&
      error.code === 'write_failed' &&
      !error.message.includes('secret')
  )
})
