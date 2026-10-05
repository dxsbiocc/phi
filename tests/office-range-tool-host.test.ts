import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createOfficeApplyHostHandler,
  createOfficeDescribeHostHandler
} from '../src/main/agent/office/office-tool-host'
import type { OfficeWriteRequest } from '../src/main/agent/office/office-write'

test('office apply host revalidates and forwards a normalized set_range request', async () => {
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
        preview: [{ cell: 'A1', before: 'old', after: 'A' }],
        beforeHash: 'a'.repeat(64),
        afterHash: 'b'.repeat(64),
        previewConfirmed: true
      }
    }
  })

  const result = await handler(
    {
      operation: {
        type: 'set_range',
        sheet: 'Sheet1',
        range: 'a1:b2',
        values: [
          ['A', 2],
          [true, 'D']
        ]
      },
      baseRevision: 0
    },
    { originSessionId: 'session-1', toolCallId: 'tool-range-1' }
  )

  assert.equal(result.ok, true)
  assert.equal(observed.length, 1)
  assert.deepEqual(observed[0], {
    operation: {
      type: 'set_range',
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [
        ['A', 2],
        [true, 'D']
      ],
      rowCount: 2,
      columnCount: 2,
      cellCount: 4
    },
    baseRevision: 0
  })
  const rejected = await handler(
    {
      operation: {
        type: 'set_range',
        sheet: 'Sheet1',
        range: 'A1:B2',
        values: [
          ['A', 2],
          [true, 'D']
        ],
        extra: true
      },
      baseRevision: 0
    },
    { originSessionId: 'session-1', toolCallId: 'tool-range-2' }
  )
  assert.equal(rejected.ok, false)
  assert.equal(observed.length, 1)
})

test('office describe host returns a compact set_range approval description', async () => {
  const handler = createOfficeDescribeHostHandler({
    resolveActiveRun: () => ({ runId: 'run-1' }),
    describeCellEdit: async () => {
      throw new Error('set_cell path must not run')
    },
    describeWriteRequest: async (_runId, request) => ({
      type: 'set_range',
      documentName: 'experiment.xlsx',
      sheet: request.operation.sheet,
      range: 'A1:B2',
      rowCount: 2,
      columnCount: 2,
      cellCount: 4,
      changedCells: 4,
      preview: [{ cell: 'A1', before: 'old', after: 'A' }],
      revision: 0
    })
  })

  const result = await handler(
    {
      operation: {
        type: 'set_range',
        sheet: 'Sheet1',
        range: 'A1:B2',
        values: [
          ['A', 2],
          [true, 'D']
        ]
      },
      baseRevision: 0
    },
    { originSessionId: 'session-1', toolCallId: 'tool-range-1' }
  )

  assert.equal(result.ok, true)
  if (result.ok) {
    assert.equal(result.value.type, 'set_range')
    assert.equal(result.value.changedCells, 4)
    assert.deepEqual(result.value.preview, [{ cell: 'A1', before: 'old', after: 'A' }])
  }
})
