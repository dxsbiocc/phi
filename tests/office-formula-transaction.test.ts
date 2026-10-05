import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import type { OfficeReadCell, OfficeReadResult } from '../src/main/agent/office/office-read'
import { validateOfficeWriteRequest } from '../src/main/agent/office/office-write'
import { OfficeWriteError } from '../src/main/agent/office/office-write'

const openRequest = {
  sessionId: 'session-1',
  projectId: 'project-1',
  sourcePath: '/project/source.xlsx',
  projectLocation: { kind: 'local' as const, path: '/project', realPath: '/project' },
  allowRoots: ['/project']
}

function formulaResponse(revision: number, cell: OfficeReadCell): OfficeReadResult {
  return {
    revision,
    sheet: 'Sheet1',
    range: 'E1',
    cells: [cell],
    rowCount: 1,
    columnCount: 1,
    complete: true,
    truncated: false,
    limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
  }
}

function transactionRead(
  revision: number,
  target: OfficeReadCell,
  range: string | undefined
): OfficeReadResult {
  if (!range || range === 'E1') return formulaResponse(revision, target)
  return {
    ...formulaResponse(revision, { ref: range, value: null, valueType: 'empty' }),
    range
  }
}

function dependencies(
  overrides: Partial<OfficeServiceDependencies> = {}
): OfficeServiceDependencies {
  return {
    detectRuntime: async () => ({
      state: 'available',
      binaryPath: '/officecli',
      version: '1.0.153',
      platform: 'darwin-arm64'
    }),
    prepareDraft: async (input) => ({
      artifactId: 'artifact-1',
      sessionId: input.sessionId,
      projectId: input.projectId,
      sourcePath: input.sourcePath,
      sourceHash: 'source-hash',
      draftPath: '/sessions/session-1/artifacts/office/artifact-1/source.xlsx'
    }),
    prepareBlankDraft: async () => {
      throw new Error('unused')
    },
    startDocument: async () => ({ residentPid: 101 }),
    adoptCreatedDocument: async () => ({ residentPid: 101 }),
    startPreview: async () => ({
      watchPid: 202,
      watchPort: 31_001,
      gatewayPort: 42_001,
      previewUrl: 'http://127.0.0.1:42001/'
    }),
    stopPreview: async () => undefined,
    closeDocument: async () => undefined,
    removeBlankDraft: async () => undefined,
    validateRegisteredDraft: async () => undefined,
    assertNotOfficeArtifactPath: async () => undefined,
    resolveSelection: async () => null,
    clearSelection: async () => undefined,
    readRange: async () => formulaResponse(0, { ref: 'E1', value: null, valueType: 'empty' }),
    applyCellValue: async () => {
      throw new Error('single-cell writer must not run')
    },
    saveDraft: async () => undefined,
    armPreviewConfirmation: () => ({
      promise: Promise.resolve(true),
      cancel: () => undefined
    }),
    loadOperationLog: async () => ({ version: 2, contentRevision: 0, operations: {} }),
    persistOperationLog: async () => undefined,
    ...overrides
  }
}

async function openBoundService(
  overrides: Partial<OfficeServiceDependencies>
): Promise<OfficeService> {
  const service = new OfficeService(dependencies(overrides))
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-formula',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  return service
}

test('set_formula returns the computed value and increments revision once', async () => {
  let current: OfficeReadCell = { ref: 'E1', value: '旧值', valueType: 'string' }
  let saves = 0
  const service = await openBoundService({
    readRange: async (context, params) => transactionRead(context.revision, current, params.range),
    applyWriteOperation: async (_context, operation) => {
      const formula = (operation as unknown as { formula: string }).formula
      current = {
        ref: 'E1',
        value: 6,
        valueType: 'number',
        formula,
        evaluated: true
      }
    },
    saveDraft: async () => {
      saves += 1
    }
  })
  const request = validateOfficeWriteRequest({
    operation: {
      type: 'set_formula',
      sheet: 'Sheet1',
      cell: 'E1',
      formula: '=SUM(A1:A3)'
    },
    baseRevision: 0
  })

  const result = await service.applyWriteRequest('run-formula', request, {
    operationId: 'formula-success'
  })

  assert.deepEqual(result, {
    applied: true,
    saved: true,
    revision: 1,
    sheet: 'Sheet1',
    cell: 'E1',
    formula: '=SUM(A1:A3)',
    computedValue: 6,
    valueType: 'number',
    previewConfirmed: true
  })
  assert.equal(saves, 1)
})

test('an error formula is restored to the old value and fails without changing revision', async () => {
  let current: OfficeReadCell = { ref: 'E1', value: '旧值', valueType: 'string' }
  let writes = 0
  let restores = 0
  const service = await openBoundService({
    readRange: async (context, params) => transactionRead(context.revision, current, params.range),
    applyWriteOperation: async (_context, operation) => {
      writes += 1
      current = {
        ref: 'E1',
        value: '#DIV/0!',
        valueType: 'error',
        formula: (operation as unknown as { formula: string }).formula,
        evaluated: true
      }
    },
    restoreWriteOperation: async () => {
      restores += 1
      current = { ref: 'E1', value: '旧值', valueType: 'string' }
    }
  } as Partial<OfficeServiceDependencies>)
  const request = validateOfficeWriteRequest({
    operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E1', formula: '=1/0' },
    baseRevision: 0
  })

  await assert.rejects(
    service.applyWriteRequest('run-formula', request, { operationId: 'formula-error' }),
    (error) => {
      assert.ok(error instanceof OfficeWriteError)
      assert.equal(error.code, 'formula_invalid')
      assert.deepEqual(error.details?.result, {
        applied: false,
        saved: true,
        revision: 0,
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
      })
      return true
    }
  )
  assert.equal(writes, 1)
  assert.equal(restores, 1)
  assert.deepEqual(current, { ref: 'E1', value: '旧值', valueType: 'string' })
  const described = await service.describeWriteRequest('run-formula', {
    ...request,
    baseRevision: 0
  })
  assert.equal(described.revision, 0)
})

test('an unsupported formula restores the complete previous formula state', async () => {
  const previous: OfficeReadCell = {
    ref: 'E1',
    value: 3,
    valueType: 'number',
    formula: '=A1+A2',
    evaluated: true
  }
  let current = previous
  let restoreEvidence: unknown
  const service = await openBoundService({
    readRange: async (context, params) => transactionRead(context.revision, current, params.range),
    applyWriteOperation: async (_context, operation) => {
      current = {
        ref: 'E1',
        value: null,
        valueType: 'error',
        formula: (operation as unknown as { formula: string }).formula,
        evaluated: false,
        error: 'unsupported_function'
      }
    },
    restoreWriteOperation: async (_context, _operation, before) => {
      restoreEvidence = before
      current = previous
    }
  } as Partial<OfficeServiceDependencies>)
  const request = validateOfficeWriteRequest({
    operation: {
      type: 'set_formula',
      sheet: 'Sheet1',
      cell: 'E1',
      formula: '=NOSUCHFN(A1)'
    },
    baseRevision: 0
  })

  await assert.rejects(
    service.applyWriteRequest('run-formula', request, {
      operationId: 'formula-unsupported'
    }),
    (error) => {
      assert.ok(error instanceof OfficeWriteError)
      assert.equal(error.code, 'formula_invalid')
      assert.equal(
        (error.details?.result as { reason?: unknown } | undefined)?.reason,
        'unsupported_function'
      )
      return true
    }
  )
  assert.deepEqual(restoreEvidence, {
    value: 3,
    valueType: 'number',
    formula: '=A1+A2',
    evaluated: true
  })
  assert.deepEqual(current, previous)
})

test('a failed formula rollback becomes unknown and freezes without retrying the formula', async () => {
  let current: OfficeReadCell = { ref: 'E1', value: '旧值', valueType: 'string' }
  let writes = 0
  let restores = 0
  const service = await openBoundService({
    readRange: async (context, params) => transactionRead(context.revision, current, params.range),
    applyWriteOperation: async (_context, operation) => {
      writes += 1
      current = {
        ref: 'E1',
        value: '#VALUE!',
        valueType: 'error',
        formula: (operation as unknown as { formula: string }).formula,
        evaluated: true
      }
    },
    restoreWriteOperation: async () => {
      restores += 1
      throw new OfficeWriteError('write_failed', 'rollback failed internally')
    }
  } as Partial<OfficeServiceDependencies>)
  const request = validateOfficeWriteRequest({
    operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E1', formula: '="x"+1' },
    baseRevision: 0
  })

  await assert.rejects(
    service.applyWriteRequest('run-formula', request, { operationId: 'formula-rollback-failed' }),
    { code: 'write_unknown' }
  )
  await assert.rejects(
    service.applyWriteRequest('run-formula', request, { operationId: 'formula-blocked' }),
    { code: 'document_frozen' }
  )
  assert.equal(writes, 1)
  assert.equal(restores, 1)
})

test('formula_invalid is deduplicated with its safe failure result and no second write', async () => {
  let current: OfficeReadCell = { ref: 'E1', value: 'before', valueType: 'string' }
  let writes = 0
  let restores = 0
  const service = await openBoundService({
    readRange: async (context, params) => transactionRead(context.revision, current, params.range),
    applyWriteOperation: async (_context, operation) => {
      writes += 1
      current = {
        ref: 'E1',
        value: '#N/A',
        valueType: 'error',
        formula: (operation as unknown as { formula: string }).formula,
        evaluated: true
      }
    },
    restoreWriteOperation: async () => {
      restores += 1
      current = { ref: 'E1', value: 'before', valueType: 'string' }
    }
  } as Partial<OfficeServiceDependencies>)
  const request = validateOfficeWriteRequest({
    operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E1', formula: '=NA()' },
    baseRevision: 0
  })
  const apply = (): Promise<unknown> =>
    service.applyWriteRequest('run-formula', request, { operationId: 'formula-deduplicated' })

  await assert.rejects(apply(), { code: 'formula_invalid' })
  await assert.rejects(apply(), (error) => {
    assert.ok(error instanceof OfficeWriteError)
    assert.equal(error.code, 'formula_invalid')
    assert.equal(error.details?.deduplicated, true)
    assert.equal(
      (error.details?.result as { deduplicated?: unknown } | undefined)?.deduplicated,
      true
    )
    assert.equal((error.details?.result as { reason?: unknown } | undefined)?.reason, 'error_value')
    return true
  })
  assert.equal(writes, 1)
  assert.equal(restores, 1)
})

test('a rollback save failure remains unknown and frozen after automatic reconciliation', async () => {
  let current: OfficeReadCell = { ref: 'E1', value: 'before', valueType: 'string' }
  const service = await openBoundService({
    readRange: async (context, params) => transactionRead(context.revision, current, params.range),
    applyWriteOperation: async (_context, operation) => {
      current = {
        ref: 'E1',
        value: '#REF!',
        valueType: 'error',
        formula: (operation as unknown as { formula: string }).formula,
        evaluated: true
      }
    },
    restoreWriteOperation: async () => {
      current = { ref: 'E1', value: 'before', valueType: 'string' }
    },
    saveDraft: async () => {
      throw new Error('private save detail')
    }
  } as Partial<OfficeServiceDependencies>)
  const request = validateOfficeWriteRequest({
    operation: {
      type: 'set_formula',
      sheet: 'Sheet1',
      cell: 'E1',
      formula: '=INDEX(A1:A3,99)'
    },
    baseRevision: 0
  })

  await assert.rejects(
    service.applyWriteRequest('run-formula', request, { operationId: 'formula-rollback-save' }),
    { code: 'write_unknown' }
  )
  assert.throws(() => service.assertWritable('artifact-1'), { code: 'document_frozen' })
})

test('an engine-accepted direct circular reference is detected and rolled back', async () => {
  let current: OfficeReadCell = { ref: 'E1', value: 1, valueType: 'number' }
  const service = await openBoundService({
    readRange: async (context, params) => transactionRead(context.revision, current, params.range),
    applyWriteOperation: async (_context, operation) => {
      current = {
        ref: 'E1',
        value: 2,
        valueType: 'number',
        formula: (operation as unknown as { formula: string }).formula,
        evaluated: true
      }
    },
    restoreWriteOperation: async () => {
      current = { ref: 'E1', value: 1, valueType: 'number' }
    }
  } as Partial<OfficeServiceDependencies>)
  const request = validateOfficeWriteRequest({
    operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E1', formula: '=E1+1' },
    baseRevision: 0
  })

  await assert.rejects(
    service.applyWriteRequest('run-formula', request, { operationId: 'formula-circular' }),
    (error) => {
      assert.ok(error instanceof OfficeWriteError)
      assert.equal(error.code, 'formula_invalid')
      assert.equal(
        (error.details?.result as { reason?: unknown } | undefined)?.reason,
        'circular_reference'
      )
      return true
    }
  )
  assert.deepEqual(current, { ref: 'E1', value: 1, valueType: 'number' })
})

test('an engine-accepted formula with unbalanced delimiters is rolled back', async () => {
  let current: OfficeReadCell = { ref: 'E1', value: 'before', valueType: 'string' }
  const service = await openBoundService({
    readRange: async (context, params) => transactionRead(context.revision, current, params.range),
    applyWriteOperation: async (_context, operation) => {
      current = {
        ref: 'E1',
        value: 6,
        valueType: 'number',
        formula: (operation as unknown as { formula: string }).formula,
        evaluated: true
      }
    },
    restoreWriteOperation: async () => {
      current = { ref: 'E1', value: 'before', valueType: 'string' }
    }
  } as Partial<OfficeServiceDependencies>)
  const request = validateOfficeWriteRequest({
    operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E1', formula: '=SUM(A1:A3' },
    baseRevision: 0
  })

  await assert.rejects(
    service.applyWriteRequest('run-formula', request, { operationId: 'formula-invalid-syntax' }),
    (error) => {
      assert.ok(error instanceof OfficeWriteError)
      assert.equal(error.code, 'formula_invalid')
      assert.equal(
        (error.details?.result as { reason?: unknown } | undefined)?.reason,
        'invalid_syntax'
      )
      return true
    }
  )
  assert.deepEqual(current, { ref: 'E1', value: 'before', valueType: 'string' })
})

test('a lost reply never reconciles an engine-accepted circular formula as applied', async () => {
  let current: OfficeReadCell = { ref: 'E1', value: 1, valueType: 'number' }
  const service = await openBoundService({
    readRange: async (context, params) => transactionRead(context.revision, current, params.range),
    applyWriteOperation: async (_context, operation) => {
      current = {
        ref: 'E1',
        value: 2,
        valueType: 'number',
        formula: (operation as unknown as { formula: string }).formula,
        evaluated: true
      }
      throw new OfficeWriteError('write_unknown', 'reply lost')
    }
  })
  const request = validateOfficeWriteRequest({
    operation: { type: 'set_formula', sheet: 'Sheet1', cell: 'E1', formula: '=E1+1' },
    baseRevision: 0
  })

  await assert.rejects(
    service.applyWriteRequest('run-formula', request, { operationId: 'formula-circular-lost' }),
    { code: 'write_unknown' }
  )
  assert.throws(() => service.assertWritable('artifact-1'), { code: 'document_frozen' })
})
