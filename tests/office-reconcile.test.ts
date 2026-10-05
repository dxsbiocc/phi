import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import type { OfficeReadResult } from '../src/main/agent/office/office-read'
import { OfficeWriteError } from '../src/main/agent/office/office-write'
import {
  officeOperationDigest,
  type OfficeOperationLogState
} from '../src/main/agent/office/office-operation-log'

const openRequest = {
  sessionId: 'session-1',
  projectId: 'project-1',
  sourcePath: '/project/source.xlsx',
  projectLocation: { kind: 'local' as const, path: '/project', realPath: '/project' },
  allowRoots: ['/project']
}

function cellResponse(revision: number, value: string | number | boolean | null): OfficeReadResult {
  return {
    revision,
    sheet: 'Sheet1',
    range: 'A1',
    cells: [{ ref: 'A1', value, valueType: value === null ? 'empty' : valueType(value) }],
    rowCount: 1,
    columnCount: 1,
    complete: true,
    truncated: false,
    limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
  }
}

function valueType(value: string | number | boolean): 'string' | 'number' | 'boolean' {
  return typeof value
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
      sourceHash: 'hash',
      draftPath: '/session/artifacts/office/artifact-1/source.xlsx'
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
    readRange: async () => {
      throw new Error('must not read')
    },
    applyCellValue: async () => {
      throw new Error('must not write')
    },
    saveDraft: async () => undefined,
    armPreviewConfirmation: () => ({ promise: Promise.resolve(false), cancel: () => undefined }),
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
    runId: 'run-write',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  return service
}

test('a lost write reply is automatically reconciled as applied without replaying the write', async () => {
  let current: string | number | boolean | null = 'before'
  let writes = 0
  let saves = 0
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      writes += 1
      current = params.value
      throw new OfficeWriteError('write_unknown', 'simulated lost reply')
    },
    saveDraft: async () => {
      saves += 1
    }
  })
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 }
  const options = { operationId: 'lost-reply-applied' }

  const result = await service.applyCellEdit('run-write', params, options)
  const replay = await service.applyCellEdit('run-write', params, options)

  assert.deepEqual(result, {
    applied: true,
    saved: true,
    revision: 1,
    sheet: 'Sheet1',
    cell: 'A1',
    before: 'before',
    after: 'after',
    previewConfirmed: false,
    warnings: ['preview_not_confirmed'],
    reconciled: true
  })
  assert.deepEqual(replay, { ...result, deduplicated: true })
  assert.equal(writes, 1)
  assert.equal(saves, 1)
  assert.doesNotThrow(() => service.assertWritable('artifact-1'))
  assert.doesNotThrow(() => service.assertDeliverable('artifact-1'))
  await assert.rejects(service.reconcile('artifact-1', 'session-2'), {
    code: 'target_session_mismatch'
  })
})

test('an unknown command that did not run is reconciled as not_applied and can be retried with a new id', async () => {
  let current: string | number | boolean | null = 'before'
  let writes = 0
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      writes += 1
      if (writes === 1) throw new OfficeWriteError('write_unknown', 'simulated pre-exec timeout')
      current = params.value
    }
  })
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 }

  await assert.rejects(service.applyCellEdit('run-write', params, { operationId: 'not-applied' }), {
    code: 'write_not_applied'
  })
  await assert.rejects(
    service.applyCellEdit('run-write', params, { operationId: 'not-applied' }),
    (error) =>
      error instanceof OfficeWriteError &&
      error.code === 'write_not_applied' &&
      error.details?.deduplicated === true
  )
  const retried = await service.applyCellEdit('run-write', params, {
    operationId: 'not-applied-retry'
  })

  assert.equal(retried.revision, 1)
  assert.equal(writes, 2)
})

test('a third value is indeterminate, remains frozen, and manual reconciliation never rewrites', async () => {
  let current: string | number | boolean | null = 'before'
  let writes = 0
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async () => {
      writes += 1
      current = 'third-party-value'
      throw new OfficeWriteError('write_unknown', 'simulated lost reply')
    }
  })
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'expected', baseRevision: 0 }

  await assert.rejects(
    service.applyCellEdit('run-write', params, { operationId: 'indeterminate' }),
    { code: 'write_unknown' }
  )
  await assert.rejects(
    service.applyCellEdit(
      'run-write',
      { ...params, value: 'blocked' },
      { operationId: 'blocked-write' }
    ),
    { code: 'document_frozen' }
  )
  const reconciled = await service.reconcile('artifact-1', 'session-1')

  assert.equal(reconciled.conclusion, 'indeterminate')
  assert.equal(reconciled.code, 'reconcile_indeterminate')
  assert.equal(reconciled.freezeState, 'unknown')
  assert.equal(writes, 1)
  assert.throws(() => service.assertWritable('artifact-1'), { code: 'document_frozen' })
  assert.throws(() => service.assertDeliverable('artifact-1'), {
    code: 'document_not_deliverable'
  })
})

test('matching before and expected values reconcile as applied_no_change without revision growth', async () => {
  let writes = 0
  let saves = 0
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, 'same'),
    applyCellValue: async () => {
      writes += 1
      throw new OfficeWriteError('write_unknown', 'simulated lost reply')
    },
    saveDraft: async () => {
      saves += 1
    }
  })

  const result = await service.applyCellEdit(
    'run-write',
    { sheet: 'Sheet1', cell: 'A1', value: 'same', baseRevision: 0 },
    { operationId: 'no-change' }
  )

  assert.equal(result.reconciled, true)
  assert.equal(result.revision, 0)
  assert.equal(result.before, 'same')
  assert.equal(result.after, 'same')
  assert.equal(writes, 1)
  assert.equal(saves, 1)
})

function pendingLog(before: string | number | boolean | null = 'before'): OfficeOperationLogState {
  const operation = { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 }
  return {
    version: 2,
    contentRevision: 0,
    freezeState: 'unknown',
    operations: {
      recovered: {
        digest: officeOperationDigest(operation),
        status: 'in_flight',
        createdAt: '2026-10-05T00:00:00.000Z',
        operation,
        before
      }
    }
  }
}

test('reopening a draft automatically reconciles persisted in-flight evidence', async (t) => {
  await t.test('applied', async () => {
    let persisted = pendingLog()
    let writes = 0
    const service = await openBoundService({
      loadOperationLog: async () => structuredClone(persisted),
      persistOperationLog: async (_draftPath, state) => {
        persisted = structuredClone(state)
      },
      readRange: async (context) => cellResponse(context.revision, 'after'),
      applyCellValue: async () => {
        writes += 1
      }
    })

    assert.equal(persisted.contentRevision, 1)
    assert.equal(persisted.operations.recovered.receipt?.ok, true)
    assert.equal(writes, 0)
    assert.doesNotThrow(() => service.assertWritable('artifact-1'))
  })

  await t.test('not_applied', async () => {
    let persisted = pendingLog()
    let writes = 0
    const service = await openBoundService({
      loadOperationLog: async () => structuredClone(persisted),
      persistOperationLog: async (_draftPath, state) => {
        persisted = structuredClone(state)
      },
      readRange: async (context) => cellResponse(context.revision, 'before'),
      applyCellValue: async () => {
        writes += 1
      }
    })

    assert.equal(persisted.contentRevision, 0)
    assert.deepEqual(persisted.operations.recovered.receipt, {
      ok: false,
      error: { code: 'write_not_applied' }
    })
    assert.equal(writes, 0)
    assert.doesNotThrow(() => service.assertWritable('artifact-1'))
  })

  await t.test('indeterminate', async () => {
    let persisted = pendingLog()
    let writes = 0
    const service = await openBoundService({
      loadOperationLog: async () => structuredClone(persisted),
      persistOperationLog: async (_draftPath, state) => {
        persisted = structuredClone(state)
      },
      readRange: async (context) => cellResponse(context.revision, 'third'),
      applyCellValue: async () => {
        writes += 1
      }
    })

    assert.equal(persisted.lastReconcile?.conclusion, 'indeterminate')
    assert.equal(persisted.freezeState, 'unknown')
    assert.equal(writes, 0)
    assert.throws(() => service.assertWritable('artifact-1'), { code: 'document_frozen' })
  })
})

test('legacy v1 in-flight evidence stays indeterminate and a corrupt log is not auto-read', async () => {
  let reads = 0
  const legacy = await openBoundService({
    loadOperationLog: async () => ({
      version: 1,
      contentRevision: 0,
      freezeState: 'unknown',
      operations: {
        legacy: {
          digest: 'a'.repeat(64),
          status: 'in_flight',
          createdAt: '2026-10-05T00:00:00.000Z'
        }
      }
    }),
    readRange: async (context) => {
      reads += 1
      return cellResponse(context.revision, 'after')
    }
  })
  const legacyResult = await legacy.reconcile('artifact-1', 'session-1')
  assert.equal(legacyResult.conclusion, 'indeterminate')
  assert.equal(reads, 0)

  const corrupt = await openBoundService({
    loadOperationLog: async () => ({
      version: 2,
      contentRevision: 0,
      operations: {},
      freezeState: 'unknown',
      integrityError: 'operation_log_corrupt'
    }),
    readRange: async (context) => {
      reads += 1
      return cellResponse(context.revision, 'after')
    }
  })
  assert.equal(reads, 0)
  await assert.rejects(corrupt.reconcile('artifact-1', 'session-1'), {
    code: 'reconcile_failed'
  })
  assert.equal(reads, 0)
})

test('reconcile read failure or timeout stays indeterminate and keeps the document frozen', async (t) => {
  await t.test('read failure', async () => {
    let reads = 0
    const service = await openBoundService({
      readRange: async (context) => {
        reads += 1
        if (reads === 1) return cellResponse(context.revision, 'before')
        throw new Error('/private/workbook.xlsx missing sheet on port 42001')
      },
      applyCellValue: async () => {
        throw new OfficeWriteError('write_unknown', 'lost reply')
      }
    })

    await assert.rejects(
      service.applyCellEdit(
        'run-write',
        { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 },
        { operationId: 'read-failure' }
      ),
      { code: 'write_unknown' }
    )
    const result = await service.reconcile('artifact-1', 'session-1')
    assert.equal(result.conclusion, 'indeterminate')
    assert.doesNotMatch(result.message, /private|42001/u)
    assert.throws(() => service.assertWritable('artifact-1'), { code: 'document_frozen' })
  })

  await t.test('timeout', async () => {
    let reads = 0
    const service = await openBoundService({
      reconcileTimeoutMs: 5,
      readRange: async (context) => {
        reads += 1
        if (reads === 1) return cellResponse(context.revision, 'before')
        return new Promise<OfficeReadResult>(() => undefined)
      },
      applyCellValue: async () => {
        throw new OfficeWriteError('write_unknown', 'lost reply')
      }
    })

    await assert.rejects(
      service.applyCellEdit(
        'run-write',
        { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 },
        { operationId: 'read-timeout' }
      ),
      { code: 'write_unknown' }
    )
    assert.throws(() => service.assertWritable('artifact-1'), { code: 'document_frozen' })
  })
})

test('an applied reconciliation with save failure unfreezes writes but remains undeliverable', async () => {
  let current: string | number | boolean | null = 'before'
  let saves = 0
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      current = params.value
      throw new OfficeWriteError('write_unknown', 'lost reply')
    },
    saveDraft: async () => {
      saves += 1
      throw new Error('/private/save failed')
    }
  })
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 }

  await assert.rejects(
    service.applyCellEdit('run-write', params, { operationId: 'save-after-reconcile' }),
    (error) => {
      if (!(error instanceof OfficeWriteError) || error.code !== 'save_failed') return false
      const result = error.details?.result as { reconciled?: unknown; saved?: unknown } | undefined
      return result?.reconciled === true && result.saved === false
    }
  )
  assert.doesNotThrow(() => service.assertWritable('artifact-1'))
  assert.throws(() => service.assertDeliverable('artifact-1'), {
    code: 'document_not_deliverable'
  })
  assert.equal(saves, 1)
})

test('concurrent manual reconciliations serialize and replay one resolved conclusion', async () => {
  let current: string | number | boolean | null = 'before'
  let reads = 0
  let saves = 0
  const service = await openBoundService({
    readRange: async (context) => {
      reads += 1
      return cellResponse(context.revision, current)
    },
    applyCellValue: async () => {
      current = 'third'
      throw new OfficeWriteError('write_unknown', 'lost reply')
    },
    saveDraft: async () => {
      saves += 1
    }
  })
  await assert.rejects(
    service.applyCellEdit(
      'run-write',
      { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 },
      { operationId: 'concurrent-reconcile' }
    ),
    { code: 'write_unknown' }
  )
  current = 'after'
  const readsBeforeManual = reads

  const [first, second] = await Promise.all([
    service.reconcile('artifact-1', 'session-1'),
    service.reconcile('artifact-1', 'session-1')
  ])

  assert.equal(first.conclusion, 'applied')
  assert.equal(second.conclusion, 'applied')
  assert.equal(reads, readsBeforeManual + 1)
  assert.equal(saves, 1)
})

test('a frozen artifact does not block another artifact from reading, writing, or delivery', async () => {
  const values = new Map<string, string | number | boolean | null>([
    ['artifact-1', 'before-one'],
    ['artifact-2', 'before-two']
  ])
  let sequence = 0
  const service = new OfficeService(
    dependencies({
      prepareDraft: async (input) => {
        sequence += 1
        const artifactId = `artifact-${sequence}`
        return {
          artifactId,
          sessionId: input.sessionId,
          projectId: input.projectId,
          sourcePath: input.sourcePath,
          sourceHash: `hash-${sequence}`,
          draftPath: `/session/artifacts/office/${artifactId}/source.xlsx`
        }
      },
      startPreview: async (_binaryPath, artifact) => ({
        watchPid: 200 + sequence,
        watchPort: 31_000 + sequence,
        gatewayPort: 42_000 + sequence,
        previewUrl: `http://127.0.0.1:${42_000 + sequence}/${artifact.artifactId}`
      }),
      readRange: async (context) =>
        cellResponse(context.revision, values.get(context.artifactId) ?? null),
      applyCellValue: async (context, params) => {
        const artifactId = context.draftPath.includes('artifact-1') ? 'artifact-1' : 'artifact-2'
        if (artifactId === 'artifact-1') {
          values.set(artifactId, 'third')
          throw new OfficeWriteError('write_unknown', 'lost reply')
        }
        values.set(artifactId, params.value)
      }
    })
  )
  const first = await service.open(openRequest)
  const second = await service.open({ ...openRequest, sourcePath: '/project/second.xlsx' })
  assert.equal(first.state, 'ready')
  assert.equal(second.state, 'ready')
  if (first.state !== 'ready' || second.state !== 'ready') return
  service.bindRunTarget({
    runId: 'run-one',
    artifactId: first.document.artifactId,
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  service.bindRunTarget({
    runId: 'run-two',
    artifactId: second.document.artifactId,
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  await assert.rejects(
    service.applyCellEdit(
      'run-one',
      { sheet: 'Sheet1', cell: 'A1', value: 'expected-one', baseRevision: 0 },
      { operationId: 'freeze-one' }
    ),
    { code: 'write_unknown' }
  )
  const secondWrite = await service.applyCellEdit(
    'run-two',
    { sheet: 'Sheet1', cell: 'A1', value: 'after-two', baseRevision: 0 },
    { operationId: 'write-two' }
  )

  assert.equal((await service.readRange('run-one', { sheet: 'Sheet1', range: 'A1' })).revision, 0)
  assert.equal(secondWrite.revision, 1)
  assert.throws(() => service.assertWritable(first.document.artifactId), {
    code: 'document_frozen'
  })
  assert.doesNotThrow(() => service.assertWritable(second.document.artifactId))
  assert.doesNotThrow(() => service.assertDeliverable(second.document.artifactId))
})
