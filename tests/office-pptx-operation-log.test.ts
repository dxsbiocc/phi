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

test('PPTX terminal receipts survive restart with stable slide identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-pptx-log-'))
  const draftPath = join(root, 'deck.pptx')
  const request = validateOfficeWriteRequest({
    operation: { type: 'add_slide', title: '新增页', body: '正文' },
    baseRevision: 0
  })
  try {
    let state = startOfficeOperation(
      { version: 2, contentRevision: 0, operations: {} },
      'pptx-op-1',
      officeOperationDigest(request),
      '2026-10-05T00:00:00.000Z'
    )
    state = recordOfficeOperationPrewrite(state, 'pptx-op-1', request, {
      type: 'add_slide',
      slideCount: 0
    })
    state = completeOfficeOperation(
      state,
      'pptx-op-1',
      {
        ok: true,
        value: {
          applied: true,
          saved: true,
          revision: 1,
          slideId: '256',
          path: '/slide[@id=256]',
          index: 0,
          title: '新增页',
          body: '正文',
          previewConfirmed: true
        }
      },
      1
    )
    await persistOfficeOperationLog(draftPath, state)
    const restored = await loadOfficeOperationLog(draftPath)
    assert.deepEqual(
      restored.operations['pptx-op-1']?.receipt,
      state.operations['pptx-op-1']?.receipt
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('persisted in-flight PPTX set freezes with bounded stable-id before evidence', async () => {
  const root = mkdtempSync(join(tmpdir(), 'phi-pptx-inflight-'))
  const draftPath = join(root, 'deck.pptx')
  const request = validateOfficeWriteRequest({
    operation: {
      type: 'set_slide_text',
      slideId: '256',
      elementId: '2',
      text: '新标题',
      expectedText: '旧标题'
    },
    baseRevision: 2
  })
  try {
    let state = startOfficeOperation(
      { version: 2, contentRevision: 2, operations: {} },
      'pptx-op-inflight',
      officeOperationDigest(request),
      '2026-10-05T00:00:00.000Z'
    )
    state = recordOfficeOperationPrewrite(state, 'pptx-op-inflight', request, {
      type: 'set_slide_text',
      slideId: '256',
      elementId: '2',
      text: '旧标题'
    })
    await persistOfficeOperationLog(draftPath, state)
    const restored = await loadOfficeOperationLog(draftPath)
    assert.equal(restored.freezeState, 'unknown')
    assert.deepEqual(restored.operations['pptx-op-inflight']?.before, {
      type: 'set_slide_text',
      slideId: '256',
      elementId: '2',
      text: '旧标题'
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
