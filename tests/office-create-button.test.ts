import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

import { OfficeCreateButton } from '../src/renderer/src/features/office/components/OfficeCreateButton'
import {
  createOfficeCreateController,
  type OfficeCreateUiState
} from '../src/renderer/src/features/office/lib/officeCreateController'
import type { OfficeRendererBridge } from '../src/shared/officeProtocol'

function officeBridge(enabled: boolean): OfficeRendererBridge {
  return {
    enabled,
    create: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    cancelCreate: async () => ({ ok: true, value: false }),
    open: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    close: async () => ({ ok: true, value: false }),
    clearSelection: async () => ({ ok: true, value: false }),
    reconcile: async () => ({ ok: false, error: { code: 'unused', message: 'unused' } }),
    status: async () => ({ ok: true, value: null }),
    onSelection: () => () => undefined
  }
}

test('blank Excel, Word, and PowerPoint entries render only when Office development is enabled', () => {
  const hidden = renderToStaticMarkup(
    createElement(OfficeCreateButton, {
      bridge: officeBridge(false),
      disabled: false,
      onCreated: () => undefined
    })
  )
  const visible = renderToStaticMarkup(
    createElement(OfficeCreateButton, {
      bridge: officeBridge(true),
      disabled: false,
      onCreated: () => undefined
    })
  )

  assert.equal(hidden, '')
  assert.match(visible, /data-phi-office-create-button="true"/)
  assert.match(visible, /新建空白 Excel/)
  assert.match(visible, /新建空白 Word/)
  assert.match(visible, /data-phi-office-create-kind="pptx"/)
  assert.match(visible, /新建空白 PowerPoint/)
})

test('submitting Word or PowerPoint forwards kind while legacy submissions remain xlsx-compatible', async () => {
  const inputs: unknown[] = []
  const bridge: OfficeRendererBridge = {
    ...officeBridge(true),
    create: async (input) => {
      inputs.push(input)
      return { ok: false, error: { code: 'expected', message: 'expected' } }
    }
  }
  const controller = createOfficeCreateController({
    bridge,
    requestIdFactory: (() => {
      let id = 0
      return () => `create-${++id}`
    })(),
    onState: () => undefined,
    onCreated: () => undefined
  })

  await controller.submit('说明', 'docx')
  await controller.submit('简报', 'pptx')
  await controller.submit('预算')

  assert.deepEqual(inputs, [
    { requestId: 'create-1', name: '说明', kind: 'docx' },
    { requestId: 'create-2', name: '简报', kind: 'pptx' },
    { requestId: 'create-3', name: '预算' }
  ])
})

test('cancelling before submission never sends an Office create request', async () => {
  let createCalls = 0
  let cancelCalls = 0
  const bridge: OfficeRendererBridge = {
    ...officeBridge(true),
    create: async () => {
      createCalls += 1
      return { ok: false, error: { code: 'unused', message: 'unused' } }
    },
    cancelCreate: async () => {
      cancelCalls += 1
      return { ok: true, value: false }
    }
  }
  const controller = createOfficeCreateController({
    bridge,
    requestIdFactory: () => 'create-1',
    onState: () => undefined,
    onCreated: () => undefined
  })

  await controller.cancel()

  assert.equal(createCalls, 0)
  assert.equal(cancelCalls, 0)
})

test('submitting creates one workbook and opens the returned draft path only after ready', async () => {
  const states: OfficeCreateUiState[] = []
  const createdPaths: string[] = []
  const inputs: Array<{ requestId: string; name?: string }> = []
  const bridge: OfficeRendererBridge = {
    ...officeBridge(true),
    create: async (input) => {
      inputs.push(input)
      return {
        ok: true,
        value: {
          state: 'ready',
          document: {
            artifactId: 'artifact-1',
            sessionId: 'session-1',
            projectId: 'project-1',
            sourcePath: '/sessions/session-1/artifacts/office/artifact-1/预算.xlsx',
            sourceHash: null,
            previewUrl: 'http://127.0.0.1:42001/'
          }
        }
      }
    }
  }
  const controller = createOfficeCreateController({
    bridge,
    requestIdFactory: () => 'create-1',
    onState: (state) => states.push(state),
    onCreated: (path) => createdPaths.push(path)
  })

  await controller.submit('预算')

  assert.deepEqual(inputs, [{ requestId: 'create-1', name: '预算' }])
  assert.deepEqual(states, [{ state: 'preparing', requestId: 'create-1' }])
  assert.deepEqual(createdPaths, ['/sessions/session-1/artifacts/office/artifact-1/预算.xlsx'])
})

test('create failure shows a readable error state and never opens a draft', async () => {
  const states: OfficeCreateUiState[] = []
  const createdPaths: string[] = []
  const controller = createOfficeCreateController({
    bridge: {
      ...officeBridge(true),
      create: async () => ({
        ok: false,
        error: { code: 'office-create-failed', message: '无法创建空白 Excel，请重试' }
      })
    },
    requestIdFactory: () => 'create-2',
    onState: (state) => states.push(state),
    onCreated: (path) => createdPaths.push(path)
  })

  await controller.submit()

  assert.deepEqual(states, [
    { state: 'preparing', requestId: 'create-2' },
    {
      state: 'error',
      code: 'office-create-failed',
      message: '无法创建空白 Excel，请重试'
    }
  ])
  assert.deepEqual(createdPaths, [])
})

test('a thrown PowerPoint create request reports the requested product instead of Excel', async () => {
  const states: OfficeCreateUiState[] = []
  const controller = createOfficeCreateController({
    bridge: {
      ...officeBridge(true),
      create: async () => {
        throw new Error('transport failed')
      }
    },
    requestIdFactory: () => 'create-pptx-failure',
    onState: (state) => states.push(state),
    onCreated: () => undefined
  })

  await controller.submit('简报', 'pptx')

  assert.deepEqual(states, [
    { state: 'preparing', requestId: 'create-pptx-failure' },
    {
      state: 'error',
      code: 'unavailable',
      message: '无法创建空白 PowerPoint，请重试'
    }
  ])
})

test('cancelling while preparing requests cleanup and ignores a late ready result', async () => {
  let resolveCreate: ((value: Awaited<ReturnType<OfficeRendererBridge['create']>>) => void) | null =
    null
  const cancelInputs: Array<{ requestId: string }> = []
  const createdPaths: string[] = []
  const bridge: OfficeRendererBridge = {
    ...officeBridge(true),
    create: () =>
      new Promise((resolve) => {
        resolveCreate = resolve
      }),
    cancelCreate: async (input) => {
      cancelInputs.push(input)
      return { ok: true, value: true }
    }
  }
  const controller = createOfficeCreateController({
    bridge,
    requestIdFactory: () => 'create-3',
    onState: () => undefined,
    onCreated: (path) => createdPaths.push(path)
  })

  const pending = controller.submit()
  await controller.cancel()
  assert.ok(resolveCreate)
  resolveCreate({
    ok: true,
    value: {
      state: 'ready',
      document: {
        artifactId: 'artifact-late',
        sessionId: 'session-1',
        projectId: null,
        sourcePath: '/sessions/session-1/artifacts/office/artifact-late/late.xlsx',
        sourceHash: null,
        previewUrl: 'http://127.0.0.1:42002/'
      }
    }
  })
  await pending

  assert.deepEqual(cancelInputs, [{ requestId: 'create-3' }])
  assert.deepEqual(createdPaths, [])
})

test('disposing while preparing cancels the active create request', async () => {
  const cancelInputs: Array<{ requestId: string }> = []
  const bridge: OfficeRendererBridge = {
    ...officeBridge(true),
    create: () => new Promise(() => undefined),
    cancelCreate: async (input) => {
      cancelInputs.push(input)
      return { ok: true, value: true }
    }
  }
  const controller = createOfficeCreateController({
    bridge,
    requestIdFactory: () => 'create-4',
    onState: () => undefined,
    onCreated: () => undefined
  })

  void controller.submit()
  await controller.dispose()

  assert.deepEqual(cancelInputs, [{ requestId: 'create-4' }])
})

test('create dialog exposes stable smoke selectors and App opens the ready draft tab', () => {
  const buttonSource = readFileSync(
    resolve('src/renderer/src/features/office/components/OfficeCreateButton.tsx'),
    'utf8'
  )
  const appSource = readFileSync(resolve('src/renderer/src/App.tsx'), 'utf8')

  for (const selector of [
    'data-phi-office-create-dialog',
    'data-phi-office-create-name',
    'data-phi-office-create-submit',
    'data-phi-office-create-cancel'
  ]) {
    assert.match(buttonSource, new RegExp(selector))
  }
  assert.match(buttonSource, /data-phi-office-create-kind/)
  assert.match(buttonSource, /display: \{ xs: 'none', lg: 'inline' \}/)
  assert.match(appSource, /disabled=\{!activePhiSessionId\}/)
  assert.match(appSource, /onCreated=\{previewFilePathInWorkspaceTab\}/)
})
