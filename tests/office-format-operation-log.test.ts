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
  formatRangeWriteRequest,
  type OfficeFormatBeforeCell
} from '../src/main/agent/office/office-write'

test('format_range prewrite evidence and compact receipt survive persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'office-format-log-'))
  const draftPath = join(directory, 'draft.xlsx')
  const request = formatRangeWriteRequest({
    sheet: 'Sheet1',
    range: 'A1:B1',
    format: { bold: true, numberFormat: '0.00' },
    baseRevision: 2
  })
  const before: readonly OfficeFormatBeforeCell[] = [
    {
      ref: 'A1',
      value: 'Title',
      valueType: 'string',
      format: { bold: false, numberFormat: 'General' }
    },
    {
      ref: 'B1',
      value: 12.345,
      valueType: 'number',
      format: { bold: false, numberFormat: 'General' }
    }
  ]
  const started = startOfficeOperation(
    { version: 2, contentRevision: 2, operations: {} },
    'format-log-1',
    officeOperationDigest(request),
    '2026-10-05T00:00:00.000Z'
  )
  const unresolved = recordOfficeOperationPrewrite(started, 'format-log-1', request, before)
  const result = {
    applied: true,
    saved: true,
    revision: 3,
    sheet: 'Sheet1',
    range: 'A1:B1',
    rowCount: 1,
    columnCount: 2,
    changedCells: 2,
    appliedFormat: { bold: true, numberFormat: '0.00' },
    previewConfirmed: true
  } as const

  try {
    await writeFile(draftPath, 'draft')
    await persistOfficeOperationLog(draftPath, unresolved)
    const loadedUnresolved = await loadOfficeOperationLog(draftPath)
    assert.deepEqual(loadedUnresolved.operations['format-log-1']?.operation, request)
    assert.deepEqual(loadedUnresolved.operations['format-log-1']?.before, before)

    const completed = completeOfficeOperation(
      unresolved,
      'format-log-1',
      { ok: true, value: result },
      3
    )
    await persistOfficeOperationLog(draftPath, completed)
    const loadedCompleted = await loadOfficeOperationLog(draftPath)
    assert.deepEqual(loadedCompleted.operations['format-log-1']?.receipt, {
      ok: true,
      value: result
    })
    assert.equal(loadedCompleted.operations['format-log-1']?.operation, undefined)
    assert.equal(loadedCompleted.operations['format-log-1']?.before, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
