import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OFFICE_MAX_WORKBOOK_SHEETS,
  addSheetSnapshot,
  validateAddSheetParams
} from '../src/main/agent/office/office-sheet-contract'
import { OfficeWriteError } from '../src/main/agent/office/office-write-contract'
import { officeWriteStrategy } from '../src/main/agent/office/office-write-operation'
import { addSheetWriteRequest } from '../src/main/agent/office/office-sheet-operation'
import { officeApplyApprovalDigest } from '../src/main/agent/office/office-approval'
import { OfficeBatchWriter } from '../src/main/agent/office/office-batch-writer'
import { assertSuccessfulAddSheetBatch } from '../src/main/agent/office/office-sheet-parser'

function expectWriteError(input: unknown, code: OfficeWriteError['code'], message: RegExp): void {
  assert.throws(
    () => validateAddSheetParams(input),
    (error: unknown) =>
      error instanceof OfficeWriteError && error.code === code && message.test(error.message)
  )
}

test('add_sheet accepts an exact valid name and revision', () => {
  assert.deepEqual(validateAddSheetParams({ name: '汇总 表-1', baseRevision: 4 }), {
    name: '汇总 表-1',
    baseRevision: 4
  })
  assert.equal(OFFICE_MAX_WORKBOOK_SHEETS, 20)
})

test('add_sheet rejects invalid names without trimming or rewriting them', () => {
  for (const name of [
    '',
    ' '.repeat(3),
    ' 汇总表',
    '汇总表 ',
    "'汇总表",
    "汇总表'",
    'x'.repeat(32),
    '汇/总',
    '汇\\总',
    '汇?总',
    '汇*总',
    '汇[总',
    '汇]总',
    '汇:总',
    '汇\u0000总',
    '汇\u0085总'
  ]) {
    expectWriteError({ name, baseRevision: 0 }, 'invalid_sheet', /工作表名称/u)
  }
})

test('add_sheet rejects unknown fields and invalid revisions', () => {
  expectWriteError({ name: '汇总表', baseRevision: 0, extra: true }, 'invalid_value', /字段/u)
  expectWriteError({ name: '汇总表', baseRevision: -1 }, 'revision_conflict', /版本/u)
})

test('add_sheet strategy binds the full normalized name and builds one atomic add command', () => {
  const request = addSheetWriteRequest({ name: '汇总表', baseRevision: 7 })
  const strategy = officeWriteStrategy(request.operation)
  assert.equal(strategy.type, 'add_sheet')
  assert.deepEqual(strategy.digestInput(request), {
    operation: { type: 'add_sheet', name: '汇总表' },
    baseRevision: 7
  })
  assert.deepEqual(strategy.commands(request.operation), [
    { command: 'add', parent: '/', type: 'sheet', props: { name: '汇总表' } }
  ])
  assert.deepEqual(strategy.previewCondition(request.operation), {
    kind: 'sheet',
    sheet: '汇总表'
  })
})

test('add_sheet rejects case-insensitive duplicates and the workbook sheet limit before dispatch', () => {
  const request = addSheetWriteRequest({ name: '汇总表', baseRevision: 0 })
  const strategy = officeWriteStrategy(request.operation)
  assert.throws(
    () => strategy.assertBefore?.(request.operation, addSheetSnapshot(['Sheet1', '汇总表'])),
    (error: unknown) =>
      error instanceof OfficeWriteError &&
      error.code === 'sheet_exists' &&
      assert.deepEqual(error.details?.sheetNames, ['Sheet1', '汇总表']) === undefined
  )
  assert.throws(
    () =>
      strategy.assertBefore?.(
        request.operation,
        addSheetSnapshot(Array.from({ length: OFFICE_MAX_WORKBOOK_SHEETS }, (_, i) => `S${i + 1}`))
      ),
    (error: unknown) => error instanceof OfficeWriteError && error.code === 'too_many_sheets'
  )
})

test('add_sheet readback requires exactly one appended empty sheet and preserves prior order', () => {
  const request = addSheetWriteRequest({ name: '汇总表', baseRevision: 2 })
  const strategy = officeWriteStrategy(request.operation)
  const before = addSheetSnapshot(['Sheet1', '数据'])
  const applied = addSheetSnapshot(['Sheet1', '数据', '汇总表'], true)
  const notApplied = addSheetSnapshot(['Sheet1', '数据'])
  for (const indeterminate of [
    addSheetSnapshot(['Sheet1', '汇总表', '数据'], true),
    addSheetSnapshot(['Sheet1', '数据', '汇总表', '其它'], true),
    addSheetSnapshot(['Sheet1', '数据', '汇总表', '汇总表'], true),
    addSheetSnapshot(['Sheet1', '数据', '汇总表'], false)
  ]) {
    assert.equal(strategy.classify(request.operation, before, indeterminate), 'indeterminate')
    assert.equal(strategy.verify?.(request.operation, before, indeterminate), false)
  }
  assert.equal(strategy.classify(request.operation, before, applied), 'applied')
  assert.equal(strategy.classify(request.operation, before, notApplied), 'not_applied')
  assert.equal(strategy.verify?.(request.operation, before, applied), true)
})

test('add_sheet approval and result expose a reusable parsed path and unmodified sheet list', () => {
  const request = addSheetWriteRequest({ name: '汇总表', baseRevision: 2 })
  const strategy = officeWriteStrategy(request.operation)
  const before = addSheetSnapshot(['Sheet1', '数据'])
  const verified = addSheetSnapshot(['Sheet1', '数据', '汇总表'], true)
  const description = strategy.describe(request, before, 'Book.xlsx', 2)
  assert.equal(strategy.approvalSummary(description), '新建工作表「汇总表」（当前共 2 个工作表）')
  assert.deepEqual(strategy.before(request.operation, before), {
    sheetNames: ['Sheet1', '数据']
  })
  assert.deepEqual(
    strategy.restoreBefore(request.operation, { sheetNames: ['Sheet1', '数据'] }),
    before
  )
  assert.deepEqual(strategy.result(request, before, 3, true, true, verified), {
    applied: true,
    saved: true,
    revision: 3,
    sheet: '汇总表',
    path: '/汇总表',
    sheetCount: 3,
    sheetNames: ['Sheet1', '数据', '汇总表'],
    previewConfirmed: true
  })
})

test('add_sheet approval escapes user data and its digest binds the complete name', () => {
  const request = addSheetWriteRequest({ name: '汇总<表>` & 1', baseRevision: 2 })
  const strategy = officeWriteStrategy(request.operation)
  const before = addSheetSnapshot(['Sheet1'])
  assert.equal(
    strategy.approvalSummary(strategy.describe(request, before, 'Book.xlsx', 2)),
    '新建工作表「汇总‹表›｀ ＆ 1」（当前共 1 个工作表）'
  )
  assert.notEqual(
    officeApplyApprovalDigest(request),
    officeApplyApprovalDigest(addSheetWriteRequest({ name: '汇总<表>` & 2', baseRevision: 2 }))
  )
})

test('add_sheet writer sends one atomic batch through stdin with no name in argv', async () => {
  const calls: Array<{ args: readonly string[]; stdin?: string }> = []
  const writer = new OfficeBatchWriter({
    run: async (_binaryPath, args, options) => {
      calls.push({ args, stdin: options.stdin })
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          success: true,
          data: {
            results: [{ index: 0, success: true, output: 'Added sheet at /汇总表' }],
            summary: { total: 1, executed: 1, succeeded: 1, failed: 0, skipped: 0 }
          }
        }),
        stderr: '',
        timedOut: false,
        truncated: false
      }
    }
  })
  const request = addSheetWriteRequest({ name: '汇总表', baseRevision: 0 })
  await writer.apply({ binaryPath: '/officecli', draftPath: '/draft.xlsx' }, request.operation)

  assert.deepEqual(calls, [
    {
      args: ['batch', '/draft.xlsx', '--json'],
      stdin: '[{"command":"add","parent":"/","type":"sheet","props":{"name":"汇总表"}}]'
    }
  ])
  assert.equal(calls[0]?.args.join(' ').includes('汇总表'), false)
})

test('add_sheet receipt requires exact summary counts and distinguishes proven rollback', () => {
  const base = {
    exitCode: 0,
    stdout: '',
    stderr: '',
    timedOut: false,
    truncated: false
  }
  const envelope = {
    success: true,
    data: {
      results: [{ index: 0, success: true, output: 'Added sheet at /汇总表' }],
      summary: { total: 1, executed: 1, succeeded: 1, failed: 0, skipped: 0 }
    }
  }
  assert.doesNotThrow(() =>
    assertSuccessfulAddSheetBatch({ ...base, stdout: JSON.stringify(envelope) }, 1)
  )
  assert.throws(
    () =>
      assertSuccessfulAddSheetBatch(
        {
          ...base,
          stdout: JSON.stringify({
            ...envelope,
            data: { ...envelope.data, summary: { ...envelope.data.summary, executed: 0 } }
          })
        },
        1
      ),
    { code: 'write_unknown' }
  )
  assert.throws(
    () =>
      assertSuccessfulAddSheetBatch(
        {
          ...base,
          exitCode: 1,
          stdout: JSON.stringify({
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
          })
        },
        1
      ),
    { code: 'write_failed' }
  )
})
