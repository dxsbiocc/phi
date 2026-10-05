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
import { addSheetWriteRequest } from '../src/main/agent/office/office-sheet-operation'

test('add_sheet prewrite list and compact reusable receipt survive persistence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'office-sheet-log-'))
  const draftPath = join(directory, 'draft.xlsx')
  const request = addSheetWriteRequest({ name: '汇总表', baseRevision: 2 })
  const before = { sheetNames: ['Sheet1', '数据'] }
  const started = startOfficeOperation(
    { version: 2, contentRevision: 2, operations: {} },
    'sheet-log-1',
    officeOperationDigest(request),
    '2026-10-05T00:00:00.000Z'
  )
  const unresolved = recordOfficeOperationPrewrite(started, 'sheet-log-1', request, before)
  const result = {
    applied: true,
    saved: true,
    revision: 3,
    sheet: '汇总表',
    path: '/汇总表',
    sheetCount: 3,
    sheetNames: ['Sheet1', '数据', '汇总表'],
    previewConfirmed: true
  } as const

  try {
    await writeFile(draftPath, 'draft')
    await persistOfficeOperationLog(draftPath, unresolved)
    const loadedUnresolved = await loadOfficeOperationLog(draftPath)
    assert.deepEqual(loadedUnresolved.operations['sheet-log-1']?.operation, request)
    assert.deepEqual(loadedUnresolved.operations['sheet-log-1']?.before, before)

    const completed = completeOfficeOperation(
      unresolved,
      'sheet-log-1',
      { ok: true, value: result },
      3
    )
    await persistOfficeOperationLog(draftPath, completed)
    const loadedCompleted = await loadOfficeOperationLog(draftPath)
    assert.deepEqual(loadedCompleted.operations['sheet-log-1']?.receipt, {
      ok: true,
      value: result
    })
    assert.equal(loadedCompleted.operations['sheet-log-1']?.operation, undefined)
    assert.equal(loadedCompleted.operations['sheet-log-1']?.before, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('add_sheet digest changes when the name changes', () => {
  assert.notEqual(
    officeOperationDigest(addSheetWriteRequest({ name: '汇总表', baseRevision: 2 })),
    officeOperationDigest(addSheetWriteRequest({ name: '汇总表2', baseRevision: 2 }))
  )
})
