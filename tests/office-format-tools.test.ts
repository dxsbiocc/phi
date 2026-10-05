import assert from 'node:assert/strict'
import test from 'node:test'
import AjvModule from 'ajv'

import { buildOfficeApplyTool } from '../src/main/agent/office/office-apply-tool'

const Ajv = AjvModule.default ?? AjvModule

test('office_apply exposes a strict verified format_range schema', () => {
  const tool = buildOfficeApplyTool(async () => ({ ok: true, value: {} }))
  const validate = new Ajv({ strict: false }).compile(tool.parameters)
  const valid = {
    operation: {
      type: 'format_range',
      sheet: 'Sheet1',
      range: 'A1:D1',
      format: { bold: true, fill: '#ffeeaa', horizontalAlign: 'center', numberFormat: '0.00' }
    },
    baseRevision: 0
  }
  assert.equal(validate(valid), true)
  for (const invalid of [
    { ...valid, operation: { ...valid.operation, format: {} } },
    { ...valid, operation: { ...valid.operation, format: { italic: true } } },
    { ...valid, operation: { ...valid.operation, format: { fill: 'ffeeaa' } } },
    { ...valid, operation: { ...valid.operation, format: { horizontalAlign: 'justify' } } },
    { ...valid, operation: { ...valid.operation, format: { numberFormat: '0.000' } } },
    { ...valid, operation: { ...valid.operation, extra: true } }
  ]) {
    assert.equal(validate(invalid), false)
  }
  assert.match(tool.description, /format_range/u)
  assert.match(tool.description, /不改变数据/u)
})

test('office_apply forwards format_range and returns only its compact safe receipt', async () => {
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
        range: 'A1:D1',
        rowCount: 1,
        columnCount: 4,
        changedCells: 3,
        appliedFormat: { bold: true, fill: '#FFEEAA' },
        previewConfirmed: true
      }
    }
  })
  const params = {
    operation: {
      type: 'format_range',
      sheet: 'Sheet1',
      range: 'A1:D1',
      format: { bold: true, fill: '#FFEEAA' }
    },
    baseRevision: 0
  }

  const result = await tool.execute('format-tool-1', params as never, undefined, {} as never)

  assert.deepEqual(calls, [params])
  const payload = JSON.parse((result.content[0] as { text: string }).text)
  assert.deepEqual(payload.appliedFormat, { bold: true, fill: '#FFEEAA' })
  assert.equal(payload.changedCells, 3)
  assert.equal(Object.hasOwn(payload, 'beforeHash'), false)
})
