import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
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
import { validateOfficeWriteRequest } from '../src/main/agent/office/office-write-operation'

test('DOCX terminal receipts survive restart and preserve stable paragraph identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-docx-log-'))
  const draftPath = join(root, 'document.docx')
  const request = validateOfficeWriteRequest({
    operation: { type: 'add_paragraph', text: '新增正文' },
    baseRevision: 0
  })
  try {
    let state = startOfficeOperation(
      { version: 2, contentRevision: 0, operations: {} },
      'docx-op-1',
      officeOperationDigest(request),
      '2026-10-05T00:00:00.000Z'
    )
    state = recordOfficeOperationPrewrite(state, 'docx-op-1', request, {
      type: 'add_paragraph',
      paragraphCount: 0
    })
    state = completeOfficeOperation(
      state,
      'docx-op-1',
      {
        ok: true,
        value: {
          applied: true,
          saved: true,
          revision: 1,
          paraId: '00100000',
          path: '/body/p[@paraId=00100000]',
          index: 0,
          text: '新增正文',
          previewConfirmed: true
        }
      },
      1
    )
    await persistOfficeOperationLog(draftPath, state)

    const restored = await loadOfficeOperationLog(draftPath)

    assert.equal(restored.contentRevision, 1)
    assert.deepEqual(
      restored.operations['docx-op-1']?.receipt,
      state.operations['docx-op-1']?.receipt
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a persisted in-flight DOCX set freezes on restart with bounded before evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-docx-inflight-'))
  const draftPath = join(root, 'document.docx')
  const request = validateOfficeWriteRequest({
    operation: {
      type: 'set_paragraph_text',
      paraId: '0010000A',
      text: '新正文',
      expectedText: '旧正文'
    },
    baseRevision: 2
  })
  try {
    let state = startOfficeOperation(
      { version: 2, contentRevision: 2, operations: {} },
      'docx-op-inflight',
      officeOperationDigest(request),
      '2026-10-05T00:00:00.000Z'
    )
    state = recordOfficeOperationPrewrite(state, 'docx-op-inflight', request, {
      type: 'set_paragraph_text',
      paraId: '0010000A',
      text: '旧正文'
    })
    await persistOfficeOperationLog(draftPath, state)

    const restored = await loadOfficeOperationLog(draftPath)

    assert.equal(restored.freezeState, 'unknown')
    assert.equal(restored.operations['docx-op-inflight']?.status, 'in_flight')
    assert.deepEqual(restored.operations['docx-op-inflight']?.before, {
      type: 'set_paragraph_text',
      paraId: '0010000A',
      text: '旧正文'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
