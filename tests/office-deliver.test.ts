import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import {
  OfficeService,
  type OfficeOpenRequest,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import { loadOfficeOutputLog } from '../src/main/agent/office/office-output-log'
import { OfficeSaveAsError } from '../src/main/agent/office/office-save-as-target'

test('delivery description resolves the run target and a cwd-relative kind-safe file name', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'office-deliver-description-'))
  const artifactRoot = await mkdtemp(join(tmpdir(), 'office-deliver-artifact-'))
  const sourcePath = join(cwd, 'source.xlsx')
  const draftPath = join(artifactRoot, '季度报告.xlsx')
  try {
    await writeFile(sourcePath, 'source')
    await writeFile(draftPath, 'draft')
    const service = await openBoundService(cwd, sourcePath, draftPath)

    assert.deepEqual(
      await service.describeDelivery('run-1', cwd, await realpath(cwd), '最终报告', 'tool-call-1'),
      {
        fileName: '最终报告.xlsx',
        kind: 'xlsx',
        outputPath: '最终报告.xlsx'
      }
    )
    const defaultName = await service.describeDelivery(
      'run-1',
      cwd,
      await realpath(cwd),
      undefined,
      'stable-default'
    )
    assert.match(defaultName.fileName, /^季度报告-[a-f0-9]{10}\.xlsx$/u)
    assert.deepEqual(
      await service.describeDelivery(
        'run-1',
        cwd,
        await realpath(cwd),
        undefined,
        'stable-default'
      ),
      defaultName
    )
    assert.deepEqual((await readdir(cwd)).sort(), ['source.xlsx'])
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('delivery commits checks and presentation validation before the v2 output receipt', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'office-deliver-transaction-'))
  const artifactRoot = await mkdtemp(join(tmpdir(), 'office-deliver-artifact-'))
  const sourcePath = join(cwd, 'source.xlsx')
  const draftPath = join(artifactRoot, '季度报告.xlsx')
  const draftBytes = Buffer.from('immutable-delivery')
  let authorized = 0
  let checkedPath = ''
  let checkedCalls = 0
  try {
    await writeFile(sourcePath, 'source')
    await writeFile(draftPath, draftBytes)
    const dependencies = serviceDependencies(sourcePath, draftPath, {
      verifySavedDraft: async () => ({ sha256: digest(draftBytes), size: draftBytes.length }),
      verifyOutputFile: async (path) => {
        const bytes = await readFile(path)
        return { sha256: digest(bytes), size: bytes.length }
      },
      checkDeliveredOutput: async (input) => {
        checkedCalls += 1
        checkedPath = input.outputPath
        assert.deepEqual(await readFile(input.outputPath), draftBytes)
        return {
          checks: [{ name: 'xlsx_content', status: 'passed', sampled: 1 }],
          warnings: ['preview_not_confirmed']
        }
      },
      outputId: () => 'delivery-1',
      now: () => new Date('2026-10-05T13:00:00.000Z')
    })
    const service = new OfficeService(dependencies)
    await service.open(openRequest(cwd, sourcePath))
    service.bindRunTarget({
      runId: 'run-1',
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: 'project-1'
    })
    const cwdRealPath = await realpath(cwd)
    assert.equal(
      await service.shouldBypassDeliverApproval(
        'run-1',
        cwd,
        cwdRealPath,
        '最终报告',
        'tool-call-deliver-1'
      ),
      false
    )
    const result = await service.deliverDocument('run-1', cwd, cwdRealPath, '最终报告', {
      operationId: 'tool-call-deliver-1',
      authorize: () => {
        authorized += 1
        return true
      },
      validatePresentation: async (pending) => {
        assert.equal(pending.absolutePath, join(cwdRealPath, '最终报告.xlsx'))
        await assert.rejects(readFile(join(artifactRoot, 'outputs.json')))
      }
    })

    assert.equal(authorized, 1)
    assert.equal(checkedPath, join(cwdRealPath, '最终报告.xlsx'))
    assert.deepEqual(result, {
      absolutePath: join(cwdRealPath, '最终报告.xlsx'),
      outputPath: '最终报告.xlsx',
      fileName: '最终报告.xlsx',
      outputId: 'delivery-1',
      kind: 'xlsx',
      revision: 0,
      sha256: digest(draftBytes),
      size: draftBytes.length,
      warnings: ['preview_not_confirmed'],
      checks: [
        { name: 'schema', status: 'passed' },
        { name: 'xlsx_content', status: 'passed', sampled: 1 }
      ]
    })
    const [draftStats, outputStats] = await Promise.all([
      lstat(draftPath),
      lstat(result.absolutePath)
    ])
    assert.notEqual(draftStats.ino, outputStats.ino)
    const log = await loadOfficeOutputLog(draftPath)
    assert.equal(log.version, 2)
    assert.equal(log.outputs.length, 1)

    assert.equal(
      await service.shouldBypassDeliverApproval(
        'run-1',
        cwd,
        cwdRealPath,
        '最终报告',
        'tool-call-deliver-1'
      ),
      true
    )
    const replay = await service.deliverDocument('run-1', cwd, cwdRealPath, '最终报告', {
      operationId: 'tool-call-deliver-1',
      authorize: () => {
        authorized += 1
        return true
      }
    })
    assert.deepEqual(replay, { ...result, deduplicated: true })
    assert.equal(authorized, 1)
    assert.equal(checkedCalls, 1)
    assert.equal((await loadOfficeOutputLog(draftPath)).outputs.length, 1)
    await assert.rejects(
      service.deliverDocument('run-1', cwd, cwdRealPath, '另一个名字', {
        operationId: 'tool-call-deliver-1'
      }),
      { code: 'operation_conflict' }
    )
    const restarted = new OfficeService({
      ...dependencies,
      resolveRegisteredDraftByArtifactId: async (sessionId, artifactId) => ({
        artifactId,
        sessionId,
        projectId: 'project-1',
        kind: 'xlsx',
        sourcePath,
        sourceHash: digest(await readFile(sourcePath)),
        draftPath
      })
    })
    assert.equal(
      await restarted.resolveOutputPath('artifact-1', 'session-1', cwdRealPath, result.outputId),
      result.absolutePath
    )
    const frozen = new OfficeService({
      ...dependencies,
      loadOperationLog: async () => ({
        version: 2,
        contentRevision: 4,
        operations: {},
        freezeState: 'unknown',
        needsSave: true
      })
    })
    await frozen.open(openRequest(cwd, sourcePath))
    frozen.bindRunTarget({
      runId: 'run-replay',
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: 'project-1'
    })
    assert.deepEqual(
      await frozen.deliverDocument('run-replay', cwd, cwdRealPath, '最终报告', {
        operationId: 'tool-call-deliver-1'
      }),
      { ...result, deduplicated: true }
    )
    await frozen.dispose()
    await writeFile(result.absolutePath, 'tampered')
    await assert.rejects(
      restarted.resolveOutputPath('artifact-1', 'session-1', cwdRealPath, result.outputId),
      { code: 'output_integrity_failed' }
    )
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

test('check and presentation failures remove only the attempted output and preserve the draft', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'office-deliver-cleanup-'))
  const artifactRoot = await mkdtemp(join(tmpdir(), 'office-deliver-cleanup-artifact-'))
  const sourcePath = join(cwd, 'source.xlsx')
  const draftPath = join(artifactRoot, 'draft.xlsx')
  const bytes = Buffer.from('draft-must-survive')
  let failCheck = true
  try {
    await writeFile(sourcePath, 'source')
    await writeFile(draftPath, bytes)
    const service = new OfficeService(
      serviceDependencies(sourcePath, draftPath, {
        verifySavedDraft: async () => ({ sha256: digest(bytes), size: bytes.length }),
        verifyOutputFile: async (path) => {
          const output = await readFile(path)
          return { sha256: digest(output), size: output.length }
        },
        checkDeliveredOutput: async () => {
          if (failCheck) {
            throw new OfficeSaveAsError('delivery_check_failed', 'content mismatch')
          }
          return {
            checks: [{ name: 'xlsx_content', status: 'passed', sampled: 0 }],
            warnings: []
          }
        }
      })
    )
    await service.open(openRequest(cwd, sourcePath))
    service.bindRunTarget({
      runId: 'run-1',
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: 'project-1'
    })
    const cwdRealPath = await realpath(cwd)
    await assert.rejects(
      service.deliverDocument('run-1', cwd, cwdRealPath, 'check-failed', {
        operationId: 'check-failed'
      }),
      { code: 'delivery_check_failed' }
    )
    failCheck = false
    await assert.rejects(
      service.deliverDocument('run-1', cwd, cwdRealPath, 'presentation-failed', {
        operationId: 'presentation-failed',
        validatePresentation: () => {
          throw new Error('present_files rejected path')
        }
      }),
      { code: 'presentation_validation_failed' }
    )

    assert.deepEqual(await readFile(draftPath), bytes)
    assert.deepEqual((await readdir(cwd)).sort(), ['source.xlsx'])
    await assert.rejects(readFile(join(artifactRoot, 'outputs.json')))
  } finally {
    await rm(cwd, { recursive: true, force: true })
    await rm(artifactRoot, { recursive: true, force: true })
  }
})

async function openBoundService(
  cwd: string,
  sourcePath: string,
  draftPath: string
): Promise<OfficeService> {
  const service = new OfficeService(serviceDependencies(sourcePath, draftPath))
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
    armPreviewConfirmation: () => ({ promise: Promise.resolve(true), cancel: () => undefined }),
    loadOperationLog: async () => ({
      version: 2,
      contentRevision: 0,
      operations: {},
      saveState: 'saved',
      lastSavedRevision: 0,
      savedDraftHash: digest(Buffer.from('draft'))
    }),
    ...overrides
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
