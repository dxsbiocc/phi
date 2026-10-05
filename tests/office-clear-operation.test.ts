import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clearCellWriteRequest,
  officeWriteStrategy,
  validateOfficeWriteRequest
} from '../src/main/agent/office/office-write-operation'

test('clear_cell is internal-only and emits one atomic clear command with empty readback', () => {
  const request = clearCellWriteRequest({ sheet: 'Sheet1', cell: 'A1', baseRevision: 4 })
  const strategy = officeWriteStrategy(request.operation)

  assert.throws(
    () =>
      validateOfficeWriteRequest({
        operation: { type: 'clear_cell', sheet: 'Sheet1', cell: 'A1' },
        baseRevision: 4
      }),
    { code: 'invalid_value' }
  )
  assert.deepEqual(strategy.commands(request.operation), [
    { command: 'set', path: '/Sheet1/A1', props: { clear: true } }
  ])
  const before = strategy.snapshot(request.operation, [
    {
      ref: 'A1',
      value: 3,
      valueType: 'number',
      formula: '=1+2',
      evaluated: true,
      format: { bold: true, fill: '#FF0000' }
    }
  ])
  assert.deepEqual(strategy.before(request.operation, before), {
    value: 3,
    valueType: 'number',
    formula: '=1+2',
    evaluated: true,
    format: { bold: true, fill: '#FF0000' }
  })
  const after = strategy.snapshot(request.operation, [
    { ref: 'A1', value: null, valueType: 'empty', format: { bold: true, fill: '#FF0000' } }
  ])
  assert.deepEqual(strategy.expected(request.operation, before), after)
  assert.equal(strategy.classify(request.operation, before, after), 'applied')
})
