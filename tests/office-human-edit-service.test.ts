import assert from 'node:assert/strict'
import test from 'node:test'

import { OfficeReadError, type OfficeReadResult } from '../src/main/agent/office/office-read'
import {
  OfficeService,
  type OfficeServiceDependencies
} from '../src/main/agent/office/office-service'
import type { OfficeWriteOperation } from '../src/main/agent/office/office-write-contract'

interface WorkbookState {
  value: string | number | boolean | null
  writes: OfficeWriteOperation[]
  persisted: unknown[]
}

function dependencies(
  state: WorkbookState,
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
      artifactId: 'artifact-human',
      sessionId: input.sessionId,
      projectId: input.projectId,
      sourcePath: input.sourcePath,
      sourceHash: 'hash',
      draftPath: '/session/artifacts/office/artifact-human/source.xlsx'
    }),
    prepareBlankDraft: async () => {
      throw new Error('unused')
    },
    startDocument: async () => ({ residentPid: 10 }),
    adoptCreatedDocument: async () => ({ residentPid: 10 }),
    startPreview: async () => ({
      watchPid: 20,
      watchPort: 30,
      gatewayPort: 40,
      previewUrl: 'http://127.0.0.1:40/'
    }),
    stopPreview: async () => undefined,
    closeDocument: async () => undefined,
    removeBlankDraft: async () => undefined,
    validateRegisteredDraft: async () => undefined,
    assertNotOfficeArtifactPath: async () => undefined,
    resolveSelection: async () => null,
    clearSelection: async () => undefined,
    readRange: async (context, params) =>
      cellResponse(context.revision, params.range!, state.value),
    applyCellValue: async () => {
      throw new Error('unexpected legacy writer')
    },
    applyWriteOperation: async (_context, operation) => {
      state.writes.push(operation)
      state.value = operation.type === 'clear_cell' ? null : operation.value
    },
    restoreWriteOperation: async () => undefined,
    saveDraft: async () => undefined,
    armPreviewConfirmation: () => ({ promise: Promise.resolve(true), cancel: () => undefined }),
    loadOperationLog: async () => ({ version: 2, contentRevision: 0, operations: {} }),
    persistOperationLog: async (_path, log) => {
      state.persisted.push(log)
    },
    ...overrides
  }
}

const openRequest = {
  sessionId: 'session-human',
  projectId: 'project-human',
  sourcePath: '/project/source.xlsx',
  projectLocation: { kind: 'local' as const, path: '/project', realPath: '/project' },
  allowRoots: ['/project']
}

function cellResponse(
  revision: number,
  cell: string,
  value: string | number | boolean | null
): OfficeReadResult {
  return {
    revision,
    sheet: 'Sheet1',
    range: cell,
    cells: [
      {
        ref: cell,
        value,
        valueType:
          value === null
            ? 'empty'
            : typeof value === 'number'
              ? 'number'
              : typeof value === 'boolean'
                ? 'boolean'
                : 'string'
      }
    ],
    rowCount: 1,
    columnCount: 1,
    complete: true,
    truncated: false,
    limits: { maxCells: 2_000, maxBytes: 256 * 1024 }
  }
}

test('human edit shares the document queue, increments revision once, and conflicts an old Agent write', async () => {
  const state: WorkbookState = { value: 'before', writes: [], persisted: [] }
  const service = new OfficeService(dependencies(state))
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'agent-run',
    artifactId: 'artifact-human',
    sessionId: 'session-human',
    projectId: 'project-human'
  })
  const before = await service.readRange('agent-run', { sheet: 'Sheet1', range: 'A1' })
  assert.equal(before.revision, 0)
  let approvalCalls = 0

  const human = await service.applyHumanCellEdit(
    'artifact-human',
    { sheet: 'Sheet1', cell: 'A1', text: '42' },
    {
      operationId: 'human-operation-1',
      authorize: () => {
        approvalCalls += 1
        return false
      }
    } as never
  )
  assert.equal(human.revision, 1)
  assert.equal(state.value, 42)
  assert.equal(state.writes.length, 1)
  assert.equal(approvalCalls, 0)

  await assert.rejects(
    service.applyCellEdit(
      'agent-run',
      { sheet: 'Sheet1', cell: 'A1', value: 'stale', baseRevision: 0 },
      { operationId: 'agent-operation-stale' }
    ),
    { code: 'revision_conflict' }
  )
  assert.equal(state.value, 42)
  const after = await service.readRange('agent-run', { sheet: 'Sheet1', range: 'A1' })
  assert.equal(after.revision, 1)
  const status = service.statusForSource(openRequest.sessionId, openRequest.sourcePath)
  assert.equal(status?.state, 'ready')
  if (status?.state === 'ready') {
    assert.equal(status.readOnly, false)
    assert.deepEqual(status.lastHumanEdit, {
      type: 'number',
      conclusion: 'succeeded',
      code: 'ok',
      message: '单元格已更新'
    })
  }
  const persistedText = JSON.stringify(state.persisted)
  assert.match(persistedText, /"source":"human"/u)
  assert.doesNotMatch(persistedText, /人工值|\/project\/source\.xlsx|residentPid/u)
})

test('human empty text uses clear_cell and an unknown sheet fails before writing', async () => {
  const state: WorkbookState = { value: 'erase me', writes: [], persisted: [] }
  const base = dependencies(state)
  const service = new OfficeService(
    dependencies(state, {
      readRange: async (context, params) => {
        if (params.sheet === 'Missing') {
          throw new OfficeReadError('invalid_sheet', '指定的工作表不存在')
        }
        return base.readRange(context, params)
      }
    })
  )
  await service.open(openRequest)

  const cleared = await service.applyHumanCellEdit(
    'artifact-human',
    { sheet: 'Sheet1', cell: 'A1', text: '' },
    { operationId: 'human-clear-1' }
  )
  assert.equal(cleared.revision, 1)
  assert.equal(state.value, null)
  assert.equal(state.writes[0]?.type, 'clear_cell')

  await assert.rejects(
    service.applyHumanCellEdit(
      'artifact-human',
      { sheet: 'Missing', cell: 'A1', text: 'x' },
      { operationId: 'human-missing-sheet' }
    ),
    { code: 'invalid_sheet' }
  )
  assert.equal(state.writes.length, 1)
})

test('read-only and frozen documents reject human edits and publish sanitized failure status', async () => {
  for (const mode of ['readOnly', 'frozen'] as const) {
    const state: WorkbookState = { value: 'before', writes: [], persisted: [] }
    const service = new OfficeService(
      dependencies(state, {
        ...(mode === 'readOnly'
          ? {
              prepareDraft: async (input) => ({
                artifactId: 'artifact-human',
                sessionId: input.sessionId,
                projectId: input.projectId,
                sourcePath: input.sourcePath,
                sourceHash: 'hash',
                draftPath: '/session/artifacts/office/artifact-human/source.xlsx',
                readOnly: true
              })
            }
          : {
              loadOperationLog: async () => ({
                version: 2 as const,
                contentRevision: 0,
                operations: {},
                freezeState: 'unknown' as const
              })
            })
      })
    )
    await service.open(openRequest)
    await assert.rejects(
      service.applyHumanCellEdit(
        'artifact-human',
        { sheet: 'Sheet1', cell: 'A1', text: 'blocked' },
        { operationId: `human-${mode}` }
      ),
      { code: mode === 'readOnly' ? 'document_read_only' : 'document_frozen' }
    )
    assert.equal(state.writes.length, 0)
    const status = service.statusForSource(openRequest.sessionId, openRequest.sourcePath)
    assert.equal(status?.state, 'ready')
    if (status?.state === 'ready') {
      assert.equal(status.readOnly, mode === 'readOnly')
      assert.equal(status.lastHumanEdit?.conclusion, 'failed')
      assert.equal(
        status.lastHumanEdit?.code,
        mode === 'readOnly' ? 'document_read_only' : 'document_frozen'
      )
      assert.doesNotMatch(
        JSON.stringify(status.lastHumanEdit),
        /blocked|\/session|residentPid|watchPort/u
      )
    }
  }
})

test('an invalid human formula rolls back, keeps revision, and publishes a sanitized reason', async () => {
  const state: WorkbookState = { value: 'before', writes: [], persisted: [] }
  let formula: string | undefined
  let evaluated: boolean | undefined
  let valueType: 'string' | 'error' = 'string'
  const service = new OfficeService(
    dependencies(state, {
      readRange: async (context, params) => ({
        ...cellResponse(context.revision, params.range!, state.value),
        cells: [
          {
            ref: params.range!,
            value: state.value,
            valueType,
            ...(formula ? { formula } : {}),
            ...(evaluated === undefined ? {} : { evaluated })
          }
        ]
      }),
      applyWriteOperation: async (_context, operation) => {
        assert.equal(operation.type, 'set_formula')
        state.writes.push(operation)
        state.value = '#OCLI_NOTEVAL!'
        valueType = 'error'
        formula = '=UNSUPPORTED(1)'
        evaluated = false
      },
      restoreWriteOperation: async () => {
        state.value = 'before'
        valueType = 'string'
        formula = undefined
        evaluated = undefined
      }
    })
  )
  await service.open(openRequest)

  await assert.rejects(
    service.applyHumanCellEdit(
      'artifact-human',
      { sheet: 'Sheet1', cell: 'A1', text: '=UNSUPPORTED(1)' },
      { operationId: 'human-formula-invalid' }
    ),
    { code: 'formula_invalid' }
  )
  assert.equal(state.value, 'before')
  const status = service.statusForSource(openRequest.sessionId, openRequest.sourcePath)
  assert.equal(status?.state, 'ready')
  if (status?.state === 'ready') {
    assert.equal(status.lastHumanEdit?.type, 'formula')
    assert.equal(status.lastHumanEdit?.code, 'formula_invalid')
    assert.match(status.lastHumanEdit?.message ?? '', /公式无法计算，已撤销/u)
    assert.doesNotMatch(JSON.stringify(status.lastHumanEdit), /UNSUPPORTED|OCLI|Sheet1|A1/u)
  }
  const log = state.persisted.at(-1) as { contentRevision?: number }
  assert.equal(log.contentRevision, 0)
})

test('an unknown human write is never replayed and auto-reconciles through the shared transaction', async () => {
  const state: WorkbookState = { value: 'before', writes: [], persisted: [] }
  const service = new OfficeService(
    dependencies(state, {
      applyWriteOperation: async (_context, operation) => {
        state.writes.push(operation)
        assert.equal(operation.type, 'set_cell')
        state.value = operation.value
        throw new Error('lost reply after apply')
      }
    })
  )
  await service.open(openRequest)
  const result = await service.applyHumanCellEdit(
    'artifact-human',
    { sheet: 'Sheet1', cell: 'A1', text: 'after' },
    { operationId: 'human-unknown-applied' }
  )
  assert.equal(result.revision, 1)
  assert.equal(result.reconciled, true)
  assert.equal(state.writes.length, 1)
  assert.equal(state.value, 'after')
  const status = service.statusForSource(openRequest.sessionId, openRequest.sourcePath)
  assert.equal(status?.state, 'ready')
  if (status?.state === 'ready') {
    assert.equal(status.freezeState, undefined)
    assert.equal(status.lastHumanEdit?.conclusion, 'succeeded')
  }
  assert.match(JSON.stringify(state.persisted), /"source":"human"/u)
})

test('human and Agent writes serialize on the same artifact queue', async () => {
  const state: WorkbookState = { value: 'before', writes: [], persisted: [] }
  let markStarted!: () => void
  let release!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  const service = new OfficeService(
    dependencies(state, {
      applyWriteOperation: async (_context, operation) => {
        state.writes.push(operation)
        if (operation.type === 'set_cell' && operation.value === 'agent') {
          markStarted()
          await blocked
        }
        assert.equal(operation.type, 'set_cell')
        state.value = operation.value
      }
    })
  )
  await service.open(openRequest)
  service.bindRunTarget({
    runId: 'agent-queued',
    artifactId: 'artifact-human',
    sessionId: 'session-human',
    projectId: 'project-human'
  })
  const agent = service.applyCellEdit(
    'agent-queued',
    { sheet: 'Sheet1', cell: 'A1', value: 'agent', baseRevision: 0 },
    { operationId: 'agent-queued-write' }
  )
  await started
  const human = service.applyHumanCellEdit(
    'artifact-human',
    { sheet: 'Sheet1', cell: 'A1', text: 'human' },
    { operationId: 'human-queued-write' }
  )
  await Promise.resolve()
  assert.equal(state.writes.length, 1)
  release()
  const [agentResult, humanResult] = await Promise.all([agent, human])
  assert.equal(agentResult.revision, 1)
  assert.equal(humanResult.revision, 2)
  assert.equal(state.value, 'human')
})
