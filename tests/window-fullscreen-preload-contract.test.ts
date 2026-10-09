import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import * as promptTarget from '../src/preload/promptTarget'

const source = (path: string): string => readFileSync(resolve(process.cwd(), path), 'utf8')

test('preload exposes the initial fullscreen state and an independently cancellable subscription', async () => {
  const preload = source('src/preload/index.ts')
  const compiled = ts.transpileModule(preload, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const calls: Array<{ channel: string; args: unknown[] }> = []

  class FakeIpcRenderer extends EventEmitter {
    async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
      calls.push({ channel, args })
      return channel === 'window:get-fullscreen'
    }
  }

  const ipcRenderer = new FakeIpcRenderer()
  const exposed = new Map<string, unknown>()
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
    { contextIsolated: true, platform: 'darwin' },
    { addEventListener: (): void => undefined },
    console
  )

  const api = exposed.get('api') as {
    readyWindow: (background: string) => Promise<void>
    getWindowFullscreen: () => Promise<boolean>
    onWindowFullscreenChanged: (callback: (fullscreen: boolean) => void) => () => void
  }
  assert.equal(await api.getWindowFullscreen(), true)
  assert.deepEqual(calls, [{ channel: 'window:get-fullscreen', args: [] }])
  await api.readyWindow('#0D1218')
  assert.deepEqual(calls.at(-1), { channel: 'window:renderer-ready', args: ['#0D1218'] })

  const first: boolean[] = []
  const second: boolean[] = []
  const unsubscribeFirst = api.onWindowFullscreenChanged((fullscreen) => first.push(fullscreen))
  const unsubscribeSecond = api.onWindowFullscreenChanged((fullscreen) => second.push(fullscreen))

  assert.equal(ipcRenderer.listenerCount('window:fullscreen-changed'), 2)
  ipcRenderer.emit('window:fullscreen-changed', { sender: 'main' }, true)
  assert.deepEqual(first, [true])
  assert.deepEqual(second, [true])

  unsubscribeFirst()
  unsubscribeFirst()
  assert.equal(ipcRenderer.listenerCount('window:fullscreen-changed'), 1)
  ipcRenderer.emit('window:fullscreen-changed', { sender: 'main' }, false)
  assert.deepEqual(first, [true])
  assert.deepEqual(second, [true, false])

  unsubscribeSecond()
  assert.equal(ipcRenderer.listenerCount('window:fullscreen-changed'), 0)
})

test('fullscreen state is typed end to end and only sourced from the trusted main window', () => {
  const preload = source('src/preload/index.ts')
  const ambient = source('src/preload/index.d.ts')
  const renderer = source('src/renderer/src/types.ts')
  const main = source('src/main/index.ts')

  for (const apiSource of [preload, ambient, renderer]) {
    assert.match(apiSource, /readyWindow: \(background: string\) => Promise<void>/)
    assert.match(apiSource, /getWindowFullscreen: \(\) => Promise<boolean>/)
    assert.match(
      apiSource,
      /onWindowFullscreenChanged: \(cb: \(fullscreen: boolean\) => void\) => (?:Unsubscribe|\(\) => void)/
    )
  }

  assert.match(main, /ipcMain\.handle\('window:get-fullscreen', \(event\) =>/)
  assert.match(main, /event\.sender !== window\.webContents/)
  assert.match(main, /event\.senderFrame !== event\.sender\.mainFrame/)
  assert.match(main, /window\.webContents\.send\('window:fullscreen-changed', fullscreen\)/)
  assert.match(
    main,
    /window\.on\('enter-full-screen',[\s\S]{0,160}setWindowButtonVisibility\(true\)[\s\S]{0,120}sendMainWindowFullscreenState\(window, true\)/
  )
  assert.match(
    main,
    /window\.on\('leave-full-screen',[\s\S]{0,160}setWindowButtonVisibility\(false\)[\s\S]{0,120}sendMainWindowFullscreenState\(window, false\)/
  )
  assert.match(
    main,
    /window\.webContents\.on\('did-finish-load',[\s\S]{0,220}window\.isFullScreen\(\)/
  )
})
