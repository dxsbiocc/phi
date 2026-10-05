import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createOfficeApplyHostHandler,
  createOfficeDescribeHostHandler
} from '../src/main/agent/office/office-tool-host'
import type { OfficeWriteRequest } from '../src/main/agent/office/office-write'

test('office apply host strictly normalizes format_range and sanitizes its receipt', async () => {
  const observed: OfficeWriteRequest[] = []
  const handler = createOfficeApplyHostHandler({
    resolveActiveRun: () => ({ runId: 'run-1' }),
    applyCellEdit: async () => {
      throw new Error('set_cell path must not run')
    },
    applyWriteRequest: async (_runId, request) => {
      observed.push(request)
      return {
        applied: true,
        saved: true,
        revision: 1,
        sheet: 'Sheet1',
        range: 'A1:B2',
        rowCount: 2,
        columnCount: 2,
        changedCells: 4,
        appliedFormat: { bold: true, fill: '#FFEEAA', numberFormat: '0.00' },
        previewConfirmed: true
      }
    }
  })

  const result = await handler(
    {
      operation: {
        type: 'format_range',
        sheet: 'Sheet1',
        range: 'a1:b2',
        format: { bold: true, fill: '#ffeeaa', numberFormat: '0.00' }
      },
      baseRevision: 0
    },
    { originSessionId: 'session-1', toolCallId: 'format-tool-1' }
  )

  assert.equal(result.ok, true)
  assert.deepEqual(observed[0], {
    operation: {
      type: 'format_range',
      sheet: 'Sheet1',
      range: 'A1:B2',
      format: { bold: true, fill: '#FFEEAA', numberFormat: '0.00' },
      rowCount: 2,
      columnCount: 2,
      cellCount: 4
    },
    baseRevision: 0
  })
  if (result.ok) assert.deepEqual(result.value, (await Promise.resolve(result)).value)

  const rejected = await handler(
    {
      operation: {
        type: 'format_range',
        sheet: 'Sheet1',
        range: 'A1:B2',
        format: { bold: true, italic: true }
      },
      baseRevision: 0
    },
    { originSessionId: 'session-1', toolCallId: 'format-tool-2' }
  )
  assert.equal(rejected.ok, false)
  assert.equal(observed.length, 1)
})

test('office describe host returns compact format_range approval evidence', async () => {
  const handler = createOfficeDescribeHostHandler({
    resolveActiveRun: () => ({ runId: 'run-1' }),
    describeCellEdit: async () => {
      throw new Error('set_cell path must not run')
    },
    describeWriteRequest: async () => ({
      type: 'format_range',
      documentName: 'experiment.xlsx',
      sheet: 'Sheet1',
      range: 'A1:D1',
      rowCount: 1,
      columnCount: 4,
      cellCount: 4,
      changedCells: 3,
      format: {
        bold: true,
        fill: '#FFEEAA',
        horizontalAlign: 'center',
        numberFormat: '0.00'
      },
      revision: 0
    })
  })

  const result = await handler(
    {
      operation: {
        type: 'format_range',
        sheet: 'Sheet1',
        range: 'A1:D1',
        format: { bold: true, fill: '#FFEEAA', horizontalAlign: 'center', numberFormat: '0.00' }
      },
      baseRevision: 0
    },
    { originSessionId: 'session-1', toolCallId: 'format-tool-1' }
  )

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.type, 'format_range')
    assert.equal(result.value.changedCells, 3)
  }
})
