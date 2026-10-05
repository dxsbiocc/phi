import assert from 'node:assert/strict'
import test from 'node:test'

import { createOfficeDeliverHostHandler } from '../src/main/agent/office/office-deliver-tool-host'

test('Office delivery host derives the run and operation id from trusted context', async () => {
  const calls: unknown[] = []
  const handler = createOfficeDeliverHostHandler({
    resolveActiveRun: () => ({ runId: 'run-trusted' }),
    deliver: async (runId, input, operationId) => {
      calls.push({ runId, input, operationId })
      return { fileName: '报告.xlsx', outputPath: '报告.xlsx' }
    }
  })

  const result = await handler(
    {
      outputName: '报告',
      runId: 'forged',
      sessionId: 'forged',
      artifactId: 'forged',
      path: '/private/forged.xlsx',
      toolCallId: 'forged'
    },
    { originSessionId: 'runtime-1', toolCallId: 'call-trusted' }
  )

  assert.deepEqual(calls, [
    {
      runId: 'run-trusted',
      input: { outputName: '报告' },
      operationId: 'call-trusted'
    }
  ])
  assert.deepEqual(result, {
    ok: true,
    value: { fileName: '报告.xlsx', outputPath: '报告.xlsx' }
  })
})

test('Office delivery host rejects missing trusted identity without calling delivery', async () => {
  let calls = 0
  const handler = createOfficeDeliverHostHandler({
    resolveActiveRun: () => undefined,
    deliver: async () => {
      calls += 1
      return {}
    }
  })

  assert.deepEqual(await handler({}, { originSessionId: 'missing' }), {
    ok: false,
    error: { code: 'no_target', message: '当前任务没有关联 Office 文档，无法交付' }
  })
  assert.equal(calls, 0)
})

test('Office delivery host returns fixed errors without leaking private paths', async () => {
  const handler = createOfficeDeliverHostHandler({
    resolveActiveRun: () => ({ runId: 'run-1' }),
    deliver: async () => {
      throw Object.assign(new Error('/private/session/artifacts/office/secret.xlsx pid=42'), {
        code: 'delivery_check_failed'
      })
    }
  })
  const result = await handler({}, { originSessionId: 'runtime-1', toolCallId: 'call-1' })

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'delivery_check_failed', message: 'Office 输出内容检查失败，未创建交付文件' }
  })
  assert.doesNotMatch(JSON.stringify(result), /private|secret|pid=42/u)
})
