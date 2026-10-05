import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import type { OfficeOperationLogState } from '../src/main/agent/office/office-operation-log'
import type { OfficeReadResult } from '../src/main/agent/office/office-read'

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
      draftPath: '/phi/artifact-1/report.xlsx'
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
      throw new Error('unused')
    },
    applyCellValue: async () => {
      throw new Error('unused')
    },
    saveDraft: async () => undefined,
    verifySavedDraft: async () => ({ sha256: 'a'.repeat(64), size: 1024 }),
    armPreviewConfirmation: () => ({
      promise: Promise.resolve(true),
      cancel: () => undefined
    }),
    loadOperationLog: async () => ({ version: 2, contentRevision: 0, operations: {} }),
    persistOperationLog: async () => undefined,
    now: () => new Date('2026-10-05T12:00:00.000Z'),
    ...overrides
  }
}

async function openService(
  overrides: Partial<OfficeServiceDependencies> = {}
): Promise<OfficeService> {
  const service = new OfficeService(dependencies(overrides))
  await service.open({
    sessionId: 'session-1',
    projectId: 'project-1',
    sourcePath: '/project/report.xlsx',
    projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
    allowRoots: ['/project']
  })
  return service
}

function cellResponse(revision: number, value: string): OfficeReadResult {
  return {
    revision,
    sheet: 'Sheet1',
    range: 'A1',
    cells: [{ ref: 'A1', value, valueType: 'string' }],
    rowCount: 1,
    columnCount: 1,
    complete: true,
    truncated: false,
    limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
  }
}

test('explicit save verifies the draft and persists the confirmed revision and hash', async () => {
  const persisted: OfficeOperationLogState[] = []
  let saves = 0
  const service = await openService({
    saveDraft: async () => {
      saves += 1
    },
    persistOperationLog: async (_draftPath, state) => {
      persisted.push(state)
    }
  })

  const result = await service.saveDocument('artifact-1', 'session-1')

  assert.deepEqual(result, {
    saved: true,
    revision: 0,
    lastSavedAt: '2026-10-05T12:00:00.000Z'
  })
  assert.equal(saves, 1)
  assert.deepEqual(persisted.at(-1), {
    version: 2,
    contentRevision: 0,
    operations: {},
    saveState: 'saved',
    lastSavedRevision: 0,
    lastSavedAt: '2026-10-05T12:00:00.000Z',
    savedDraftHash: 'a'.repeat(64)
  })
  const status = service.statusForSource('session-1', '/project/report.xlsx')
  assert.equal(status?.state, 'ready')
  if (status?.state === 'ready') {
    assert.equal(status.saveState, 'saved')
    assert.equal(status.lastSavedRevision, 0)
    assert.equal(status.lastSavedAt, '2026-10-05T12:00:00.000Z')
  }
})

test('a DOCX preview render failure does not block file-level saving', async () => {
  let saves = 0
  const service = new OfficeService(
    dependencies({
      prepareDraft: async (input) => ({
        artifactId: 'artifact-1',
        sessionId: input.sessionId,
        projectId: input.projectId,
        kind: 'docx',
        sourcePath: input.sourcePath,
        sourceHash: 'source-hash',
        draftPath: '/phi/artifact-1/report.docx'
      }),
      startPreview: async () => ({
        watchPid: 202,
        watchPort: 31_001,
        gatewayPort: 42_001,
        previewUrl: 'http://127.0.0.1:42001/',
        previewState: 'preview_failed',
        previewError: '预览渲染失败：预览页面未显示文档正文'
      }),
      saveDraft: async () => {
        saves += 1
      }
    })
  )
  const opened = await service.open({
    sessionId: 'session-1',
    projectId: 'project-1',
    sourcePath: '/project/report.docx',
    projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
    allowRoots: ['/project']
  })
  assert.equal(opened.state, 'ready')
  if (opened.state !== 'ready') throw new Error(opened.message)
  assert.equal(opened.document.previewState, 'preview_failed')

  const saved = await service.saveDocument('artifact-1', 'session-1')

  assert.equal(saved.saved, true)
  assert.equal(saves, 1)
})

test('a write reports editing while active and its internal verified save ends at saved', async () => {
  let current = 'before'
  let release!: () => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const service = await openService({
    readRange: async (context) => cellResponse(context.revision, current),
    applyCellValue: async (_context, params) => {
      markStarted()
      await new Promise<void>((resolve) => {
        release = resolve
      })
      current = String(params.value)
    }
  })
  service.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  const write = service.applyCellEdit(
    'run-1',
    { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 0 },
    { operationId: 'save-state-write' }
  )
  await started
  const editing = service.statusForSource('session-1', '/project/report.xlsx')
  assert.equal(editing?.state === 'ready' ? editing.saveState : undefined, 'editing')

  release()
  const result = await write
  assert.equal(result.saved, true)
  const saved = service.statusForSource('session-1', '/project/report.xlsx')
  assert.equal(saved?.state === 'ready' ? saved.saveState : undefined, 'saved')
  assert.equal(saved?.state === 'ready' ? saved.lastSavedRevision : undefined, 1)
})

test('an explicit save failure preserves the revision and a serialized retry succeeds', async () => {
  let attempts = 0
  const service = await openService({
    saveDraft: async () => {
      attempts += 1
      if (attempts === 1) throw new Error('/private/draft.xlsx failed')
    }
  })

  await assert.rejects(service.saveDocument('artifact-1', 'session-1'), {
    code: 'save_failed'
  })
  const failed = service.statusForSource('session-1', '/project/report.xlsx')
  assert.equal(failed?.state === 'ready' ? failed.saveState : undefined, 'failed')
  assert.equal(failed?.state === 'ready' ? failed.lastSavedRevision : undefined, 0)

  const retried = await service.saveDocument('artifact-1', 'session-1')
  assert.equal(retried.revision, 0)
  assert.equal(attempts, 2)
  const saved = service.statusForSource('session-1', '/project/report.xlsx')
  assert.equal(saved?.state === 'ready' ? saved.saveState : undefined, 'saved')
})

test('concurrent explicit saves serialize and reuse the first verified result', async () => {
  let saves = 0
  let release!: () => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const service = await openService({
    saveDraft: async () => {
      saves += 1
      markStarted()
      await new Promise<void>((resolve) => {
        release = resolve
      })
    }
  })

  const first = service.saveDocument('artifact-1', 'session-1')
  await started
  const second = service.saveDocument('artifact-1', 'session-1')
  release()

  assert.deepEqual(await second, await first)
  assert.equal(saves, 1)
})

test('a frozen document cannot be marked saved', async () => {
  let saves = 0
  const service = await openService({
    loadOperationLog: async () => ({
      version: 2,
      contentRevision: 0,
      operations: {},
      freezeState: 'unknown'
    }),
    saveDraft: async () => {
      saves += 1
    }
  })

  await assert.rejects(service.saveDocument('artifact-1', 'session-1'), {
    code: 'document_frozen'
  })
  assert.equal(saves, 0)
})
