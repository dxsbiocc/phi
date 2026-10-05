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
import {
  OfficeWriteError,
  type OfficeWriteRequest
} from '../src/main/agent/office/office-write-contract'

test('PPTX add slide uses shared transaction, preview confirmation, and operation-id replay', async () => {
  const harness = pptxHarness([])
  const service = await openBoundPptx(harness.dependencies)
  const request = writeRequest({ type: 'add_slide', title: '标题', body: '正文' }, 0)

  const first = await service.applyWriteRequest('run-pptx', request, { operationId: 'pptx-add-1' })
  const replay = await service.applyWriteRequest('run-pptx', request, { operationId: 'pptx-add-1' })

  assert.equal(harness.applyCount(), 1)
  assert.equal('slideId' in first ? first.slideId : undefined, '256')
  assert.equal('title' in first ? first.title : undefined, '标题')
  assert.equal(first.previewConfirmed, true)
  assert.deepEqual(replay, { ...first, deduplicated: true })
  assert.equal(harness.slides().length, 1)
})

test('PPTX set rejects stale expectedText before mutation', async () => {
  const harness = pptxHarness([slide('256', 0, '当前标题')])
  const service = await openBoundPptx(harness.dependencies)
  await assert.rejects(
    service.applyWriteRequest(
      'run-pptx',
      writeRequest(
        {
          type: 'set_slide_text',
          slideId: '256',
          elementId: '2',
          text: '新标题',
          expectedText: '过期'
        },
        0
      ),
      { operationId: 'pptx-stale' }
    ),
    { code: 'stale_target' }
  )
  assert.equal(harness.applyCount(), 0)
})

test('unknown PPTX add and set reconcile without retrying writes', async () => {
  const addHarness = pptxHarness([], { unknownAfterApply: true })
  const addService = await openBoundPptx(addHarness.dependencies)
  const added = await addService.applyWriteRequest(
    'run-pptx',
    writeRequest({ type: 'add_slide', title: '只加一次' }, 0),
    { operationId: 'pptx-add-unknown' }
  )
  assert.equal(addHarness.applyCount(), 1)
  assert.equal(added.reconciled, true)
  assert.equal(addHarness.slides().length, 1)

  const setHarness = pptxHarness([slide('256', 0, '旧标题')], { unknownAfterApply: true })
  const setService = await openBoundPptx(setHarness.dependencies)
  const changed = await setService.applyWriteRequest(
    'run-pptx',
    writeRequest(
      {
        type: 'set_slide_text',
        slideId: '256',
        elementId: '2',
        text: '新标题',
        expectedText: '旧标题'
      },
      0
    ),
    { operationId: 'pptx-set-unknown' }
  )
  assert.equal(setHarness.applyCount(), 1)
  assert.equal(changed.reconciled, true)
  assert.equal(setHarness.slides()[0]?.title, '新标题')
})

test('PPTX set read-back mismatch restores the original element', async () => {
  const harness = pptxHarness([slide('256', 0, '回滚前')], { mismatchAfterApply: true })
  const service = await openBoundPptx(harness.dependencies)
  await assert.rejects(
    service.applyWriteRequest(
      'run-pptx',
      writeRequest(
        {
          type: 'set_slide_text',
          slideId: '256',
          elementId: '2',
          text: '目标',
          expectedText: '回滚前'
        },
        0
      ),
      { operationId: 'pptx-rollback' }
    ),
    { code: 'write_failed' }
  )
  assert.equal(harness.restoreCount(), 1)
  assert.equal(harness.slides()[0]?.title, '回滚前')
})

test('PPTX add read-back mismatch removes the newly added slide', async () => {
  const harness = pptxHarness([], { mismatchAfterApply: true })
  const service = await openBoundPptx(harness.dependencies)

  await assert.rejects(
    service.applyWriteRequest(
      'run-pptx',
      writeRequest({ type: 'add_slide', title: '必须回滚' }, 0),
      { operationId: 'pptx-add-rollback' }
    ),
    { code: 'write_failed' }
  )

  assert.equal(harness.restoreCount(), 1)
  assert.deepEqual(harness.slides(), [])
})

test('PPTX operations and spreadsheet operations reject mismatched document kinds before writes', async () => {
  let pptxWrites = 0
  const docxDependencies = baseDependencies({
    prepareDraft: async (input) => ({
      artifactId: 'artifact-pptx',
      sessionId: input.sessionId,
      projectId: input.projectId,
      kind: 'docx',
      sourcePath: input.sourcePath,
      sourceHash: 'hash',
      draftPath: '/session/artifact/document.docx'
    }),
    applyPptxOperation: async () => {
      pptxWrites += 1
      throw new Error('must not write')
    }
  })
  const docx = await openBoundPptx(docxDependencies)
  await assert.rejects(
    docx.applyWriteRequest('run-pptx', writeRequest({ type: 'add_slide', title: '错误目标' }, 0), {
      operationId: 'pptx-wrong-kind'
    }),
    { code: 'operation_not_supported_for_kind' }
  )
  assert.equal(pptxWrites, 0)

  const harness = pptxHarness([])
  const pptx = await openBoundPptx(harness.dependencies)
  await assert.rejects(
    pptx.applyWriteRequest(
      'run-pptx',
      {
        operation: { type: 'set_cell', sheet: 'Sheet1', cell: 'A1', value: 'x' },
        baseRevision: 0
      },
      { operationId: 'xlsx-wrong-kind' }
    ),
    { code: 'operation_not_supported_for_kind' }
  )
})

function pptxHarness(
  initial: OfficePptxSnapshot['slides'],
  options: { readonly unknownAfterApply?: boolean; readonly mismatchAfterApply?: boolean } = {}
): {
  dependencies: OfficeServiceDependencies
  applyCount: () => number
  restoreCount: () => number
  slides: () => OfficePptxSnapshot['slides']
} {
  const state = { current: [...initial], nextId: 256, applications: 0, restores: 0 }
  const dependencies = baseDependencies({
    readPptxSnapshot: async () => snapshot(state.current),
    applyPptxOperation: async (_context, operation) =>
      applyHarnessOperation(state, operation, options),
    restorePptxOperation: async (_context, operation, before, receipt) =>
      restoreHarnessOperation(state, operation, before, receipt),
    armDocumentPreviewConfirmation: () => ({
      promise: Promise.resolve(true),
      cancel: () => undefined,
      markDispatched: () => undefined
    })
  })
  return {
    dependencies,
    applyCount: () => state.applications,
    restoreCount: () => state.restores,
    slides: () => state.current
  }
}

type HarnessState = {
  current: OfficePptxSnapshot['slides']
  nextId: number
  applications: number
  restores: number
}

async function applyHarnessOperation(
  state: HarnessState,
  operation: OfficePptxOperation,
  options: { readonly unknownAfterApply?: boolean; readonly mismatchAfterApply?: boolean }
): Promise<OfficePptxWriteReceipt> {
  state.applications += 1
  if (operation.type === 'add_slide') {
    while (state.current.some((entry) => entry.slideId === String(state.nextId))) state.nextId += 1
    const index = insertionIndex(operation, state.current)
    const added = slide(
      String(state.nextId++),
      index,
      options.mismatchAfterApply ? '错误读回' : operation.title,
      operation.body
    )
    state.current = reindex([
      ...state.current.slice(0, index),
      added,
      ...state.current.slice(index)
    ])
    if (options.unknownAfterApply) throw new OfficeWriteError('write_unknown', 'unknown')
    return {
      type: operation.type,
      slideId: added.slideId,
      path: `/slide[@id=${added.slideId}]`,
      index
    }
  }
  const text = options.mismatchAfterApply ? '错误读回' : operation.text
  state.current = state.current.map((entry) =>
    entry.slideId === operation.slideId ? updateElement(entry, operation.elementId, text) : entry
  )
  if (options.unknownAfterApply) throw new OfficeWriteError('write_unknown', 'unknown')
  return {
    type: operation.type,
    slideId: operation.slideId,
    elementId: operation.elementId,
    path: `/slide[@id=${operation.slideId}]/shape[@id=${operation.elementId}]`
  }
}

async function restoreHarnessOperation(
  state: HarnessState,
  operation: OfficePptxOperation,
  before: Parameters<NonNullable<OfficeServiceDependencies['restorePptxOperation']>>[2],
  receipt: OfficePptxWriteReceipt
): Promise<void> {
  state.restores += 1
  if (operation.type === 'add_slide') {
    state.current = reindex(state.current.filter((entry) => entry.slideId !== receipt.slideId))
    return
  }
  if (before.type !== 'set_slide_text') throw new Error('bad before')
  state.current = state.current.map((entry) =>
    entry.slideId === before.slideId ? updateElement(entry, before.elementId, before.text) : entry
  )
}

function baseDependencies(
  overrides: Partial<OfficeServiceDependencies>
): OfficeServiceDependencies {
  return {
    detectRuntime: async () => ({
      state: 'available',
      binaryPath: '/officecli',
      version: '1.0.153',
      platform: 'darwin-arm64'
    }),
    prepareDraft: async (input) => ({
      artifactId: 'artifact-pptx',
      sessionId: input.sessionId,
      projectId: input.projectId,
      kind: 'pptx',
      sourcePath: input.sourcePath,
      sourceHash: 'hash',
      draftPath: '/session/artifact/deck.pptx'
    }),
    prepareBlankDraft: unusedPrepareBlankDraft,
    startDocument: async () => ({ residentPid: 101 }),
    adoptCreatedDocument: async () => ({ residentPid: 101 }),
    startPreview: async () => ({
      watchPid: 202,
      watchPort: 31_001,
      gatewayPort: 42_001,
      previewUrl: 'http://127.0.0.1:42001/',
      slideCount: 0
    }),
    stopPreview: async () => undefined,
    closeDocument: async () => undefined,
    removeBlankDraft: async () => undefined,
    validateRegisteredDraft: async () => undefined,
    assertNotOfficeArtifactPath: async () => undefined,
    resolveSelection: async () => null,
    clearSelection: async () => undefined,
    readRange: async () => {
      throw new Error('must not read xlsx')
    },
    applyCellValue: async () => {
      throw new Error('must not write xlsx')
    },
    saveDraft: async () => undefined,
    armPreviewConfirmation: () => ({ promise: Promise.resolve(false), cancel: () => undefined }),
    loadOperationLog: async () => ({ version: 2, contentRevision: 0, operations: {} }),
    persistOperationLog: async () => undefined,
    ...overrides
  }
}

async function unusedPrepareBlankDraft(): Promise<never> {
  throw new Error('unused')
}

async function openBoundPptx(dependencies: OfficeServiceDependencies): Promise<OfficeService> {
  const service = new OfficeService(dependencies)
  await service.open({
    sessionId: 'session-1',
    projectId: 'project-1',
    sourcePath: '/project/source.pptx',
    projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
    allowRoots: ['/project']
  })
  service.bindRunTarget({
    runId: 'run-pptx',
    artifactId: 'artifact-pptx',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  return service
}

function writeRequest(operation: OfficePptxOperation, baseRevision: number): OfficeWriteRequest {
  return { operation, baseRevision }
}

function snapshot(slides: OfficePptxSnapshot['slides']): OfficePptxSnapshot {
  return { slides, slideCount: slides.length }
}

function slide(
  slideId: string,
  index: number,
  title: string,
  body?: string
): OfficePptxSnapshot['slides'][number] {
  const elements: OfficePptxSnapshot['slides'][number]['elements'] = [
    element(slideId, index, '2', 'title', title)
  ]
  return {
    slideId,
    index,
    title,
    elements:
      body === undefined ? elements : [...elements, element(slideId, index, '3', 'body', body)]
  }
}

function element(
  slideId: string,
  index: number,
  elementId: string,
  kind: 'title' | 'body',
  text: string
): OfficePptxSnapshot['slides'][number]['elements'][number] {
  return {
    elementId,
    path: `/slide[@id=${slideId}]/shape[@id=${elementId}]`,
    cliPath: `/slide[${index + 1}]/shape[@id=${elementId}]`,
    kind,
    text,
    editable: true,
    geometry: {
      widthPoints: 800,
      heightPoints: kind === 'title' ? 100 : 300,
      fontSizePoints: kind === 'title' ? 44 : 24
    }
  }
}

function updateElement(
  value: OfficePptxSnapshot['slides'][number],
  elementId: string,
  text: string
): OfficePptxSnapshot['slides'][number] {
  const elements = value.elements.map((entry) =>
    entry.elementId === elementId ? { ...entry, text } : entry
  )
  return { ...value, title: elements.find((entry) => entry.kind === 'title')?.text, elements }
}

function reindex(slides: OfficePptxSnapshot['slides']): OfficePptxSnapshot['slides'] {
  return slides.map((entry, index) => ({
    ...entry,
    index,
    elements: entry.elements.map((element) => ({
      ...element,
      cliPath: `/slide[${index + 1}]/shape[@id=${element.elementId}]`
    }))
  }))
}

function insertionIndex(
  operation: OfficePptxOperation,
  slides: OfficePptxSnapshot['slides']
): number {
  return operation.type === 'add_slide' && operation.position && operation.position !== 'end'
    ? slides.findIndex((entry) => entry.slideId === operation.position!.after) + 1
    : slides.length
}
