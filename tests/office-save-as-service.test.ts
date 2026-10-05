import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { loadOfficeOutputLog } from '../src/main/agent/office/office-output-log'
import {
  OfficeService,
  type OfficeOpenRequest,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import type { OfficeReadResult } from '../src/main/agent/office/office-read'

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

test('save as creates and records an immutable project-relative snapshot without changing source', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'office-save-as-project-'))
  const artifactRoot = await mkdtemp(join(tmpdir(), 'office-save-as-artifact-'))
  const sourcePath = join(projectRoot, 'source.xlsx')
  const draftPath = join(artifactRoot, 'draft.xlsx')
  const targetPath = join(projectRoot, 'output.xlsx')
  const sourceBytes = Buffer.from('original-source')
  const draftBytes = Buffer.from('saved-draft-revision-3')
  try {
    await writeFile(sourcePath, sourceBytes)
    await writeFile(draftPath, draftBytes)
    const dependencies = serviceDependencies({ sourcePath, draftPath })
    const service = new OfficeService(dependencies)
    await service.open(openRequest(projectRoot, sourcePath))

    assert.deepEqual(service.saveAsDescriptor('artifact-1', 'session-1'), {
      fileName: 'draft.xlsx',
      kind: 'xlsx'
    })

    const result = await service.saveAsDocument('artifact-1', 'session-1', projectRoot, targetPath)

    assert.deepEqual(result, {
      outputId: 'output-1',
      outputPath: 'output.xlsx',
      fileName: 'output.xlsx',
      revision: 3,
      sha256: digest(draftBytes),
      size: draftBytes.length,
      createdAt: '2026-10-05T12:00:00.000Z',
      source: 'draft'
    })
    assert.deepEqual(await readFile(targetPath), draftBytes)
    assert.deepEqual(await readFile(sourcePath), sourceBytes)
    assert.deepEqual((await loadOfficeOutputLog(draftPath)).outputs, [
      {
        outputId: 'output-1',
        outputPath: 'output.xlsx',
        revision: 3,
        sha256: digest(draftBytes),
        size: draftBytes.length,
        createdAt: '2026-10-05T12:00:00.000Z',
        source: 'draft'
      }
    ])

    await writeFile(draftPath, 'later-change')
    assert.deepEqual(await readFile(targetPath), draftBytes)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('docx save as keeps the shared save transaction and rejects an xlsx target', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'office-save-as-docx-project-'))
  const artifactRoot = await mkdtemp(join(tmpdir(), 'office-save-as-docx-artifact-'))
  const sourcePath = join(projectRoot, 'source.docx')
  const draftPath = join(artifactRoot, '未命名文档.docx')
  const targetPath = join(projectRoot, '文档副本.docx')
  const draftBytes = Buffer.from('saved-docx-draft')
  try {
    await writeFile(sourcePath, 'original-docx')
    await writeFile(draftPath, draftBytes)
    const service = new OfficeService(serviceDependencies({ sourcePath, draftPath }))
    await service.open(openRequest(projectRoot, sourcePath))

    assert.deepEqual(service.saveAsDescriptor('artifact-1', 'session-1'), {
      fileName: '未命名文档.docx',
      kind: 'docx'
    })
    await assert.rejects(
      service.saveAsDocument(
        'artifact-1',
        'session-1',
        projectRoot,
        join(projectRoot, '错误类型.xlsx')
      ),
      { code: 'invalid_extension' }
    )

    const result = await service.saveAsDocument('artifact-1', 'session-1', projectRoot, targetPath)
    assert.equal(result.fileName, '文档副本.docx')
    assert.equal(result.outputPath, '文档副本.docx')
    assert.equal(result.sha256, digest(draftBytes))
    assert.deepEqual(await readFile(targetPath), draftBytes)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('a concurrent write waits for save-as and the immutable output keeps the recorded revision', async () => {
  const projectRoot = await mkdtemp(join(tmpdir(), 'office-save-as-queue-project-'))
  const artifactRoot = await mkdtemp(join(tmpdir(), 'office-save-as-queue-artifact-'))
  const sourcePath = join(projectRoot, 'source.xlsx')
  const draftPath = join(artifactRoot, 'draft.xlsx')
  const targetPath = join(projectRoot, 'snapshot.xlsx')
  const revision3 = Buffer.from('revision-3')
  let current = 'before'
  let writes = 0
  let releaseValidation!: () => void
  let markValidationStarted!: () => void
  const validationStarted = new Promise<void>((resolve) => {
    markValidationStarted = resolve
  })
  try {
    await writeFile(sourcePath, 'source')
    await writeFile(draftPath, revision3)
    const service = new OfficeService(
      serviceDependencies(
        { sourcePath, draftPath },
        {
          readRange: async (context) => cellResponse(context.revision, current),
          applyCellValue: async (_context, params) => {
            writes += 1
            current = String(params.value)
            await writeFile(draftPath, 'revision-4')
          },
          verifyOutputFile: async (path) => {
            markValidationStarted()
            await new Promise<void>((resolve) => {
              releaseValidation = resolve
            })
            const bytes = await readFile(path)
            return { sha256: digest(bytes), size: bytes.length }
          }
        }
      )
    )
    await service.open(openRequest(projectRoot, sourcePath))
    service.bindRunTarget({
      runId: 'run-write',
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: 'project-1'
    })

    const saveAs = service.saveAsDocument('artifact-1', 'session-1', projectRoot, targetPath)
    await validationStarted
    const write = service.applyCellEdit(
      'run-write',
      { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 3 },
      { operationId: 'queued-after-save-as' }
    )
    await Promise.resolve()
    assert.equal(writes, 0)

    releaseValidation()
    const output = await saveAs
    const edit = await write

    assert.equal(output.revision, 3)
    assert.deepEqual(await readFile(targetPath), revision3)
    assert.equal(edit.revision, 4)
    assert.equal(writes, 1)
  } finally {
    await rm(projectRoot, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('frozen and unsaved drafts are rejected before save-as creates a target', async () => {
  for (const state of [
    { freezeState: 'unknown' as const, expected: 'document_frozen' },
    { needsSave: true as const, expected: 'save_failed' }
  ]) {
    const projectRoot = await mkdtemp(join(tmpdir(), 'office-save-as-guard-project-'))
    const artifactRoot = await mkdtemp(join(tmpdir(), 'office-save-as-guard-artifact-'))
    const sourcePath = join(projectRoot, 'source.xlsx')
    const draftPath = join(artifactRoot, 'draft.xlsx')
    const targetPath = join(projectRoot, 'blocked.xlsx')
    let saves = 0
    try {
      await writeFile(sourcePath, 'source')
      await writeFile(draftPath, 'draft')
      const service = new OfficeService(
        serviceDependencies(
          { sourcePath, draftPath },
          {
            loadOperationLog: async () => ({
              version: 2,
              contentRevision: 3,
              operations: {},
              ...(state.freezeState ? { freezeState: state.freezeState } : {}),
              ...(state.needsSave ? { needsSave: true } : {})
            }),
            saveDraft: async () => {
              saves += 1
            }
          }
        )
      )
      await service.open(openRequest(projectRoot, sourcePath))

      await assert.rejects(
        service.saveAsDocument('artifact-1', 'session-1', projectRoot, targetPath),
        { code: state.expected }
      )
      assert.equal(saves, 0)
      await assert.rejects(readFile(targetPath))
    } finally {
      await rm(projectRoot, { recursive: true, force: true })
      await rm(artifactRoot, { recursive: true, force: true })
    }
  }
})

function serviceDependencies(
  paths: { sourcePath: string; draftPath: string },
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
      kind: input.sourcePath.toLowerCase().endsWith('.docx') ? 'docx' : 'xlsx',
      sourcePath: paths.sourcePath,
      sourceHash: digest(await readFile(paths.sourcePath)),
      draftPath: paths.draftPath
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
    verifySavedDraft: async () => {
      const bytes = await readFile(paths.draftPath)
      return { sha256: digest(bytes), size: bytes.length }
    },
    verifyOutputFile: async (path) => {
      const bytes = await readFile(path)
      return { sha256: digest(bytes), size: bytes.length }
    },
    armPreviewConfirmation: () => ({ promise: Promise.resolve(true), cancel: () => undefined }),
    loadOperationLog: async () => ({
      version: 2,
      contentRevision: 3,
      operations: {},
      saveState: 'saved',
      lastSavedRevision: 3,
      lastSavedAt: '2026-10-05T11:00:00.000Z',
      savedDraftHash: digest(Buffer.from('saved-draft-revision-3'))
    }),
    outputId: () => 'output-1',
    now: () => new Date('2026-10-05T12:00:00.000Z'),
    ...overrides
  }
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

function openRequest(projectRoot: string, sourcePath: string): OfficeOpenRequest {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    sourcePath,
    projectLocation: { kind: 'local' as const, path: projectRoot, realPath: projectRoot },
    allowRoots: [projectRoot]
  }
}
