import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createOfficeApplyHostHandler,
  createOfficeDescribeHostHandler,
  createOfficeReadHostHandler
} from '../src/main/agent/office/office-tool-host'
import { OfficeReadError } from '../src/main/agent/office/office-read'
import { OfficeWriteError } from '../src/main/agent/office/office-write-contract'

test('office read host resolves the run from trusted runtime context and ignores forged identities', async () => {
  const reads: Array<{ runId: string; params: unknown }> = []
  const handler = createOfficeReadHostHandler({
    resolveActiveRun: (originSessionId) =>
      originSessionId === 'runtime-main' ? { runId: 'trusted-run' } : undefined,
    readRange: async (runId, params) => {
      reads.push({ runId, params })
      return {
        revision: 4,
        sheet: 'Sheet1',
        range: 'A1:B3',
        cells: [],
        rowCount: 3,
        columnCount: 2,
        complete: true,
        truncated: false,
        limits: { maxCells: 2000, maxBytes: 262144 }
      }
    }
  })

  const result = await handler(
    {
      sheet: 'Sheet1',
      range: 'A1:B3',
      cursor: 'cursor-1',
      maxCells: 12,
      runId: 'forged-run',
      sessionId: 'forged-session',
      artifactId: 'forged-artifact',
      path: '/private/forged.xlsx'
    },
    { originSessionId: 'runtime-main' }
  )

  assert.deepEqual(reads, [
    {
      runId: 'trusted-run',
      params: { sheet: 'Sheet1', range: 'A1:B3', cursor: 'cursor-1', maxCells: 12 }
    }
  ])
  assert.equal(result.ok, true)
})

test('office apply host authorizes the trusted call before applying normalized parameters', async () => {
  const events: string[] = []
  const handler = createOfficeApplyHostHandler({
    resolveActiveRun: () => ({ runId: 'trusted-run' }),
    authorizeApply: async (runId, toolCallId, params) => {
      events.push(`authorize:${runId}:${toolCallId}:${params.sheet}!${params.cell}`)
      return true
    },
    applyCellEdit: async (runId, params, options) => {
      if (options.authorize && !(await options.authorize())) {
        throw new OfficeWriteError('approval_changed', 'not authorized')
      }
      events.push(`apply:${runId}:${params.value}:${params.baseRevision}`)
      return {
        applied: true,
        saved: true,
        revision: 7,
        sheet: params.sheet,
        cell: params.cell,
        before: '旧值',
        after: params.value,
        previewConfirmed: true,
        draftPath: '/private/secret.xlsx',
        residentPid: 4242
      }
    }
  })
  const params = {
    operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'a1', value: '实验编号' },
    baseRevision: 6,
    runId: 'forged-run',
    path: '/private/forged.xlsx'
  }

  const result = await handler(params, {
    originSessionId: 'runtime-main',
    toolCallId: 'trusted-tool-call'
  })

  assert.deepEqual(events, [
    'authorize:trusted-run:trusted-tool-call:Sheet1!A1',
    'apply:trusted-run:实验编号:6'
  ])
  assert.deepEqual(result, {
    ok: true,
    value: {
      applied: true,
      saved: true,
      revision: 7,
      sheet: 'Sheet1',
      cell: 'A1',
      before: '旧值',
      after: '实验编号',
      previewConfirmed: true
    }
  })
})

test('office apply host rejects a missing trusted operation id before authorization', async () => {
  let authorizations = 0
  let writes = 0
  const handler = createOfficeApplyHostHandler({
    resolveActiveRun: () => ({ runId: 'trusted-run' }),
    authorizeApply: () => {
      authorizations += 1
      return true
    },
    applyCellEdit: async (_runId, _params, options) => {
      if (options.authorize && !(await options.authorize())) {
        throw new OfficeWriteError('approval_changed', 'not authorized')
      }
      writes += 1
      throw new Error('must not write')
    }
  })

  const result = await handler(
    {
      operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '实验编号' },
      baseRevision: 0
    },
    { originSessionId: 'runtime-main' }
  )

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'missing_operation_id', message: '写入请求缺少可信操作编号，未做任何修改' }
  })
  assert.equal(authorizations, 0)
  assert.equal(writes, 0)
})

test('office apply host rejects a changed or missing authorization before any write', async () => {
  let writes = 0
  const handler = createOfficeApplyHostHandler({
    resolveActiveRun: () => ({ runId: 'trusted-run' }),
    authorizeApply: () => false,
    applyCellEdit: async (_runId, _params, options) => {
      if (options.authorize && !(await options.authorize())) {
        throw new OfficeWriteError('approval_changed', 'not authorized')
      }
      writes += 1
      throw new Error('must not write')
    }
  })

  const result = await handler(
    {
      operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '被篡改的值' },
      baseRevision: 9
    },
    { originSessionId: 'runtime-main', toolCallId: 'approved-different-call' }
  )

  assert.equal(writes, 0)
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'approval_changed',
      message: '写入参数未获本次批准，未做任何修改'
    }
  })
})

test('office apply host keeps agent_runs on their own unbound run instead of using the parent run', async () => {
  const runIds: string[] = []
  const handler = createOfficeApplyHostHandler({
    resolveActiveRun: () => ({ runId: 'parent-run-must-not-be-used' }),
    applyCellEdit: async (runId) => {
      runIds.push(runId)
      throw new OfficeWriteError('no_target', 'unsafe internal detail')
    }
  })

  const result = await handler(
    {
      operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '实验编号' },
      baseRevision: 0
    },
    { originSessionId: 'runtime-main', agentRunId: 'child-run', toolCallId: 'child-call' }
  )

  assert.deepEqual(runIds, ['child-run'])
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'no_target',
      message: '当前运行没有关联的 Office 文档，请先在右侧打开表格并在输入框里关联它'
    }
  })
})

test('office read host keeps agent_runs on their unbound run and returns a guided no_target error', async () => {
  const runIds: string[] = []
  const handler = createOfficeReadHostHandler({
    resolveActiveRun: () => ({ runId: 'parent-run-must-not-be-used' }),
    readRange: async (runId) => {
      runIds.push(runId)
      throw new OfficeReadError('no_target', '此任务没有关联 Office 文档')
    }
  })

  const result = await handler({}, { originSessionId: 'runtime-main', agentRunId: 'child-run' })

  assert.deepEqual(runIds, ['child-run'])
  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'no_target',
      message: '当前运行没有关联的 Office 文档，请先在右侧打开表格并在输入框里关联它'
    }
  })
})

test('office read host rejects values outside the public schema before calling the service', async () => {
  let reads = 0
  const handler = createOfficeReadHostHandler({
    resolveActiveRun: () => ({ runId: 'trusted-run' }),
    readRange: async () => {
      reads += 1
      throw new Error('must not read')
    }
  })
  const cases: Array<{ params: unknown; code: string }> = [
    { params: { sheet: 'x'.repeat(32) }, code: 'invalid_sheet' },
    { params: { sheet: 1 }, code: 'invalid_sheet' },
    { params: { range: 'A0' }, code: 'invalid_range' },
    { params: { range: 1 }, code: 'invalid_range' },
    { params: { cursor: 'x'.repeat(2049) }, code: 'invalid_cursor' },
    { params: { cursor: 1 }, code: 'invalid_cursor' },
    { params: { maxCells: 0 }, code: 'invalid_range' },
    { params: { maxCells: 2001 }, code: 'invalid_range' },
    { params: { maxCells: 1.5 }, code: 'invalid_range' },
    { params: { from: -1 }, code: 'invalid_arguments' },
    { params: { limit: 201 }, code: 'invalid_arguments' }
  ]

  for (const entry of cases) {
    const result = await handler(entry.params, { originSessionId: 'runtime-main' })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, entry.code)
  }
  assert.equal(reads, 0)
})

test('office read host preserves every public OfficeReadError code without leaking details', async () => {
  const codes = [
    'no_target',
    'target_missing',
    'session_mismatch',
    'invalid_sheet',
    'invalid_range',
    'range_out_of_bounds',
    'range_too_large',
    'invalid_cursor',
    'read_timeout',
    'read_failed',
    'unsupported_document_kind',
    'invalid_arguments',
    'workbook_busy'
  ] as const
  let nextError: Error = new Error('not configured')
  const handler = createOfficeReadHostHandler({
    resolveActiveRun: () => ({ runId: 'trusted-run' }),
    readRange: async () => {
      throw nextError
    }
  })

  for (const code of codes) {
    nextError = new OfficeReadError(code, `安全消息：${code}`, {
      draftPath: '/private/secret.xlsx',
      residentPid: 4242,
      port: 9999
    })
    const result = await handler({}, { originSessionId: 'runtime-main' })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, code)
      assert.doesNotMatch(JSON.stringify(result), /private|secret|4242|9999|draftPath/u)
    }
  }

  nextError = new Error('/private/secret.xlsx pid=4242 port=9999')
  assert.deepEqual(await handler({}, { originSessionId: 'runtime-main' }), {
    ok: false,
    error: { code: 'read_failed', message: '无法读取 Office 内容，请稍后重试' }
  })
})

test('office describe host uses trusted runtime identity and forwards only normalized set_cell fields', async () => {
  const descriptions: Array<{ runId: string; params: unknown }> = []
  const handler = createOfficeDescribeHostHandler({
    resolveActiveRun: (originSessionId) =>
      originSessionId === 'runtime-main' ? { runId: 'trusted-run' } : undefined,
    describeCellEdit: async (runId, params) => {
      descriptions.push({ runId, params })
      return {
        documentName: 'experiment.xlsx',
        sheet: params.sheet,
        cell: params.cell,
        before: '旧值',
        after: params.value,
        revision: 6,
        draftPath: '/private/secret.xlsx',
        residentPid: 4242
      }
    }
  })

  const result = await handler(
    {
      operation: {
        type: 'set_cell',
        sheet: 'Sheet1',
        cell: 'a1',
        value: '实验编号',
        path: '/private/forged.xlsx'
      },
      baseRevision: 6,
      runId: 'forged-run',
      sessionId: 'forged-session',
      artifactId: 'forged-artifact',
      path: '/private/forged.xlsx'
    },
    { originSessionId: 'runtime-main', toolCallId: 'trusted-tool-call' }
  )

  assert.deepEqual(descriptions, [
    {
      runId: 'trusted-run',
      params: { sheet: 'Sheet1', cell: 'A1', value: '实验编号' }
    }
  ])
  assert.deepEqual(result, {
    ok: true,
    value: {
      documentName: 'experiment.xlsx',
      sheet: 'Sheet1',
      cell: 'A1',
      before: '旧值',
      after: '实验编号',
      revision: 6
    }
  })
  assert.doesNotMatch(JSON.stringify(result), /private|secret|4242|draftPath|residentPid/u)
})

test('office apply host exposes only the safe result when saving fails after a confirmed write', async () => {
  const handler = createOfficeApplyHostHandler({
    resolveActiveRun: () => ({ runId: 'trusted-run' }),
    applyCellEdit: async () => {
      throw new OfficeWriteError('save_failed', '/private/secret.xlsx pid=4242 port=9999', {
        draftPath: '/private/secret.xlsx',
        result: {
          applied: true,
          saved: false,
          revision: 11,
          sheet: 'Sheet1',
          cell: 'A1',
          before: '旧值',
          after: '实验编号',
          previewConfirmed: true,
          draftPath: '/private/secret.xlsx',
          residentPid: 4242,
          port: 9999
        }
      })
    }
  })

  const result = await handler(
    {
      operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '实验编号' },
      baseRevision: 10
    },
    { originSessionId: 'runtime-main', toolCallId: 'trusted-tool-call' }
  )

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'save_failed',
      message: '内容已写入，但 Office 草稿保存失败',
      result: {
        applied: true,
        saved: false,
        revision: 11,
        sheet: 'Sheet1',
        cell: 'A1',
        before: '旧值',
        after: '实验编号',
        previewConfirmed: true
      }
    }
  })
  assert.doesNotMatch(JSON.stringify(result), /private|secret|4242|9999|draftPath|residentPid/u)
})

test('office apply host preserves write error codes with fixed safe messages', async () => {
  const codes = [
    'no_target',
    'target_missing',
    'session_mismatch',
    'invalid_sheet',
    'invalid_cell',
    'invalid_value',
    'formula_not_supported',
    'revision_conflict',
    'document_frozen',
    'unsupported_document_kind',
    'operation_not_supported_for_kind',
    'paragraph_not_found',
    'paragraph_not_plain',
    'stale_target',
    'write_failed',
    'write_verification_failed',
    'save_failed',
    'write_cancelled',
    'write_unknown',
    'missing_operation_id',
    'operation_conflict',
    'operation_log_corrupt',
    'approval_changed'
  ] as const
  let nextError: Error = new Error('not configured')
  const handler = createOfficeApplyHostHandler({
    resolveActiveRun: () => ({ runId: 'trusted-run' }),
    applyCellEdit: async () => {
      throw nextError
    }
  })
  const params = {
    operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: '实验编号' },
    baseRevision: 4
  }

  for (const code of codes) {
    nextError = new OfficeWriteError(code, '/private/secret.xlsx pid=4242 port=9999', {
      draftPath: '/private/secret.xlsx',
      residentPid: 4242,
      port: 9999
    })
    const result = await handler(params, {
      originSessionId: 'runtime-main',
      toolCallId: 'trusted-tool-call'
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, code)
    assert.doesNotMatch(JSON.stringify(result), /private|secret|4242|9999|draftPath|residentPid/u)
  }

  nextError = new Error('/private/secret.xlsx pid=4242 port=9999')
  assert.deepEqual(
    await handler(params, { originSessionId: 'runtime-main', toolCallId: 'trusted-tool-call' }),
    {
      ok: false,
      error: { code: 'write_failed', message: '无法修改 Office 内容，请稍后重试' }
    }
  )
})
