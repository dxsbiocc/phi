import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  OfficeService,
  type OfficeOpenRequest,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import type { OfficeReadResult } from '../src/main/agent/office/office-read'

test('remote, frozen, unsaved, and save-failed deliveries produce no output', async () => {
  const cases = [
    { name: 'remote', expected: 'remote_not_supported', remote: true },
    { name: 'frozen', expected: 'document_frozen', freezeState: 'unknown' as const },
    { name: 'unsaved', expected: 'save_failed', needsSave: true },
    { name: 'read-only', expected: 'document_read_only', readOnly: true },
    { name: 'save-failed', expected: 'save_failed', failSave: true }
  ]
  for (const scenario of cases) {
    const cwd = await mkdtemp(join(tmpdir(), `office-deliver-${scenario.name}-`))
    const artifactRoot = await mkdtemp(join(tmpdir(), 'office-deliver-guard-artifact-'))
    const sourcePath = join(cwd, 'source.xlsx')
    const draftPath = join(artifactRoot, 'draft.xlsx')
    const outputPath = join(cwd, `${scenario.name}.xlsx`)
    try {
      await writeFile(sourcePath, 'source')
      await writeFile(draftPath, 'draft')
      const service = await openBoundService(
        cwd,
        sourcePath,
        draftPath,
        serviceDependencies(sourcePath, draftPath, {
          loadOperationLog: async () => ({
            version: 2,
            contentRevision: 3,
            operations: {},
            ...(scenario.freezeState ? { freezeState: scenario.freezeState } : {}),
            ...(scenario.needsSave ? { needsSave: true } : {})
          }),
          ...(scenario.failSave
            ? {
                saveDraft: async () => {
                  throw new Error('save failed')
                }
              }
            : {}),
          ...(scenario.readOnly
            ? {
                prepareDraft: async (input) => ({
                  artifactId: 'artifact-1',
                  sessionId: input.sessionId,
                  projectId: input.projectId,
                  kind: 'xlsx' as const,
                  sourcePath,
                  sourceHash: digest(await readFile(sourcePath)),
                  draftPath,
                  readOnly: true
                })
              }
            : {})
        })
      )
      await assert.rejects(
        service.deliverDocument('run-1', cwd, await realpath(cwd), scenario.name, {
          operationId: scenario.name,
          ...(scenario.remote ? { remote: true } : {})
        }),
        { code: scenario.expected }
      )
      await assert.rejects(readFile(outputPath))
      assert.equal(await readFile(draftPath, 'utf8'), 'draft')
      await assert.rejects(readFile(join(artifactRoot, 'outputs.json')))
    } finally {
      await rm(cwd, { recursive: true, force: true })
      await rm(artifactRoot, { recursive: true, force: true })
    }
  }
})

test('a concurrent write waits until delivery records one immutable revision', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'office-deliver-queue-'))
  const artifactRoot = await mkdtemp(join(tmpdir(), 'office-deliver-queue-artifact-'))
  const sourcePath = join(cwd, 'source.xlsx')
  const draftPath = join(artifactRoot, 'draft.xlsx')
  const revision3 = Buffer.from('revision-3')
  let current = 'before'
  let writes = 0
  let releaseCheck!: () => void
  let checkStarted!: () => void
  const checking = new Promise<void>((resolve) => {
    checkStarted = resolve
  })
  try {
    await writeFile(sourcePath, 'source')
    await writeFile(draftPath, revision3)
    const dependencies = serviceDependencies(sourcePath, draftPath, {
      readRange: async (context) => cellResponse(context.revision, current),
      applyCellValue: async () => {
        writes += 1
        current = 'after'
        await writeFile(draftPath, 'revision-4')
      },
      verifySavedDraft: async () => {
        const bytes = await readFile(draftPath)
        return { sha256: digest(bytes), size: bytes.length }
      },
      verifyOutputFile: async (path) => {
        const bytes = await readFile(path)
        return { sha256: digest(bytes), size: bytes.length }
      },
      checkDeliveredOutput: async () => {
        checkStarted()
        await new Promise<void>((resolve) => {
          releaseCheck = resolve
        })
        return {
          checks: [{ name: 'xlsx_content', status: 'passed', sampled: 0 }],
          warnings: []
        }
      },
      loadOperationLog: async () => ({ version: 2, contentRevision: 3, operations: {} })
    })
    const service = await openBoundService(cwd, sourcePath, draftPath, dependencies)
    const delivery = service.deliverDocument('run-1', cwd, await realpath(cwd), 'snapshot', {
      operationId: 'delivery'
    })
    await checking
    const write = service.applyCellEdit(
      'run-1',
      { sheet: 'Sheet1', cell: 'A1', value: 'after', baseRevision: 3 },
      { operationId: 'write-after-delivery' }
    )
    await Promise.resolve()
    assert.equal(writes, 0)

    releaseCheck()
    const [output, edit] = await Promise.all([delivery, write])
    assert.equal(output.revision, 3)
    assert.deepEqual(await readFile(output.absolutePath), revision3)
    assert.equal(edit.revision, 4)
    assert.equal(writes, 1)
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

async function openBoundService(
  cwd: string,
  sourcePath: string,
  draftPath: string,
  dependencies: OfficeServiceDependencies
): Promise<OfficeService> {
  const service = new OfficeService(dependencies)
  await service.open(openRequest(cwd, sourcePath))
  service.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  return service
}

function serviceDependencies(
  sourcePath: string,
  draftPath: string,
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
      kind: 'xlsx',
      sourcePath,
      sourceHash: digest(await readFile(sourcePath)),
      draftPath
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
    verifySavedDraft: async () => ({
      sha256: digest(await readFile(draftPath)),
      size: (await readFile(draftPath)).length
    }),
    verifyOutputFile: async (path) => ({
      sha256: digest(await readFile(path)),
      size: (await readFile(path)).length
    }),
    checkDeliveredOutput: async () => ({
      checks: [{ name: 'xlsx_content', status: 'passed', sampled: 0 }],
      warnings: []
    }),
    armPreviewConfirmation: () => ({ promise: Promise.resolve(true), cancel: () => undefined }),
    loadOperationLog: async () => ({ version: 2, contentRevision: 3, operations: {} }),
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

function openRequest(cwd: string, sourcePath: string): OfficeOpenRequest {
  return {
    sessionId: 'session-1',
    projectId: 'project-1',
    sourcePath,
    projectLocation: { kind: 'local', path: cwd, realPath: cwd },
    allowRoots: [cwd]
  }
}

function digest(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}
