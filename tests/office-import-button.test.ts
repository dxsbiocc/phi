import assert from 'node:assert/strict'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, it } from 'node:test'

import type { OfficeRendererBridge } from '../src/shared/officeProtocol'
import { OfficeImportAction } from '../src/renderer/src/features/office/components/OfficeImportAction'
import {
  createOfficeImportController,
  officeImportFormatForPath,
  type OfficeImportUiState
} from '../src/renderer/src/features/office/lib/officeImportController'

function bridge(enabled = true): OfficeRendererBridge {
  return {
    enabled,
    availability: {
      supported: true,
      userEnabled: enabled,
      enabled,
      reason: enabled ? null : 'user-disabled'
    },
    create: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    cancelCreate: async () => ({ ok: true, value: false }),
    importFile: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    cancelImport: async () => ({ ok: true, value: false }),
    open: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    close: async () => ({ ok: true, value: false }),
    clearSelection: async () => ({ ok: true, value: false }),
    reconcile: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    save: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    saveAs: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    revealOutput: async () => ({ ok: true, value: false }),
    resolveOutput: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    status: async () => ({ ok: true, value: null }),
    onSelection: () => () => undefined
  }
}

describe('Office import UI', () => {
  it('recognizes CSV, TSV, and TAB paths without widening other preview formats', () => {
    assert.equal(officeImportFormatForPath('/project/data.csv'), 'csv')
    assert.equal(officeImportFormatForPath('/project/data.TSV'), 'tsv')
    assert.equal(officeImportFormatForPath('/project/data.tab'), 'tsv')
    assert.equal(officeImportFormatForPath('/project/data.csv.bak'), undefined)
  })

  it('shows the availability-gated action with the type and size rules', () => {
    const visible = renderToStaticMarkup(
      createElement(OfficeImportAction, {
        bridge: bridge(true),
        sourcePath: '/project/data.csv',
        onImported: () => undefined
      })
    )
    const hidden = renderToStaticMarkup(
      createElement(OfficeImportAction, {
        bridge: bridge(false),
        sourcePath: '/project/data.csv',
        onImported: () => undefined
      })
    )

    assert.match(visible, /导入为 Excel 草稿/)
    assert.match(visible, /1,000 行/)
    assert.match(visible, /100 列/)
    assert.match(visible, /80,000/)
    assert.match(visible, /5 MiB/)
    assert.match(visible, /= 开头/)
    assert.equal(hidden, '')
  })

  it('sends only request id, source path, and format, then opens the ready draft', async () => {
    const inputs: unknown[] = []
    const states: OfficeImportUiState[] = []
    const opened: string[] = []
    const controller = createOfficeImportController({
      bridge: {
        ...bridge(),
        importFile: async (input) => {
          inputs.push(input)
          return {
            ok: true,
            value: {
              state: 'ready',
              document: {
                artifactId: 'import-1',
                sessionId: 'session-1',
                projectId: null,
                sourcePath: '/private/session/import-1/data.xlsx',
                sourceHash: 'a'.repeat(64),
                previewUrl: 'http://127.0.0.1:42001/',
                readOnly: false,
                saveState: 'saved',
                lastSavedRevision: 0
              }
            }
          }
        }
      },
      requestIdFactory: () => 'import-request-1',
      onState: (state) => states.push(state),
      onImported: (path) => opened.push(path)
    })

    await controller.submit('/project/data.tab', 'tsv')

    assert.deepEqual(inputs, [
      { requestId: 'import-request-1', sourcePath: '/project/data.tab', format: 'tsv' }
    ])
    assert.deepEqual(states, [{ state: 'preparing', requestId: 'import-request-1' }])
    assert.deepEqual(opened, ['/private/session/import-1/data.xlsx'])
  })

  it('cancels a preparing import and ignores a late ready result', async () => {
    let resolveImport:
      ((value: { ok: false; error: { code: string; message: string } }) => void) | undefined
    const cancelled: string[] = []
    const controller = createOfficeImportController({
      bridge: {
        ...bridge(),
        importFile: () =>
          new Promise((resolve) => {
            resolveImport = resolve
          }),
        cancelImport: async ({ requestId }) => {
          cancelled.push(requestId)
          return { ok: true, value: true }
        }
      },
      requestIdFactory: () => 'import-request-2',
      onState: () => undefined,
      onImported: () => assert.fail('cancelled import must not open')
    })

    const pending = controller.submit('/project/data.csv', 'csv')
    await controller.cancel()
    resolveImport?.({ ok: false, error: { code: 'late', message: 'late' } })
    await pending

    assert.deepEqual(cancelled, ['import-request-2'])
  })
})
