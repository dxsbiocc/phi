import assert from 'node:assert/strict'
import test from 'node:test'

import type { OfficeCliRunResult } from '../src/main/agent/office/office-driver'
import {
  formatOfficeApplyApprovalSummary,
  officeApplyApprovalDigest
} from '../src/main/agent/office/office-approval'
import {
  OFFICE_NUMBER_FORMATS,
  OfficeBatchWriter,
  OfficeWriteError,
  formatRangeWriteRequest,
  officeWriteStrategy,
  validateOfficeWriteRequest
} from '../src/main/agent/office/office-write'
import type { OfficeWriteSnapshot } from '../src/main/agent/office/office-write'

function request(
  format: Record<string, unknown> = { bold: true }
): ReturnType<typeof formatRangeWriteRequest> {
  return formatRangeWriteRequest({
    sheet: 'Sheet1',
    range: 'a1:b2',
    format,
    baseRevision: 3
  })
}

test('format_range strictly normalizes only verified properties', () => {
  assert.deepEqual(request({ bold: true, fill: '#ffeeaa', horizontalAlign: 'center' }), {
    operation: {
      type: 'format_range',
      sheet: 'Sheet1',
      range: 'A1:B2',
      format: { bold: true, fill: '#FFEEAA', horizontalAlign: 'center' },
      rowCount: 2,
      columnCount: 2,
      cellCount: 4
    },
    baseRevision: 3
  })

  const invalid = [
    {},
    { italic: true },
    { bold: 'true' },
    { fill: 'ffeeaa' },
    { fill: '#GGEEAA' },
    { horizontalAlign: 'justify' },
    { numberFormat: '0.000' },
    { numberFormat: '0%' },
    { numberFormat: 'yyyy-mm-dd' },
    { numberFormat: '@' }
  ]
  for (const format of invalid) {
    assert.throws(
      () => request(format),
      (error) => error instanceof OfficeWriteError && error.code === 'invalid_value'
    )
  }
  assert.deepEqual(OFFICE_NUMBER_FORMATS, ['General', '0', '0.00', '#,##0', '#,##0.00'])
})

test('format_range rejects extra fields, unsafe targets, and oversized ranges', () => {
  const invalid = [
    {
      operation: { type: 'format_range', sheet: '../x', range: 'A1:B2', format: { bold: true } },
      baseRevision: 0
    },
    {
      operation: { type: 'format_range', sheet: 'Sheet1', range: 'K1:K2', format: { bold: true } },
      baseRevision: 0
    },
    {
      operation: {
        type: 'format_range',
        sheet: 'Sheet1',
        range: 'A1:C667',
        format: { bold: true }
      },
      baseRevision: 0
    },
    {
      operation: {
        type: 'format_range',
        sheet: 'Sheet1',
        range: 'A1:B2',
        format: { bold: true },
        extra: true
      },
      baseRevision: 0
    },
    {
      operation: { type: 'format_range', sheet: 'Sheet1', range: 'A1:B2', format: { bold: true } },
      baseRevision: 0,
      extra: true
    }
  ]
  for (const input of invalid) {
    assert.throws(() => validateOfficeWriteRequest(input), OfficeWriteError)
  }
})

test('format_range uses one atomic range command with verified CLI property names', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = []
  const result: OfficeCliRunResult = {
    exitCode: 0,
    stdout: JSON.stringify({
      success: true,
      data: {
        results: [{ index: 0, success: true }],
        summary: { total: 1, executed: 1, succeeded: 1, failed: 0, skipped: 0 }
      }
    }),
    stderr: '',
    timedOut: false,
    truncated: false
  }
  const writer = new OfficeBatchWriter({
    run: async (_binaryPath, args, options) => {
      calls.push({ args, stdin: options?.stdin })
      return result
    }
  })
  const operation = request({
    bold: false,
    fill: '#abcdef',
    horizontalAlign: 'right',
    numberFormat: '#,##0.00'
  }).operation

  await writer.apply({ binaryPath: '/officecli', draftPath: '/draft.xlsx' }, operation)

  assert.deepEqual(JSON.parse(calls[0]!.stdin!), [
    {
      command: 'set',
      path: '/Sheet1/A1:B2',
      props: {
        bold: 'false',
        fill: '#ABCDEF',
        'alignment.horizontal': 'right',
        numfmt: '#,##0.00'
      }
    }
  ])
})

test('format_range fails closed on unsupported, warning, count, and partial receipts', async () => {
  const cases: Array<{ name: string; receipt: unknown; code: string }> = [
    {
      name: 'unsupported output',
      receipt: {
        success: true,
        data: {
          results: [
            { index: 0, success: true, output: 'Updated /Sheet1/A1:B2\nUNSUPPORTED props: color' }
          ],
          summary: { total: 1, executed: 1, succeeded: 1, failed: 0, skipped: 0 }
        }
      },
      code: 'write_unknown'
    },
    {
      name: 'unexpected warning',
      receipt: {
        success: true,
        warnings: [{ code: 'warning', message: 'unexpected' }],
        data: {
          results: [{ index: 0, success: true }],
          summary: { total: 1, executed: 1, succeeded: 1, failed: 0, skipped: 0 }
        }
      },
      code: 'write_unknown'
    },
    {
      name: 'item count mismatch',
      receipt: {
        success: true,
        data: {
          results: [],
          summary: { total: 0, executed: 0, succeeded: 0, failed: 0, skipped: 0 }
        }
      },
      code: 'write_unknown'
    },
    {
      name: 'partial success without rollback proof',
      receipt: {
        success: false,
        data: {
          results: [{ index: 0, success: true }],
          summary: { total: 2, executed: 2, succeeded: 1, failed: 1, skipped: 0 }
        }
      },
      code: 'write_unknown'
    },
    {
      name: 'proven atomic rollback',
      receipt: {
        success: false,
        data: {
          results: [{ index: 0, success: false }],
          summary: {
            total: 1,
            executed: 1,
            succeeded: 0,
            failed: 1,
            skipped: 0,
            atomicRolledBack: true
          }
        }
      },
      code: 'write_failed'
    }
  ]
  for (const item of cases) {
    const writer = new OfficeBatchWriter({
      run: async () => ({
        exitCode: item.code === 'write_failed' ? 1 : 0,
        stdout: JSON.stringify(item.receipt),
        stderr: '',
        timedOut: false,
        truncated: false
      })
    })
    await assert.rejects(
      writer.apply(
        { binaryPath: '/officecli', draftPath: '/draft.xlsx' },
        request({ bold: true }).operation
      ),
      (error) => error instanceof OfficeWriteError && error.code === item.code,
      item.name
    )
  }
})

test('format_range classification requires unchanged data and uniform requested formatting', () => {
  const write = request({ bold: true, numberFormat: '0.00' })
  const strategy = officeWriteStrategy(write.operation)
  const cells = (bold: boolean, numberFormat: string, value = 12.345): OfficeWriteSnapshot =>
    strategy.snapshot(write.operation, [
      { ref: 'A1', value: 'Title', valueType: 'string', format: { bold, numberFormat } },
      { ref: 'B1', value, valueType: 'number', format: { bold, numberFormat } },
      {
        ref: 'A2',
        value: 13.345,
        valueType: 'number',
        formula: '=SUM(B1,1)',
        evaluated: true,
        format: { bold, numberFormat }
      },
      { ref: 'B2', value: null, valueType: 'empty', format: { bold, numberFormat } }
    ])
  const before = cells(false, 'General')
  const expected = cells(true, '0.00')

  assert.equal(strategy.classify(write.operation, before, expected), 'applied')
  assert.equal(strategy.classify(write.operation, before, before), 'not_applied')
  assert.equal(strategy.classify(write.operation, expected, expected), 'applied_no_change')
  assert.equal(strategy.classify(write.operation, before, cells(true, 'General')), 'indeterminate')
  assert.equal(strategy.classify(write.operation, before, cells(true, '0.00', 99)), 'indeterminate')
})

test('format_range approval summary and digest bind the complete normalized format', () => {
  const write = request({
    bold: true,
    fill: '#ffeeaa',
    horizontalAlign: 'center',
    numberFormat: '0.00'
  })
  const strategy = officeWriteStrategy(write.operation)
  const before = strategy.snapshot(
    write.operation,
    ['A1', 'B1', 'A2', 'B2'].map((ref) => ({
      ref,
      value: 'x',
      valueType: 'string' as const,
      format: { bold: false, numberFormat: 'General' }
    }))
  )
  const description = strategy.describe(write, before, 'experiment.xlsx', 3)

  assert.equal(
    formatOfficeApplyApprovalSummary(description),
    '将 Sheet1!A1:B2（2 行 × 2 列，共 4 格）设置格式：加粗、背景色 #FFEEAA、居中、数字格式 0.00；其中 4 格当前格式将改变'
  )
  const digest = officeApplyApprovalDigest({
    operation: {
      type: 'format_range',
      sheet: 'Sheet1',
      range: 'A1:B2',
      format: write.operation.type === 'format_range' ? write.operation.format : {}
    },
    baseRevision: 3
  })
  assert.notEqual(
    digest,
    officeApplyApprovalDigest({
      operation: {
        type: 'format_range',
        sheet: 'Sheet1',
        range: 'A1:B2',
        format: { bold: false, fill: '#FFEEAA', horizontalAlign: 'center', numberFormat: '0.00' }
      },
      baseRevision: 3
    })
  )
})
