import assert from 'node:assert/strict'
import test from 'node:test'

import type { OfficeCliRunResult } from '../src/main/agent/office/office-driver'
import {
  OfficeBatchWriter,
  OfficeWriteError,
  officeWriteStrategy,
  rangeWriteRequest,
  validateRangeEditParams
} from '../src/main/agent/office/office-write'

test('set_range normalizes a matching row-major matrix', () => {
  assert.deepEqual(
    validateRangeEditParams({
      sheet: 'Sheet1',
      range: 'a1:b2',
      values: [
        ['A', 2],
        [true, 'D']
      ],
      baseRevision: 7
    }),
    {
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [
        ['A', 2],
        [true, 'D']
      ],
      rowCount: 2,
      columnCount: 2,
      cellCount: 4,
      baseRevision: 7
    }
  )
})

test('set_range rejects shape, workbook, count, and value limit violations', () => {
  const invalid: Array<{ input: unknown; code: string }> = [
    {
      input: { sheet: 'Sheet1', range: 'A1:B2', values: [['A', 'B']], baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      input: { sheet: 'Sheet1', range: 'A1:B2', values: [['A'], ['B']], baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      input: { sheet: '../Sheet1', range: 'A1:B1', values: [['a', 'b']], baseRevision: 0 },
      code: 'invalid_sheet'
    },
    {
      input: { sheet: 'Sheet1', range: 'K1:K1', values: [['x']], baseRevision: 0 },
      code: 'range_out_of_bounds'
    },
    {
      input: { sheet: 'Sheet1', range: 'A1001:A1001', values: [['x']], baseRevision: 0 },
      code: 'range_out_of_bounds'
    },
    {
      input: {
        sheet: 'Sheet1',
        range: 'A1:C667',
        values: Array.from({ length: 667 }, () => ['a', 'b', 'c']),
        baseRevision: 0
      },
      code: 'range_too_large'
    },
    {
      input: { sheet: 'Sheet1', range: 'A1:A1', values: [['']], baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      input: {
        sheet: 'Sheet1',
        range: 'A1:B1',
        values: [['=SUM(A1:A2)', 'x']],
        baseRevision: 0
      },
      code: 'formula_not_supported'
    },
    {
      input: { sheet: 'Sheet1', range: 'A1:A1', values: [[null]], baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      input: { sheet: 'Sheet1', range: '$A$1:$B$1', values: [['a', 'b']], baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      input: { sheet: 'Sheet1', range: 'A1:B1', values: [['x\u0000y', 'b']], baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      input: {
        sheet: 'Sheet1',
        range: 'A1:B1',
        values: [['x'.repeat(32_768), 'b']],
        baseRevision: 0
      },
      code: 'invalid_value'
    },
    {
      input: { sheet: 'Sheet1', range: 'A1:B1', values: [[Number.NaN, 'b']], baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      input: { sheet: 'Sheet1', range: 'B2:A1', values: [['x']], baseRevision: 0 },
      code: 'invalid_value'
    }
  ]
  for (const { input, code } of invalid) {
    assert.throws(
      () => validateRangeEditParams(input),
      (error) => error instanceof OfficeWriteError && error.code === code,
      JSON.stringify(input).slice(0, 160)
    )
  }
  const maximum = validateRangeEditParams({
    sheet: 'Sheet1',
    range: 'A1:B1000',
    values: Array.from({ length: 1_000 }, () => ['a', 'b']),
    baseRevision: 0
  })
  assert.equal(maximum.cellCount, 2_000)
})

test('set_range rejects a serialized command body above 256 KiB before running OfficeCLI', () => {
  assert.throws(
    () =>
      rangeWriteRequest(
        validateRangeEditParams({
          sheet: 'Sheet1',
          range: 'A1:J1',
          values: [Array.from({ length: 10 }, () => '界'.repeat(20_000))],
          baseRevision: 0
        })
      ),
    (error) => error instanceof OfficeWriteError && error.code === 'range_too_large'
  )
})

test('set_range classifies complete expected, before, mixed, and no-change matrices', () => {
  const request = rangeWriteRequest(
    validateRangeEditParams({
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [
        ['A', 2],
        [true, 'D']
      ],
      baseRevision: 0
    })
  )
  const strategy = officeWriteStrategy(request.operation)
  const cells = (
    values: readonly (string | number | boolean)[]
  ): ReturnType<typeof strategy.snapshot> =>
    strategy.snapshot(
      request.operation,
      ['A1', 'B1', 'A2', 'B2'].map((ref, index) => {
        const value = values[index]!
        return {
          ref,
          value,
          valueType:
            typeof value === 'string'
              ? ('string' as const)
              : typeof value === 'number'
                ? ('number' as const)
                : ('boolean' as const)
        }
      })
    )
  const before = cells(['old-a', 1, false, 'old-d'])
  const expected = strategy.expected(request.operation)

  assert.equal(strategy.classify(request.operation, before, expected), 'applied')
  assert.equal(strategy.classify(request.operation, before, before), 'not_applied')
  assert.equal(
    strategy.classify(request.operation, before, cells(['A', 1, true, 'D'])),
    'indeterminate'
  )
  assert.equal(strategy.classify(request.operation, expected, expected), 'applied_no_change')
})

test('set_range receipts truncate preview strings while hashing complete values', () => {
  const request = rangeWriteRequest(
    validateRangeEditParams({
      sheet: 'Sheet1',
      range: 'A1:B1',
      values: [['新'.repeat(1_000), 'same']],
      baseRevision: 0
    })
  )
  const strategy = officeWriteStrategy(request.operation)
  const before = strategy.snapshot(request.operation, [
    { ref: 'A1', value: '旧'.repeat(1_000), valueType: 'string' },
    { ref: 'B1', value: 'same', valueType: 'string' }
  ])
  const result = strategy.result(request, before, 1, true, true)
  assert.equal('preview' in result, true)
  if (!('preview' in result)) throw new Error('missing range preview')
  assert.equal([...String(result.preview[0]?.before)].length, 121)
  assert.equal([...String(result.preview[0]?.after)].length, 121)
  assert.match(result.beforeHash, /^[a-f0-9]{64}$/u)
  assert.match(result.afterHash, /^[a-f0-9]{64}$/u)
})

test('set_range sends one atomic row-major batch without exposing values in argv', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = []
  const result: OfficeCliRunResult = {
    exitCode: 0,
    stdout: JSON.stringify({
      success: true,
      data: {
        results: Array.from({ length: 4 }, (_, index) => ({ index, success: true })),
        summary: { total: 4, executed: 4, succeeded: 4, failed: 0, skipped: 0 }
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
  const request = rangeWriteRequest(
    validateRangeEditParams({
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [
        ['secret', 2],
        [true, 'D']
      ],
      baseRevision: 0
    })
  )

  await writer.apply(
    { binaryPath: '/officecli', draftPath: '/private/draft.xlsx' },
    request.operation
  )

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.args, ['batch', '/private/draft.xlsx', '--json'])
  assert.equal(calls[0]?.args.join(' ').includes('secret'), false)
  assert.deepEqual(JSON.parse(calls[0]!.stdin!), [
    { command: 'set', path: '/Sheet1/A1', props: { value: 'secret', type: 'string' } },
    { command: 'set', path: '/Sheet1/B1', props: { value: 2, type: 'number' } },
    { command: 'set', path: '/Sheet1/A2', props: { value: true, type: 'boolean' } },
    { command: 'set', path: '/Sheet1/B2', props: { value: 'D', type: 'string' } }
  ])
  assert.equal(calls[0]?.args.includes('--force'), false)
  assert.equal(calls[0]?.args.includes('--best-effort'), false)
})

test('set_range distinguishes proven atomic rollback from ambiguous batch receipts', async () => {
  const request = rangeWriteRequest(
    validateRangeEditParams({
      sheet: 'Sheet1',
      range: 'A1:B1',
      values: [['A', 'B']],
      baseRevision: 0
    })
  )
  const receipts: Array<{ result: OfficeCliRunResult; code: string }> = [
    {
      result: {
        exitCode: 1,
        stdout: JSON.stringify({
          success: false,
          data: {
            results: [
              { index: 0, success: true },
              { index: 1, success: false, code: 'not_found' }
            ],
            summary: { atomicRolledBack: true }
          }
        }),
        stderr: '',
        timedOut: false,
        truncated: false
      },
      code: 'write_failed'
    },
    {
      result: {
        exitCode: 0,
        stdout: JSON.stringify({ success: true, data: { results: [{ success: true }] } }),
        stderr: '',
        timedOut: false,
        truncated: false
      },
      code: 'write_unknown'
    },
    {
      result: {
        exitCode: 1,
        stdout: JSON.stringify({
          success: false,
          data: { results: [{ success: true }, { success: false }] }
        }),
        stderr: '',
        timedOut: false,
        truncated: false
      },
      code: 'write_unknown'
    },
    {
      result: {
        exitCode: 0,
        stdout: JSON.stringify({
          success: true,
          warnings: ['warning'],
          data: { results: [{ success: true }, { success: true }] }
        }),
        stderr: '',
        timedOut: false,
        truncated: false
      },
      code: 'write_unknown'
    },
    {
      result: {
        exitCode: 0,
        stdout: JSON.stringify({
          success: true,
          data: {
            results: [{ success: true }, { success: true, output: 'UNSUPPORTED props: color' }]
          }
        }),
        stderr: '',
        timedOut: false,
        truncated: false
      },
      code: 'write_unknown'
    },
    {
      result: {
        exitCode: 0,
        stdout: '{not-json',
        stderr: '',
        timedOut: false,
        truncated: false
      },
      code: 'write_unknown'
    }
  ]

  for (const { result, code } of receipts) {
    let calls = 0
    const writer = new OfficeBatchWriter({
      run: async () => {
        calls += 1
        return result
      }
    })
    await assert.rejects(
      writer.apply(
        { binaryPath: '/officecli', draftPath: '/private/draft.xlsx' },
        request.operation
      ),
      (error) => error instanceof OfficeWriteError && error.code === code
    )
    assert.equal(calls, 1)
  }
})
