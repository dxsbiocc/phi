import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createOfficeApplyHostHandler,
  createOfficeDescribeHostHandler
} from '../src/main/agent/office/office-tool-host'
import {
  OfficeWriteError,
  type OfficeWriteRequest
} from '../src/main/agent/office/office-write-contract'

test('office apply host revalidates set_formula and routes it through applyWriteRequest', async () => {
  const observed: Array<{ runId: string; request: OfficeWriteRequest; operationId?: string }> = []
  const handler = createOfficeApplyHostHandler({
    resolveActiveRun: () => ({ runId: 'run-formula' }),
    applyCellEdit: async () => {
      throw new Error('set_cell path must not run')
    },
    applyWriteRequest: async (runId, request, options) => {
      observed.push({ runId, request, operationId: options.operationId })
      return {
        applied: true,
        saved: true,
        revision: 4,
        sheet: 'Sheet1',
        cell: 'E1',
        formula: '=SUM(A1:A3)',
        computedValue: 6,
        valueType: 'number',
        previewConfirmed: true
      }
    }
  })

  const result = await handler(
    {
      operation: {
        type: 'set_formula',
        sheet: 'Sheet1',
        cell: 'e1',
        formula: '=SUM(A1:A3)'
      },
      baseRevision: 3
    },
    { originSessionId: 'session-1', toolCallId: 'formula-op-1' }
  )

  assert.equal(result.ok, true)
  assert.deepEqual(observed, [
    {
      runId: 'run-formula',
      request: {
        operation: {
          type: 'set_formula',
          sheet: 'Sheet1',
          cell: 'E1',
          formula: '=SUM(A1:A3)'
        },
        baseRevision: 3
      },
      operationId: 'formula-op-1'
    }
  ])
  assert.deepEqual(result, {
    ok: true,
    value: {
      applied: true,
      saved: true,
      revision: 4,
      sheet: 'Sheet1',
      cell: 'E1',
      formula: '=SUM(A1:A3)',
      computedValue: 6,
      valueType: 'number',
      previewConfirmed: true
    }
  })
})

test('office describe host routes set_formula through describeWriteRequest and preserves old formula', async () => {
  const observed: OfficeWriteRequest[] = []
  const handler = createOfficeDescribeHostHandler({
    resolveActiveRun: () => ({ runId: 'run-formula' }),
    describeCellEdit: async () => {
      throw new Error('set_cell path must not run')
    },
    describeWriteRequest: async (_runId, request) => {
      observed.push(request)
      return {
        type: 'set_formula',
        documentName: 'Book.xlsx',
        sheet: 'Sheet1',
        cell: 'E1',
        formula: '=AVERAGE(A1:A3)',
        before: { value: 6, valueType: 'number', formula: '=SUM(A1:A3)', evaluated: true },
        revision: 3
      }
    }
  })

  const result = await handler(
    {
      operation: {
        type: 'set_formula',
        sheet: 'Sheet1',
        cell: 'E1',
        formula: '=AVERAGE(A1:A3)'
      },
      baseRevision: 3
    },
    { agentRunId: 'run-formula', toolCallId: 'formula-describe-1' }
  )

  assert.equal(observed.length, 1)
  assert.deepEqual(result, {
    ok: true,
    value: {
      type: 'set_formula',
      documentName: 'Book.xlsx',
      sheet: 'Sheet1',
      cell: 'E1',
      formula: '=AVERAGE(A1:A3)',
      before: { value: 6, valueType: 'number', formula: '=SUM(A1:A3)', evaluated: true },
      revision: 3
    }
  })
})

test('office apply host safely carries formula_invalid rollback evidence', async () => {
  const handler = createOfficeApplyHostHandler({
    resolveActiveRun: () => ({ runId: 'run-formula' }),
    applyCellEdit: async () => {
      throw new Error('set_cell path must not run')
    },
    applyWriteRequest: async () => {
      throw new OfficeWriteError('formula_invalid', '/private/secret.xlsx pid=4242', {
        result: {
          applied: false,
          saved: true,
          revision: 3,
          sheet: 'Sheet1',
          cell: 'E1',
          formula: '=1/0',
          formulaStatus: {
            formula: '=1/0',
            evaluated: true,
            computedValue: '#DIV/0!',
            valueType: 'error',
            draftPath: '/private/secret.xlsx'
          },
          reason: 'error_value',
          previewConfirmed: false,
          residentPid: 4242
        }
      })
    }
  })

  const result = await handler(
    {
      operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E1', formula: '=1/0' },
      baseRevision: 3
    },
    { agentRunId: 'run-formula', toolCallId: 'formula-invalid-host-1' }
  )

  assert.deepEqual(result, {
    ok: false,
    error: {
      code: 'formula_invalid',
      message: '公式无法可靠计算，已恢复写入前内容',
      result: {
        applied: false,
        saved: true,
        revision: 3,
        sheet: 'Sheet1',
        cell: 'E1',
        formula: '=1/0',
        formulaStatus: {
          formula: '=1/0',
          evaluated: true,
          computedValue: '#DIV/0!',
          valueType: 'error'
        },
        reason: 'error_value',
        previewConfirmed: false
      }
    }
  })
  assert.doesNotMatch(JSON.stringify(result), /private|secret|4242|draftPath|residentPid/u)
})
