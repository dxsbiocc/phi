import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import type {
  OfficeReadContext,
  OfficeReadParams,
  OfficeReadResponse
} from '../src/main/agent/office/office-read'

function dependencies(
  readRange: (context: OfficeReadContext, params: OfficeReadParams) => Promise<OfficeReadResponse>,
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
    readRange,
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

test('readRange resolves only the run-bound draft and supplies its content revision', async () => {
  const calls: Array<{ context: OfficeReadContext; params: OfficeReadParams }> = []
  const expected = Object.freeze({
    revision: 0,
    sheets: Object.freeze([]),
    complete: false as const,
    truncated: false as const,
    hint: 'specify range',
    limits: Object.freeze({ maxCells: 2_000, maxBytes: 256 * 1024 })
  })
  const service = new OfficeService(
    dependencies(async (context, params) => {
      calls.push({ context, params })
      return expected
    })
  )
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    selection: {
      sheet: 'Sheet1',
      range: 'A1:B3',
      paths: ['/Sheet1/A1:B3'],
      resolvedAt: '2026-10-04T12:00:00.000Z'
    }
  })

  assert.equal(await service.readRange('run-1', {}), expected)
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0]?.params, {})
  assert.deepEqual(calls[0]?.context, {
    artifactId: 'artifact-1',
    binaryPath: '/officecli',
    draftPath: '/sessions/session-1/artifacts/office/artifact-1/source.xlsx',
    revision: 0,
    selection: {
      sheet: 'Sheet1',
      range: 'A1:B3',
      paths: ['/Sheet1/A1:B3'],
      resolvedAt: '2026-10-04T12:00:00.000Z'
    },
    signal: calls[0]?.context.signal
  })
  assert.ok(calls[0]?.context.signal instanceof AbortSignal)
})

test('readRange reports no_target and target_missing without a visible-document fallback', async () => {
  const service = new OfficeService(
    dependencies(async () => {
      throw new Error('must not read')
    })
  )
  await service.open(openRequest)
  await assert.rejects(service.readRange('unbound-run', {}), { code: 'no_target' })

  service.bindRunTarget({
    runId: 'released-run',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  service.clearRunTarget('released-run')
  await assert.rejects(service.readRange('released-run', {}), { code: 'target_missing' })
})

test('readRange rejects DOCX pagination arguments for an XLSX target', async () => {
  let reads = 0
  const service = new OfficeService(
    dependencies(async () => {
      reads += 1
      throw new Error('must not read')
    })
  )
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-xlsx-invalid',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  await assert.rejects(service.readRange('run-xlsx-invalid', { from: 0, limit: 10 }), {
    code: 'invalid_arguments'
  })
  assert.equal(reads, 0)
})

test('readRange dispatches a bound DOCX to the paragraph reader without invoking XLSX', async () => {
  let spreadsheetReads = 0
  let paragraphReads = 0
  const expected = {
    revision: 0,
    paragraphs: [],
    total: 0,
    complete: true,
    truncated: false,
    limits: {
      maxParagraphs: 200,
      maxParagraphBytes: 16_384,
      maxTextBytes: 196_608,
      maxBytes: 262_144
    }
  }
  const service = new OfficeService(
    dependencies(
      async () => {
        spreadsheetReads += 1
        throw new Error('must not read')
      },
      {
        readParagraphs: async (_context, params) => {
          paragraphReads += 1
          assert.deepEqual(params, { from: 0, limit: 10 })
          return expected
        }
      } as never
    )
  )
  await service.open({ ...openRequest, sourcePath: '/project/source.docx' })
  service.bindRunTarget({
    runId: 'run-docx',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  assert.equal(await service.readRange('run-docx', { from: 0, limit: 10 }), expected)
  assert.equal(spreadsheetReads, 0)
  assert.equal(paragraphReads, 1)
})

test('readRange dispatches a bound PPTX to the slide reader without other readers', async () => {
  let spreadsheetReads = 0
  let paragraphReads = 0
  let slideReads = 0
  const expected = emptyPptxReadResult()
  const service = new OfficeService(
    dependencies(
      async () => {
        spreadsheetReads += 1
        throw new Error('must not read')
      },
      {
        readParagraphs: async () => {
          paragraphReads += 1
          throw new Error('must not read')
        },
        readSlides: async (_context, params) => {
          slideReads += 1
          assert.deepEqual(params, {})
          return expected
        }
      } as never
    )
  )
  await service.open({ ...openRequest, sourcePath: '/project/source.pptx' })
  service.bindRunTarget({
    runId: 'run-pptx',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  assert.equal(await service.readRange('run-pptx', {}), expected)
  assert.equal(spreadsheetReads, 0)
  assert.equal(paragraphReads, 0)
  assert.equal(slideReads, 1)
})

function emptyPptxReadResult(): {
  revision: number
  slides: never[]
  total: number
  complete: boolean
  truncated: boolean
  limits: Record<string, number>
} {
  return {
    revision: 0,
    slides: [],
    total: 0,
    complete: true,
    truncated: false,
    limits: {
      maxSlides: 50,
      maxElementsPerSlide: 100,
      maxElementBytes: 8_192,
      maxSlideTextBytes: 32_768,
      maxTextBytes: 196_608,
      maxBytes: 262_144
    }
  }
}

test('closing a session during a read aborts it and reports target_missing', async () => {
  let finishRead!: () => void
  const readPending = new Promise<void>((resolve) => {
    finishRead = resolve
  })
  let started!: () => void
  const readStarted = new Promise<void>((resolve) => {
    started = resolve
  })
  let readSignal: AbortSignal | undefined
  const result = Object.freeze({
    revision: 0,
    sheets: Object.freeze([]),
    complete: false as const,
    truncated: false as const,
    hint: 'specify range',
    limits: Object.freeze({ maxCells: 2_000, maxBytes: 256 * 1024 })
  })
  const service = new OfficeService(
    dependencies(async (context) => {
      readSignal = context.signal
      started()
      await readPending
      return result
    })
  )
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-race',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  const reading = service.readRange('run-race', {})
  await readStarted
  const closing = service.closeSession('session-1')
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(readSignal?.aborted, true)
  finishRead()

  await assert.rejects(reading, { code: 'target_missing' })
  await closing
})

test('reads for one artifact execute serially on its document operation queue', async () => {
  let releaseFirst!: () => void
  const firstPending = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const starts: number[] = []
  const result = Object.freeze({
    revision: 0,
    sheets: Object.freeze([]),
    complete: false as const,
    truncated: false as const,
    hint: 'specify range',
    limits: Object.freeze({ maxCells: 2_000, maxBytes: 256 * 1024 })
  })
  const service = new OfficeService(
    dependencies(async () => {
      const index = starts.length + 1
      starts.push(index)
      if (index === 1) await firstPending
      return result
    })
  )
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-queue',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  const first = service.readRange('run-queue', {})
  const second = service.readRange('run-queue', {})
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(starts, [1])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(starts, [1, 2])
})

test('a read rebuilds dead Office processes before using the resident', async () => {
  const recovered: string[] = []
  const result = Object.freeze({
    revision: 0,
    sheets: Object.freeze([]),
    complete: false as const,
    truncated: false as const,
    hint: 'specify range',
    limits: Object.freeze({ maxCells: 2_000, maxBytes: 256 * 1024 })
  })
  const service = new OfficeService(
    dependencies(async () => result, {
      isProcessAlive: (pid) => pid === 202,
      recoverDocument: async (owned, state) => {
        recovered.push(`${owned.document.artifactId}:${state.residentAlive}:${state.watchAlive}`)
        return {
          residentPid: 303,
          watchPid: 404,
          watchPort: 31_002,
          gatewayPort: 42_002,
          previewUrl: 'http://127.0.0.1:42002/'
        }
      }
    })
  )
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'run-recover',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  assert.equal(await service.readRange('run-recover', {}), result)
  assert.deepEqual(recovered, ['artifact-1:false:true'])
  const status = service.statusForSource(openRequest.sessionId, openRequest.sourcePath)
  assert.equal(status?.state, 'ready')
  if (status?.state === 'ready') {
    assert.equal(status.document.residentPid, 303)
    assert.equal(status.document.watchPid, 404)
    assert.equal(status.document.previewUrl, 'http://127.0.0.1:42002/')
  }
})

test('stopping a run settles its active read without affecting another run', async () => {
  const firstStarted = deferredSignal()
  let calls = 0
  const result = Object.freeze({
    revision: 0,
    sheets: Object.freeze([]),
    complete: false as const,
    truncated: false as const,
    hint: 'specify range',
    limits: Object.freeze({ maxCells: 2_000, maxBytes: 256 * 1024 })
  })
  const service = new OfficeService(
    dependencies(async (context) => {
      calls += 1
      if (calls > 1) return result
      firstStarted.resolve()
      await new Promise<void>((_resolve, reject) => {
        context.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
          once: true
        })
      })
      return result
    })
  )
  await service.open(openRequest)
  for (const runId of ['run-a', 'run-b']) {
    service.bindRunTarget({
      runId,
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectId: 'project-1'
    })
  }

  const activeRead = service.readRange('run-a', {})
  await firstStarted.promise
  assert.equal(service.clearRunTarget('run-a'), true)

  await assert.rejects(activeRead, { code: 'read_cancelled' })
  assert.equal(await service.readRange('run-b', {}), result)
})

function deferredSignal(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
