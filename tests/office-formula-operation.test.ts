import assert from 'node:assert/strict'
import test from 'node:test'

import { validateFormulaEditParams } from '../src/main/agent/office/office-formula-parser'
import { officeApplyApprovalDigest } from '../src/main/agent/office/office-approval'
import {
  OfficeBatchWriter,
  formulaWriteRequest,
  OfficeWriteError,
  officeWriteStrategy,
  serializeOfficeWriteRequest,
  validateCellEditParams,
  validateOfficeWriteRequest
} from '../src/main/agent/office/office-write'
import { validateRangeEditParams } from '../src/main/agent/office/office-write-contract'

test('set_formula normalizes a valid single-cell formula request', () => {
  assert.deepEqual(
    validateFormulaEditParams({
      sheet: 'Sheet1',
      cell: 'e1',
      formula: '=SUM(A1:A3)',
      baseRevision: 7
    }),
    {
      sheet: 'Sheet1',
      cell: 'E1',
      formula: '=SUM(A1:A3)',
      baseRevision: 7
    }
  )
})

test('set_formula public request validation is strict and serializes the complete formula', () => {
  const request = validateOfficeWriteRequest({
    operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'e1', formula: '=SUM(A1:A3)' },
    baseRevision: 7
  })
  assert.deepEqual(request, {
    operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E1', formula: '=SUM(A1:A3)' },
    baseRevision: 7
  })
  assert.equal(
    serializeOfficeWriteRequest(request),
    JSON.stringify({
      operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E1', formula: '=SUM(A1:A3)' },
      baseRevision: 7
    })
  )

  const invalid = [
    { operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'A1', formula: 'SUM(A1:A3)' } },
    { operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'A1', formula: '=' } },
    {
      operation: {
        type: 'set_formula',
        sheet: 'Sheet1',
        cell: 'A1',
        formula: `=${'x'.repeat(8_192)}`
      }
    },
    { operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'A1', formula: '=A1\n+A2' } },
    { operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'A1', formula: '=A1\t+A2' } },
    { operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'A1', formula: '=A1\u007f' } },
    { operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'A1', formula: '=A1\u0085' } },
    { operation: { type: 'set_formula', sheet: '../Sheet1', cell: 'A1', formula: '=1+1' } },
    { operation: { type: 'set_formula', sheet: 'Sheet1', cell: '../A1', formula: '=1+1' } },
    {
      operation: {
        type: 'set_formula',
        sheet: 'Sheet1',
        cell: 'A1',
        formula: '=1+1',
        unexpected: true
      }
    }
  ]
  for (const input of invalid) {
    assert.throws(
      () => validateOfficeWriteRequest({ ...input, baseRevision: 0 }),
      (error) => error instanceof OfficeWriteError
    )
  }

  assert.equal(
    validateOfficeWriteRequest({
      operation: {
        type: 'set_formula',
        sheet: 'Sheet1',
        cell: 'A1',
        formula: `=${'x'.repeat(8_191)}`
      },
      baseRevision: 0
    }).operation.type,
    'set_formula'
  )
})

test('set_formula strategy preserves formula-aware state and classifies only evaluated values', () => {
  const request = formulaWriteRequest({
    sheet: 'Sheet1',
    cell: 'e1',
    formula: '=SUM(A1:A3)',
    baseRevision: 7
  })
  const strategy = officeWriteStrategy(request.operation)
  assert.deepEqual(strategy.affectedCells(request.operation), ['E1'])
  assert.equal(strategy.readRange(request.operation), 'E1')
  assert.deepEqual(strategy.expected(request.operation), {
    cells: [
      {
        ref: 'E1',
        value: null,
        valueType: 'unknown',
        formula: '=SUM(A1:A3)',
        evaluated: true
      }
    ],
    rowCount: 1,
    columnCount: 1
  })
  assert.deepEqual(strategy.commands(request.operation), [
    { command: 'set', path: '/Sheet1/E1', props: { formula: 'SUM(A1:A3)' } }
  ])

  const before = strategy.snapshot(request.operation, [
    {
      ref: 'E1',
      value: 3,
      valueType: 'number',
      formula: '=A1+A2',
      evaluated: true
    }
  ])
  const evidence = strategy.before(request.operation, before)
  assert.deepEqual(evidence, {
    value: 3,
    valueType: 'number',
    formula: '=A1+A2',
    evaluated: true
  })
  assert.deepEqual(strategy.restoreBefore(request.operation, evidence), before)

  const applied = strategy.snapshot(request.operation, [
    {
      ref: 'E1',
      value: 6,
      valueType: 'number',
      formula: '=SUM(A1:A3)',
      evaluated: true
    }
  ])
  const notEvaluated = strategy.snapshot(request.operation, [
    {
      ref: 'E1',
      value: null,
      valueType: 'error',
      formula: '=SUM(A1:A3)',
      evaluated: false
    }
  ])
  const errorValue = strategy.snapshot(request.operation, [
    {
      ref: 'E1',
      value: '#DIV/0!',
      valueType: 'error',
      formula: '=SUM(A1:A3)',
      evaluated: true
    }
  ])
  assert.equal(strategy.classify(request.operation, before, applied), 'applied')
  assert.equal(strategy.classify(request.operation, before, before), 'not_applied')
  assert.equal(strategy.classify(request.operation, before, notEvaluated), 'indeterminate')
  assert.equal(strategy.classify(request.operation, before, errorValue), 'indeterminate')
})

test('set_formula approval shows the exact visible formula and digest binds every character', () => {
  const request = formulaWriteRequest({
    sheet: 'Sheet1',
    cell: 'E1',
    formula: '=SUM(A1:A3)',
    baseRevision: 7
  })
  const strategy = officeWriteStrategy(request.operation)
  const before = strategy.snapshot(request.operation, [
    { ref: 'E1', value: '旧值', valueType: 'string' }
  ])
  const description = strategy.describe(request, before, 'Book.xlsx', 7)
  assert.deepEqual(description, {
    type: 'set_formula',
    documentName: 'Book.xlsx',
    sheet: 'Sheet1',
    cell: 'E1',
    formula: '=SUM(A1:A3)',
    before: { value: '旧值', valueType: 'string' },
    revision: 7
  })
  assert.equal(
    strategy.approvalSummary(description),
    '将 Sheet1!E1 写入公式 `=SUM(A1:A3)`（当前内容：「旧值」）'
  )

  const oldFormula = strategy.snapshot(request.operation, [
    {
      ref: 'E1',
      value: 2,
      valueType: 'number',
      formula: '=1+1',
      evaluated: true
    }
  ])
  assert.equal(
    strategy.approvalSummary(strategy.describe(request, oldFormula, 'Book.xlsx', 7)),
    '将 Sheet1!E1 写入公式 `=SUM(A1:A3)`（当前内容：公式 `=1+1`）'
  )

  const approved = officeApplyApprovalDigest(request)
  assert.notEqual(
    approved,
    officeApplyApprovalDigest({
      ...request,
      operation: { ...request.operation, formula: '=SUM(A1:A4)' }
    })
  )

  const unsafeRequest = formulaWriteRequest({
    sheet: 'Sheet1',
    cell: 'E1',
    formula: `="<script>\`"&"${'x'.repeat(120)}"`,
    baseRevision: 7
  })
  const unsafeSummary = officeWriteStrategy(unsafeRequest.operation).approvalSummary(
    officeWriteStrategy(unsafeRequest.operation).describe(unsafeRequest, before, 'Book.xlsx', 7)
  )
  assert.doesNotMatch(unsafeSummary, /[<>]/u)
  assert.equal((unsafeSummary.match(/`/gu) ?? []).length, 2)
  assert.match(unsafeSummary, /…（已截断）/u)
})

test('set_formula result returns the actual verified computed value', () => {
  const request = formulaWriteRequest({
    sheet: 'Sheet1',
    cell: 'E1',
    formula: '=SUM(A1:A3)',
    baseRevision: 7
  })
  const strategy = officeWriteStrategy(request.operation)
  const before = strategy.snapshot(request.operation, [
    { ref: 'E1', value: '旧值', valueType: 'string' }
  ])
  const verified = strategy.snapshot(request.operation, [
    {
      ref: 'E1',
      value: 6,
      valueType: 'number',
      formula: '=SUM(A1:A3)',
      evaluated: true
    }
  ])

  assert.deepEqual(strategy.result(request, before, 8, true, false, verified), {
    applied: true,
    saved: true,
    revision: 8,
    sheet: 'Sheet1',
    cell: 'E1',
    formula: '=SUM(A1:A3)',
    computedValue: 6,
    valueType: 'number',
    previewConfirmed: false,
    warnings: ['preview_not_confirmed']
  })
})

test('plain value operations reject leading equals with set_formula guidance', () => {
  for (const write of [
    () =>
      validateCellEditParams({
        sheet: 'Sheet1',
        cell: 'A1',
        value: '=SUM(A1:A3)',
        baseRevision: 0
      }),
    () =>
      validateRangeEditParams({
        sheet: 'Sheet1',
        range: 'A1:B1',
        values: [['=SUM(A1:A3)', 'x']],
        baseRevision: 0
      })
  ]) {
    assert.throws(
      write,
      (error) =>
        error instanceof OfficeWriteError &&
        error.code === 'formula_not_supported' &&
        /set_formula/u.test(error.message)
    )
  }
})

test('set_formula rollback commands restore an old formula, value, or true empty cell', () => {
  const request = formulaWriteRequest({
    sheet: 'Sheet1',
    cell: 'E1',
    formula: '=1/0',
    baseRevision: 0
  })
  const strategy = officeWriteStrategy(request.operation)
  assert.ok(strategy.restoreCommands)
  assert.deepEqual(
    strategy.restoreCommands(request.operation, {
      value: 3,
      valueType: 'number',
      formula: '=A1+A2',
      evaluated: true
    }),
    [{ command: 'set', path: '/Sheet1/E1', props: { formula: 'A1+A2' } }]
  )
  assert.deepEqual(
    strategy.restoreCommands(request.operation, { value: '旧值', valueType: 'string' }),
    [{ command: 'set', path: '/Sheet1/E1', props: { value: '旧值', type: 'string' } }]
  )
  assert.deepEqual(
    strategy.restoreCommands(request.operation, { value: null, valueType: 'empty' }),
    [{ command: 'set', path: '/Sheet1/E1', props: { clear: true } }]
  )
})

test('formula rollback accepts only the expected formula-replacement warning', async () => {
  const request = formulaWriteRequest({
    sheet: 'Sheet1',
    cell: 'E1',
    formula: '=1/0',
    baseRevision: 0
  })
  const writer = new OfficeBatchWriter({
    run: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        success: true,
        data: { results: [{ index: 0, success: true, output: 'Updated /Sheet1/E1' }] },
        warnings: [
          {
            code: 'warning',
            message:
              'Warning: Cell E1 has formula "=1/0"; replacing with literal value. Use --prop formula=… to update the formula instead.'
          }
        ]
      }),
      stderr: '',
      timedOut: false,
      truncated: false
    })
  })

  await writer.restore({ binaryPath: '/officecli', draftPath: '/draft.xlsx' }, request.operation, {
    value: 'before',
    valueType: 'string'
  })
})

test('formula rollback rejects any unrelated batch warning', async () => {
  const request = formulaWriteRequest({
    sheet: 'Sheet1',
    cell: 'E1',
    formula: '=1/0',
    baseRevision: 0
  })
  const writer = new OfficeBatchWriter({
    run: async () => ({
      exitCode: 0,
      stdout: JSON.stringify({
        success: true,
        data: { results: [{ index: 0, success: true, output: 'Updated' }] },
        warnings: [{ code: 'other', message: 'unexpected warning' }]
      }),
      stderr: '',
      timedOut: false,
      truncated: false
    })
  })

  await assert.rejects(
    writer.restore({ binaryPath: '/officecli', draftPath: '/draft.xlsx' }, request.operation, {
      value: 'before',
      valueType: 'string'
    }),
    { code: 'write_unknown' }
  )
})
