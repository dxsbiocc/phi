import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import type {
  BrowserRendererBridge,
  BrowserRendererEventEnvelope,
  BrowserUiCommand
} from '../src/shared/browserTypes'
import * as promptTarget from '../src/preload/promptTarget'

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

test('shared browser renderer bridge exposes one Electron-free public contract', () => {
  const shared = source('src/shared/browserTypes.ts')
  const start = shared.indexOf('export interface BrowserRendererBridge')
  assert.notEqual(start, -1)
  const bridge = shared.slice(start, shared.indexOf('\n}', start) + 2)
  const uiStart = shared.indexOf('export type BrowserUiCommand')
  assert.notEqual(uiStart, -1)
  const uiCommand = shared.slice(uiStart, shared.indexOf('\n\nexport', uiStart))

  assert.match(shared, /export type BrowserRendererEventEnvelope\s*=/)
  assert.match(shared, /sessionId: string[\s\S]{0,100}event: BrowserWorkspaceEvent/)
  assert.match(
    shared,
    /sessionId: null[\s\S]{0,140}type: 'appShellOpenFailed'[\s\S]{0,100}reason: 'browserUnavailable'/
  )
  assert.match(uiCommand, /Extract</)
  for (const type of [
    'open',
    'newTab',
    'activate',
    'close',
    'navigate',
    'history',
    'reload',
    'stop',
    'restore',
    'openExternal'
  ]) {
    assert.match(uiCommand, new RegExp(`'${type}'`))
  }
  assert.doesNotMatch(uiCommand, /'snapshot'|'click'|'typeText'|'keypress'|'scroll'/)
  assert.match(bridge, /execute\(command: BrowserUiCommand\): Promise<BrowserOutcome>/)
  assert.match(bridge, /snapshot\(\): Promise<BrowserWorkspaceSnapshot>/)
  assert.match(
    bridge,
    /setViewport\(input: \{[\s\S]{0,160}sessionId: string[\s\S]{0,160}sessionGeneration: number[\s\S]{0,160}tabId: string[\s\S]{0,160}viewport: BrowserViewport \| null[\s\S]{0,80}\): Promise<void>/
  )
  assert.match(
    bridge,
    /onEvent\(cb: \(envelope: BrowserRendererEventEnvelope\) => void\): \(\) => void/
  )
  assert.doesNotMatch(
    bridge,
    /ipcRenderer|webContents|partition|EngineTabHandle|Electron|IpcMain|WebContentsView/
  )
})

test('preload and renderer expose only one namespaced browser bridge using shared types', () => {
  const preload = source('src/preload/index.ts')
  const ambient = source('src/preload/index.d.ts')
  const renderer = source('src/renderer/src/types.ts')
  const apiTypeStart = preload.indexOf('type RendererAuthApi')
  const apiTypeEnd = preload.indexOf('\n}', apiTypeStart)
  const apiType = preload.slice(apiTypeStart, apiTypeEnd)

  assert.match(
    preload,
    /import type \{[\s\S]*BrowserRendererBridge[\s\S]*} from '\.\.\/shared\/browserTypes'/
  )
  assert.match(apiType, /browser: BrowserRendererBridge/)
  assert.doesNotMatch(apiType, /browserExecute|browserSnapshot|browserSetViewport|browserOnEvent/)
  assert.match(preload, /execute: \(command\) => ipcRenderer\.invoke\('browser:execute', command\)/)
  assert.match(preload, /snapshot: \(\) => ipcRenderer\.invoke\('browser:snapshot'\)/)
  assert.match(
    preload,
    /setViewport: \(input\) => ipcRenderer\.invoke\('browser:setViewport', input\)/
  )
  assert.match(preload, /ipcRenderer\.on\('browser:event', handler\)/)
  assert.match(preload, /ipcRenderer\.removeListener\('browser:event', handler\)/)
  assert.doesNotMatch(preload, /removeAllListeners\('browser:event'/)
  assert.match(preload, /browser: browserBridge/)

  assert.match(ambient, /import type \{ BrowserRendererBridge \} from '\.\.\/shared\/browserTypes'/)
  assert.match(ambient, /api: \{[\s\S]*browser: BrowserRendererBridge/)
  assert.match(
    renderer,
    /import type \{ BrowserRendererBridge \} from '\.\.\/\.\.\/shared\/browserTypes'/
  )
  assert.match(
    renderer,
    /export type RendererApi = AutoCompactionApi & \{[\s\S]*browser: BrowserRendererBridge/
  )

  const design = source('docs/superpowers/specs/2026-09-30-in-app-browser-design.md')
  const designUiStart = design.indexOf('export type BrowserUiCommand')
  assert.notEqual(designUiStart, -1)
  const designUiCommand = design.slice(designUiStart, design.indexOf('\n\nexport', designUiStart))
  for (const type of [
    'open',
    'newTab',
    'activate',
    'close',
    'navigate',
    'history',
    'reload',
    'stop',
    'restore'
  ]) {
    assert.match(designUiCommand, new RegExp(`'${type}'`))
  }
  assert.doesNotMatch(designUiCommand, /'snapshot'|'click'|'typeText'|'keypress'|'scroll'/)
  assert.match(design, /execute\(command: BrowserUiCommand\): Promise<BrowserOutcome>/)
  assert.match(
    design,
    /setViewport\(input: \{[\s\S]{0,160}sessionId: string[\s\S]{0,160}sessionGeneration: number[\s\S]{0,160}tabId: string[\s\S]{0,160}viewport: BrowserViewport \| null[\s\S]{0,80}\): Promise<void>/
  )
  assert.match(
    design,
    /onEvent\([^)]*\(envelope: BrowserRendererEventEnvelope\) => void\)[^:]*: \(\) => void/
  )
  assert.match(design, /trusted sessionId[\s\S]{0,180}stale|stale[\s\S]{0,180}trusted sessionId/i)
})

test('preload browser bridge invokes exact channels and independently unsubscribes listeners', async () => {
  const preload = source('src/preload/index.ts')
  const compiled = ts.transpileModule(preload, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const calls: Array<{ channel: string; args: unknown[] }> = []
  class FakeIpcRenderer extends EventEmitter {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      calls.push({ channel, args })
      return undefined
    }
  }
  const ipcRenderer = new FakeIpcRenderer()
  const exposed = new Map<string, unknown>()
  const fakeWindow = { addEventListener: (): void => undefined }
  const load = (specifier: string): unknown => {
    // The preload's only local dependency is the pure prompt-target sanitiser.
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
    { contextIsolated: true, platform: process.platform },
    fakeWindow,
    console
  )
  const api = exposed.get('api') as { browser: BrowserRendererBridge }
  assert.ok(api.browser)

  const command: BrowserUiCommand = {
    type: 'open',
    requestId: 'request-1',
    url: 'https://example.test'
  }
  await api.browser.execute(command)
  await api.browser.snapshot()
  const viewportRequest = {
    sessionId: 'phi-session',
    sessionGeneration: 3,
    tabId: 'tab-1',
    viewport: { x: 1, y: 2, width: 300, height: 200 }
  }
  await api.browser.setViewport(viewportRequest)
  assert.deepEqual(calls, [
    { channel: 'browser:execute', args: [command] },
    { channel: 'browser:snapshot', args: [] },
    {
      channel: 'browser:setViewport',
      args: [viewportRequest]
    }
  ])

  const envelope = {
    sessionId: 'phi-session',
    event: {
      type: 'error',
      revision: 1,
      error: { code: 'ENGINE_UNAVAILABLE', message: 'safe', retryable: true }
    }
  } satisfies BrowserRendererEventEnvelope
  const received: BrowserRendererEventEnvelope[] = []
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  const unsubscribeThrowing = api.browser.onEvent(() => {
    throw new Error('subscriber failure')
  })
  const unsubscribeRejecting = api.browser.onEvent(async () => {
    throw new Error('async subscriber failure')
  })
  const unsubscribeReceiving = api.browser.onEvent((payload) => received.push(payload))
  try {
    assert.equal(ipcRenderer.listenerCount('browser:event'), 3)
    assert.doesNotThrow(() => ipcRenderer.emit('browser:event', { sender: 'secret' }, envelope))
    await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
    assert.deepEqual(received, [envelope])
    assert.deepEqual(unhandled, [])
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }

  unsubscribeThrowing()
  unsubscribeThrowing()
  unsubscribeRejecting()
  unsubscribeRejecting()
  assert.equal(ipcRenderer.listenerCount('browser:event'), 1)
  ipcRenderer.emit('browser:event', { sender: 'secret' }, envelope)
  assert.deepEqual(received, [envelope, envelope])
  unsubscribeReceiving()
  assert.equal(ipcRenderer.listenerCount('browser:event'), 0)
})
