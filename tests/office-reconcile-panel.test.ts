import assert from 'node:assert/strict'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { OfficeDocumentAlert } from '../src/renderer/src/features/office/components/OfficeDocumentAlert'
import { createOfficeReconcileController } from '../src/renderer/src/features/office/lib/officeReconcileController'
import type { OfficePreviewDocument, OfficeRendererBridge } from '../src/shared/officeProtocol'

const document: OfficePreviewDocument = {
  artifactId: 'artifact-1',
  sessionId: 'session-1',
  projectId: null,
  sourcePath: '/private/draft.xlsx',
  sourceHash: null,
  previewUrl: 'http://127.0.0.1:42001/',
  readOnly: false,
  saveState: 'saved',
  lastSavedRevision: 0
}

function unusedBridge(): OfficeRendererBridge {
  return {
    enabled: true,
    availability: {
      supported: true,
      userEnabled: true,
      enabled: true,
      reason: null
    },
    create: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    cancelCreate: async () => ({ ok: true, value: false }),
    open: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    close: async () => ({ ok: true, value: false }),
    clearSelection: async () => ({ ok: true, value: false }),
    reconcile: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    save: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    status: async () => ({ ok: true, value: null }),
    onSelection: () => () => undefined
  }
}

test('frozen Office documents show the reconcile action', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeDocumentAlert, {
      freezeState: 'unknown',
      needsSave: false,
      reconcileState: { phase: 'idle' },
      onReconcile: () => undefined
    })
  )

  assert.match(markup, /data-phi-office-freeze-banner="true"/)
  assert.match(markup, /写入结果待核对/)
  assert.match(markup, />重新核对</)
})

test('reconcile action is disabled and reports progress while running', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeDocumentAlert, {
      freezeState: 'unknown',
      needsSave: false,
      reconcileState: { phase: 'pending' },
      onReconcile: () => undefined
    })
  )

  const button = markup.match(/<button[^>]*>.*?核对中.*?<\/button>/)?.[0] ?? ''
  assert.match(button, /disabled/)
  assert.match(button, /role="progressbar"/)
})

test('an unsaved Office draft shows only the save warning', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeDocumentAlert, {
      needsSave: true,
      reconcileState: { phase: 'idle' },
      onReconcile: () => undefined
    })
  )

  assert.match(markup, /data-phi-office-save-banner="true"/)
  assert.match(markup, /草稿尚未保存/)
  assert.doesNotMatch(markup, /重新核对/)
})

test('reconcile controller sends only artifact identity, coalesces clicks, and refreshes status', async () => {
  let finish: ((value: Awaited<ReturnType<OfficeRendererBridge['reconcile']>>) => void) | undefined
  const reconcileInputs: unknown[] = []
  const statusInputs: unknown[] = []
  const states: unknown[] = []
  const documents: unknown[] = []
  const bridge: OfficeRendererBridge = {
    ...unusedBridge(),
    reconcile: (input) => {
      reconcileInputs.push(input)
      return new Promise((resolve) => {
        finish = resolve
      })
    },
    status: async (input) => {
      statusInputs.push(input)
      return { ok: true, value: { state: 'ready', document } }
    }
  }
  const controller = createOfficeReconcileController({
    bridge,
    onState: (state) => states.push(state),
    onDocumentState: (state) => documents.push(state)
  })

  const first = controller.reconcile(document)
  const second = controller.reconcile(document)
  assert.deepEqual(reconcileInputs, [{ artifactId: 'artifact-1' }])
  finish?.({
    ok: true,
    value: {
      conclusion: 'applied',
      message: '已核对写入生效',
      revision: 1
    }
  })
  await Promise.all([first, second])

  assert.deepEqual(statusInputs, [{ sourcePath: '/private/draft.xlsx' }])
  assert.deepEqual(states, [
    { phase: 'pending' },
    { phase: 'result', conclusion: 'applied', message: '已核对写入生效' }
  ])
  assert.equal(documents.length, 1)
})

test('manual reconcile result remains visible after the document is unfrozen', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeDocumentAlert, {
      needsSave: false,
      reconcileState: {
        phase: 'result',
        conclusion: 'applied_no_change',
        message: '当前值已是预期值，已解除冻结'
      },
      onReconcile: () => undefined
    })
  )

  assert.match(markup, /data-phi-office-reconcile-result="applied_no_change"/)
  assert.match(markup, /当前值已是预期值，已解除冻结/)
  assert.doesNotMatch(markup, /写入结果待核对|草稿尚未保存/)
})

test('normal Office documents render no reconciliation or save banner', () => {
  const markup = renderToStaticMarkup(
    createElement(OfficeDocumentAlert, {
      needsSave: false,
      reconcileState: { phase: 'idle' },
      onReconcile: () => undefined
    })
  )

  assert.equal(markup, '')
})

test('a failed human edit shows a dismissible sanitized banner while success stays quiet', () => {
  const failure = renderToStaticMarkup(
    createElement(OfficeDocumentAlert, {
      needsSave: false,
      reconcileState: { phase: 'idle' },
      humanEdit: {
        type: 'formula',
        conclusion: 'failed',
        code: 'formula_invalid',
        message: '公式无法计算，已撤销：括号或引号不完整'
      },
      onDismissHumanEdit: () => undefined,
      onReconcile: () => undefined
    })
  )
  assert.match(failure, /data-phi-office-human-edit-failure="formula_invalid"/u)
  assert.match(failure, /公式无法计算，已撤销/)
  assert.match(failure, /aria-label="Close"/u)

  const success = renderToStaticMarkup(
    createElement(OfficeDocumentAlert, {
      needsSave: false,
      reconcileState: { phase: 'idle' },
      humanEdit: {
        type: 'text',
        conclusion: 'succeeded',
        code: 'ok',
        message: '单元格已更新'
      },
      onDismissHumanEdit: () => undefined,
      onReconcile: () => undefined
    })
  )
  assert.equal(success, '')
})

test('a confirmed reconcile result survives a transient status refresh failure', async () => {
  const states: unknown[] = []
  const controller = createOfficeReconcileController({
    bridge: {
      ...unusedBridge(),
      reconcile: async () => ({
        ok: true,
        value: {
          conclusion: 'not_applied',
          message: '已确认写入未生效',
          revision: 0
        }
      }),
      status: async () => {
        throw new Error('/private/internal/path')
      }
    },
    onState: (state) => states.push(state),
    onDocumentState: () => undefined
  })

  await controller.reconcile(document)

  assert.deepEqual(states, [
    { phase: 'pending' },
    { phase: 'result', conclusion: 'not_applied', message: '已确认写入未生效' }
  ])
})
