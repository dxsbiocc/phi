import assert from 'node:assert/strict'
import test from 'node:test'

import { buildOfficeApplyTool } from '../src/main/agent/office/office-apply-tool'

test('office_apply forwards set_range and returns a compact receipt without the values matrix', async () => {
  const calls: unknown[] = []
  const tool = buildOfficeApplyTool(async (_method, params) => {
    calls.push(params)
    return {
      ok: true,
      value: {
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
  const params = {
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
  }

  const result = await tool.execute('range-tool-1', params as never, undefined, {} as never)

  assert.deepEqual(calls, [params])
  const payload = JSON.parse((result.content[0] as { text: string }).text)
  assert.equal(payload.range, 'A1:B2')
  assert.equal(payload.changedCells, 4)
  assert.equal(Object.hasOwn(payload, 'values'), false)
  assert.deepEqual(payload.preview, [{ cell: 'A1', before: 'old', after: 'A' }])
})
