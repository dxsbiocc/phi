import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { OfficeExportMenu } from '../src/renderer/src/features/office/components/OfficeExportMenu'
import {
  createOfficeExportController,
  officeExportAvailable
} from '../src/renderer/src/features/office/lib/officeExportController'
import type {
  OfficeExportOutputSummary,
  OfficePreviewDocument,
  OfficeRendererBridge
} from '../src/shared/officeProtocol'

function document(overrides: Partial<OfficePreviewDocument> = {}): OfficePreviewDocument {
  return {
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    sourcePath: '/project/source.xlsx',
    sourceHash: 'source-hash',
    previewUrl: 'http://127.0.0.1:42001/',
    readOnly: false,
    saveState: 'saved',
    lastSavedRevision: 3,
    ...overrides
  }
}

function menuMarkup(
  overrides: Partial<React.ComponentProps<typeof OfficeExportMenu>> = {}
): string {
  return renderToStaticMarkup(
    createElement(OfficeExportMenu, {
      available: true,
      document: document(),
      activeSheet: '数据表',
      state: { phase: 'idle' },
      onExport: () => undefined,
      onCancel: () => undefined,
      onRevealOutput: () => undefined,
      ...overrides
    })
  )
}

test('export actions appear only for capable XLSX previews and explain the fixed data tradeoffs', () => {
  const visible = menuMarkup()

  assert.match(visible, /导出为 CSV/u)
  assert.match(visible, /导出为 TSV/u)
  assert.match(visible, /data-phi-office-export-csv="true"/u)
  assert.match(visible, /data-phi-office-export-tsv="true"/u)
  assert.match(visible, /仅导出当前工作表/u)
  assert.match(visible, /计算值/u)
  assert.match(visible, /不保留格式、公式或图表/u)
  assert.match(visible, /=、\+、-、@/u)
  assert.match(visible, /忠实导出/u)
  assert.equal(menuMarkup({ available: false }), '')
  assert.equal(menuMarkup({ document: document({ kind: 'docx', humanEdit: 'none' }) }), '')
})

function assertBlocked(
  documentOverrides: Partial<OfficePreviewDocument>,
  message: RegExp,
  activeSheet = '数据表'
): void {
  const markup = menuMarkup({ document: document(documentOverrides), activeSheet })
  assert.equal((markup.match(/<button[^>]*disabled/g) ?? []).length, 2)
  assert.match(markup, message)
}

test('export actions disable every unsafe state with an explicit reason and never invent Sheet1', () => {
  assertBlocked({ previewState: 'preview_failed' }, /预览渲染失败.*无法确认当前工作表/u)
  assertBlocked({ readOnly: true }, /只读.*不能导出/u)
  assertBlocked({ freezeState: 'unknown' }, /写入结果待核对/u)
  assertBlocked({ needsSave: true }, /草稿尚未成功保存/u)
  assertBlocked({ saveState: 'editing' }, /草稿正在修改/u)
  assertBlocked({ saveState: 'unsaved' }, /草稿尚未保存/u)
  assertBlocked({ saveState: 'saving' }, /草稿正在保存/u)
  assertBlocked({ saveState: 'failed' }, /草稿保存失败/u)
  const noSheet = menuMarkup({ activeSheet: undefined })
  assert.equal((noSheet.match(/<button[^>]*disabled/g) ?? []).length, 2)
  assert.match(noSheet, /请先在表格预览中选择一个工作表/u)
  assert.doesNotMatch(noSheet, /Sheet1/u)
})

function output(format: 'csv' | 'tsv', sheet: string): OfficeExportOutputSummary {
  return {
    outputId: `output-${format}`,
    outputPath: `exports/数据表.${format}`,
    fileName: `数据表.${format}`,
    revision: 4,
    sha256: 'a'.repeat(64),
    size: 128,
    createdAt: '2026-10-06T12:00:00.000Z',
    source: 'draft',
    format,
    sheet,
    rows: 12,
    columns: 4
  }
}

test('export capability requires the dev bridge and both export methods', () => {
  const exportSheet: NonNullable<OfficeRendererBridge['exportSheet']> = async () => ({
    ok: true,
    value: { status: 'cancelled' }
  })
  const cancelExport: NonNullable<OfficeRendererBridge['cancelExport']> = async () => ({
    ok: true,
    value: true
  })

  assert.equal(officeExportAvailable({ enabled: true, exportSheet, cancelExport }), true)
  assert.equal(officeExportAvailable({ enabled: false, exportSheet, cancelExport }), false)
  assert.equal(officeExportAvailable({ enabled: true, cancelExport }), false)
  assert.equal(officeExportAvailable({ enabled: true, exportSheet }), false)
})

test('export controller creates a new id per request, sends only export identity, and reveals output', async () => {
  const exportInputs: unknown[] = []
  const revealInputs: unknown[] = []
  const states: unknown[] = []
  const ids = ['request-1', 'request-2']
  const bridge = {
    exportSheet: async (input: Parameters<NonNullable<OfficeRendererBridge['exportSheet']>>[0]) => {
      exportInputs.push(input)
      return {
        ok: true as const,
        value: { status: 'saved' as const, output: output(input.format, input.sheet) }
      }
    },
    revealOutput: async (input: unknown) => {
      revealInputs.push(input)
      return { ok: true as const, value: true }
    }
  }
  const controller = createOfficeExportController({
    bridge,
    requestIdFactory: () => ids.shift() ?? assert.fail('unexpected request id'),
    onState: (state) => states.push(state)
  })

  await controller.exportSheet(document(), '明细', 'csv')
  await controller.exportSheet(document(), '汇总', 'tsv')
  await controller.reveal(document(), output('tsv', '汇总'))

  assert.deepEqual(exportInputs, [
    { requestId: 'request-1', artifactId: 'artifact-1', sheet: '明细', format: 'csv' },
    { requestId: 'request-2', artifactId: 'artifact-1', sheet: '汇总', format: 'tsv' }
  ])
  assert.deepEqual(revealInputs, [{ artifactId: 'artifact-1', outputId: 'output-tsv' }])
  assert.deepEqual(states, [
    { phase: 'pending', requestId: 'request-1', format: 'csv', sheet: '明细' },
    { phase: 'success', output: output('csv', '明细') },
    { phase: 'pending', requestId: 'request-2', format: 'tsv', sheet: '汇总' },
    { phase: 'success', output: output('tsv', '汇总') }
  ])
})

test('export controller cancels the active request and ignores its late success reply', async () => {
  type ExportReply = Awaited<ReturnType<NonNullable<OfficeRendererBridge['exportSheet']>>>
  let finish!: (value: ExportReply) => void
  const cancelInputs: unknown[] = []
  const states: unknown[] = []
  const controller = createOfficeExportController({
    bridge: {
      exportSheet: () =>
        new Promise((resolve) => {
          finish = resolve
        }),
      cancelExport: async (input) => {
        cancelInputs.push(input)
        return { ok: true, value: true }
      },
      revealOutput: async () => ({ ok: true, value: true })
    },
    requestIdFactory: () => 'request-cancel',
    onState: (state) => states.push(state)
  })

  const pending = controller.exportSheet(document(), '数据表', 'csv')
  await controller.cancel()
  finish({ ok: true, value: { status: 'saved', output: output('csv', '数据表') } })
  await pending

  assert.deepEqual(cancelInputs, [{ requestId: 'request-cancel' }])
  assert.deepEqual(states, [
    { phase: 'pending', requestId: 'request-cancel', format: 'csv', sheet: '数据表' },
    { phase: 'idle' }
  ])
})

test('export menu shows cancel progress, the full success receipt, and retryable failures', () => {
  const pending = menuMarkup({
    state: { phase: 'pending', requestId: 'request-1', format: 'csv', sheet: '明细' }
  })
  assert.match(pending, /取消导出 CSV/u)
  assert.equal((pending.match(/<button[^>]*disabled/g) ?? []).length, 2)

  const success = menuMarkup({ state: { phase: 'success', output: output('csv', '明细') } })
  assert.match(success, /data-phi-office-export-success="true"/u)
  assert.match(success, /CSV/u)
  assert.match(success, /明细/u)
  assert.match(success, /12 × 4/u)
  assert.match(success, /revision 4/u)
  assert.match(success, /在文件夹中显示/u)

  const failure = menuMarkup({
    state: { phase: 'error', code: 'target_exists', message: '目标文件已存在；Phi 不会覆盖' }
  })
  assert.match(failure, /data-phi-office-export-error="target_exists"/u)
  assert.match(failure, /目标文件已存在/u)
  assert.doesNotMatch(failure, /data-phi-office-export-success/u)
})

test('an export past its commit point reports failed cancellation and still publishes its result', async () => {
  type ExportReply = Awaited<ReturnType<NonNullable<OfficeRendererBridge['exportSheet']>>>
  let finish!: (value: ExportReply) => void
  const states: unknown[] = []
  const controller = createOfficeExportController({
    bridge: {
      exportSheet: () => new Promise((resolve) => (finish = resolve)),
      cancelExport: async () => ({ ok: true, value: false }),
      revealOutput: async () => ({ ok: true, value: true })
    },
    requestIdFactory: () => 'request-cancel-failed',
    onState: (state) => states.push(state)
  })

  const pending = controller.exportSheet(document(), '数据表', 'tsv')
  await controller.cancel()
  finish({ ok: true, value: { status: 'saved', output: output('tsv', '数据表') } })
  await pending

  assert.deepEqual(states, [
    { phase: 'pending', requestId: 'request-cancel-failed', format: 'tsv', sheet: '数据表' },
    {
      phase: 'pending',
      requestId: 'request-cancel-failed',
      format: 'tsv',
      sheet: '数据表',
      cancelMessage: '导出已进入提交阶段，正在等待最终结果'
    },
    { phase: 'success', output: output('tsv', '数据表') }
  ])
})

test('disposing an export controller cancels work without publishing a late state', async () => {
  type ExportReply = Awaited<ReturnType<NonNullable<OfficeRendererBridge['exportSheet']>>>
  let finish!: (value: ExportReply) => void
  const cancelled: unknown[] = []
  const states: unknown[] = []
  const controller = createOfficeExportController({
    bridge: {
      exportSheet: () => new Promise((resolve) => (finish = resolve)),
      cancelExport: async (input) => {
        cancelled.push(input)
        return { ok: true, value: true }
      },
      revealOutput: async () => ({ ok: true, value: true })
    },
    requestIdFactory: () => 'request-dispose',
    onState: (state) => states.push(state)
  })

  const pending = controller.exportSheet(document(), '数据表', 'csv')
  await controller.dispose()
  finish({ ok: true, value: { status: 'saved', output: output('csv', '数据表') } })
  await pending

  assert.deepEqual(cancelled, [{ requestId: 'request-dispose' }])
  assert.deepEqual(states, [
    { phase: 'pending', requestId: 'request-dispose', format: 'csv', sheet: '数据表' }
  ])
})

test('a backend-cancelled export returns to idle without a false success receipt', async () => {
  const states: unknown[] = []
  const controller = createOfficeExportController({
    bridge: {
      exportSheet: async () => ({ ok: true, value: { status: 'cancelled' } }),
      cancelExport: async () => ({ ok: true, value: true }),
      revealOutput: async () => ({ ok: true, value: true })
    },
    requestIdFactory: () => 'request-backend-cancel',
    onState: (state) => states.push(state)
  })

  await controller.exportSheet(document(), '数据表', 'csv')

  assert.deepEqual(states, [
    { phase: 'pending', requestId: 'request-backend-cancel', format: 'csv', sheet: '数据表' },
    { phase: 'idle' }
  ])
})

test('a late cancel IPC error cannot overwrite an export that already succeeded', async () => {
  type ExportReply = Awaited<ReturnType<NonNullable<OfficeRendererBridge['exportSheet']>>>
  let finishExport!: (value: ExportReply) => void
  let rejectCancel!: (error: Error) => void
  const states: unknown[] = []
  const controller = createOfficeExportController({
    bridge: {
      exportSheet: () => new Promise((resolve) => (finishExport = resolve)),
      cancelExport: () => new Promise((_resolve, reject) => (rejectCancel = reject)),
      revealOutput: async () => ({ ok: true, value: true })
    },
    requestIdFactory: () => 'request-late-cancel-error',
    onState: (state) => states.push(state)
  })

  const exporting = controller.exportSheet(document(), '数据表', 'csv')
  const cancelling = controller.cancel()
  finishExport({ ok: true, value: { status: 'saved', output: output('csv', '数据表') } })
  await exporting
  rejectCancel(new Error('late cancel failure'))
  await cancelling

  assert.deepEqual(states, [
    {
      phase: 'pending',
      requestId: 'request-late-cancel-error',
      format: 'csv',
      sheet: '数据表'
    },
    { phase: 'success', output: output('csv', '数据表') }
  ])
})
