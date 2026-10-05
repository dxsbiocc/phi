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
import { clearCellWriteRequest } from '../src/main/agent/office/office-write-operation'

test('clear_cell persists human source and full prewrite evidence for reconciliation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'office-clear-log-'))
  const draftPath = join(directory, 'draft.xlsx')
  const request = clearCellWriteRequest({ sheet: 'Sheet1', cell: 'A1', baseRevision: 2 })
  const before = {
    value: 3,
    valueType: 'number' as const,
    formula: '=1+2',
    evaluated: true,
    format: { bold: true as const, fill: '#FFEEAA', numberFormat: '0.00' }
  }
  try {
    await writeFile(draftPath, 'draft')
    const started = startOfficeOperation(
      { version: 2, contentRevision: 2, operations: {} },
      'human-clear-log',
      officeOperationDigest(request),
      '2026-10-05T00:00:00.000Z',
      'human'
    )
    const pending = recordOfficeOperationPrewrite(started, 'human-clear-log', request, before)
    await persistOfficeOperationLog(draftPath, pending)
    const loaded = await loadOfficeOperationLog(draftPath)
    assert.equal(loaded.operations['human-clear-log']?.source, 'human')
    assert.deepEqual(loaded.operations['human-clear-log']?.operation, request)
    assert.deepEqual(loaded.operations['human-clear-log']?.before, before)

    const completed = completeOfficeOperation(
      loaded,
      'human-clear-log',
      {
        ok: true,
        value: {
          applied: true,
          saved: true,
          revision: 3,
          sheet: 'Sheet1',
          cell: 'A1',
          before: 3,
          after: null,
          previewConfirmed: true
        }
      },
      3
    )
    await persistOfficeOperationLog(draftPath, completed)
    const terminal = await loadOfficeOperationLog(draftPath)
    assert.equal(terminal.operations['human-clear-log']?.source, 'human')
    assert.equal(terminal.contentRevision, 3)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
