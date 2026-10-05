import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'

import * as promptTarget from '../src/preload/promptTarget'
import type { OfficeRendererBridge } from '../src/shared/officeProtocol'

test('preload exposes controlled Office reconcile, selection clear, and independently cancellable events', async () => {
  const source = readFileSync(resolve('src/preload/index.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const calls: Array<{ channel: string; args: unknown[] }> = []

  class FakeIpcRenderer extends EventEmitter {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      calls.push({ channel, args })
      return { ok: true, value: true }
    }
  }

  const ipcRenderer = new FakeIpcRenderer()
  const exposed = new Map<string, unknown>()
  const load = (specifier: string): unknown => {
    if (specifier === './promptTarget') return promptTarget
    assert.equal(specifier, 'electron')
    return {
      contextBridge: {
        exposeInMainWorld: (name: string, value: unknown): void => {
          exposed.set(name, value)
        }
      },
      ipcRenderer,
      webUtils: { getPathForFile: (): string => '' }
    }
  }

  new Function('require', 'exports', 'process', 'window', 'console', compiled)(
    load,
    {},
    { contextIsolated: true, platform: 'darwin', env: { PHI_OFFICE_DEV: '1' } },
    { addEventListener: (): void => undefined },
    console
  )

  const office = (exposed.get('api') as { office: OfficeRendererBridge }).office
  await office.create({ requestId: 'create-docx', kind: 'docx', name: '未命名文档' })
  await office.importFile?.({
    requestId: 'import-csv',
    sourcePath: '/project/data.csv',
    format: 'csv'
  })
  await office.cancelImport?.({ requestId: 'import-cancelled' })
  await office.open({ sourcePath: '/project/document.docx' })
  await office.save({ artifactId: 'artifact-1' })
  await office.saveAs({ artifactId: 'artifact-1' })
  await office.exportSheet?.({
    requestId: 'export-csv',
    artifactId: 'artifact-1',
    sheet: '数据表',
    format: 'csv'
  })
  await office.cancelExport?.({ requestId: 'export-cancelled' })
  await office.revealOutput({ artifactId: 'artifact-1', outputId: 'output-1' })
  await office.resolveOutput({ artifactId: 'artifact-1', outputId: 'output-1' })
  await office.reconcile({ artifactId: 'artifact-1' })
  await office.clearSelection({ artifactId: 'artifact-1' })
  await office.setPreviewPreferences?.({
    artifactId: 'artifact-1',
    visible: true,
    followAi: false
  })
  assert.deepEqual(calls, [
    {
      channel: 'office:create',
      args: [{ requestId: 'create-docx', kind: 'docx', name: '未命名文档' }]
    },
    {
      channel: 'office:import',
      args: [{ requestId: 'import-csv', sourcePath: '/project/data.csv', format: 'csv' }]
    },
    { channel: 'office:cancelImport', args: [{ requestId: 'import-cancelled' }] },
    { channel: 'office:open', args: [{ sourcePath: '/project/document.docx' }] },
    { channel: 'office:save', args: [{ artifactId: 'artifact-1' }] },
    { channel: 'office:saveAs', args: [{ artifactId: 'artifact-1' }] },
    {
      channel: 'office:export',
      args: [
        {
          requestId: 'export-csv',
          artifactId: 'artifact-1',
          sheet: '数据表',
          format: 'csv'
        }
      ]
    },
    { channel: 'office:cancelExport', args: [{ requestId: 'export-cancelled' }] },
    {
      channel: 'office:revealOutput',
      args: [{ artifactId: 'artifact-1', outputId: 'output-1' }]
    },
    {
      channel: 'office:resolveOutput',
      args: [{ artifactId: 'artifact-1', outputId: 'output-1' }]
    },
    { channel: 'office:reconcile', args: [{ artifactId: 'artifact-1' }] },
    { channel: 'office:clearSelection', args: [{ artifactId: 'artifact-1' }] },
    {
      channel: 'office:setPreviewPreferences',
      args: [{ artifactId: 'artifact-1', visible: true, followAi: false }]
    }
  ])

  const first: unknown[] = []
  const second: unknown[] = []
  const unsubscribeFirst = office.onSelection((event) => first.push(event))
  const unsubscribeSecond = office.onSelection((event) => second.push(event))
  const payload = {
    artifactId: 'artifact-1',
    selection: { sheet: 'Sheet1', range: 'A1:B3', paths: ['/Sheet1/A1'] }
  }
  ipcRenderer.emit('office:selection', { sender: 'main' }, payload)
  assert.deepEqual(first, [payload])
  assert.deepEqual(second, [payload])

  unsubscribeFirst()
  unsubscribeFirst()
  ipcRenderer.emit('office:selection', { sender: 'main' }, { ...payload, selection: null })
  assert.deepEqual(first, [payload])
  assert.deepEqual(second, [payload, { ...payload, selection: null }])
  unsubscribeSecond()
  assert.equal(ipcRenderer.listenerCount('office:selection'), 0)
})
