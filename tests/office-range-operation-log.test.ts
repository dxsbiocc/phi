import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  completeOfficeOperation,
  loadOfficeOperationLog,
  officeOperationDigest,
  persistOfficeOperationLog,
  recordOfficeOperationPrewrite,
  startOfficeOperation
} from '../src/main/agent/office/office-operation-log'
import {
  rangeWriteRequest,
  validateRangeEditParams,
  type OfficeRangeBeforeValue
} from '../src/main/agent/office/office-write'

test('operation log persists complete typed range evidence while unresolved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'office-range-log-'))
  const draftPath = join(directory, 'draft.xlsx')
  const request = rangeWriteRequest(
    validateRangeEditParams({
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [
        ['A', 2],
        [true, 'D']
      ],
      baseRevision: 3
    })
  )
  const before: readonly (readonly OfficeRangeBeforeValue[])[] = [
    [
      { value: 'old-a', valueType: 'string' },
      { value: 1, valueType: 'number' }
    ],
    [
      { value: false, valueType: 'boolean' },
      { value: 'old-d', valueType: 'string' }
    ]
  ]
  const started = startOfficeOperation(
    { version: 2, contentRevision: 3, operations: {} },
    'range-log-1',
    officeOperationDigest(request),
    '2026-10-05T00:00:00.000Z'
  )
  const unresolved = recordOfficeOperationPrewrite(started, 'range-log-1', request, before)

  try {
    await writeFile(draftPath, 'draft')
    await persistOfficeOperationLog(draftPath, unresolved)
    assert.deepEqual(await loadOfficeOperationLog(draftPath), {
      ...unresolved,
      freezeState: 'unknown'
    })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('terminal range receipts discard full matrices while remaining replayable', () => {
  const request = rangeWriteRequest(
    validateRangeEditParams({
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [
        ['A', 'B'],
        ['C', 'D']
      ],
      baseRevision: 0
    })
  )
  const before = [
    [
      { value: 'old-a', valueType: 'string' as const },
      { value: 'old-b', valueType: 'string' as const }
    ],
    [
      { value: 'old-c', valueType: 'string' as const },
      { value: 'old-d', valueType: 'string' as const }
    ]
  ]
  const started = startOfficeOperation(
    { version: 2, contentRevision: 0, operations: {} },
    'range-terminal-1',
    officeOperationDigest(request),
    '2026-10-05T00:00:00.000Z'
  )
  const unresolved = recordOfficeOperationPrewrite(started, 'range-terminal-1', request, before)
  const result = {
    applied: true,
    saved: true,
    revision: 1,
    sheet: 'Sheet1',
    range: 'A1:B2',
    rowCount: 2,
    columnCount: 2,
    changedCells: 4,
    preview: [{ cell: 'A1', before: 'old-a', after: 'A' }],
    beforeHash: 'a'.repeat(64),
    afterHash: 'b'.repeat(64),
    previewConfirmed: true
  } as const

  const completed = completeOfficeOperation(
    unresolved,
    'range-terminal-1',
    { ok: true, value: result },
    1
  )

  assert.equal(completed.operations['range-terminal-1']?.operation, undefined)
  assert.equal(completed.operations['range-terminal-1']?.before, undefined)
  assert.deepEqual(completed.operations['range-terminal-1']?.receipt, { ok: true, value: result })
})

test('five hundred compact terminal range receipts stay below four MiB', () => {
  let state = { version: 2 as const, contentRevision: 0, operations: {} }
  const result = {
    applied: true,
    saved: true,
    revision: 1,
    sheet: 'Sheet1',
    range: 'A1:J100',
    rowCount: 100,
    columnCount: 10,
    changedCells: 1_000,
    preview: Array.from({ length: 6 }, (_, index) => ({
      cell: `A${index + 1}`,
      before: '🧪'.repeat(121),
      after: '🔬'.repeat(121)
    })),
    beforeHash: 'a'.repeat(64),
    afterHash: 'b'.repeat(64),
    previewConfirmed: true
  } as const
  for (let index = 0; index < 500; index += 1) {
    const operationId = `range-${String(index).padStart(3, '0')}`
    state = startOfficeOperation(
      state,
      operationId,
      index.toString(16).padStart(64, '0'),
      new Date(Date.UTC(2026, 9, 5, 0, 0, index)).toISOString()
    )
    state = completeOfficeOperation(
      state,
      operationId,
      { ok: true, value: { ...result, revision: index + 1 } },
      index + 1
    )
  }

  assert.equal(Object.keys(state.operations).length, 500)
  assert.ok(Buffer.byteLength(JSON.stringify(state, null, 2), 'utf8') < 4 * 1024 * 1024)
})
