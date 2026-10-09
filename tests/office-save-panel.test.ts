import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { OfficeSaveToolbar } from '../src/renderer/src/features/office/components/OfficeSaveToolbar'
import { OfficeReadyDocument } from '../src/renderer/src/features/office/components/OfficeReadyDocument'
import { createOfficeSaveController } from '../src/renderer/src/features/office/lib/officeSaveController'
import { createOfficeSaveAsController } from '../src/renderer/src/features/office/lib/officeSaveAsController'
import { officePanelErrorMessage } from '../src/renderer/src/features/office/lib/officeDocumentUi'
import type { OfficePreviewDocument, OfficeRendererBridge } from '../src/shared/officeProtocol'

function document(
  saveState: OfficePreviewDocument['saveState'],
  overrides: Partial<OfficePreviewDocument> = {}
): OfficePreviewDocument {
  return {
    artifactId: 'artifact-1',
    sessionId: 'session-1',
    projectId: 'project-1',
    sourcePath: '/project/source.xlsx',
    sourceHash: 'source-hash',
    previewUrl: 'http://127.0.0.1:42001/',
    readOnly: false,
    saveState,
    lastSavedRevision: 1,
    ...overrides
  }
}

test('preview failures always have an explicit rendering label', () => {
  assert.equal(
    officePanelErrorMessage('preview_failed', '未找到文档容器'),
    '预览渲染失败：未找到文档容器'
  )
  assert.equal(
    officePanelErrorMessage('preview_failed', '预览渲染失败：首批正文未出现'),
    '预览渲染失败：首批正文未出现'
  )
  assert.equal(officePanelErrorMessage('open_failed', '无法打开文档'), '无法打开文档')
  assert.equal(
    officePanelErrorMessage('missing', 'Office 支持尚未安装，请先完成用户级安装'),
    'Office 支持尚未安装，请先完成用户级安装'
  )
  assert.equal(
    officePanelErrorMessage('unsupported-platform', '当前平台暂不支持 Office'),
    '当前平台暂不支持 Office'
  )
})

test('save toolbar distinguishes source drafts, progress, failure retry, and frozen state', () => {
  const saved = renderToStaticMarkup(
    createElement(OfficeSaveToolbar, {
      document: document('saved'),
      state: { phase: 'idle' },
      onSave: () => undefined
    })
  )
  assert.match(saved, /data-phi-office-save-state="saved"/u)
  assert.match(saved, /草稿已保存（原文件未改动）/u)
  assert.match(saved, /data-phi-office-save-draft="true"/u)
  assert.match(saved, /<button(?![^>]*disabled)[^>]*>保存草稿<\/button>/u)

  const saving = renderToStaticMarkup(
    createElement(OfficeSaveToolbar, {
      document: document('saving'),
      state: { phase: 'pending' },
      onSave: () => undefined
    })
  )
  assert.match(saving, /data-phi-office-save-state="saving"/u)
  assert.match(saving, /保存中…/u)

  const failed = renderToStaticMarkup(
    createElement(OfficeSaveToolbar, {
      document: document('failed'),
      state: { phase: 'error', message: '草稿保存失败，内容仍保留' },
      onSave: () => undefined
    })
  )
  assert.match(failed, /保存失败/u)
  assert.match(failed, />重试</u)
  assert.match(failed, /<button(?![^>]*disabled)[^>]*>重试<\/button>/u)

  const frozen = renderToStaticMarkup(
    createElement(OfficeSaveToolbar, {
      document: document('unsaved', { freezeState: 'unknown' }),
      state: { phase: 'idle' },
      onSave: () => undefined
    })
  )
  assert.match(frozen, /请先核对写入结果/u)
  assert.match(frozen, /<button[^>]*disabled/u)
})

test('save controller coalesces clicks and refreshes the authoritative document state', async () => {
  let finish!: (value: Awaited<ReturnType<OfficeRendererBridge['save']>>) => void
  const saves: unknown[] = []
  const states: unknown[] = []
  const documents: unknown[] = []
  const bridge = {
    save: (input: unknown) => {
      saves.push(input)
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    status: async () => ({
      ok: true as const,
      value: { state: 'ready' as const, document: document('saved') }
    })
  } as Pick<OfficeRendererBridge, 'save' | 'status'>
  const controller = createOfficeSaveController({
    bridge,
    onState: (state) => states.push(state),
    onDocumentState: (state) => documents.push(state)
  })

  const first = controller.save(document('unsaved'))
  const second = controller.save(document('unsaved'))
  finish({
    ok: true,
    value: { saved: true, revision: 1, lastSavedAt: '2026-10-05T12:00:00.000Z' }
  })
  await Promise.all([first, second])

  assert.deepEqual(saves, [{ artifactId: 'artifact-1' }])
  assert.deepEqual(states, [{ phase: 'pending' }, { phase: 'success' }])
  assert.equal(documents.length, 1)
})

test('save-as toolbar shows a sanitized success summary and a retryable failure', () => {
  const output = {
    outputId: 'output-1',
    outputPath: 'outputs/report.xlsx',
    fileName: 'report.xlsx',
    revision: 4,
    sha256: 'a'.repeat(64),
    size: 2048,
    createdAt: '2026-10-05T12:00:00.000Z',
    source: 'draft' as const
  }
  const success = renderToStaticMarkup(
    createElement(OfficeSaveToolbar, {
      document: document('saved'),
      state: { phase: 'idle' },
      saveAsState: { phase: 'success', output },
      onSave: () => undefined,
      onSaveAs: () => undefined,
      onRevealOutput: () => undefined
    })
  )
  assert.match(success, /另存为…/u)
  assert.match(success, /report\.xlsx/u)
  assert.match(success, /outputs\/report\.xlsx/u)
  assert.match(success, /revision 4/u)
  assert.match(success, /在文件夹中显示/u)

  const failure = renderToStaticMarkup(
    createElement(OfficeSaveToolbar, {
      document: document('saved'),
      state: { phase: 'idle' },
      saveAsState: { phase: 'error', message: '目标文件已存在；Phi 不会覆盖已有文件' },
      onSave: () => undefined,
      onSaveAs: () => undefined
    })
  )
  assert.match(failure, /目标文件已存在/u)
  assert.doesNotMatch(failure, /data-phi-office-save-as-success/u)
})

test('save-as controller coalesces requests and never reports cancellation as success', async () => {
  const states: unknown[] = []
  const calls: unknown[] = []
  const controller = createOfficeSaveAsController({
    bridge: {
      saveAs: async (input) => {
        calls.push(input)
        return { ok: true, value: { status: 'cancelled' } }
      }
    },
    onState: (state) => states.push(state)
  })
  await Promise.all([controller.saveAs(document('saved')), controller.saveAs(document('saved'))])

  assert.deepEqual(calls, [{ artifactId: 'artifact-1' }])
  assert.deepEqual(states, [{ phase: 'pending' }, { phase: 'idle' }])
})

test('DOCX uses a read-only preview hint without becoming globally read-only', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeReadyDocument, {
      document: document('saved', { kind: 'docx', humanEdit: 'none', readOnly: false }),
      save: { state: { phase: 'idle' }, save: async () => undefined },
      saveAs: {
        state: { phase: 'idle' },
        saveAs: async () => undefined,
        revealOutput: async () => undefined
      },
      reconciliation: { state: { phase: 'idle' }, reconcile: async () => undefined },
      humanEdit: { dismiss: () => undefined },
      recreateFromSource: () => undefined
    })
  )

  assert.match(markup, /只读实时预览/u)
  assert.match(markup, /显示效果可能与 Microsoft Word 略有差异/u)
  assert.doesNotMatch(markup, /双击单元格可编辑/u)
  assert.doesNotMatch(markup, /当前文档暂不可编辑/u)
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>保存草稿<\/button>/u)
})

test('DOCX preview_failed keeps save controls but does not mount a misleading webview', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeReadyDocument, {
      document: document('saved', {
        kind: 'docx',
        humanEdit: 'none',
        previewState: 'preview_failed',
        previewError: '预览渲染失败：预览页面未显示文档正文'
      }),
      save: { state: { phase: 'idle' }, save: async () => undefined },
      saveAs: {
        state: { phase: 'idle' },
        saveAs: async () => undefined,
        revealOutput: async () => undefined
      },
      reconciliation: { state: { phase: 'idle' }, reconcile: async () => undefined },
      humanEdit: { dismiss: () => undefined },
      recreateFromSource: () => undefined
    })
  )

  assert.match(markup, /预览渲染失败：预览页面未显示文档正文/u)
  assert.doesNotMatch(markup, /data-phi-office-webview/u)
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>保存草稿<\/button>/u)
})

test('an empty PPTX shows a real zero-slide state while its live preview stays hidden', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeReadyDocument, {
      document: document('saved', {
        kind: 'pptx',
        humanEdit: 'none',
        readOnly: false,
        slideCount: 0
      }),
      save: { state: { phase: 'idle' }, save: async () => undefined },
      saveAs: {
        state: { phase: 'idle' },
        saveAs: async () => undefined,
        revealOutput: async () => undefined
      },
      reconciliation: { state: { phase: 'idle' }, reconcile: async () => undefined },
      humanEdit: { dismiss: () => undefined },
      recreateFromSource: () => undefined
    })
  )

  assert.match(markup, /只读实时预览/u)
  assert.match(markup, /显示效果可能与 Microsoft PowerPoint 略有差异/u)
  assert.match(markup, /data-phi-office-empty-preview="pptx"/u)
  assert.match(markup, /暂无幻灯片/u)
  assert.match(markup, /data-phi-office-webview="true"/u)
  assert.match(markup, /aria-hidden="true"/u)
  assert.match(markup, /visibility:hidden/u)
  assert.match(markup, /<button(?![^>]*disabled)[^>]*>保存草稿<\/button>/u)
})

test('a non-empty PPTX exposes its live preview without the zero-slide state', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeReadyDocument, {
      document: document('saved', {
        kind: 'pptx',
        humanEdit: 'none',
        readOnly: false,
        slideCount: 1
      }),
      save: { state: { phase: 'idle' }, save: async () => undefined },
      saveAs: {
        state: { phase: 'idle' },
        saveAs: async () => undefined,
        revealOutput: async () => undefined
      },
      reconciliation: { state: { phase: 'idle' }, reconcile: async () => undefined },
      humanEdit: { dismiss: () => undefined },
      recreateFromSource: () => undefined
    })
  )

  assert.match(markup, /data-phi-office-webview="true"/u)
  assert.doesNotMatch(markup, /data-phi-office-empty-preview/u)
  assert.doesNotMatch(markup, /aria-hidden="true"/u)
  assert.doesNotMatch(markup, /visibility:hidden/u)
})
