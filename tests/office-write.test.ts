import assert from 'node:assert/strict'
import { test } from 'node:test'

import type { OfficeCliRunResult } from '../src/main/agent/office/office-driver'
import {
  OfficeCellWriter,
  OfficeWriteError,
  validateCellEditParams
} from '../src/main/agent/office/office-write'

function cliJson(value: unknown, exitCode = 0): OfficeCliRunResult {
  return {
    exitCode,
    stdout: JSON.stringify(value),
    stderr: '',
    timedOut: false,
    truncated: false
  }
}

test('cell writer uses one atomic batch command with an explicit string type', async () => {
  const calls: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = []
  const writer = new OfficeCellWriter({
    run: async (_binaryPath, args, options) => {
      calls.push({ args, env: options?.env })
      return cliJson({
        success: true,
        data: {
          results: [{ index: 0, success: true, output: 'Updated /Sheet1/A1: value=123' }],
          summary: { total: 1, executed: 1, succeeded: 1, failed: 0, skipped: 0 }
        }
      })
    }
  })

  await writer.apply(
    { binaryPath: '/officecli', draftPath: '/private/draft.xlsx' },
    { sheet: 'Sheet1', cell: 'A1', value: '123', baseRevision: 0 }
  )

  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.args.slice(0, 2), ['batch', '/private/draft.xlsx'])
  assert.equal(calls[0]?.args.includes('--force'), false)
  assert.equal(calls[0]?.args.includes('--best-effort'), false)
  const commandsAt = calls[0]?.args.indexOf('--commands') ?? -1
  assert.ok(commandsAt > 0)
  assert.deepEqual(JSON.parse(calls[0]!.args[commandsAt + 1]), [
    {
      command: 'set',
      path: '/Sheet1/A1',
      props: { value: '123', type: 'string' }
    }
  ])
  assert.equal(calls[0]?.args.at(-1), '--json')
  assert.equal(calls[0]?.env?.OFFICECLI_SKIP_UPDATE, '1')
  assert.equal(calls[0]?.env?.OFFICECLI_RESIDENT_FLUSH, 'each')
})

test('cell edit validation rejects malicious addresses and unsafe values', () => {
  const invalid: Array<{ params: unknown; code: string }> = [
    {
      params: { sheet: '../Sheet1', cell: 'A1', value: 'x', baseRevision: 0 },
      code: 'invalid_sheet'
    },
    {
      params: { sheet: 'Sheet1/Other', cell: 'A1', value: 'x', baseRevision: 0 },
      code: 'invalid_sheet'
    },
    {
      params: { sheet: 'Sheet\u0085One', cell: 'A1', value: 'x', baseRevision: 0 },
      code: 'invalid_sheet'
    },
    {
      params: { sheet: 'Sheet1', cell: 'A1:B2', value: 'x', baseRevision: 0 },
      code: 'invalid_cell'
    },
    {
      params: { sheet: 'Sheet1', cell: 'XFE1', value: 'x', baseRevision: 0 },
      code: 'invalid_cell'
    },
    {
      params: { sheet: 'Sheet1', cell: 'A1048577', value: 'x', baseRevision: 0 },
      code: 'invalid_cell'
    },
    {
      params: { sheet: 'Sheet1', cell: 'A1', value: 'x\u0000y', baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      params: { sheet: 'Sheet1', cell: 'A1', value: 'x\u0085y', baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      params: { sheet: 'Sheet1', cell: 'A1', value: 'x'.repeat(32_768), baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      params: { sheet: 'Sheet1', cell: 'A1', value: Number.POSITIVE_INFINITY, baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      params: { sheet: 'Sheet1', cell: 'A1', value: null, baseRevision: 0 },
      code: 'invalid_value'
    },
    {
      params: { sheet: 'Sheet1', cell: 'A1', value: 'x', baseRevision: -1 },
      code: 'revision_conflict'
    }
  ]
  for (const item of invalid) {
    assert.throws(
      () => validateCellEditParams(item.params),
      (error) => error instanceof OfficeWriteError && error.code === item.code
    )
  }
  assert.deepEqual(
    validateCellEditParams({
      sheet: '资料 2026',
      cell: 'b2',
      value: '第一行\n第二行\t末尾',
      baseRevision: 7
    }),
    { sheet: '资料 2026', cell: 'B2', value: '第一行\n第二行\t末尾', baseRevision: 7 }
  )
})

test('cell writer preserves number and boolean types in batch props', async () => {
  const commands: unknown[] = []
  const writer = new OfficeCellWriter({
    run: async (_binaryPath, args) => {
      commands.push(JSON.parse(args[args.indexOf('--commands') + 1]))
      return cliJson({
        success: true,
        data: {
          results: [{ index: 0, success: true, output: 'Updated' }],
          summary: { total: 1, executed: 1, succeeded: 1, failed: 0, skipped: 0 }
        }
      })
    }
  })
  const context = { binaryPath: '/officecli', draftPath: '/private/draft.xlsx' }

  await writer.apply(context, { sheet: 'Sheet1', cell: 'A1', value: 123, baseRevision: 0 })
  await writer.apply(context, { sheet: 'Sheet1', cell: 'A2', value: true, baseRevision: 0 })

  assert.deepEqual(commands, [
    [{ command: 'set', path: '/Sheet1/A1', props: { value: 123, type: 'number' } }],
    [{ command: 'set', path: '/Sheet1/A2', props: { value: true, type: 'boolean' } }]
  ])
})

test('cell writer rejects every known non-success batch receipt without retrying', async () => {
  const failures: Array<{ result: OfficeCliRunResult; code: string }> = [
    {
      result: cliJson(
        {
          success: false,
          data: {
            results: [{ index: 0, success: false, code: 'not_found' }],
            summary: { atomicRolledBack: true }
          }
        },
        1
      ),
      code: 'write_failed'
    },
    {
      result: cliJson(
        {
          success: true,
          warnings: [{ code: 'unsupported_property' }],
          data: { results: [{ index: 0, success: true, output: 'Updated' }] }
        },
        2
      ),
      code: 'write_failed'
    },
    {
      result: cliJson({
        success: true,
        data: {
          results: [{ index: 0, success: true, output: 'Updated\nUNSUPPORTED props: color' }],
          summary: { failed: 0 }
        }
      }),
      code: 'write_failed'
    },
    {
      result: { ...cliJson({ success: true }), stdout: '{not-json' },
      code: 'write_unknown'
    },
    {
      result: { ...cliJson({ success: true }), timedOut: true },
      code: 'write_unknown'
    }
  ]
  for (const failure of failures) {
    let calls = 0
    const writer = new OfficeCellWriter({
      run: async () => {
        calls += 1
        return failure.result
      }
    })
    await assert.rejects(
      writer.apply(
        { binaryPath: '/officecli', draftPath: '/private/draft.xlsx' },
        { sheet: 'Sheet1', cell: 'A1', value: 'x', baseRevision: 0 }
      ),
      (error) => error instanceof OfficeWriteError && error.code === failure.code
    )
    assert.equal(calls, 1)
  }
})

test('save requires a successful JSON receipt and a healthy draft file', async () => {
  const calls: readonly string[][] = []
  const writer = new OfficeCellWriter({
    run: async (_binaryPath, args) => {
      ;(calls as string[][]).push([...args])
      return cliJson({ success: true, data: 'No pending changes for draft.xlsx' })
    },
    inspectDraft: async () => true
  })
  await writer.save({ binaryPath: '/officecli', draftPath: '/private/draft.xlsx' })
  assert.deepEqual(calls, [['save', '/private/draft.xlsx', '--json']])

  for (const result of [
    cliJson({ success: false }, 1),
    { ...cliJson({ success: true }), stdout: 'not-json' },
    cliJson({ success: true, data: { warnings: [{ code: 'save_warning' }] } })
  ]) {
    const failing = new OfficeCellWriter({
      run: async () => result,
      inspectDraft: async () => true
    })
    await assert.rejects(
      failing.save({ binaryPath: '/officecli', draftPath: '/private/draft.xlsx' }),
      { code: 'save_failed' }
    )
  }
  const missing = new OfficeCellWriter({
    run: async () => cliJson({ success: true }),
    inspectDraft: async () => false
  })
  await assert.rejects(
    missing.save({ binaryPath: '/officecli', draftPath: '/private/draft.xlsx' }),
    { code: 'save_failed' }
  )
})
