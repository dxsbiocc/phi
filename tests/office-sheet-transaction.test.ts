import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import { addSheetSnapshot } from '../src/main/agent/office/office-sheet-contract'
import { addSheetWriteRequest } from '../src/main/agent/office/office-sheet-operation'
import type { OfficeOperationLogState } from '../src/main/agent/office/office-operation-log'
import { OfficeWriteError } from '../src/main/agent/office/office-write-contract'

const openRequest = {
  sessionId: 'session-1',
  projectId: 'project-1',
  sourcePath: '/project/source.xlsx',
  projectLocation: { kind: 'local' as const, path: '/project', realPath: '/project' },
  allowRoots: ['/project']
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
    readRange: async () => {
      throw new Error('cell reader must not run')
    },
    applyCellValue: async () => {
      throw new Error('cell writer must not run')
    },
    saveDraft: async () => undefined,
    armPreviewConfirmation: () => ({ promise: Promise.resolve(false), cancel: () => undefined }),
    loadOperationLog: async () => ({ version: 2, contentRevision: 0, operations: {} }),
    persistOperationLog: async () => undefined,
    ...overrides
  }
}

async function bind(service: OfficeService): Promise<void> {
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-sheet',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
}

test('add_sheet snapshots, prewrites, dispatches once, verifies, saves, and increments once', async () => {
  let sheetNames = ['Sheet1', '数据']
  let writes = 0
  let saves = 0
  const persisted: OfficeOperationLogState[] = []
  const service = new OfficeService(
    dependencies({
      readWorkbookSnapshot: async (_context, addedSheet) =>
        addSheetSnapshot(sheetNames, addedSheet === undefined ? undefined : true),
      applyWriteOperation: async (_context, operation) => {
        assert.deepEqual(operation, { type: 'add_sheet', name: '汇总表' })
        writes += 1
        sheetNames = [...sheetNames, operation.type === 'add_sheet' ? operation.name : 'unexpected']
      },
      saveDraft: async () => {
        saves += 1
      },
      armSheetPreviewConfirmation: (_artifactId, sheet) => {
        assert.equal(sheet, '汇总表')
        return { promise: Promise.resolve(true), cancel: () => undefined }
      },
      persistOperationLog: async (_path, state) => persisted.push(structuredClone(state))
    })
  )
  await bind(service)
  const request = addSheetWriteRequest({ name: '汇总表', baseRevision: 0 })

  const result = await service.applyWriteRequest('run-sheet', request, {
    operationId: 'add-sheet-success'
  })
  const replay = await service.applyWriteRequest('run-sheet', request, {
    operationId: 'add-sheet-success'
  })

  assert.deepEqual(result, {
    applied: true,
    saved: true,
    revision: 1,
    sheet: '汇总表',
    path: '/汇总表',
    sheetCount: 3,
    sheetNames: ['Sheet1', '数据', '汇总表'],
    previewConfirmed: true
  })
  assert.equal(replay.deduplicated, true)
  assert.equal(writes, 1)
  assert.equal(saves, 1)
  await assert.rejects(
    service.applyWriteRequest(
      'run-sheet',
      addSheetWriteRequest({ name: '另一张表', baseRevision: 0 }),
      { operationId: 'add-sheet-success' }
    ),
    { code: 'operation_conflict' }
  )
  assert.equal(writes, 1)
  assert.deepEqual(
    persisted.find((state) => state.operations['add-sheet-success']?.before)?.operations[
      'add-sheet-success'
    ]?.before,
    { sheetNames: ['Sheet1', '数据'] }
  )
})

test('add_sheet rejects duplicate and sheet limit before write or revision growth', async (t) => {
  for (const fixture of [
    { names: ['Sheet1', '汇总表'], code: 'sheet_exists' },
    { names: Array.from({ length: 20 }, (_, index) => `S${index + 1}`), code: 'too_many_sheets' }
  ] as const) {
    await t.test(fixture.code, async () => {
      let writes = 0
      const service = new OfficeService(
        dependencies({
          readWorkbookSnapshot: async () => addSheetSnapshot(fixture.names),
          applyWriteOperation: async () => {
            writes += 1
          }
        })
      )
      await bind(service)
      const request = addSheetWriteRequest({ name: '汇总表', baseRevision: 0 })
      const operationId = `add-${fixture.code}`
      await assert.rejects(service.applyWriteRequest('run-sheet', request, { operationId }), {
        code: fixture.code
      })
      await assert.rejects(
        service.applyWriteRequest('run-sheet', request, { operationId }),
        (error: unknown) =>
          error instanceof OfficeWriteError &&
          error.code === fixture.code &&
          error.details?.deduplicated === true &&
          Array.isArray(error.details.sheetNames)
      )
      assert.equal(writes, 0)
    })
  }
})

test('add_sheet verification freezes on reordered, extra, duplicate, or nonempty readback', async (t) => {
  for (const current of [
    addSheetSnapshot(['汇总表', 'Sheet1'], true),
    addSheetSnapshot(['Sheet1', '汇总表', '其它'], true),
    addSheetSnapshot(['Sheet1', '汇总表', '汇总表'], true),
    addSheetSnapshot(['Sheet1', '汇总表'], false)
  ]) {
    await t.test(JSON.stringify(current), async () => {
      let reads = 0
      const service = new OfficeService(
        dependencies({
          readWorkbookSnapshot: async () => {
            reads += 1
            return reads === 1 ? addSheetSnapshot(['Sheet1']) : current
          },
          applyWriteOperation: async () => undefined
        })
      )
      await bind(service)
      await assert.rejects(
        service.applyWriteRequest(
          'run-sheet',
          addSheetWriteRequest({ name: '汇总表', baseRevision: 0 }),
          { operationId: `invalid-readback-${reads}-${current.sheetNames?.length}` }
        ),
        { code: 'write_unknown' }
      )
      assert.throws(() => service.assertWritable('artifact-1'), { code: 'document_frozen' })
    })
  }
})

test('lost add_sheet replies reconcile applied and not_applied without replay', async (t) => {
  for (const mode of ['applied', 'not_applied'] as const) {
    await t.test(mode, async () => {
      let sheetNames = ['Sheet1']
      let writes = 0
      const service = new OfficeService(
        dependencies({
          readWorkbookSnapshot: async (_context, addedSheet) =>
            addSheetSnapshot(
              sheetNames,
              addedSheet === undefined ? undefined : sheetNames.includes(addedSheet)
            ),
          applyWriteOperation: async (_context, operation) => {
            writes += 1
            if (mode === 'applied' && operation.type === 'add_sheet') {
              sheetNames = [...sheetNames, operation.name]
            }
            throw new OfficeWriteError('write_unknown', 'lost reply')
          }
        })
      )
      await bind(service)
      const promise = service.applyWriteRequest(
        'run-sheet',
        addSheetWriteRequest({ name: '汇总表', baseRevision: 0 }),
        { operationId: `lost-sheet-${mode}` }
      )
      if (mode === 'applied') {
        const result = await promise
        assert.equal(result.revision, 1)
        assert.equal(result.reconciled, true)
      } else {
        await assert.rejects(promise, { code: 'write_not_applied' })
      }
      assert.equal(writes, 1)
    })
  }
})

test('add_sheet cancellation is safe before dispatch, during dispatch, and during preview', async (t) => {
  await t.test('before dispatch', async () => {
    let reads = 0
    let writes = 0
    const controller = new AbortController()
    controller.abort()
    const service = new OfficeService(
      dependencies({
        readWorkbookSnapshot: async () => {
          reads += 1
          return addSheetSnapshot(['Sheet1'])
        },
        applyWriteOperation: async () => {
          writes += 1
        }
      })
    )
    await bind(service)
    await assert.rejects(
      service.applyWriteRequest(
        'run-sheet',
        addSheetWriteRequest({ name: '汇总表', baseRevision: 0 }),
        { operationId: 'sheet-cancel-before', signal: controller.signal }
      ),
      { code: 'write_cancelled' }
    )
    assert.equal(reads, 0)
    assert.equal(writes, 0)
  })

  await t.test('during dispatch', async () => {
    let sheetNames = ['Sheet1']
    const controller = new AbortController()
    const service = new OfficeService(
      dependencies({
        readWorkbookSnapshot: async (_context, addedSheet) =>
          addSheetSnapshot(
            sheetNames,
            addedSheet === undefined ? undefined : sheetNames.includes(addedSheet)
          ),
        applyWriteOperation: async (_context, operation) => {
          if (operation.type === 'add_sheet') sheetNames = [...sheetNames, operation.name]
          controller.abort()
          throw new OfficeWriteError('write_unknown', 'cancelled after dispatch')
        }
      })
    )
    await bind(service)
    const result = await service.applyWriteRequest(
      'run-sheet',
      addSheetWriteRequest({ name: '汇总表', baseRevision: 0 }),
      { operationId: 'sheet-cancel-during', signal: controller.signal }
    )
    assert.equal(result.reconciled, true)
    assert.equal(result.revision, 1)
  })

  await t.test('while waiting for preview', async () => {
    let sheetNames = ['Sheet1']
    const service = new OfficeService(
      dependencies({
        readWorkbookSnapshot: async (_context, addedSheet) =>
          addSheetSnapshot(sheetNames, addedSheet === undefined ? undefined : true),
        applyWriteOperation: async (_context, operation) => {
          if (operation.type === 'add_sheet') sheetNames = [...sheetNames, operation.name]
        },
        armSheetPreviewConfirmation: () => ({
          promise: Promise.reject(new Error('preview closed')),
          cancel: () => undefined
        })
      })
    )
    await bind(service)
    const result = await service.applyWriteRequest(
      'run-sheet',
      addSheetWriteRequest({ name: '汇总表', baseRevision: 0 }),
      { operationId: 'sheet-cancel-preview' }
    )
    assert.equal(result.previewConfirmed, false)
    assert.deepEqual(result.warnings, ['preview_not_confirmed'])
  })
})

test('stale add_sheet revision is rejected without creating a sheet', async () => {
  let sheetNames = ['Sheet1']
  let writes = 0
  const service = new OfficeService(
    dependencies({
      readWorkbookSnapshot: async (_context, addedSheet) =>
        addSheetSnapshot(sheetNames, addedSheet === undefined ? undefined : true),
      applyWriteOperation: async (_context, operation) => {
        writes += 1
        if (operation.type === 'add_sheet') sheetNames = [...sheetNames, operation.name]
      }
    })
  )
  await bind(service)
  await service.applyWriteRequest(
    'run-sheet',
    addSheetWriteRequest({ name: '数据', baseRevision: 0 }),
    { operationId: 'sheet-revision-first' }
  )
  await assert.rejects(
    service.applyWriteRequest(
      'run-sheet',
      addSheetWriteRequest({ name: '汇总表', baseRevision: 0 }),
      { operationId: 'sheet-revision-stale' }
    ),
    { code: 'revision_conflict' }
  )
  assert.equal(writes, 1)
  assert.deepEqual(sheetNames, ['Sheet1', '数据'])
})

test('add_sheet save failure preserves the applied result without replaying creation', async () => {
  let sheetNames = ['Sheet1']
  let writes = 0
  const service = new OfficeService(
    dependencies({
      readWorkbookSnapshot: async (_context, addedSheet) =>
        addSheetSnapshot(sheetNames, addedSheet === undefined ? undefined : true),
      applyWriteOperation: async (_context, operation) => {
        writes += 1
        if (operation.type === 'add_sheet') sheetNames = [...sheetNames, operation.name]
      },
      saveDraft: async () => {
        throw new Error('/private/secret.xlsx')
      }
    })
  )
  await bind(service)
  const request = addSheetWriteRequest({ name: '汇总表', baseRevision: 0 })
  const options = { operationId: 'sheet-save-failed' }

  for (const deduplicated of [false, true]) {
    await assert.rejects(
      service.applyWriteRequest('run-sheet', request, options),
      (error: unknown) =>
        error instanceof OfficeWriteError &&
        error.code === 'save_failed' &&
        error.details?.deduplicated === (deduplicated || undefined) &&
        (error.details.result as { path?: unknown } | undefined)?.path === '/汇总表'
    )
  }
  assert.equal(writes, 1)
  assert.deepEqual(sheetNames, ['Sheet1', '汇总表'])
})
