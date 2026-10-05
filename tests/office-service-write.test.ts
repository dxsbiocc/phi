import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import { OfficeWriteError } from '../src/main/agent/office/office-write'
import type { OfficeReadResult } from '../src/main/agent/office/office-read'
import type {
  OfficeCellEditOptions,
  OfficeCellEditParams,
  OfficeCellEditResult
} from '../src/main/agent/office/office-write-contract'
import { officeOperationDigest } from '../src/main/agent/office/office-operation-log'

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
    prepareDraft: async (input) => {
      const kind = input.sourcePath.toLowerCase().endsWith('.pptx')
        ? ('pptx' as const)
        : input.sourcePath.toLowerCase().endsWith('.docx')
          ? ('docx' as const)
          : ('xlsx' as const)
      return {
        artifactId: 'artifact-1',
        sessionId: input.sessionId,
        projectId: input.projectId,
        kind,
        sourcePath: input.sourcePath,
        sourceHash: 'hash',
        draftPath: `/sessions/session-1/artifacts/office/artifact-1/source.${kind}`
      }
    },
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
    armPreviewConfirmation: () => ({
      promise: Promise.resolve(false),
      cancel: () => undefined
    }),
    loadOperationLog: async () => ({ version: 1, contentRevision: 0, operations: {} }),
    persistOperationLog: async () => undefined,
    ...overrides
  }
}

const openRequest = {
  sessionId: 'session-1',
  projectId: 'project-1',
  sourcePath: '/project/source.xlsx',
  projectLocation: { kind: 'local' as const, path: '/project', realPath: '/project' },
  allowRoots: ['/project']
}

async function openBoundService(
  overrides: Partial<OfficeServiceDependencies>,
  runId = 'run-write'
): Promise<OfficeService> {
  const service = new OfficeService(dependencies(overrides))
  await service.open(openRequest)
  service.bindRunTarget({
    runId,
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  return service
}

function cellResponse(revision: number, value: string | number | boolean | null): OfficeReadResult {
  return {
    revision,
    sheet: 'Sheet1',
    range: 'A1',
    cells: [
      { ref: 'A1', value, valueType: value === null ? ('empty' as const) : ('string' as const) }
    ],
    rowCount: 1,
    columnCount: 1,
    complete: true as const,
    truncated: false as const,
    limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
  }
}

let operationSequence = 0

function applyCellEdit(
  service: OfficeService,
  runId: string,
  params: OfficeCellEditParams,
  options: OfficeCellEditOptions = {}
): Promise<OfficeCellEditResult> {
  operationSequence += 1
  return service.applyCellEdit(runId, params, {
    operationId: `office-write-test-${operationSequence}`,
    ...options
  })
}

async function assertCleanupAbortsInFlightWrite(
  cleanup: (service: OfficeService) => Promise<unknown>
): Promise<void> {
  let current: string | number | boolean | null = 'before'
  let observedSignal: AbortSignal | undefined
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (context, params) => {
      observedSignal = context.signal
      markStarted()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          current = params.value
          resolve()
        }, 20)
        context.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          },
          { once: true }
        )
      })
    }
  })
  const applying = applyCellEdit(service, 'run-write', {
    sheet: 'Sheet1',
    cell: 'A1',
    value: 'ghost',
    baseRevision: 0
  })
  await started
  const cleaning = cleanup(service)

  await assert.rejects(applying, { code: 'reconcile_failed' })
  await cleaning
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.equal(observedSignal?.aborted, true)
  assert.equal(current, 'before')
}

test('applyCellEdit rejects formula text before reading or writing the draft', async () => {
  const service = new OfficeService(dependencies())
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  await assert.rejects(
    applyCellEdit(service, 'run-1', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: '=SUM(A1:A2)',
      baseRevision: 0
    }),
    { code: 'formula_not_supported' }
  )
})

test('XLSX operations reject a DOCX target before reading or writing content', async () => {
  let reads = 0
  let writes = 0
  const service = new OfficeService(
    dependencies({
      readRange: async () => {
        reads += 1
        throw new Error('must not read')
      },
      applyCellValue: async () => {
        writes += 1
      }
    })
  )
  await service.open({ ...openRequest, sourcePath: '/project/source.docx' })
  service.bindRunTarget({
    runId: 'run-docx',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  const expected = {
    code: 'operation_not_supported_for_kind',
    message: '该写入操作不适用于当前文档类型'
  }

  await assert.rejects(
    service.describeCellEdit('run-docx', { sheet: 'Sheet1', cell: 'A1', value: 'x' }),
    expected
  )
  await assert.rejects(
    applyCellEdit(service, 'run-docx', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: 'x',
      baseRevision: 0
    }),
    expected
  )
  assert.equal(reads, 0)
  assert.equal(writes, 0)
})

test('spreadsheet writes reject a PPTX target before content access', async () => {
  let reads = 0
  let writes = 0
  const service = new OfficeService(
    dependencies({
      readRange: async () => {
        reads += 1
        throw new Error('must not read')
      },
      applyCellValue: async () => {
        writes += 1
      }
    })
  )
  await service.open({ ...openRequest, sourcePath: '/project/source.pptx' })
  assert.equal(service.humanEditAccess('artifact-1'), 'read_only')
  await assert.rejects(
    service.applyHumanCellEdit(
      'artifact-1',
      { sheet: 'Sheet1', cell: 'A1', text: 'x' },
      { operationId: 'human-pptx' }
    ),
    {
      code: 'unsupported_document_kind',
      message: '当前关联的是 PowerPoint 演示文稿，暂不支持在预览中人工编辑幻灯片'
    }
  )
  service.bindRunTarget({
    runId: 'run-pptx',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  const expected = {
    code: 'operation_not_supported_for_kind',
    message: '该写入操作不适用于当前文档类型'
  }

  await assert.rejects(
    service.describeCellEdit('run-pptx', { sheet: 'Sheet1', cell: 'A1', value: 'x' }),
    expected
  )
  await assert.rejects(
    applyCellEdit(service, 'run-pptx', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: 'x',
      baseRevision: 0
    }),
    expected
  )
  assert.equal(reads, 0)
  assert.equal(writes, 0)
})

test('applyCellEdit requires a host-provided operation id before document access', async () => {
  let reads = 0
  let writes = 0
  const service = await openBoundService({
    readRange: async (context) => {
      reads += 1
      return cellResponse(context.revision, 'before')
    },
    applyCellValue: async () => {
      writes += 1
    }
  })

  await assert.rejects(
    service.applyCellEdit('run-write', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: 'never',
      baseRevision: 0
    }),
    { code: 'missing_operation_id' }
  )
  assert.equal(reads, 0)
  assert.equal(writes, 0)
})

test('describeCellEdit reads one cell without changing the document revision', async () => {
  const service = new OfficeService(
    dependencies({
      readRange: async (context, params) => {
        assert.equal(context.revision, 0)
        assert.deepEqual(params, { sheet: 'Sheet1', range: 'A1' })
        return {
          revision: 0,
          sheet: 'Sheet1',
          range: 'A1',
          cells: [{ ref: 'A1', value: '旧值', valueType: 'string' }],
          rowCount: 1,
          columnCount: 1,
          complete: true,
          truncated: false,
          limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
        }
      }
    })
  )
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-describe',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  assert.deepEqual(
    await service.describeCellEdit('run-describe', {
      sheet: 'Sheet1',
      cell: 'a1',
      value: '实验编号'
    }),
    {
      documentName: 'source.xlsx',
      sheet: 'Sheet1',
      cell: 'A1',
      before: '旧值',
      after: '实验编号',
      revision: 0
    }
  )
})

test('applyCellEdit verifies one value, saves it, confirms preview, and increments revision', async () => {
  let currentValue: string | number | boolean | null = '旧值'
  let saves = 0
  const service = new OfficeService(
    dependencies({
      readRange: async (context, params) => ({
        revision: context.revision,
        sheet: params.sheet!,
        range: params.range!,
        cells: [{ ref: params.range!, value: currentValue, valueType: 'string' }],
        rowCount: 1,
        columnCount: 1,
        complete: true,
        truncated: false,
        limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
      }),
      applyCellValue: async (_context, params) => {
        currentValue = params.value
      },
      saveDraft: async () => {
        saves += 1
      },
      armPreviewConfirmation: (_artifactId, sheet, cell) => {
        assert.deepEqual({ sheet, cell }, { sheet: 'Sheet1', cell: 'A1' })
        return { promise: Promise.resolve(true), cancel: () => undefined }
      }
    })
  )
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-apply',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  assert.deepEqual(
    await applyCellEdit(service, 'run-apply', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: '实验编号',
      baseRevision: 0
    }),
    {
      sheet: 'Sheet1',
      cell: 'A1',
      before: '旧值',
      after: '实验编号',
      revision: 1,
      applied: true,
      saved: true,
      previewConfirmed: true
    }
  )
  assert.equal(saves, 1)
  assert.equal(
    (
      await service.describeCellEdit('run-apply', {
        sheet: 'Sheet1',
        cell: 'A1',
        value: '下一值'
      })
    ).revision,
    1
  )
})

test('only a first saved preview-confirmed Agent write publishes an AI highlight', async () => {
  let current: string | number | boolean | null = 'before'
  const published: unknown[] = []
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      current = params.value
    },
    armPreviewConfirmation: () => ({
      promise: Promise.resolve(true),
      cancel: () => undefined
    }),
    publishConfirmedWrite: (artifactId, operation) => {
      published.push({ artifactId, operation })
    }
  })
  const request = {
    sheet: 'Sheet1',
    cell: 'A1',
    value: 'after',
    baseRevision: 0
  }
  const options = { operationId: 'highlight-once' }

  const first = await service.applyCellEdit('run-write', request, options)
  const duplicate = await service.applyCellEdit('run-write', request, options)
  await service.applyHumanCellEdit(
    'artifact-1',
    { sheet: 'Sheet1', cell: 'A1', text: 'human' },
    { operationId: 'human-no-highlight' }
  )

  assert.equal(first.previewConfirmed, true)
  assert.equal(duplicate.deduplicated, true)
  assert.deepEqual(published, [
    {
      artifactId: 'artifact-1',
      operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: 'after' }
    }
  ])
})

test('preview timeout and save failure never publish an AI highlight', async () => {
  for (const scenario of ['preview-timeout', 'save-failure'] as const) {
    let current: string | number | boolean | null = 'before'
    const published: unknown[] = []
    const service = await openBoundService({
      readRange: async (context) => cellResponse(context.revision, current),
      applyCellValue: async (_context, params) => {
        current = params.value
      },
      armPreviewConfirmation: () => ({
        promise: Promise.resolve(scenario !== 'preview-timeout'),
        cancel: () => undefined
      }),
      saveDraft: async () => {
        if (scenario === 'save-failure') throw new Error('save failed')
      },
      publishConfirmedWrite: (artifactId, operation) => {
        published.push({ artifactId, operation })
      }
    })
    const applying = service.applyCellEdit(
      'run-write',
      { sheet: 'Sheet1', cell: 'A1', value: scenario, baseRevision: 0 },
      { operationId: `no-highlight-${scenario}` }
    )

    if (scenario === 'save-failure') await assert.rejects(applying, { code: 'save_failed' })
    else assert.equal((await applying).previewConfirmed, false)
    assert.deepEqual(published, [])
  }
})

test('a preview decoration failure cannot change a confirmed write receipt', async () => {
  let current: string | number | boolean | null = 'before'
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      current = params.value
    },
    armPreviewConfirmation: () => ({ promise: Promise.resolve(true), cancel: () => undefined }),
    publishConfirmedWrite: () => {
      throw new Error('preview subscriber disappeared')
    }
  })

  const result = await service.applyCellEdit(
    'run-write',
    { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 },
    { operationId: 'highlight-publish-failure' }
  )

  assert.equal(result.applied, true)
  assert.equal(result.saved, true)
  assert.equal(result.previewConfirmed, true)
})

test('same operation id and payload returns the original receipt before reauthorizing', async () => {
  let current: string | number | boolean | null = 'before'
  let writes = 0
  let authorizations = 0
  let confirmations = 0
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      writes += 1
      current = params.value
    },
    armPreviewConfirmation: () => {
      confirmations += 1
      return { promise: Promise.resolve(true), cancel: () => undefined }
    }
  })
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 }
  const options = {
    operationId: 'same-operation',
    authorize: () => {
      authorizations += 1
      return true
    }
  }

  const first = await service.applyCellEdit('run-write', params, options)
  assert.equal(
    await service.shouldBypassCellEditApproval('run-write', params, options.operationId),
    true
  )
  const duplicate = await service.applyCellEdit('run-write', params, options)

  assert.deepEqual(duplicate, { ...first, deduplicated: true })
  assert.equal(writes, 1)
  assert.equal(authorizations, 1)
  assert.equal(confirmations, 1)
})

test('same operation id with a different payload is rejected without consuming authorization', async () => {
  let current: string | number | boolean | null = 'before'
  let writes = 0
  let authorizations = 0
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      writes += 1
      current = params.value
    }
  })
  const options = {
    operationId: 'conflicting-operation',
    authorize: () => {
      authorizations += 1
      return true
    }
  }
  await service.applyCellEdit(
    'run-write',
    { sheet: 'Sheet1', cell: 'A1', value: 'first', baseRevision: 0 },
    options
  )

  await assert.rejects(
    service.applyCellEdit(
      'run-write',
      { sheet: 'Sheet1', cell: 'A1', value: 'different', baseRevision: 0 },
      options
    ),
    { code: 'operation_conflict' }
  )
  assert.equal(writes, 1)
  assert.equal(authorizations, 1)
})

test('concurrent duplicates share one queued write transaction', async () => {
  let current: string | number | boolean | null = 'before'
  let writes = 0
  let authorizations = 0
  let releaseWrite!: () => void
  const blocked = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      writes += 1
      markStarted()
      await blocked
      current = params.value
    }
  })
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 }
  const options = {
    operationId: 'concurrent-operation',
    authorize: () => {
      authorizations += 1
      return true
    }
  }

  const first = service.applyCellEdit('run-write', params, options)
  await started
  const duplicate = service.applyCellEdit('run-write', params, options)
  releaseWrite()
  const [firstReceipt, duplicateReceipt] = await Promise.all([first, duplicate])

  assert.deepEqual(duplicateReceipt, { ...firstReceipt, deduplicated: true })
  assert.equal(writes, 1)
  assert.equal(authorizations, 1)
})

test('the same operation id is independent across artifacts', async () => {
  const values = new Map<string, string | number | boolean | null>()
  let writes = 0
  const service = new OfficeService(
    dependencies({
      prepareDraft: async (input) => {
        const suffix = input.sourcePath.endsWith('one.xlsx') ? 'one' : 'two'
        const draftPath = `/sessions/session-1/artifacts/office/artifact-${suffix}/${suffix}.xlsx`
        values.set(draftPath, 'before')
        return {
          artifactId: `artifact-${suffix}`,
          sessionId: input.sessionId,
          projectId: input.projectId,
          sourcePath: input.sourcePath,
          sourceHash: `hash-${suffix}`,
          draftPath
        }
      },
      readRange: async (context) =>
        cellResponse(context.revision, values.get(context.draftPath) ?? null),
      applyCellValue: async (context, params) => {
        writes += 1
        values.set(context.draftPath, params.value)
      }
    })
  )
  const one = await service.open({ ...openRequest, sourcePath: '/project/one.xlsx' })
  const two = await service.open({ ...openRequest, sourcePath: '/project/two.xlsx' })
  assert.equal(one.state, 'ready')
  assert.equal(two.state, 'ready')
  if (one.state !== 'ready' || two.state !== 'ready') throw new Error('open failed')
  service.bindRunTarget({
    runId: 'run-one',
    artifactId: one.document.artifactId,
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  service.bindRunTarget({
    runId: 'run-two',
    artifactId: two.document.artifactId,
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  const first = await service.applyCellEdit(
    'run-one',
    { sheet: 'Sheet1', cell: 'A1', value: 'first', baseRevision: 0 },
    { operationId: 'shared-across-artifacts' }
  )
  const second = await service.applyCellEdit(
    'run-two',
    { sheet: 'Sheet1', cell: 'A1', value: 'second', baseRevision: 0 },
    { operationId: 'shared-across-artifacts' }
  )

  assert.equal(first.deduplicated, undefined)
  assert.equal(second.deduplicated, undefined)
  assert.equal(writes, 2)
})

test('a new service restores revision and deduplicates a persisted operation receipt', async () => {
  let persisted: Awaited<ReturnType<NonNullable<OfficeServiceDependencies['loadOperationLog']>>> = {
    version: 1,
    contentRevision: 0,
    operations: {}
  }
  let current: string | number | boolean | null = 'before'
  let writes = 0
  const overrides: Partial<OfficeServiceDependencies> = {
    loadOperationLog: async () => structuredClone(persisted),
    persistOperationLog: async (_draftPath, state) => {
      persisted = structuredClone(state)
    },
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      writes += 1
      current = params.value
    }
  }
  const firstService = await openBoundService(overrides)
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'persisted', baseRevision: 0 }
  const first = await firstService.applyCellEdit('run-write', params, {
    operationId: 'persisted-operation'
  })
  await firstService.dispose()

  const secondService = await openBoundService(overrides)
  const replay = await secondService.applyCellEdit('run-write', params, {
    operationId: 'persisted-operation'
  })
  assert.deepEqual(replay, { ...first, deduplicated: true })
  assert.equal(writes, 1)
  assert.equal(
    (
      await secondService.describeCellEdit('run-write', {
        sheet: 'Sheet1',
        cell: 'A1',
        value: 'next'
      })
    ).revision,
    1
  )
  await assert.rejects(
    secondService.applyCellEdit(
      'run-write',
      { sheet: 'Sheet1', cell: 'A1', value: 'stale', baseRevision: 0 },
      { operationId: 'stale-after-restart' }
    ),
    { code: 'revision_conflict' }
  )
  const next = await secondService.applyCellEdit(
    'run-write',
    { sheet: 'Sheet1', cell: 'A1', value: 'next', baseRevision: 1 },
    { operationId: 'next-after-restart' }
  )
  assert.equal(next.revision, 2)
  await secondService.dispose()
})

test('a recovered in-flight operation is never replayed and freezes the artifact', async () => {
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'unknown', baseRevision: 0 }
  let persisted = {
    version: 1 as const,
    contentRevision: 0,
    freezeState: 'unknown' as const,
    operations: {
      'recovered-operation': {
        digest: officeOperationDigest(params),
        status: 'in_flight' as const,
        createdAt: '2026-10-05T00:00:00.000Z'
      }
    }
  }
  let writes = 0
  let authorizations = 0
  const service = await openBoundService({
    loadOperationLog: async () => structuredClone(persisted),
    persistOperationLog: async (_draftPath, state) => {
      persisted = structuredClone(state) as typeof persisted
    },
    applyCellValue: async () => {
      writes += 1
    }
  })
  const options = {
    operationId: 'recovered-operation',
    authorize: () => {
      authorizations += 1
      return true
    }
  }

  await assert.rejects(service.applyCellEdit('run-write', params, options), {
    code: 'write_unknown'
  })
  await assert.rejects(
    service.applyCellEdit('run-write', params, options),
    (error) =>
      error instanceof OfficeWriteError &&
      error.code === 'write_unknown' &&
      error.details?.deduplicated === true
  )
  await assert.rejects(
    service.applyCellEdit(
      'run-write',
      { sheet: 'Sheet1', cell: 'A1', value: 'blocked', baseRevision: 0 },
      { operationId: 'new-operation' }
    ),
    { code: 'document_frozen' }
  )
  assert.equal(writes, 0)
  assert.equal(authorizations, 0)
})

test('an in-flight receipt persistence failure prevents authorization and content writes', async () => {
  let writes = 0
  let authorizations = 0
  const service = await openBoundService({
    persistOperationLog: async () => {
      throw new Error('/private/internal/operations.json rename failed')
    },
    applyCellValue: async () => {
      writes += 1
    }
  })

  await assert.rejects(
    service.applyCellEdit(
      'run-write',
      { sheet: 'Sheet1', cell: 'A1', value: 'never', baseRevision: 0 },
      {
        operationId: 'not-persisted',
        authorize: () => {
          authorizations += 1
          return true
        }
      }
    ),
    (error) =>
      error instanceof OfficeWriteError &&
      error.code === 'write_failed' &&
      !/private|operations\.json/u.test(error.message)
  )
  assert.equal(authorizations, 0)
  assert.equal(writes, 0)
})

test('applyCellEdit persists typed prewrite evidence after reading and before the CLI write', async () => {
  let current: string | number | boolean | null = 'before'
  const events: string[] = []
  const service = await openBoundService({
    readRange: async (context) => {
      events.push('read')
      return cellResponse(context.revision, current)
    },
    persistOperationLog: async (_draftPath, state) => {
      const record = state.operations['ordered-prewrite']
      events.push(record?.operation ? 'persist-prewrite' : 'persist')
      if (record?.operation) {
        assert.deepEqual(record.operation, {
          sheet: 'Sheet1',
          cell: 'A1',
          value: 7,
          baseRevision: 0
        })
        assert.equal(record.before, 'before')
      }
    },
    applyCellValue: async (_context, params) => {
      events.push('write')
      current = params.value
    }
  })

  await service.applyCellEdit(
    'run-write',
    { sheet: 'Sheet1', cell: 'A1', value: 7, baseRevision: 0 },
    { operationId: 'ordered-prewrite' }
  )

  assert.deepEqual(events.slice(0, 4), ['persist', 'read', 'persist-prewrite', 'write'])
})

test('a corrupt loaded operation log freezes writes with a stable safe error', async () => {
  let authorizations = 0
  let writes = 0
  const service = await openBoundService({
    loadOperationLog: async () => ({
      version: 1,
      contentRevision: 0,
      operations: {},
      freezeState: 'unknown',
      integrityError: 'operation_log_corrupt'
    }),
    applyCellValue: async () => {
      writes += 1
    }
  })

  await assert.rejects(
    service.applyCellEdit(
      'run-write',
      { sheet: 'Sheet1', cell: 'A1', value: 'never', baseRevision: 0 },
      {
        operationId: 'corrupt-log-operation',
        authorize: () => {
          authorizations += 1
          return true
        }
      }
    ),
    (error) =>
      error instanceof OfficeWriteError &&
      error.code === 'operation_log_corrupt' &&
      !/private|pid|port/u.test(error.message)
  )
  assert.equal(authorizations, 0)
  assert.equal(writes, 0)
})

test('a terminal receipt persistence failure keeps an in-memory receipt and freezes the artifact', async () => {
  let current: string | number | boolean | null = 'before'
  let writes = 0
  let persistenceCalls = 0
  let highlights = 0
  const warnings: Array<{ event: string; metadata: Readonly<Record<string, unknown>> }> = []
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      writes += 1
      current = params.value
    },
    armPreviewConfirmation: () => ({ promise: Promise.resolve(true), cancel: () => undefined }),
    publishConfirmedWrite: () => {
      highlights += 1
    },
    persistOperationLog: async () => {
      persistenceCalls += 1
      if (persistenceCalls === 3) throw new Error('/private/internal/rename failed')
    },
    logOperationWarning: (event, metadata) => warnings.push({ event, metadata })
  })
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 }

  const first = await service.applyCellEdit('run-write', params, {
    operationId: 'terminal-persist-failure'
  })
  const replay = await service.applyCellEdit('run-write', params, {
    operationId: 'terminal-persist-failure'
  })

  assert.deepEqual(first.warnings, ['operation_receipt_not_persisted'])
  assert.deepEqual(replay, { ...first, deduplicated: true })
  assert.equal(writes, 1)
  assert.equal(highlights, 0)
  assert.deepEqual(warnings, [
    {
      event: 'office_operation_receipt_persist_failed',
      metadata: { artifactId: 'artifact-1', operationId: 'terminal-persist-failure' }
    }
  ])
  assert.doesNotMatch(JSON.stringify(warnings), /before|after|private|rename/u)
  await assert.rejects(
    service.applyCellEdit(
      'run-write',
      { sheet: 'Sheet1', cell: 'A1', value: 'blocked', baseRevision: 1 },
      { operationId: 'blocked-after-persist-failure' }
    ),
    { code: 'document_frozen' }
  )
})

test('revision conflicts are checked inside the queue before any content access', async () => {
  let reads = 0
  let writes = 0
  const service = await openBoundService({
    readRange: async (context) => {
      reads += 1
      return cellResponse(context.revision, 'current')
    },
    applyCellValue: async () => {
      writes += 1
    }
  })

  await assert.rejects(
    applyCellEdit(service, 'run-write', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: 'stale',
      baseRevision: 9
    }),
    (error) =>
      error instanceof OfficeWriteError &&
      error.code === 'revision_conflict' &&
      error.details?.currentRevision === 0
  )
  assert.equal(reads, 0)
  assert.equal(writes, 0)
})

test('an explicit failed receipt is deduplicated without repeating authorization', async () => {
  let authorizations = 0
  const service = await openBoundService({})
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'stale', baseRevision: 9 }
  const options = {
    operationId: 'failed-operation',
    authorize: () => {
      authorizations += 1
      return true
    }
  }

  await assert.rejects(service.applyCellEdit('run-write', params, options), {
    code: 'revision_conflict'
  })
  await assert.rejects(
    service.applyCellEdit('run-write', params, options),
    (error) =>
      error instanceof OfficeWriteError &&
      error.code === 'revision_conflict' &&
      error.details?.deduplicated === true &&
      error.details?.currentRevision === 0
  )
  assert.equal(authorizations, 1)
})

test('read-back mismatch auto-reconciles not_applied and permits a new operation', async () => {
  let writes = 0
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, 'unchanged'),
    applyCellValue: async () => {
      writes += 1
    }
  })
  const mismatched = { sheet: 'Sheet1', cell: 'A1', value: 'requested', baseRevision: 0 }
  const mismatchOptions = { operationId: 'verification-failed-operation' }

  await assert.rejects(service.applyCellEdit('run-write', mismatched, mismatchOptions), {
    code: 'write_not_applied'
  })
  await assert.rejects(
    service.applyCellEdit('run-write', mismatched, mismatchOptions),
    (error) =>
      error instanceof OfficeWriteError &&
      error.code === 'write_not_applied' &&
      error.details?.deduplicated === true
  )
  await assert.rejects(
    applyCellEdit(service, 'run-write', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: 'again',
      baseRevision: 0
    }),
    { code: 'write_not_applied' }
  )
  assert.equal(writes, 2)
  assert.equal((await service.readRange('run-write', { sheet: 'Sheet1', range: 'A1' })).revision, 0)
  assert.doesNotThrow(() => service.assertWritable('artifact-1'))
})

test('save failure reports applied content separately and keeps the incremented revision', async () => {
  let current: string | number | boolean | null = 'before'
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      current = params.value
    },
    saveDraft: async () => {
      throw new Error('/private/draft.xlsx port 42001')
    },
    armPreviewConfirmation: () => ({
      promise: Promise.resolve(true),
      cancel: () => undefined
    })
  })
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 }
  const options = { operationId: 'save-failed-operation' }

  await assert.rejects(service.applyCellEdit('run-write', params, options), (error) => {
    if (!(error instanceof OfficeWriteError) || error.code !== 'save_failed') return false
    assert.doesNotMatch(error.message, /private|42001/)
    assert.deepEqual(error.details?.result, {
      sheet: 'Sheet1',
      cell: 'A1',
      before: 'before',
      after: 'after',
      revision: 1,
      applied: true,
      saved: false,
      previewConfirmed: true
    })
    return true
  })
  await assert.rejects(service.applyCellEdit('run-write', params, options), (error) => {
    if (!(error instanceof OfficeWriteError) || error.code !== 'save_failed') return false
    assert.equal(error.details?.deduplicated, true)
    assert.deepEqual(error.details?.result, {
      sheet: 'Sheet1',
      cell: 'A1',
      before: 'before',
      after: 'after',
      revision: 1,
      applied: true,
      saved: false,
      previewConfirmed: true,
      deduplicated: true
    })
    return true
  })
  const description = await service.describeCellEdit('run-write', {
    sheet: 'Sheet1',
    cell: 'A1',
    value: 'next'
  })
  assert.equal(description.revision, 1)
  assert.equal(description.before, 'after')
})

test('preview timeout is a warning rather than a failed write', async () => {
  let current: string | number | boolean | null = 'before'
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      current = params.value
    }
  })

  const result = await applyCellEdit(service, 'run-write', {
    sheet: 'Sheet1',
    cell: 'A1',
    value: 'after',
    baseRevision: 0
  })
  assert.equal(result.previewConfirmed, false)
  assert.deepEqual(result.warnings, ['preview_not_confirmed'])
  assert.equal(result.applied, true)
  assert.equal(result.saved, true)
})

test('cancellation before the batch does not write and cancellation during it is reconciled', async () => {
  const current: string | number | boolean | null = 'before'
  let writes = 0
  let started!: () => void
  const writeStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (context) => {
      writes += 1
      started()
      await new Promise<void>((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      })
    }
  })
  const before = new AbortController()
  before.abort()
  await assert.rejects(
    applyCellEdit(
      service,
      'run-write',
      { sheet: 'Sheet1', cell: 'A1', value: 'never', baseRevision: 0 },
      { signal: before.signal }
    ),
    { code: 'write_cancelled' }
  )
  assert.equal(writes, 0)

  const during = new AbortController()
  const applying = applyCellEdit(
    service,
    'run-write',
    { sheet: 'Sheet1', cell: 'A1', value: 'unknown', baseRevision: 0 },
    { signal: during.signal }
  )
  await writeStarted
  during.abort()
  await assert.rejects(applying, { code: 'write_not_applied' })
  assert.equal(writes, 1)
  assert.doesNotThrow(() => service.assertWritable('artifact-1'))
  assert.equal((await service.readRange('run-write', { sheet: 'Sheet1', range: 'A1' })).revision, 0)
})

test('aborting a bound run before apply prevents all document access', async () => {
  let reads = 0
  let writes = 0
  const service = await openBoundService({
    readRange: async (context) => {
      reads += 1
      return cellResponse(context.revision, 'before')
    },
    applyCellValue: async () => {
      writes += 1
    }
  })

  assert.equal(service.abortRun('run-write'), true)
  await assert.rejects(
    applyCellEdit(service, 'run-write', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: 'never',
      baseRevision: 0
    }),
    { code: 'write_cancelled' }
  )
  assert.equal(reads, 0)
  assert.equal(writes, 0)
  assert.equal(service.abortRun('run-write'), false)
})

test('clearing a run aborts its in-flight batch without a ghost write and releases its controller', async () => {
  let current: string | number | boolean | null = 'before'
  let writeAttempts = 0
  let observedSignal: AbortSignal | undefined
  let markStarted!: () => void
  const writeStarted = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (context, params) => {
      writeAttempts += 1
      observedSignal = context.signal
      markStarted()
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          current = params.value
          resolve()
        }, 20)
        context.signal?.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            reject(new Error('aborted'))
          },
          { once: true }
        )
      })
    }
  })

  const applying = applyCellEdit(service, 'run-write', {
    sheet: 'Sheet1',
    cell: 'A1',
    value: 'ghost',
    baseRevision: 0
  })
  await writeStarted
  assert.equal(service.clearRunTarget('run-write'), true)
  const firstSignal = observedSignal
  const outcome = await applying.then(
    (result) => ({ result }),
    (error: unknown) => ({ error })
  )
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(firstSignal?.aborted, true)
  assert.equal(current, 'before')
  assert.ok('error' in outcome)
  assert.ok(outcome.error instanceof OfficeWriteError)
  assert.equal(outcome.error.code, 'write_not_applied')

  service.bindRunTarget({
    runId: 'run-write-next',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  const result = await applyCellEdit(service, 'run-write-next', {
    sheet: 'Sheet1',
    cell: 'A1',
    value: 'confirmed',
    baseRevision: 0
  })
  assert.equal(result.after, 'confirmed')
  assert.equal(writeAttempts, 2)
  assert.notEqual(observedSignal, firstSignal)
  assert.equal(observedSignal?.aborted, false)
})

test('session close and disposal abort in-flight writes', async (t) => {
  await t.test('session close', () =>
    assertCleanupAbortsInFlightWrite((service) => service.closeSession('session-1'))
  )
  await t.test('service disposal', () =>
    assertCleanupAbortsInFlightWrite((service) => service.dispose())
  )
})

test('a write cancelled while queued performs no read or write after acquiring the queue', async () => {
  let reads = 0
  let writes = 0
  let releaseRead!: () => void
  const blockedRead = new Promise<void>((resolve) => {
    releaseRead = resolve
  })
  let markReadStarted!: () => void
  const readStarted = new Promise<void>((resolve) => {
    markReadStarted = resolve
  })
  const service = await openBoundService({
    readRange: async (context) => {
      reads += 1
      if (reads === 1) {
        markReadStarted()
        await blockedRead
      }
      return cellResponse(context.revision, 'before')
    },
    applyCellValue: async () => {
      writes += 1
    }
  })
  const firstRead = service.readRange('run-write', { sheet: 'Sheet1', range: 'A1' })
  await readStarted
  const controller = new AbortController()
  const queuedWrite = applyCellEdit(
    service,
    'run-write',
    { sheet: 'Sheet1', cell: 'A1', value: 'never', baseRevision: 0 },
    { signal: controller.signal }
  )
  controller.abort()
  try {
    await assert.rejects(
      Promise.race([
        queuedWrite,
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('queued write cancellation did not settle')), 50)
        )
      ]),
      { code: 'write_cancelled' }
    )
    assert.equal(reads, 1)
    assert.equal(writes, 0)
  } finally {
    releaseRead()
    await Promise.allSettled([firstRead, queuedWrite])
  }
})

test('an unknown write result that reads back unchanged is not_applied and never retries the same id', async () => {
  let writes = 0
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, 'before'),
    applyCellValue: async () => {
      writes += 1
      throw new OfficeWriteError('write_unknown', '/private/draft.xlsx timed out on port 42001')
    }
  })
  const params = { sheet: 'Sheet1', cell: 'A1', value: 'unknown', baseRevision: 0 }
  const options = { operationId: 'unknown-operation' }

  await assert.rejects(service.applyCellEdit('run-write', params, options), (error) => {
    if (!(error instanceof OfficeWriteError) || error.code !== 'write_not_applied') return false
    assert.doesNotMatch(error.message, /private|42001/)
    return true
  })
  await assert.rejects(
    service.applyCellEdit('run-write', params, options),
    (error) =>
      error instanceof OfficeWriteError &&
      error.code === 'write_not_applied' &&
      error.details?.deduplicated === true
  )
  await assert.rejects(
    applyCellEdit(service, 'run-write', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: 'blocked',
      baseRevision: 0
    }),
    { code: 'write_not_applied' }
  )
  assert.equal(writes, 2)
  assert.equal((await service.readRange('run-write', { sheet: 'Sheet1', range: 'A1' })).revision, 0)
})

test('a write transaction and a concurrent read never interleave on one artifact queue', async () => {
  let current: string | number | boolean | null = 'before'
  let releaseWrite!: () => void
  const writeBlocked = new Promise<void>((resolve) => {
    releaseWrite = resolve
  })
  let markStarted!: () => void
  const writeStarted = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const events: string[] = []
  let reads = 0
  const service = await openBoundService({
    readRange: async (context) => {
      reads += 1
      events.push(reads === 1 ? 'read-before' : reads === 2 ? 'read-after' : 'read-public')
      return cellResponse(context.revision, current)
    },
    applyCellValue: async (_context, params) => {
      events.push('write-start')
      markStarted()
      await writeBlocked
      current = params.value
      events.push('write-end')
    },
    saveDraft: async () => {
      events.push('save')
    }
  })

  const writing = applyCellEdit(service, 'run-write', {
    sheet: 'Sheet1',
    cell: 'A1',
    value: 'after',
    baseRevision: 0
  })
  await writeStarted
  const reading = service.readRange('run-write', { sheet: 'Sheet1', range: 'A1' })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(events, ['read-before', 'write-start'])
  releaseWrite()

  const [writeResult, readResult] = await Promise.all([writing, reading])
  assert.deepEqual(events, [
    'read-before',
    'write-start',
    'write-end',
    'read-after',
    'save',
    'read-public'
  ])
  assert.equal(writeResult.revision, 1)
  assert.equal(readResult.revision, 1)
})

test('write failures do not increment revision or freeze a known rolled-back document', async () => {
  let shouldFail = true
  let current: string | number | boolean | null = 'before'
  const service = await openBoundService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      if (shouldFail) {
        shouldFail = false
        throw new OfficeWriteError('write_failed', '/private/draft.xlsx batch failed on port 42001')
      }
      current = params.value
    }
  })

  await assert.rejects(
    applyCellEdit(service, 'run-write', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: 'first',
      baseRevision: 0
    }),
    (error) => {
      assert.ok(error instanceof OfficeWriteError)
      assert.equal(error.code, 'write_failed')
      assert.doesNotMatch(error.message, /private|42001/)
      return true
    }
  )
  const result = await applyCellEdit(service, 'run-write', {
    sheet: 'Sheet1',
    cell: 'A1',
    value: 'second',
    baseRevision: 0
  })
  assert.equal(result.revision, 1)
  assert.equal(result.after, 'second')
})

test('write target resolution never falls back to the visible document', async () => {
  const service = new OfficeService(dependencies())
  await service.open(openRequest)
  await assert.rejects(
    applyCellEdit(service, 'unbound-run', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: 'x',
      baseRevision: 0
    }),
    { code: 'no_target' }
  )

  service.bindRunTarget({
    runId: 'released-run',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  service.clearRunTarget('released-run')
  await assert.rejects(
    service.describeCellEdit('released-run', {
      sheet: 'Sheet1',
      cell: 'A1',
      value: 'x'
    }),
    { code: 'target_missing' }
  )
})
