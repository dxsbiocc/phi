import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  OfficePptxOperation,
  OfficePptxSnapshot,
  OfficePptxWriteReceipt
} from '../src/main/agent/office/office-pptx-contract'
import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'

test('background PPTX add keeps the foreground run bound to its unchanged document', async () => {
  const snapshots = new Map<string, OfficePptxSnapshot>()
  const service = new OfficeService(dependencies(snapshots))
  const foreground = await open(service, 'foreground')
  const background = await open(service, 'background')

  service.bindRunTarget(binding('run-foreground', foreground.artifactId, 'foreground'))
  service.bindRunTarget(binding('run-background', background.artifactId, 'background'))

  await service.applyWriteRequest(
    'run-background',
    { operation: { type: 'add_slide', title: '后台新增页' }, baseRevision: 0 },
    { operationId: 'background-add' }
  )

  assert.equal(service.resolveRunTarget('run-foreground').artifactId, foreground.artifactId)
  assert.equal(snapshots.get(foreground.draftPath)?.slideCount, 0)
  assert.equal(snapshots.get(background.draftPath)?.slideCount, 1)
  await service.dispose()
})

function dependencies(snapshots: Map<string, OfficePptxSnapshot>): OfficeServiceDependencies {
  return {
    ...lifecycleDependencies(snapshots),
    ...writeDependencies(snapshots)
  } as OfficeServiceDependencies
}

function lifecycleDependencies(
  snapshots: Map<string, OfficePptxSnapshot>
): Partial<OfficeServiceDependencies> {
  return {
    detectRuntime: async () => ({
      state: 'available',
      binaryPath: '/officecli',
      version: '1.0.153',
      platform: 'darwin-arm64'
    }),
    prepareDraft: async (input) => {
      const name = input.sourcePath.includes('foreground') ? 'foreground' : 'background'
      const draftPath = `/sessions/${input.sessionId}/artifacts/office/${name}/${name}.pptx`
      snapshots.set(draftPath, emptySnapshot())
      return {
        artifactId: `artifact-${name}`,
        sessionId: input.sessionId,
        projectId: input.projectId,
        kind: 'pptx',
        sourcePath: input.sourcePath,
        sourceHash: `hash-${name}`,
        draftPath
      }
    },
    prepareBlankDraft: async () => {
      throw new Error('unused')
    },
    startDocument: async () => ({ residentPid: 101 }),
    adoptCreatedDocument: async () => ({ residentPid: 101 }),
    startPreview: async (_binaryPath, artifact) => ({
      watchPid: 202,
      watchPort: artifact.artifactId === 'artifact-foreground' ? 31_001 : 31_002,
      gatewayPort: artifact.artifactId === 'artifact-foreground' ? 42_001 : 42_002,
      previewUrl: `http://127.0.0.1/${artifact.artifactId}/`,
      slideCount: 0
    }),
    stopPreview: async () => undefined,
    closeDocument: async () => undefined,
    removeBlankDraft: async () => undefined,
    validateRegisteredDraft: async () => undefined,
    assertNotOfficeArtifactPath: async () => undefined,
    resolveSelection: async () => null,
    clearSelection: async () => undefined
  }
}

function writeDependencies(
  snapshots: Map<string, OfficePptxSnapshot>
): Partial<OfficeServiceDependencies> {
  return {
    readRange: async () => {
      throw new Error('must not read xlsx')
    },
    applyCellValue: async () => {
      throw new Error('must not write xlsx')
    },
    readPptxSnapshot: async (context) => snapshots.get(context.draftPath) ?? emptySnapshot(),
    applyPptxOperation: async (context, operation) =>
      applyOperation(snapshots, context.draftPath, operation),
    saveDraft: async () => undefined,
    armPreviewConfirmation: () => ({ promise: Promise.resolve(false), cancel: () => undefined }),
    armDocumentPreviewConfirmation: () => ({
      promise: Promise.resolve(true),
      cancel: () => undefined,
      markDispatched: () => undefined
    }),
    loadOperationLog: async () => ({ version: 2, contentRevision: 0, operations: {} }),
    persistOperationLog: async () => undefined
  }
}

function applyOperation(
  snapshots: Map<string, OfficePptxSnapshot>,
  draftPath: string,
  operation: OfficePptxOperation
): OfficePptxWriteReceipt {
  if (operation.type !== 'add_slide') throw new Error('unexpected operation')
  const current = snapshots.get(draftPath) ?? emptySnapshot()
  const slideId = '256'
  const slide = {
    slideId,
    index: current.slideCount,
    title: operation.title,
    elements: [
      {
        elementId: '2',
        path: `/slide[@id=${slideId}]/shape[@id=2]`,
        cliPath: `/slide[${current.slideCount + 1}]/shape[@id=2]`,
        kind: 'title' as const,
        text: operation.title,
        editable: true
      }
    ]
  }
  snapshots.set(draftPath, {
    slides: Object.freeze([...current.slides, slide]),
    slideCount: current.slideCount + 1
  })
  return { type: operation.type, slideId, path: `/slide[@id=${slideId}]`, index: slide.index }
}

async function open(
  service: OfficeService,
  sessionId: string
): Promise<{ artifactId: string; draftPath: string }> {
  const result = await service.open({
    sessionId,
    projectId: 'project-1',
    sourcePath: `/project/${sessionId}.pptx`,
    allowRoots: ['/project']
  })
  assert.equal(result.state, 'ready')
  if (result.state !== 'ready') throw new Error(result.message)
  return result.document
}

function binding(
  runId: string,
  artifactId: string,
  sessionId: string
): { runId: string; artifactId: string; sessionId: string; projectId: string } {
  return { runId, artifactId, sessionId, projectId: 'project-1' }
}

function emptySnapshot(): OfficePptxSnapshot {
  return { slides: Object.freeze([]), slideCount: 0 }
}
