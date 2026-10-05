import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  OfficeDocxOperation,
  OfficeDocxSnapshot,
  OfficeDocxWriteReceipt
} from '../src/main/agent/office/office-docx-contract'
import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import {
  OfficeWriteError,
  type OfficeWriteRequest
} from '../src/main/agent/office/office-write-contract'

test('DOCX add paragraph uses the shared transaction, preview confirmation, and operation-id replay', async () => {
  const harness = docxHarness([])
  const service = await openBoundDocx(harness.dependencies)
  const request = writeRequest({ type: 'add_paragraph', text: '新增正文 & <Phi>' }, 0)

  const first = await service.applyWriteRequest('run-docx', request, { operationId: 'docx-add-1' })
  const replay = await service.applyWriteRequest('run-docx', request, { operationId: 'docx-add-1' })

  assert.deepEqual(first, {
    applied: true,
    saved: true,
    revision: 1,
    paraId: '00100000',
    path: '/body/p[@paraId=00100000]',
    index: 0,
    text: '新增正文 & <Phi>',
    previewConfirmed: true
  })
  assert.deepEqual(replay, { ...first, deduplicated: true })
  assert.equal(harness.applyCount(), 1)
  assert.deepEqual(harness.paragraphs(), [plainParagraph('00100000', 0, '新增正文 & <Phi>')])
  assert.deepEqual(harness.events().slice(0, 4), [
    'persist:in_flight',
    'read',
    'persist:prewrite',
    'arm:新增正文 & <Phi>'
  ])
})

test('DOCX set paragraph rejects stale expectedText without applying a mutation', async () => {
  const harness = docxHarness([plainParagraph('0010000A', 0, '当前正文')])
  const service = await openBoundDocx(harness.dependencies)

  await assert.rejects(
    service.applyWriteRequest(
      'run-docx',
      writeRequest(
        {
          type: 'set_paragraph_text',
          paraId: '0010000A',
          text: '新正文',
          expectedText: '过期正文'
        },
        0
      ),
      { operationId: 'docx-set-stale' }
    ),
    { code: 'stale_target' }
  )
  assert.equal(harness.applyCount(), 0)
  assert.equal(harness.paragraphs()[0]?.text, '当前正文')
})

test('an unknown DOCX add is reconciled from paraId text and paragraph count without retrying', async () => {
  const harness = docxHarness([], { unknownAfterApply: true })
  const service = await openBoundDocx(harness.dependencies)

  const result = await service.applyWriteRequest(
    'run-docx',
    writeRequest({ type: 'add_paragraph', text: '只写一次' }, 0),
    { operationId: 'docx-add-unknown' }
  )

  assert.equal(harness.applyCount(), 1)
  assert.deepEqual(result, {
    applied: true,
    saved: true,
    revision: 1,
    paraId: '00100000',
    path: '/body/p[@paraId=00100000]',
    index: 0,
    text: '只写一次',
    previewConfirmed: false,
    warnings: ['preview_not_confirmed'],
    reconciled: true
  })
})

test('an unknown DOCX set is reconciled from the stable paraId and old/new text', async () => {
  const harness = docxHarness([plainParagraph('0010000A', 0, '旧正文')], {
    unknownAfterApply: true
  })
  const service = await openBoundDocx(harness.dependencies)

  const result = await service.applyWriteRequest(
    'run-docx',
    writeRequest(
      {
        type: 'set_paragraph_text',
        paraId: '0010000A',
        text: '新正文',
        expectedText: '旧正文'
      },
      0
    ),
    { operationId: 'docx-set-unknown' }
  )

  assert.equal(harness.applyCount(), 1)
  assert.equal(result.revision, 1)
  assert.equal('paraId' in result ? result.paraId : undefined, '0010000A')
  assert.equal('after' in result ? result.after : undefined, '新正文')
  assert.equal(result.reconciled, true)
})

test('a confirmed DOCX read-back mismatch rolls back to before and does not increment revision', async () => {
  const harness = docxHarness([plainParagraph('0010000B', 0, '回滚前')], {
    mismatchAfterApply: true
  })
  const service = await openBoundDocx(harness.dependencies)

  await assert.rejects(
    service.applyWriteRequest(
      'run-docx',
      writeRequest(
        {
          type: 'set_paragraph_text',
          paraId: '0010000B',
          text: '目标文本',
          expectedText: '回滚前'
        },
        0
      ),
      { operationId: 'docx-set-rollback' }
    ),
    { code: 'write_failed' }
  )
  assert.equal(harness.restoreCount(), 1)
  assert.equal(harness.paragraphs()[0]?.text, '回滚前')
})

test('DOCX operations reject an XLSX target before any document write', async () => {
  let writes = 0
  const dependencies = baseDependencies({
    prepareDraft: async (input) => ({
      artifactId: 'artifact-docx',
      sessionId: input.sessionId,
      projectId: input.projectId,
      kind: 'xlsx',
      sourcePath: input.sourcePath,
      sourceHash: 'hash',
      draftPath: '/session/artifact/book.xlsx'
    }),
    applyDocxOperation: async () => {
      writes += 1
      throw new Error('must not write')
    }
  })
  const service = new OfficeService(dependencies)
  await service.open({
    sessionId: 'session-1',
    projectId: 'project-1',
    sourcePath: '/project/source.xlsx',
    projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
    allowRoots: ['/project']
  })
  service.bindRunTarget({
    runId: 'run-docx',
    artifactId: 'artifact-docx',
    sessionId: 'session-1',
    projectId: 'project-1'
  })

  await assert.rejects(
    service.applyWriteRequest(
      'run-docx',
      writeRequest({ type: 'add_paragraph', text: '错误目标' }, 0),
      { operationId: 'docx-wrong-kind' }
    ),
    { code: 'operation_not_supported_for_kind' }
  )
  assert.equal(writes, 0)
})

function docxHarness(
  initial: OfficeDocxSnapshot['paragraphs'],
  options: {
    readonly unknownAfterApply?: boolean
    readonly mismatchAfterApply?: boolean
  } = {}
): {
  dependencies: OfficeServiceDependencies
  applyCount: () => number
  restoreCount: () => number
  paragraphs: () => OfficeDocxSnapshot['paragraphs']
  events: () => string[]
} {
  let current = [...initial]
  let nextId = 0
  let applications = 0
  let restores = 0
  const events: string[] = []
  const dependencies = baseDependencies({
    readDocxSnapshot: async () => {
      events.push('read')
      return snapshot(current)
    },
    applyDocxOperation: async (_context, operation) => {
      applications += 1
      if (operation.type === 'add_paragraph') {
        const paraId = `0010000${nextId++}`
        const index = insertionIndex(operation, current)
        current = [
          ...current.slice(0, index),
          plainParagraph(paraId, index, operation.text),
          ...current.slice(index).map((paragraph) => ({ ...paragraph, index: paragraph.index + 1 }))
        ]
        const result = receipt(operation, paraId)
        if (options.unknownAfterApply) throw new OfficeWriteError('write_unknown', 'unknown')
        return result
      }
      current = current.map((paragraph) =>
        paragraph.paraId === operation.paraId
          ? { ...paragraph, text: options.mismatchAfterApply ? '错误读回' : operation.text }
          : paragraph
      )
      const result = receipt(operation, operation.paraId)
      if (options.unknownAfterApply) throw new OfficeWriteError('write_unknown', 'unknown')
      return result
    },
    restoreDocxOperation: async (_context, operation, before, mutation) => {
      restores += 1
      if (operation.type === 'add_paragraph') {
        current = current
          .filter((paragraph) => paragraph.paraId !== mutation.paraId)
          .map((paragraph, index) => ({ ...paragraph, index }))
        return
      }
      if (before.type !== 'set_paragraph_text') throw new Error('bad before')
      current = current.map((paragraph) =>
        paragraph.paraId === before.paraId ? { ...paragraph, text: before.text } : paragraph
      )
    },
    armDocumentPreviewConfirmation: (_artifactId, text) => {
      events.push(`arm:${text}`)
      return {
        promise: Promise.resolve(true),
        cancel: () => undefined,
        markDispatched: () => events.push('dispatch')
      }
    },
    persistOperationLog: async (_path, state) => {
      const record = Object.values(state.operations)[0]
      events.push(`persist:${record?.before ? 'prewrite' : (record?.status ?? 'none')}`)
    }
  })
  return {
    dependencies,
    applyCount: () => applications,
    restoreCount: () => restores,
    paragraphs: () => current,
    events: () => events
  }
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
      artifactId: 'artifact-docx',
      sessionId: input.sessionId,
      projectId: input.projectId,
      kind: 'docx',
      sourcePath: input.sourcePath,
      sourceHash: 'hash',
      draftPath: '/session/artifact/document.docx'
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

async function openBoundDocx(dependencies: OfficeServiceDependencies): Promise<OfficeService> {
  const service = new OfficeService(dependencies)
  await service.open({
    sessionId: 'session-1',
    projectId: 'project-1',
    sourcePath: '/project/source.docx',
    projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
    allowRoots: ['/project']
  })
  service.bindRunTarget({
    runId: 'run-docx',
    artifactId: 'artifact-docx',
    sessionId: 'session-1',
    projectId: 'project-1'
  })
  return service
}

function writeRequest(operation: OfficeDocxOperation, baseRevision: number): OfficeWriteRequest {
  return { operation, baseRevision }
}

function snapshot(paragraphs: OfficeDocxSnapshot['paragraphs']): OfficeDocxSnapshot {
  return { paragraphs, paragraphCount: paragraphs.length }
}

function plainParagraph(
  paraId: string,
  index: number,
  text: string
): OfficeDocxSnapshot['paragraphs'][number] {
  return { paraId, index, text, style: 'Normal', editable: true }
}

function insertionIndex(
  operation: OfficeDocxOperation,
  paragraphs: OfficeDocxSnapshot['paragraphs']
): number {
  return operation.type === 'add_paragraph' && operation.position && operation.position !== 'end'
    ? paragraphs.findIndex((paragraph) => paragraph.paraId === operation.position!.after) + 1
    : paragraphs.length
}

function receipt(operation: OfficeDocxOperation, paraId: string): OfficeDocxWriteReceipt {
  return {
    type: operation.type,
    paraId,
    path: `/body/p[@paraId=${paraId}]`
  } as OfficeDocxWriteReceipt
}
