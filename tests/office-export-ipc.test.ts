import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  OfficeExportIpcFlow,
  registerOfficeExportRendererIpc,
  type OfficeExportIpcMainLike
} from '../src/main/agent/office/office-export-ipc'

function fixture(): {
  handlers: Map<string, (event: unknown, input: unknown) => unknown>
  calls: unknown[]
  event: {
    sender: { mainFrame: object; isDestroyed: () => boolean }
    senderFrame: object
  }
} {
  const handlers = new Map<string, (event: unknown, input: unknown) => unknown>()
  const calls: unknown[] = []
  const mainFrame = {}
  const sender = { mainFrame, isDestroyed: () => false }
  const flow = new OfficeExportIpcFlow({
    service: {
      exportDescriptor: (_artifactId, _sessionId, sheet, format) => ({
        fileName: `book-${sheet}.${format}`,
        sheet,
        format
      }),
      exportSheet: async (request) => {
        calls.push(request)
        return {
          outputId: 'output-1',
          outputPath: 'book-Sheet1.csv',
          fileName: 'book-Sheet1.csv',
          revision: 2,
          sha256: 'a'.repeat(64),
          size: 12,
          createdAt: '2026-10-06T00:00:00.000Z',
          source: 'draft',
          format: 'csv',
          sheet: 'Sheet1',
          rows: 2,
          columns: 2
        }
      }
    },
    getTrustedRenderer: () => sender,
    resolveContext: () => ({ sessionId: 'session-1', outputRoot: '/project' }),
    chooseExportTarget: async () => '/project/book-Sheet1.csv'
  })
  const ipcMain: OfficeExportIpcMainLike = {
    handle: (channel, listener) => handlers.set(channel, listener as never)
  }
  registerOfficeExportRendererIpc(ipcMain, flow)
  return { handlers, calls, event: { sender, senderFrame: mainFrame } }
}

test('export IPC owns the target path and forwards only validated identity fields', async () => {
  const { handlers, calls, event } = fixture()
  const result = await handlers.get('office:export')!(event, {
    requestId: 'export-1',
    artifactId: 'artifact-1',
    sheet: 'Sheet1',
    format: 'csv'
  })

  assert.equal((result as { ok: boolean }).ok, true)
  assert.equal(calls.length, 1)
  const { signal, beginCommit, ...request } = calls[0] as {
    signal: AbortSignal
    beginCommit: () => void
    [key: string]: unknown
  }
  assert.deepEqual(request, {
    requestId: 'export-1',
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectRoot: '/project',
    targetPath: '/project/book-Sheet1.csv',
    sheet: 'Sheet1',
    format: 'csv'
  })
  assert.equal(signal instanceof AbortSignal, true)
  assert.equal(typeof beginCommit, 'function')
})

test('export IPC rejects paths, identities, unsupported formats, and child frames', async () => {
  const { handlers, calls, event } = fixture()
  const invoke = handlers.get('office:export')!
  for (const invalid of [
    { requestId: 'export-1', artifactId: 'artifact-1', sheet: 'Sheet1', format: 'xlsx' },
    {
      requestId: 'export-1',
      artifactId: 'artifact-1',
      sheet: 'Sheet1',
      format: 'csv',
      targetPath: '/tmp/forged.csv'
    }
  ]) {
    assert.deepEqual(await invoke(event, invalid), {
      ok: false,
      error: { code: 'invalid-request', message: 'Office 导出请求无效' }
    })
  }
  const child = await invoke(
    { ...event, senderFrame: {} },
    { requestId: 'export-2', artifactId: 'artifact-1', sheet: 'Sheet1', format: 'tsv' }
  )
  assert.deepEqual(child, {
    ok: false,
    error: { code: 'unauthorized', message: 'Office 导出调用方未获授权' }
  })
  assert.deepEqual(calls, [])
})

test('cancel export aborts the matching main-process request', async () => {
  let signal: AbortSignal | undefined
  let finish!: () => void
  const mainFrame = {}
  const sender = { mainFrame, isDestroyed: () => false }
  const flow = new OfficeExportIpcFlow({
    service: {
      exportDescriptor: () => ({ fileName: 'book.tsv', sheet: 'Sheet1', format: 'tsv' }),
      exportSheet: async (request) => {
        signal = request.signal
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        throw Object.assign(new Error('cancelled'), { code: 'export_cancelled' })
      }
    },
    getTrustedRenderer: () => sender,
    resolveContext: () => ({ sessionId: 'session-1', outputRoot: '/project' }),
    chooseExportTarget: async () => '/project/book.tsv'
  })
  const event = { sender, senderFrame: mainFrame }
  const pending = flow.exportSheet(event, {
    requestId: 'export-cancel',
    artifactId: 'artifact-1',
    sheet: 'Sheet1',
    format: 'tsv'
  })
  while (!signal) await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(await flow.cancel(event, { requestId: 'export-cancel' }), {
    ok: true,
    value: true
  })
  assert.equal(signal.aborted, true)
  finish()
  assert.deepEqual(await pending, {
    ok: false,
    error: { code: 'export_cancelled', message: 'Office 导出已取消' }
  })
})

test('cancel returns false after the export crosses its durable commit point', async () => {
  let finish!: () => void
  let committed!: () => void
  const commitStarted = new Promise<void>((resolve) => (committed = resolve))
  const mainFrame = {}
  const sender = { mainFrame, isDestroyed: () => false }
  const flow = new OfficeExportIpcFlow({
    service: {
      exportDescriptor: () => ({ fileName: 'book.csv', sheet: 'Sheet1', format: 'csv' }),
      exportSheet: async (request) => {
        request.beginCommit?.()
        committed()
        await new Promise<void>((resolve) => (finish = resolve))
        return {
          outputId: 'output-commit',
          outputPath: 'book.csv',
          fileName: 'book.csv',
          revision: 2,
          sha256: 'b'.repeat(64),
          size: 6,
          createdAt: '2026-10-06T00:00:00.000Z',
          source: 'draft',
          format: 'csv',
          sheet: 'Sheet1',
          rows: 1,
          columns: 1
        }
      }
    },
    getTrustedRenderer: () => sender,
    resolveContext: () => ({ sessionId: 'session-1', outputRoot: '/project' }),
    chooseExportTarget: async () => '/project/book.csv'
  })
  const event = { sender, senderFrame: mainFrame }
  const pending = flow.exportSheet(event, {
    requestId: 'export-commit',
    artifactId: 'artifact-1',
    sheet: 'Sheet1',
    format: 'csv'
  })
  await commitStarted
  assert.deepEqual(await flow.cancel(event, { requestId: 'export-commit' }), {
    ok: true,
    value: false
  })
  finish()
  assert.equal((await pending).ok, true)
})
