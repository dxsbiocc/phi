import assert from 'node:assert/strict'
import test from 'node:test'

import { OfficeService } from '../src/main/agent/office/office-service'
import type { OfficeServiceDependencies } from '../src/main/agent/office/office-service-state'
import { OfficeDraftIntegrityError } from '../src/main/agent/office/office-draft-integrity'

const artifact = {
  artifactId: 'artifact-existing',
  sessionId: 'session-1',
  projectId: 'project-1',
  sourcePath: '/real/project/book.xlsx',
  sourceHash: 'a'.repeat(64),
  draftPath: '/sessions/session-1/artifacts/office/artifact-existing/book.xlsx'
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
    prepareDraft: async () => ({ ...artifact, artifactId: 'artifact-new' }),
    prepareBlankDraft: async () => {
      throw new Error('unused')
    },
    startDocument: async () => ({ residentPid: 101 }),
    adoptCreatedDocument: async () => ({ residentPid: 102 }),
    startPreview: async () => ({
      watchPid: 201,
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
    ...overrides
  }
}

const request = {
  sessionId: 'session-1',
  projectId: 'project-1',
  sourcePath: '/alias/project/book.xlsx',
  allowRoots: ['/real/project']
}

test('reuses a registered source draft and resident for repeated opens', async () => {
  let prepareCalls = 0
  let residentStarts = 0
  const service = new OfficeService(
    dependencies({
      resolveRegisteredDraft: async () => ({
        kind: 'registered',
        artifact,
        match: 'source',
        normalizedSourcePath: artifact.sourcePath
      }),
      prepareDraft: async (...args) => {
        prepareCalls += 1
        return dependencies().prepareDraft(...args)
      },
      startDocument: async () => {
        residentStarts += 1
        return { residentPid: 101 }
      }
    })
  )

  const first = await service.open(request)
  const second = await service.open(request)

  assert.equal(first.state, 'ready')
  assert.equal(second.state, 'ready')
  if (first.state !== 'ready' || second.state !== 'ready') throw new Error('open failed')
  assert.equal(first.document.artifactId, artifact.artifactId)
  assert.equal(second.document.artifactId, artifact.artifactId)
  assert.equal(prepareCalls, 0)
  assert.equal(residentStarts, 1)
})

test('creates a new artifact and reports source_changed when a registered source changed', async () => {
  let prepareCalls = 0
  const service = new OfficeService(
    dependencies({
      resolveRegisteredDraft: async () => ({
        kind: 'source_changed',
        previousArtifact: artifact,
        normalizedSourcePath: artifact.sourcePath,
        currentSourceHash: 'b'.repeat(64)
      }),
      prepareDraft: async () => {
        prepareCalls += 1
        return { ...artifact, artifactId: 'artifact-new', sourceHash: 'b'.repeat(64) }
      }
    })
  )

  const opened = await service.open(request)

  assert.equal(opened.state, 'ready')
  if (opened.state !== 'ready') throw new Error(opened.message)
  assert.equal(opened.document.artifactId, 'artifact-new')
  assert.equal(prepareCalls, 1)
  assert.deepEqual(opened.restoreNotice, { kind: 'source_changed' })
})

test('DOCX reopen supports registered reuse, source change, and first-open creation', async () => {
  const docxArtifact = {
    ...artifact,
    kind: 'docx' as const,
    sourcePath: '/real/project/book.docx',
    draftPath: '/sessions/session-1/artifacts/office/artifact-existing/book.docx'
  }
  const docxRequest = {
    ...request,
    sourcePath: '/alias/project/book.docx'
  }
  const reused = new OfficeService(
    dependencies({
      resolveRegisteredDraft: async () => ({
        kind: 'registered',
        artifact: docxArtifact,
        match: 'source',
        normalizedSourcePath: docxArtifact.sourcePath
      })
    })
  )
  const changed = new OfficeService(
    dependencies({
      resolveRegisteredDraft: async () => ({
        kind: 'source_changed',
        previousArtifact: docxArtifact,
        normalizedSourcePath: docxArtifact.sourcePath,
        currentSourceHash: 'b'.repeat(64)
      }),
      prepareDraft: async () => ({
        ...docxArtifact,
        artifactId: 'artifact-docx-changed',
        sourceHash: 'b'.repeat(64)
      })
    })
  )
  const fresh = new OfficeService(
    dependencies({
      resolveRegisteredDraft: async () => ({
        kind: 'none',
        normalizedSourcePath: docxArtifact.sourcePath
      }),
      prepareDraft: async () => ({
        ...docxArtifact,
        artifactId: 'artifact-docx-new'
      })
    })
  )

  const results = await Promise.all([
    reused.open(docxRequest),
    changed.open(docxRequest),
    fresh.open(docxRequest)
  ])

  assert.deepEqual(
    results.map((result) =>
      result.state === 'ready'
        ? {
            artifactId: result.document.artifactId,
            kind: result.document.kind,
            notice: result.restoreNotice?.kind
          }
        : result
    ),
    [
      { artifactId: 'artifact-existing', kind: 'docx', notice: 'recovered' },
      { artifactId: 'artifact-docx-changed', kind: 'docx', notice: 'source_changed' },
      { artifactId: 'artifact-docx-new', kind: 'docx', notice: undefined }
    ]
  )
})

test('PPTX reopen supports registered reuse, source change, and first-open creation', async () => {
  const pptxArtifact = {
    ...artifact,
    kind: 'pptx' as const,
    sourcePath: '/real/project/slides.pptx',
    draftPath: '/sessions/session-1/artifacts/office/artifact-existing/slides.pptx'
  }
  const pptxRequest = {
    ...request,
    sourcePath: '/alias/project/slides.pptx'
  }
  const reused = new OfficeService(
    dependencies({
      resolveRegisteredDraft: async () => ({
        kind: 'registered',
        artifact: pptxArtifact,
        match: 'source',
        normalizedSourcePath: pptxArtifact.sourcePath
      }),
      startPreview: async () => ({
        watchPid: 201,
        watchPort: 31_001,
        gatewayPort: 42_001,
        previewUrl: 'http://127.0.0.1:42001/',
        previewState: 'ready',
        slideCount: 0
      })
    })
  )
  const changed = new OfficeService(
    dependencies({
      resolveRegisteredDraft: async () => ({
        kind: 'source_changed',
        previousArtifact: pptxArtifact,
        normalizedSourcePath: pptxArtifact.sourcePath,
        currentSourceHash: 'b'.repeat(64)
      }),
      prepareDraft: async () => ({
        ...pptxArtifact,
        artifactId: 'artifact-pptx-changed',
        sourceHash: 'b'.repeat(64)
      })
    })
  )
  const fresh = new OfficeService(
    dependencies({
      resolveRegisteredDraft: async () => ({
        kind: 'none',
        normalizedSourcePath: pptxArtifact.sourcePath
      }),
      prepareDraft: async () => ({
        ...pptxArtifact,
        artifactId: 'artifact-pptx-new'
      })
    })
  )

  const results = await Promise.all([
    reused.open(pptxRequest),
    changed.open(pptxRequest),
    fresh.open(pptxRequest)
  ])

  assert.deepEqual(
    results.map((result) =>
      result.state === 'ready'
        ? {
            artifactId: result.document.artifactId,
            kind: result.document.kind,
            slideCount: result.document.slideCount,
            notice: result.restoreNotice?.kind
          }
        : result
    ),
    [
      { artifactId: 'artifact-existing', kind: 'pptx', slideCount: 0, notice: 'recovered' },
      {
        artifactId: 'artifact-pptx-changed',
        kind: 'pptx',
        slideCount: undefined,
        notice: 'source_changed'
      },
      {
        artifactId: 'artifact-pptx-new',
        kind: 'pptx',
        slideCount: undefined,
        notice: undefined
      }
    ]
  )
})

test('cleans stale processes and checks integrity before starting a replacement resident', async () => {
  const events: string[] = []
  const service = new OfficeService(
    dependencies({
      resolveRegisteredDraft: async () => ({
        kind: 'registered',
        artifact,
        match: 'source',
        normalizedSourcePath: artifact.sourcePath
      }),
      prepareRegisteredDraftForOpen: async () => {
        events.push('stale-then-integrity')
        return {
          issue: 'draft_hash_mismatch',
          operationLog: {
            version: 2,
            contentRevision: 4,
            operations: {},
            freezeState: 'unknown',
            needsSave: true,
            saveState: 'saved',
            lastSavedRevision: 4,
            savedDraftHash: 'a'.repeat(64),
            lastReconcile: {
              conclusion: 'indeterminate',
              at: new Date(0).toISOString(),
              reason: '草稿文件与最后一次确认保存的内容不一致，需要核对',
              revision: 4
            }
          }
        }
      },
      startDocument: async () => {
        events.push('start')
        return { residentPid: 101 }
      }
    })
  )

  const opened = await service.open(request)

  assert.deepEqual(events, ['stale-then-integrity', 'start'])
  assert.equal(opened.state, 'ready')
  if (opened.state !== 'ready') throw new Error(opened.message)
  assert.equal(opened.freezeState, 'unknown')
  assert.equal(opened.saveState, 'unsaved')
  assert.equal(opened.lastSavedRevision, 4)
  assert.deepEqual(opened.restoreNotice, { kind: 'draft_hash_mismatch' })
})

test('fresh creates a new artifact without closing or replacing the broken registered draft', async () => {
  let closeCalls = 0
  let resolverSawFresh = false
  const service = new OfficeService(
    dependencies({
      resolveRegisteredDraft: async (input) => {
        resolverSawFresh = input.fresh === true
        return { kind: 'none', normalizedSourcePath: artifact.sourcePath }
      },
      prepareDraft: async () => ({
        ...artifact,
        artifactId: 'artifact-fresh',
        draftPath: '/sessions/session-1/artifacts/office/artifact-fresh/book.xlsx'
      }),
      closeDocument: async () => {
        closeCalls += 1
      }
    })
  )

  const opened = await service.open({ ...request, fresh: true })

  assert.equal(opened.state, 'ready')
  if (opened.state !== 'ready') throw new Error(opened.message)
  assert.equal(opened.document.artifactId, 'artifact-fresh')
  assert.equal(resolverSawFresh, true)
  assert.equal(closeCalls, 0)
})

test('a missing registered draft fails before process startup and exposes controlled recreation', async () => {
  let residentStarts = 0
  const service = new OfficeService(
    dependencies({
      resolveRegisteredDraft: async () => ({
        kind: 'registered',
        artifact,
        match: 'source',
        normalizedSourcePath: artifact.sourcePath
      }),
      prepareRegisteredDraftForOpen: async () => {
        throw new OfficeDraftIntegrityError(
          'draft_missing',
          'Office 草稿文件已丢失，可从原文件重新创建',
          true
        )
      },
      startDocument: async () => {
        residentStarts += 1
        return { residentPid: 101 }
      }
    })
  )

  const opened = await service.open(request)

  assert.deepEqual(opened, {
    state: 'error',
    sourcePath: request.sourcePath,
    code: 'draft_missing',
    message: 'Office 草稿文件已丢失，可从原文件重新创建',
    canRecreateFromSource: true
  })
  assert.equal(residentStarts, 0)
})
