import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OfficeIpcCoordinator,
  registerOfficeRendererIpc,
  type OfficeIpcEventLike,
  type OfficeIpcMainLike
} from '../src/main/agent/office/office-ipc'
import type { OfficeDocumentStatus } from '../src/main/agent/office/office-service'

function fixture(
  options: {
    status?: OfficeDocumentStatus
    onReconcile?: (artifactId: string, sessionId: string) => void
    onSave?: (artifactId: string, sessionId: string) => void
    saveAsTarget?: string | null
    saveAsKind?: 'xlsx' | 'docx' | 'pptx'
    saveAsValidationError?: string
    onChooseSaveAs?: (input: unknown) => void
    onValidateSaveAs?: (input: unknown) => void
    onSaveAs?: (input: unknown) => void
    onOpen?: (input: unknown) => void
    onCreate?: (input: unknown) => void
    onImport?: (input: unknown) => void
    onPreviewPreferences?: (input: unknown) => boolean
  } = {}
): {
  coordinator: OfficeIpcCoordinator
  event: OfficeIpcEventLike
  handlers: Map<string, (...args: unknown[]) => unknown>
  sent: Array<{ channel: string; payload: unknown }>
  revealed: string[]
  emitSelection: (event: unknown) => void
} {
  const mainFrame = {}
  const sent: Array<{ channel: string; payload: unknown }> = []
  const revealed: string[] = []
  const sender = {
    isDestroyed: () => false,
    mainFrame,
    send: (channel: string, payload: unknown) => sent.push({ channel, payload })
  }
  let emitSelection: (event: unknown) => void = () => undefined
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain: OfficeIpcMainLike = {
    handle: (channel, handler) => {
      handlers.set(channel, handler as (...args: unknown[]) => unknown)
    }
  }
  const coordinator = new OfficeIpcCoordinator({
    service: {
      open: async (request) => {
        options.onOpen?.(request)
        return { state: 'preparing', sourcePath: request.sourcePath }
      },
      create: async (request) => {
        options.onCreate?.(request)
        return { state: 'preparing', requestId: request.requestId }
      },
      cancelCreate: async () => true,
      importDocument: async (request) => {
        options.onImport?.(request)
        return { state: 'preparing', requestId: request.requestId }
      },
      cancelImport: async () => true,
      clearSelection: async () => true,
      reconcile: async (artifactId, sessionId) => {
        options.onReconcile?.(artifactId, sessionId)
        return {
          conclusion: 'applied',
          message: '已核对：写入已生效',
          revision: 1
        }
      },
      saveDocument: async (artifactId, sessionId) => {
        options.onSave?.(artifactId, sessionId)
        return { saved: true, revision: 1, lastSavedAt: '2026-10-05T12:00:00.000Z' }
      },
      saveAsDescriptor: () => {
        if (options.saveAsKind === 'docx') {
          return { fileName: 'report.docx', kind: 'docx' as const }
        }
        if (options.saveAsKind === 'pptx') {
          return { fileName: 'report.pptx', kind: 'pptx' as const }
        }
        return { fileName: 'report.xlsx', kind: 'xlsx' as const }
      },
      saveAsDocument: async (artifactId, sessionId, projectRoot, targetPath) => {
        options.onSaveAs?.({ artifactId, sessionId, projectRoot, targetPath })
        return {
          outputId: 'output-1',
          outputPath: 'outputs/report.xlsx',
          fileName: 'report.xlsx',
          revision: 1,
          sha256: 'a'.repeat(64),
          size: 1024,
          createdAt: '2026-10-05T12:00:00.000Z',
          source: 'draft' as const
        }
      },
      resolveOutputPath: async () => '/project/outputs/report.xlsx',
      close: async () => true,
      statusForSource: () => options.status,
      setPreviewPreferences: (artifactId, sessionId, preferences) =>
        options.onPreviewPreferences?.({ artifactId, sessionId, ...preferences }) ?? true,
      onSelection: (listener) => {
        emitSelection = listener as (event: unknown) => void
        return () => undefined
      }
    },
    getTrustedRenderer: () => sender,
    resolveContext: () => ({
      sessionId: 'session-1',
      projectId: 'project-1',
      projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
      allowRoots: ['/project'],
      outputRoot: '/project'
    }),
    chooseSaveAsTarget: async (input) => {
      options.onChooseSaveAs?.(input)
      return options.saveAsTarget ?? null
    },
    validateSaveAsTarget: async (projectRoot, targetPath, kind) => {
      options.onValidateSaveAs?.({ projectRoot, targetPath, kind })
      if (options.saveAsValidationError) {
        throw Object.assign(new Error('private validation detail'), {
          code: options.saveAsValidationError
        })
      }
      return {
        projectRoot,
        targetPath,
        outputPath: 'outputs/report.xlsx',
        fileName: 'report.xlsx'
      }
    },
    revealPath: (path) => revealed.push(path)
  })
  registerOfficeRendererIpc(ipcMain, coordinator)
  return {
    coordinator,
    event: { sender, senderFrame: mainFrame },
    handlers,
    sent,
    revealed,
    emitSelection: (selectionEvent) => emitSelection(selectionEvent)
  }
}

test('IPC accepts a valid open request from the trusted main frame', async () => {
  const { handlers, event } = fixture()
  const invoke = handlers.get('office:open')!

  assert.deepEqual(await invoke(event, { sourcePath: '/project/report.xlsx' }), {
    ok: true,
    value: { state: 'preparing', sourcePath: '/project/report.xlsx' }
  })
})

test('IPC resolves a recorded Office output before the delivery card opens it', async () => {
  const { handlers, event } = fixture()

  assert.deepEqual(
    await handlers.get('office:resolveOutput')!(event, {
      artifactId: 'artifact-1',
      outputId: 'output-1'
    }),
    { ok: true, value: { path: '/project/outputs/report.xlsx' } }
  )
  assert.deepEqual(
    await handlers.get('office:resolveOutput')!(event, {
      artifactId: 'artifact-1',
      outputId: 'output-1',
      path: '/private/forged.xlsx'
    }),
    { ok: false, error: { code: 'invalid-request', message: 'Office 输出解析请求无效' } }
  )
})

test('IPC accepts only a boolean fresh flag in addition to sourcePath', async () => {
  const opened: unknown[] = []
  const { handlers, event } = fixture({ onOpen: (input) => opened.push(input) })
  const invoke = handlers.get('office:open')!

  assert.equal((await invoke(event, { sourcePath: '/project/report.xlsx', fresh: true })).ok, true)
  assert.equal(
    (await invoke(event, { sourcePath: '/project/report.xlsx', fresh: 'yes' })).ok,
    false
  )
  assert.equal(
    (
      await invoke(event, {
        sourcePath: '/project/report.xlsx',
        fresh: true,
        artifactId: 'forged'
      })
    ).ok,
    false
  )
  assert.deepEqual(opened, [
    {
      sessionId: 'session-1',
      projectId: 'project-1',
      projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
      allowRoots: ['/project'],
      outputRoot: '/project',
      sourcePath: '/project/report.xlsx',
      fresh: true
    }
  ])
})

test('IPC rejects malformed open arguments before calling the service', async () => {
  const { handlers, event } = fixture()
  const invoke = handlers.get('office:open')!

  assert.deepEqual(await invoke(event, { sourcePath: '/project/report.xlsx', command: 'set' }), {
    ok: false,
    error: { code: 'invalid-request', message: 'Office 预览请求无效' }
  })
})

test('IPC rejects calls from a child frame', async () => {
  const { handlers, event } = fixture()
  const invoke = handlers.get('office:open')!

  assert.deepEqual(await invoke({ ...event, senderFrame: {} }, { sourcePath: '/project/a.xlsx' }), {
    ok: false,
    error: { code: 'unauthorized', message: 'Office 预览调用方未获授权' }
  })
})

test('IPC defaults an omitted creation kind to xlsx before calling the service', async () => {
  const created: unknown[] = []
  const { handlers, event } = fixture({ onCreate: (input) => created.push(input) })

  assert.equal(
    (await handlers.get('office:create')!(event, { requestId: 'create-xlsx', name: '预算表' })).ok,
    true
  )
  assert.deepEqual(created, [
    {
      sessionId: 'session-1',
      projectId: 'project-1',
      projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
      requestId: 'create-xlsx',
      name: '预算表',
      kind: 'xlsx'
    }
  ])
})

test('IPC accepts and forwards docx creation kind', async () => {
  const created: unknown[] = []
  const { handlers, event } = fixture({ onCreate: (input) => created.push(input) })

  assert.equal(
    (
      await handlers.get('office:create')!(event, {
        requestId: 'create-docx',
        name: '会议纪要',
        kind: 'docx'
      })
    ).ok,
    true
  )
  assert.deepEqual(created, [
    {
      sessionId: 'session-1',
      projectId: 'project-1',
      projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
      requestId: 'create-docx',
      name: '会议纪要',
      kind: 'docx'
    }
  ])
})

test('IPC accepts and forwards pptx creation kind', async () => {
  const created: unknown[] = []
  const { handlers, event } = fixture({ onCreate: (input) => created.push(input) })

  assert.deepEqual(
    await handlers.get('office:create')!(event, {
      requestId: 'create-pptx',
      kind: 'pptx'
    }),
    { ok: true, value: { state: 'preparing', requestId: 'create-pptx' } }
  )
  assert.deepEqual(created, [
    {
      sessionId: 'session-1',
      projectId: 'project-1',
      projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
      requestId: 'create-pptx',
      kind: 'pptx'
    }
  ])
})

test('IPC imports CSV/TSV with host-owned identity and rejects forged fields', async () => {
  const imported: unknown[] = []
  const { handlers, event } = fixture({ onImport: (input) => imported.push(input) })
  const invoke = handlers.get('office:import')!

  assert.deepEqual(
    await invoke(event, {
      requestId: 'import-1',
      sourcePath: '/project/data.tab',
      format: 'tsv'
    }),
    { ok: true, value: { state: 'preparing', requestId: 'import-1' } }
  )
  assert.deepEqual(imported, [
    {
      sessionId: 'session-1',
      projectId: 'project-1',
      projectLocation: { kind: 'local', path: '/project', realPath: '/project' },
      allowRoots: ['/project'],
      requestId: 'import-1',
      sourcePath: '/project/data.tab',
      format: 'tsv'
    }
  ])

  for (const invalid of [
    { requestId: 'import-2', sourcePath: '/project/data.csv', format: 'xlsx' },
    {
      requestId: 'import-3',
      sourcePath: '/project/data.csv',
      format: 'csv',
      sessionId: 'forged'
    }
  ]) {
    assert.deepEqual(await invoke(event, invalid), {
      ok: false,
      error: { code: 'invalid-request', message: 'Office 导入请求无效' }
    })
  }
  assert.equal(imported.length, 1)
})

test('IPC rejects unsupported creation kinds before calling the service', async () => {
  const created: unknown[] = []
  const { handlers, event } = fixture({ onCreate: (input) => created.push(input) })

  assert.deepEqual(
    await handlers.get('office:create')!(event, {
      requestId: 'create-pdf',
      kind: 'pdf'
    }),
    {
      ok: false,
      error: { code: 'invalid-request', message: 'Office 创建请求无效' }
    }
  )
  assert.deepEqual(created, [])
})

test('IPC rejects extra creation fields before calling the service', async () => {
  const created: unknown[] = []
  const { handlers, event } = fixture({ onCreate: (input) => created.push(input) })

  assert.deepEqual(
    await handlers.get('office:create')!(event, {
      requestId: 'create-xlsx',
      kind: 'xlsx',
      directory: '/tmp/escape'
    }),
    {
      ok: false,
      error: { code: 'invalid-request', message: 'Office 创建请求无效' }
    }
  )
  assert.deepEqual(created, [])
})

test('IPC accepts only controlled fields for blank document creation', async () => {
  const { handlers, event } = fixture()
  const invoke = handlers.get('office:create')!

  assert.deepEqual(await invoke(event, { requestId: 'create-1', name: '预算表' }), {
    ok: true,
    value: { state: 'preparing', requestId: 'create-1' }
  })
  assert.deepEqual(
    await invoke(event, {
      requestId: 'create-2',
      name: '预算表',
      directory: '/tmp/escape'
    }),
    {
      ok: false,
      error: { code: 'invalid-request', message: 'Office 创建请求无效' }
    }
  )
  assert.deepEqual(await invoke(event, { requestId: '../escape', name: '预算表' }), {
    ok: false,
    error: { code: 'invalid-request', message: 'Office 创建请求无效' }
  })
})

test('IPC applies sender and main-frame checks to create and cancel', async () => {
  const { handlers, event } = fixture()
  const childEvent = { ...event, senderFrame: {} }

  assert.deepEqual(await handlers.get('office:create')!(childEvent, { requestId: 'create-1' }), {
    ok: false,
    error: { code: 'unauthorized', message: 'Office 预览调用方未获授权' }
  })
  assert.deepEqual(await handlers.get('office:cancelCreate')!(event, { requestId: 'create-1' }), {
    ok: true,
    value: true
  })
})

test('IPC registers no Office channels when Office availability is disabled', () => {
  const { coordinator } = fixture()
  const handlers = new Map<string, (...args: unknown[]) => unknown>()
  const ipcMain: OfficeIpcMainLike = {
    handle: (channel, handler) => {
      handlers.set(channel, handler as (...args: unknown[]) => unknown)
    }
  }

  registerOfficeRendererIpc(ipcMain, coordinator, { enabled: false })

  assert.deepEqual([...handlers.keys()], [])
})

test('IPC exposes only controlled close and status operations', async () => {
  const { handlers, event } = fixture()

  assert.deepEqual(
    await handlers.get('office:close')!(event, {
      artifactId: 'artifact-1',
      sessionId: 'session-1'
    }),
    {
      ok: true,
      value: true
    }
  )
  assert.deepEqual(
    await handlers.get('office:status')!(event, { sourcePath: '/project/report.xlsx' }),
    { ok: true, value: null }
  )
  assert.equal(handlers.has('office:execute'), false)
})

test('IPC clears selection only for the current-session artifact with a strict payload', async () => {
  const { handlers, event } = fixture()
  const invoke = handlers.get('office:clearSelection')!

  assert.deepEqual(await invoke(event, { artifactId: 'artifact-1' }), {
    ok: true,
    value: true
  })
  assert.deepEqual(await invoke(event, { artifactId: 'artifact-1', file: '/tmp/other.xlsx' }), {
    ok: false,
    error: { code: 'invalid-request', message: 'Office 清除选区请求无效' }
  })
})

test('IPC accepts only controlled preview preferences for the current session', async () => {
  const preferences: unknown[] = []
  const { handlers, event } = fixture({
    onPreviewPreferences: (input) => {
      preferences.push(input)
      return true
    }
  })
  const invoke = handlers.get('office:setPreviewPreferences')!

  assert.deepEqual(
    await invoke(event, { artifactId: 'artifact-1', visible: true, followAi: false }),
    { ok: true, value: true }
  )
  for (const forged of [
    { artifactId: 'artifact-1', visible: true, followAi: true, sessionId: 'other' },
    { artifactId: 'artifact-1', visible: true, followAi: true, sheet: 'Sheet1' },
    { artifactId: 'artifact-1', visible: true, followAi: true, range: 'A1' },
    { artifactId: 'artifact-1', visible: true, followAi: true, file: '/tmp/other.xlsx' },
    { artifactId: 'artifact-1', visible: 'yes', followAi: true }
  ]) {
    assert.deepEqual(await invoke(event, forged), {
      ok: false,
      error: { code: 'invalid-request', message: 'Office 预览偏好请求无效' }
    })
  }
  assert.deepEqual(preferences, [
    {
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      visible: true,
      followAi: false
    }
  ])
})

test('IPC reconciles only an artifact id in the trusted current session', async () => {
  const calls: unknown[] = []
  const { handlers, event } = fixture({
    onReconcile: (artifactId, sessionId) => calls.push({ artifactId, sessionId })
  })
  const invoke = handlers.get('office:reconcile')!

  assert.deepEqual(await invoke(event, { artifactId: 'artifact-1' }), {
    ok: true,
    value: {
      conclusion: 'applied',
      message: '已核对：写入已生效',
      revision: 1
    }
  })
  assert.deepEqual(await invoke(event, { artifactId: 'artifact-1', sessionId: 'session-2' }), {
    ok: false,
    error: { code: 'invalid-request', message: 'Office 核对请求无效' }
  })
  assert.deepEqual(await invoke({ ...event, senderFrame: {} }, { artifactId: 'artifact-1' }), {
    ok: false,
    error: { code: 'unauthorized', message: 'Office 预览调用方未获授权' }
  })
  assert.deepEqual(calls, [{ artifactId: 'artifact-1', sessionId: 'session-1' }])
})

test('IPC saves only an artifact id in the trusted current session', async () => {
  const calls: unknown[] = []
  const { handlers, event } = fixture({
    onSave: (artifactId, sessionId) => calls.push({ artifactId, sessionId })
  })
  const invoke = handlers.get('office:save')!

  assert.deepEqual(await invoke(event, { artifactId: 'artifact-1' }), {
    ok: true,
    value: {
      saved: true,
      revision: 1,
      lastSavedAt: '2026-10-05T12:00:00.000Z'
    }
  })
  assert.deepEqual(await invoke(event, { artifactId: 'artifact-1', targetPath: '/tmp/out.xlsx' }), {
    ok: false,
    error: { code: 'invalid-request', message: 'Office 保存请求无效' }
  })
  assert.deepEqual(calls, [{ artifactId: 'artifact-1', sessionId: 'session-1' }])
})

test('IPC chooses and validates save-as targets in main, returns cancellation, and never accepts a path', async () => {
  const calls: unknown[] = []
  const selected = fixture({
    saveAsTarget: '/project/outputs/report.xlsx',
    onSaveAs: (input) => calls.push(input)
  })
  assert.deepEqual(
    await selected.handlers.get('office:saveAs')!(selected.event, { artifactId: 'artifact-1' }),
    {
      ok: true,
      value: {
        status: 'saved',
        output: {
          outputId: 'output-1',
          outputPath: 'outputs/report.xlsx',
          fileName: 'report.xlsx',
          revision: 1,
          sha256: 'a'.repeat(64),
          size: 1024,
          createdAt: '2026-10-05T12:00:00.000Z',
          source: 'draft'
        }
      }
    }
  )
  assert.deepEqual(
    await selected.handlers.get('office:revealOutput')!(selected.event, {
      artifactId: 'artifact-1',
      outputId: 'output-1'
    }),
    { ok: true, value: true }
  )
  assert.deepEqual(selected.revealed, ['/project/outputs/report.xlsx'])
  assert.deepEqual(calls, [
    {
      artifactId: 'artifact-1',
      sessionId: 'session-1',
      projectRoot: '/project',
      targetPath: '/project/outputs/report.xlsx'
    }
  ])
  assert.deepEqual(
    await selected.handlers.get('office:saveAs')!(selected.event, {
      artifactId: 'artifact-1',
      targetPath: '/tmp/forged.xlsx'
    }),
    { ok: false, error: { code: 'invalid-request', message: 'Office 另存请求无效' } }
  )

  const cancelled = fixture({ saveAsTarget: null })
  assert.deepEqual(
    await cancelled.handlers.get('office:saveAs')!(cancelled.event, { artifactId: 'artifact-1' }),
    { ok: true, value: { status: 'cancelled' } }
  )
})

test('IPC reports the kind-specific required extension without leaking validation details', async () => {
  const calls: unknown[] = []
  const selected = fixture({
    saveAsTarget: '/project/outputs/report.xlsx',
    saveAsKind: 'docx',
    saveAsValidationError: 'invalid_extension',
    onChooseSaveAs: (input) => calls.push(input),
    onValidateSaveAs: (input) => calls.push(input)
  })

  const result = await selected.handlers.get('office:saveAs')!(selected.event, {
    artifactId: 'artifact-1'
  })

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'invalid_extension', message: '另存文件必须使用 .docx 扩展名' }
  })
  assert.deepEqual(calls, [
    { projectRoot: '/project', fileName: 'report.docx', kind: 'docx' },
    {
      projectRoot: '/project',
      targetPath: '/project/outputs/report.xlsx',
      kind: 'docx'
    }
  ])
  assert.doesNotMatch(JSON.stringify(result), /private validation detail/u)
})

test('IPC status exposes only sanitized freeze, save, and reconciliation summaries', async () => {
  const { handlers, event } = fixture({
    status: {
      state: 'ready',
      document: {
        artifactId: 'artifact-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        kind: 'xlsx',
        sourcePath: '/private/source.xlsx',
        sourceHash: 'hash',
        draftPath: '/private/artifact/source.xlsx',
        residentPid: 101,
        watchPid: 202,
        watchPort: 31_001,
        gatewayPort: 42_001,
        previewUrl: 'http://127.0.0.1:42001/'
      },
      freezeState: 'unknown',
      readOnly: true,
      needsSave: true,
      saveState: 'failed',
      lastSavedRevision: 2,
      lastSavedAt: '2026-10-05T12:00:00.000Z',
      lastReconciliation: {
        conclusion: 'indeterminate',
        message: '无法读取目标单元格'
      },
      lastHumanEdit: {
        type: 'formula',
        conclusion: 'failed',
        code: 'formula_invalid',
        message: '公式无法计算，已撤销：函数暂不受支持',
        value: '=SECRET()',
        path: '/Sheet1/A1',
        pid: 999
      } as never
    }
  })

  const result = await handlers.get('office:status')!(event, {
    sourcePath: '/project/report.xlsx'
  })
  assert.deepEqual(result, {
    ok: true,
    value: {
      state: 'ready',
      document: {
        artifactId: 'artifact-1',
        sessionId: 'session-1',
        projectId: 'project-1',
        kind: 'xlsx',
        humanEdit: 'cells',
        followAiControllable: true,
        sourcePath: '/private/source.xlsx',
        sourceHash: 'hash',
        previewUrl: 'http://127.0.0.1:42001/',
        readOnly: true,
        freezeState: 'unknown',
        needsSave: true,
        saveState: 'failed',
        lastSavedRevision: 2,
        lastSavedAt: '2026-10-05T12:00:00.000Z',
        lastReconciliation: {
          conclusion: 'indeterminate',
          message: '无法读取目标单元格'
        },
        lastHumanEdit: {
          type: 'formula',
          conclusion: 'failed',
          code: 'formula_invalid',
          message: '公式无法计算，已撤销：函数暂不受支持'
        }
      }
    }
  })
  assert.doesNotMatch(
    JSON.stringify(result),
    /draftPath|residentPid|watchPort|gatewayPort|SECRET|Sheet1|999/u
  )
})

test('IPC exposes imported metadata and opens the private XLSX rather than the CSV source', async () => {
  const sourceHash = 'a'.repeat(64)
  const { handlers, event } = fixture({
    status: {
      state: 'ready',
      document: {
        artifactId: 'artifact-import',
        sessionId: 'session-1',
        projectId: 'project-1',
        kind: 'xlsx',
        origin: 'import',
        sourcePath: '/project/data.csv',
        sourceHash,
        importSource: {
          path: 'data.csv',
          format: 'csv',
          delimiter: ',',
          rows: 1_000,
          columns: 80,
          sha256: sourceHash
        },
        draftPath: '/private/artifact/data.xlsx',
        residentPid: 101,
        watchPid: 202,
        watchPort: 31_001,
        gatewayPort: 42_001,
        previewUrl: 'http://127.0.0.1:42001/'
      },
      readOnly: false,
      saveState: 'saved',
      lastSavedRevision: 0
    }
  })

  const result = await handlers.get('office:status')!(event, { sourcePath: '/private/data.xlsx' })
  assert.equal(result.ok, true)
  if (!result.ok) throw new Error(result.error.message)
  assert.equal(result.value?.state, 'ready')
  if (result.value?.state !== 'ready') throw new Error('imported document not ready')
  assert.equal(result.value.document.sourcePath, '/private/artifact/data.xlsx')
  assert.deepEqual(result.value.document.importSource, {
    path: 'data.csv',
    format: 'csv',
    delimiter: ',',
    rows: 1_000,
    columns: 80,
    sha256: sourceHash
  })
  assert.doesNotMatch(JSON.stringify(result), /residentPid|watchPort|gatewayPort/u)
})

test('IPC exposes docx kind and no human editing without marking the document read-only', async () => {
  const { handlers, event } = fixture({
    status: {
      state: 'ready',
      document: {
        artifactId: 'artifact-docx',
        sessionId: 'session-1',
        projectId: 'project-1',
        kind: 'docx',
        sourcePath: '/private/source.docx',
        sourceHash: 'hash',
        draftPath: '/private/artifact/source.docx',
        residentPid: 101,
        watchPid: 202,
        watchPort: 31_001,
        gatewayPort: 42_001,
        previewUrl: 'http://127.0.0.1:42001/',
        previewState: 'preview_failed',
        previewError: '预览渲染失败：预览页面未显示文档正文'
      },
      readOnly: false,
      saveState: 'saved',
      lastSavedRevision: 0
    }
  })

  assert.deepEqual(
    await handlers.get('office:status')!(event, { sourcePath: '/project/report.docx' }),
    {
      ok: true,
      value: {
        state: 'ready',
        document: {
          artifactId: 'artifact-docx',
          sessionId: 'session-1',
          projectId: 'project-1',
          kind: 'docx',
          humanEdit: 'none',
          sourcePath: '/private/source.docx',
          sourceHash: 'hash',
          previewUrl: 'http://127.0.0.1:42001/',
          previewState: 'preview_failed',
          previewError: '预览渲染失败：预览页面未显示文档正文',
          readOnly: false,
          saveState: 'saved',
          lastSavedRevision: 0
        }
      }
    }
  )
})

test('IPC exposes pptx kind, no human editing, and the authoritative slide count', async () => {
  const { handlers, event } = fixture({
    status: {
      state: 'ready',
      document: {
        artifactId: 'artifact-pptx',
        sessionId: 'session-1',
        projectId: 'project-1',
        kind: 'pptx',
        sourcePath: '/private/source.pptx',
        sourceHash: 'hash',
        draftPath: '/private/artifact/source.pptx',
        residentPid: 101,
        watchPid: 202,
        watchPort: 31_001,
        gatewayPort: 42_001,
        previewUrl: 'http://127.0.0.1:42001/',
        previewState: 'ready',
        slideCount: 0
      },
      readOnly: false,
      saveState: 'saved',
      lastSavedRevision: 0
    }
  })

  assert.deepEqual(
    await handlers.get('office:status')!(event, { sourcePath: '/project/report.pptx' }),
    {
      ok: true,
      value: {
        state: 'ready',
        document: {
          artifactId: 'artifact-pptx',
          sessionId: 'session-1',
          projectId: 'project-1',
          kind: 'pptx',
          humanEdit: 'none',
          sourcePath: '/private/source.pptx',
          sourceHash: 'hash',
          previewUrl: 'http://127.0.0.1:42001/',
          previewState: 'ready',
          slideCount: 0,
          readOnly: false,
          saveState: 'saved',
          lastSavedRevision: 0
        }
      }
    }
  )
})

test('IPC forwards selection events only for artifacts owned by the current session', () => {
  const { sent, emitSelection } = fixture()

  emitSelection({
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    selection: { sheet: 'Sheet1', range: 'A1:B3', paths: ['/Sheet1/A1', '/Sheet1/B3'] }
  })
  emitSelection({
    artifactId: 'artifact-foreign',
    sessionId: 'session-2',
    selection: { sheet: 'Sheet1', range: 'C1', paths: ['/Sheet1/C1'] }
  })

  assert.deepEqual(sent, [
    {
      channel: 'office:selection',
      payload: {
        artifactId: 'artifact-1',
        selection: { sheet: 'Sheet1', range: 'A1:B3', paths: ['/Sheet1/A1', '/Sheet1/B3'] }
      }
    }
  ])
})

test('selection forwarding never touches destroyed renderer properties', () => {
  let emitSelection: (event: unknown) => void = () => undefined
  const destroyed = {
    isDestroyed: () => true,
    get mainFrame(): never {
      throw new Error('Object has been destroyed')
    },
    send: (): never => {
      throw new Error('Object has been destroyed')
    }
  }
  const coordinator = new OfficeIpcCoordinator({
    service: {
      open: async (request) => ({ state: 'preparing', sourcePath: request.sourcePath }),
      create: async (request) => ({ state: 'preparing', requestId: request.requestId }),
      cancelCreate: async () => true,
      clearSelection: async () => true,
      setPreviewPreferences: () => false,
      reconcile: async () => ({
        conclusion: 'indeterminate',
        message: '无法确认写入结果，文档继续冻结',
        revision: 0,
        freezeState: 'unknown'
      }),
      close: async () => true,
      statusForSource: () => undefined,
      onSelection: (listener) => {
        emitSelection = listener as (event: unknown) => void
        return () => undefined
      }
    } as never,
    getTrustedRenderer: () => destroyed,
    resolveContext: () => ({ sessionId: 'session-1', projectId: null, allowRoots: [] })
  })
  const ipcMain: OfficeIpcMainLike = { handle: () => undefined }
  registerOfficeRendererIpc(ipcMain, coordinator)

  assert.doesNotThrow(() =>
    emitSelection({ artifactId: 'artifact-1', sessionId: 'session-1', selection: null })
  )
})
