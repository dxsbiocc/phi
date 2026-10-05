import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import type { OfficeReadResult } from '../src/main/agent/office/office-read'
import type {
  OfficeCellValue,
  OfficeSetRangeOperation
} from '../src/main/agent/office/office-write'
import { OfficeWriteError } from '../src/main/agent/office/office-write'

const openRequest = {
  sessionId: 'session-1',
  projectId: 'project-1',
  sourcePath: '/project/source.xlsx',
  projectLocation: { kind: 'local' as const, path: '/project', realPath: '/project' },
  allowRoots: ['/project']
}

function rangeResponse(revision: number, values: readonly OfficeCellValue[]): OfficeReadResult {
  const refs = ['A1', 'B1', 'A2', 'B2']
  return {
    revision,
    sheet: 'Sheet1',
    range: 'A1:B2',
    cells: refs.map((ref, index) => {
      const value = values[index]!
      return {
        ref,
        value,
        valueType:
          typeof value === 'string' ? 'string' : typeof value === 'number' ? 'number' : 'boolean'
      }
    }),
    rowCount: 2,
    columnCount: 2,
    complete: true,
    truncated: false,
    limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
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
    readRange: async () => rangeResponse(0, ['old-a', 'old-b', 'old-c', 'old-d']),
    applyCellValue: async () => {
      throw new Error('single-cell writer must not run')
    },
    saveDraft: async () => undefined,
    armPreviewConfirmation: () => ({ promise: Promise.resolve(false), cancel: () => undefined }),
    loadOperationLog: async () => ({ version: 2, contentRevision: 0, operations: {} }),
    persistOperationLog: async () => undefined,
    ...overrides
  }
}

async function bindRangeService(service: OfficeService): Promise<void> {
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-range',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
}

test('applyRangeEdit performs one transaction and increments revision once', async () => {
  let current: readonly OfficeCellValue[] = ['old-a', 'old-b', 'old-c', 'old-d']
  let writes = 0
  let saves = 0
  const service = new OfficeService(
    dependencies({
      readRange: async (context) => rangeResponse(context.revision, current),
      applyWriteOperation: async (_context, operation) => {
        writes += 1
        const range = operation as OfficeSetRangeOperation
        current = range.values.flat()
      },
      saveDraft: async () => {
        saves += 1
      },
      armPreviewConfirmationSet: (_artifactId, sheet, cells) => {
        assert.equal(sheet, 'Sheet1')
        assert.deepEqual(cells, ['A1', 'B1', 'A2', 'B2'])
        return { promise: Promise.resolve(true), cancel: () => undefined }
      }
    })
  )
  await bindRangeService(service)

  const result = await service.applyRangeEdit(
    'run-range',
    {
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [
        ['new-a', 2],
        [true, 'new-d']
      ],
      baseRevision: 0
    },
    { operationId: 'range-operation-1' }
  )

  assert.equal(writes, 1)
  assert.equal(saves, 1)
  assert.equal(result.revision, 1)
  assert.equal(result.changedCells, 4)
  assert.equal(result.previewConfirmed, true)
  assert.deepEqual(current, ['new-a', 2, true, 'new-d'])
})

test('a proven range rollback does not freeze the document or increment revision', async () => {
  let current: readonly OfficeCellValue[] = ['old-a', 'old-b', 'old-c', 'old-d']
  let attempts = 0
  const service = new OfficeService(
    dependencies({
      readRange: async (context) => rangeResponse(context.revision, current),
      applyWriteOperation: async (_context, operation) => {
        attempts += 1
        if (attempts === 1) throw new OfficeWriteError('write_failed', 'atomic rollback')
        current = (operation as OfficeSetRangeOperation).values.flat()
      },
      armPreviewConfirmationSet: () => ({
        promise: Promise.resolve(true),
        cancel: () => undefined
      })
    })
  )
  await bindRangeService(service)
  const params = {
    sheet: 'Sheet1',
    range: 'A1:B2',
    values: [
      ['A', 'B'],
      ['C', 'D']
    ] as const,
    baseRevision: 0
  }

  await assert.rejects(
    service.applyRangeEdit('run-range', params, { operationId: 'rolled-back-range' }),
    { code: 'write_failed' }
  )
  assert.deepEqual(current, ['old-a', 'old-b', 'old-c', 'old-d'])
  const applied = await service.applyRangeEdit('run-range', params, {
    operationId: 'retry-after-rollback'
  })
  assert.equal(applied.revision, 1)
  assert.equal(attempts, 2)
})

test('an unknown applied range is reconciled without replaying the batch', async () => {
  let current: readonly OfficeCellValue[] = ['old-a', 'old-b', 'old-c', 'old-d']
  let writes = 0
  const service = new OfficeService(
    dependencies({
      readRange: async (context) => rangeResponse(context.revision, current),
      applyWriteOperation: async (_context, operation) => {
        writes += 1
        current = (operation as OfficeSetRangeOperation).values.flat()
        throw new OfficeWriteError('write_unknown', 'reply lost')
      },
      armPreviewConfirmationSet: () => ({
        promise: Promise.resolve(false),
        cancel: () => undefined
      })
    })
  )
  await bindRangeService(service)

  const result = await service.applyRangeEdit(
    'run-range',
    {
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [
        ['A', 'B'],
        ['C', 'D']
      ],
      baseRevision: 0
    },
    { operationId: 'lost-range-reply' }
  )

  assert.equal(result.reconciled, true)
  assert.equal(result.revision, 1)
  assert.equal(writes, 1)
})

test('an unknown range that never ran reconciles not_applied and unfreezes', async () => {
  const current: readonly OfficeCellValue[] = ['old-a', 'old-b', 'old-c', 'old-d']
  let writes = 0
  const service = new OfficeService(
    dependencies({
      readRange: async (context) => rangeResponse(context.revision, current),
      applyWriteOperation: async () => {
        writes += 1
        throw new OfficeWriteError('write_unknown', 'timed out before execution')
      },
      armPreviewConfirmationSet: () => ({
        promise: Promise.resolve(false),
        cancel: () => undefined
      })
    })
  )
  await bindRangeService(service)
  const params = {
    sheet: 'Sheet1',
    range: 'A1:B2',
    values: [
      ['A', 'B'],
      ['C', 'D']
    ] as const,
    baseRevision: 0
  }

  await assert.rejects(
    service.applyRangeEdit('run-range', params, { operationId: 'range-not-applied' }),
    { code: 'write_not_applied' }
  )
  assert.equal(writes, 1)
  service.assertWritable('artifact-1')
})

test('a mixed range after a lost reply stays indeterminate and frozen', async () => {
  let current: readonly OfficeCellValue[] = ['old-a', 'old-b', 'old-c', 'old-d']
  let writes = 0
  const service = new OfficeService(
    dependencies({
      readRange: async (context) => rangeResponse(context.revision, current),
      applyWriteOperation: async () => {
        writes += 1
        current = ['A', 'old-b', 'C', 'old-d']
        throw new OfficeWriteError('write_unknown', 'reply lost')
      },
      armPreviewConfirmationSet: () => ({
        promise: Promise.resolve(false),
        cancel: () => undefined
      })
    })
  )
  await bindRangeService(service)
  const params = {
    sheet: 'Sheet1',
    range: 'A1:B2',
    values: [
      ['A', 'B'],
      ['C', 'D']
    ] as const,
    baseRevision: 0
  }

  await assert.rejects(
    service.applyRangeEdit('run-range', params, { operationId: 'mixed-range' }),
    { code: 'write_unknown' }
  )
  await assert.rejects(
    service.applyRangeEdit('run-range', params, { operationId: 'blocked-range' }),
    { code: 'document_frozen' }
  )
  assert.equal(writes, 1)
})

test('cancelling set_range before the CLI performs no content read or write', async () => {
  let reads = 0
  let writes = 0
  const service = new OfficeService(
    dependencies({
      readRange: async () => {
        reads += 1
        return rangeResponse(0, ['old-a', 'old-b', 'old-c', 'old-d'])
      },
      applyWriteOperation: async () => {
        writes += 1
      }
    })
  )
  await bindRangeService(service)
  const controller = new AbortController()
  controller.abort()

  await assert.rejects(
    service.applyRangeEdit(
      'run-range',
      {
        sheet: 'Sheet1',
        range: 'A1:B2',
        values: [
          ['A', 'B'],
          ['C', 'D']
        ],
        baseRevision: 0
      },
      { operationId: 'cancelled-before-range', signal: controller.signal }
    ),
    { code: 'write_cancelled' }
  )
  assert.equal(reads, 0)
  assert.equal(writes, 0)
})

test('cancelling during set_range reconciles applied or not_applied without replay', async () => {
  for (const mode of ['applied', 'not_applied'] as const) {
    let current: readonly OfficeCellValue[] = ['old-a', 'old-b', 'old-c', 'old-d']
    let writes = 0
    const controller = new AbortController()
    const service = new OfficeService(
      dependencies({
        readRange: async (context) => rangeResponse(context.revision, current),
        applyWriteOperation: async (_context, operation) => {
          writes += 1
          if (mode === 'applied') {
            current = (operation as OfficeSetRangeOperation).values.flat()
          }
          controller.abort()
          throw new OfficeWriteError('write_unknown', 'cancelled during batch')
        },
        armPreviewConfirmationSet: () => ({
          promise: Promise.resolve(false),
          cancel: () => undefined
        })
      })
    )
    await bindRangeService(service)
    const applying = service.applyRangeEdit(
      'run-range',
      {
        sheet: 'Sheet1',
        range: 'A1:B2',
        values: [
          ['A', 'B'],
          ['C', 'D']
        ],
        baseRevision: 0
      },
      { operationId: `cancelled-during-${mode}`, signal: controller.signal }
    )
    if (mode === 'applied') {
      const result = await applying
      assert.equal(result.reconciled, true)
      assert.equal(result.revision, 1)
    } else {
      await assert.rejects(applying, { code: 'write_not_applied' })
      service.assertWritable('artifact-1')
    }
    assert.equal(writes, 1)
  }
})

test('set_range read-back follows cursors until every affected cell is verified', async () => {
  let current: readonly OfficeCellValue[] = ['old-a', 'old-b', 'old-c', 'old-d']
  let reads = 0
  const service = new OfficeService(
    dependencies({
      readRange: async (context, params) => {
        reads += 1
        const second = params.cursor === 'page-2'
        const refs = second ? ['A2', 'B2'] : ['A1', 'B1']
        const offset = second ? 2 : 0
        return {
          ...rangeResponse(context.revision, current),
          cells: refs.map((ref, index) => {
            const value = current[offset + index]!
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
          }),
          complete: second,
          truncated: !second,
          ...(second ? {} : { nextCursor: 'page-2' })
        }
      },
      applyWriteOperation: async (_context, operation) => {
        current = (operation as OfficeSetRangeOperation).values.flat()
      },
      armPreviewConfirmationSet: () => ({
        promise: Promise.resolve(true),
        cancel: () => undefined
      })
    })
  )
  await bindRangeService(service)

  const result = await service.applyRangeEdit(
    'run-range',
    {
      sheet: 'Sheet1',
      range: 'A1:B2',
      values: [
        ['A', 2],
        [true, 'D']
      ],
      baseRevision: 0
    },
    { operationId: 'paged-range' }
  )

  assert.equal(result.revision, 1)
  assert.equal(reads, 4)
})

test('set_range replays the compact receipt and binds idempotency to the full matrix', async () => {
  let current: readonly OfficeCellValue[] = ['old-a', 'old-b', 'old-c', 'old-d']
  let writes = 0
  const service = new OfficeService(
    dependencies({
      readRange: async (context) => rangeResponse(context.revision, current),
      applyWriteOperation: async (_context, operation) => {
        writes += 1
        current = (operation as OfficeSetRangeOperation).values.flat()
      },
      armPreviewConfirmationSet: () => ({
        promise: Promise.resolve(true),
        cancel: () => undefined
      })
    })
  )
  await bindRangeService(service)
  const params = {
    sheet: 'Sheet1',
    range: 'A1:B2',
    values: [
      ['A', 'B'],
      ['C', 'D']
    ] as const,
    baseRevision: 0
  }

  const first = await service.applyRangeEdit('run-range', params, {
    operationId: 'deduplicated-range'
  })
  const replay = await service.applyRangeEdit('run-range', params, {
    operationId: 'deduplicated-range'
  })
  assert.deepEqual(replay, { ...first, deduplicated: true })
  await assert.rejects(
    service.applyRangeEdit(
      'run-range',
      {
        ...params,
        values: [
          ['A', 'B'],
          ['C', 'changed']
        ]
      },
      { operationId: 'deduplicated-range' }
    ),
    { code: 'operation_conflict' }
  )
  assert.equal(writes, 1)
})

test('a completed range remains readable and deduplicatable after a later cancellation', async () => {
  let current: readonly OfficeCellValue[] = ['old-a', 'old-b', 'old-c', 'old-d']
  const service = new OfficeService(
    dependencies({
      readRange: async (context) => rangeResponse(context.revision, current),
      applyWriteOperation: async (_context, operation) => {
        current = (operation as OfficeSetRangeOperation).values.flat()
      },
      armPreviewConfirmationSet: () => ({
        promise: Promise.resolve(true),
        cancel: () => undefined
      })
    })
  )
  await bindRangeService(service)
  const firstParams = {
    sheet: 'Sheet1',
    range: 'A1:B2',
    values: [
      ['A', 'B'],
      ['C', 'D']
    ] as const,
    baseRevision: 0
  }
  const first = await service.applyRangeEdit('run-range', firstParams, {
    operationId: 'completed-before-cancel'
  })
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    service.applyRangeEdit(
      'run-range',
      {
        ...firstParams,
        values: [
          ['E', 'F'],
          ['G', 'H']
        ],
        baseRevision: 1
      },
      { operationId: 'cancelled-after-complete', signal: controller.signal }
    ),
    { code: 'write_cancelled' }
  )
  const read = await service.readRange('run-range', { sheet: 'Sheet1', range: 'A1:B2' })
  assert.equal(read.revision, 1)
  assert.deepEqual('cells' in read ? read.cells.map((cell) => cell.value) : [], [
    'A',
    'B',
    'C',
    'D'
  ])
  const replay = await service.applyRangeEdit('run-range', firstParams, {
    operationId: 'completed-before-cancel'
  })
  assert.deepEqual(replay, { ...first, deduplicated: true })
})
