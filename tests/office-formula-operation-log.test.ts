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
import { validateOfficeWriteRequest } from '../src/main/agent/office/office-write'

test('v2 logs preserve formula prewrite evidence and compact a formula_invalid receipt', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'office-formula-log-'))
  const draftPath = join(directory, 'draft.xlsx')
  const request = validateOfficeWriteRequest({
    operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E1', formula: '=1/0' },
    baseRevision: 4
  })
  const before = {
    value: 3,
    valueType: 'number' as const,
    formula: '=A1+A2',
    evaluated: true
  }
  const started = startOfficeOperation(
    { version: 2, contentRevision: 4, operations: {} },
    'formula-log-1',
    officeOperationDigest(request),
    '2026-10-05T00:00:00.000Z'
  )
  const unresolved = recordOfficeOperationPrewrite(started, 'formula-log-1', request, before)
  const result = {
    applied: false as const,
    saved: true as const,
    revision: 4,
    sheet: 'Sheet1',
    cell: 'E1',
    formula: '=1/0',
    formulaStatus: {
      formula: '=1/0',
      evaluated: true,
      computedValue: '#DIV/0!',
      valueType: 'error' as const
    },
    reason: 'error_value' as const,
    previewConfirmed: false as const
  }

  try {
    await writeFile(draftPath, 'draft')
    await persistOfficeOperationLog(draftPath, unresolved)
    const loadedUnresolved = await loadOfficeOperationLog(draftPath)
    assert.deepEqual(loadedUnresolved.operations['formula-log-1']?.operation, request)
    assert.deepEqual(loadedUnresolved.operations['formula-log-1']?.before, before)

    const completed = completeOfficeOperation(
      unresolved,
      'formula-log-1',
      { ok: false, error: { code: 'formula_invalid', result } },
      4
    )
    await persistOfficeOperationLog(draftPath, completed)
    const loadedCompleted = await loadOfficeOperationLog(draftPath)
    assert.deepEqual(loadedCompleted.operations['formula-log-1']?.receipt, {
      ok: false,
      error: { code: 'formula_invalid', result }
    })
    assert.equal(loadedCompleted.operations['formula-log-1']?.operation, undefined)
    assert.equal(loadedCompleted.operations['formula-log-1']?.before, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
