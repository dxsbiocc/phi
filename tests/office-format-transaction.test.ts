import assert from 'node:assert/strict'
import test from 'node:test'

import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import type { OfficeReadResult } from '../src/main/agent/office/office-read'
import {
  OfficeWriteError,
  formatRangeWriteRequest,
  type OfficeFormatRangeOperation,
  type OfficeRangeFormat
} from '../src/main/agent/office/office-write'
import type { OfficeOperationLogState } from '../src/main/agent/office/office-operation-log'

const openRequest = {
  sessionId: 'session-1',
  projectId: 'project-1',
  sourcePath: '/project/source.xlsx',
  projectLocation: { kind: 'local' as const, path: '/project', realPath: '/project' },
  allowRoots: ['/project']
}

const refs = ['A1', 'B1', 'A2', 'B2'] as const
const values = ['Title', 12.345, 13.345, null] as const

function rangeResponse(
  revision: number,
  formats: readonly OfficeRangeFormat[],
  changedValue?: number
): OfficeReadResult {
  return {
    revision,
    sheet: 'Sheet1',
    range: 'A1:B2',
    cells: refs.map((ref, index) => ({
      ref,
      value: index === 1 && changedValue !== undefined ? changedValue : values[index]!,
      valueType: index === 0 ? 'string' : index === 3 ? 'empty' : 'number',
      ...(index === 2 ? { formula: '=SUM(B1,1)', evaluated: true } : {}),
      format: formats[index]
    })),
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
    readRange: async () =>
      rangeResponse(
        0,
        Array.from({ length: 4 }, () => ({}))
      ),
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

async function bind(service: OfficeService): Promise<void> {
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-format',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
}

const requested = Object.freeze({
  bold: true,
  fill: '#FFEEAA',
  horizontalAlign: 'center' as const,
  numberFormat: '0.00'
})

test('format_range writes once, preserves data, logs relevant before formats, and increments once', async () => {
  let formats: readonly OfficeRangeFormat[] = Array.from({ length: 4 }, () => ({}))
  let writes = 0
  let saves = 0
  const persisted: OfficeOperationLogState[] = []
  const service = new OfficeService(
    dependencies({
      readRange: async (context) => rangeResponse(context.revision, formats),
      applyWriteOperation: async (_context, operation) => {
        writes += 1
        assert.equal(operation.type, 'format_range')
        formats = Array.from({ length: 4 }, () => requested)
      },
      saveDraft: async () => {
        saves += 1
      },
      persistOperationLog: async (_path, state) => {
        persisted.push(structuredClone(state))
      },
      armPreviewConfirmationSet: (_artifactId, sheet, cells) => {
        assert.equal(sheet, 'Sheet1')
        assert.deepEqual(cells, refs)
        return { promise: Promise.resolve(true), cancel: () => undefined }
      }
    })
  )
  await bind(service)
  const request = formatRangeWriteRequest({
    sheet: 'Sheet1',
    range: 'A1:B2',
    format: requested,
    baseRevision: 0
  })

  const result = await service.applyWriteRequest('run-format', request, {
    operationId: 'format-success'
  })

  assert.equal(writes, 1)
  assert.equal(saves, 1)
  assert.equal(result.revision, 1)
  assert.equal('changedCells' in result && result.changedCells, 4)
  assert.equal('appliedFormat' in result, true)
  const replay = await service.applyWriteRequest('run-format', request, {
    operationId: 'format-success'
  })
  assert.equal(replay.deduplicated, true)
  assert.equal(replay.revision, 1)
  assert.equal(writes, 1)
  const prewrite = persisted.find(
    (state) => state.operations['format-success']?.before !== undefined
  )?.operations['format-success']
  assert.ok(prewrite)
  assert.deepEqual((prewrite.before as Array<{ format: unknown }>)[0]?.format, {
    bold: false,
    fill: null,
    horizontalAlign: null,
    numberFormat: 'General'
  })
  assert.equal(JSON.stringify(prewrite.before).includes('font'), false)
})

test('format_range never reports success when formatting mismatches or data changes', async (t) => {
  for (const mode of ['format_mismatch', 'data_changed'] as const) {
    await t.test(mode, async () => {
      let formats: readonly OfficeRangeFormat[] = Array.from({ length: 4 }, () => ({}))
      let changedValue: number | undefined
      const service = new OfficeService(
        dependencies({
          readRange: async (context) => rangeResponse(context.revision, formats, changedValue),
          applyWriteOperation: async () => {
            formats = Array.from({ length: 4 }, (_, index) =>
              mode === 'format_mismatch' && index === 3 ? {} : requested
            )
            if (mode === 'data_changed') changedValue = 99
          },
          armPreviewConfirmationSet: () => ({
            promise: Promise.resolve(false),
            cancel: () => undefined
          })
        })
      )
      await bind(service)

      await assert.rejects(
        service.applyWriteRequest(
          'run-format',
          formatRangeWriteRequest({
            sheet: 'Sheet1',
            range: 'A1:B2',
            format: requested,
            baseRevision: 0
          }),
          { operationId: `format-${mode}` }
        ),
        { code: 'write_unknown' }
      )
      assert.throws(() => service.assertWritable('artifact-1'), { code: 'document_frozen' })
    })
  }
})

test('lost format_range replies reconcile applied and not_applied without replay', async (t) => {
  for (const mode of ['applied', 'not_applied'] as const) {
    await t.test(mode, async () => {
      let formats: readonly OfficeRangeFormat[] = Array.from({ length: 4 }, () => ({}))
      let writes = 0
      const service = new OfficeService(
        dependencies({
          readRange: async (context) => rangeResponse(context.revision, formats),
          applyWriteOperation: async (_context, operation) => {
            writes += 1
            assert.equal((operation as OfficeFormatRangeOperation).type, 'format_range')
            if (mode === 'applied') formats = Array.from({ length: 4 }, () => requested)
            throw new OfficeWriteError('write_unknown', 'reply lost')
          },
          armPreviewConfirmationSet: () => ({
            promise: Promise.resolve(false),
            cancel: () => undefined
          })
        })
      )
      await bind(service)
      const promise = service.applyWriteRequest(
        'run-format',
        formatRangeWriteRequest({
          sheet: 'Sheet1',
          range: 'A1:B2',
          format: requested,
          baseRevision: 0
        }),
        { operationId: `format-lost-${mode}` }
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

test('format_range cancellation is safe before, during, and after dispatch', async (t) => {
  await t.test('before dispatch', async () => {
    let reads = 0
    let writes = 0
    const service = new OfficeService(
      dependencies({
        readRange: async () => {
          reads += 1
          return rangeResponse(
            0,
            Array.from({ length: 4 }, () => ({}))
          )
        },
        applyWriteOperation: async () => {
          writes += 1
        }
      })
    )
    await bind(service)
    const controller = new AbortController()
    controller.abort()
    await assert.rejects(
      service.applyWriteRequest(
        'run-format',
        formatRangeWriteRequest({
          sheet: 'Sheet1',
          range: 'A1:B2',
          format: requested,
          baseRevision: 0
        }),
        { operationId: 'format-cancel-before', signal: controller.signal }
      ),
      { code: 'write_cancelled' }
    )
    assert.equal(reads, 0)
    assert.equal(writes, 0)
  })

  await t.test('during dispatch', async () => {
    let formats: readonly OfficeRangeFormat[] = Array.from({ length: 4 }, () => ({}))
    let writes = 0
    const controller = new AbortController()
    const service = new OfficeService(
      dependencies({
        readRange: async (context) => rangeResponse(context.revision, formats),
        applyWriteOperation: async () => {
          writes += 1
          formats = Array.from({ length: 4 }, () => requested)
          controller.abort()
          throw new OfficeWriteError('write_unknown', 'cancelled during batch')
        }
      })
    )
    await bind(service)
    const result = await service.applyWriteRequest(
      'run-format',
      formatRangeWriteRequest({
        sheet: 'Sheet1',
        range: 'A1:B2',
        format: requested,
        baseRevision: 0
      }),
      { operationId: 'format-cancel-during', signal: controller.signal }
    )
    assert.equal(result.reconciled, true)
    assert.equal(writes, 1)
  })

  await t.test('while waiting for preview', async () => {
    let formats: readonly OfficeRangeFormat[] = Array.from({ length: 4 }, () => ({}))
    const service = new OfficeService(
      dependencies({
        readRange: async (context) => rangeResponse(context.revision, formats),
        applyWriteOperation: async () => {
          formats = Array.from({ length: 4 }, () => requested)
        },
        armPreviewConfirmationSet: () => ({
          promise: Promise.reject(new Error('preview cancelled')),
          cancel: () => undefined
        })
      })
    )
    await bind(service)
    const result = await service.applyWriteRequest(
      'run-format',
      formatRangeWriteRequest({
        sheet: 'Sheet1',
        range: 'A1:B2',
        format: requested,
        baseRevision: 0
      }),
      { operationId: 'format-cancel-preview' }
    )
    assert.equal(result.previewConfirmed, false)
    assert.deepEqual(result.warnings, ['preview_not_confirmed'])
  })
})
