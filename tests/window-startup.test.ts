import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import ts from 'typescript'
import { createMainWindowStartup } from '../src/main/window-startup'
import { createAppTheme } from '../src/renderer/src/theme'
import { createMinimalTheme } from '../src/renderer/src/minimalTheme'

// Execute the actual constructor wiring, rather than duplicating its options in a fixture.
function createMainWindowFixture(): FakeWindow {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const start = source.indexOf('function createWindow(): void {')
  const end = source.indexOf('\nregisterNotebookOutputScheme()', start)
  assert.ok(start >= 0 && end > start)
  const code = ts.transpileModule(
    `let mainWindowCleanupStarted, mainWindowCleanupPromise, mainWindow;
     ${source.slice(start, end).replaceAll('import.meta.dirname', "'/tmp'")}
     createWindow(); return mainWindow;`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const bindings = {
    createMainWindowStartup,
    mainWindowStartups: new WeakMap(),
    writeAppLog: () => undefined,
    dialog: { showMessageBox: async () => ({ response: 1 }) },
    BrowserWindow: FakeWindow,
    APP_NAME: 'Phi',
    DEFAULT_WINDOW_WIDTH: 1000,
    DEFAULT_WINDOW_HEIGHT: 700,
    MIN_WINDOW_WIDTH: 600,
    MIN_WINDOW_HEIGHT: 400,
    appIcon: undefined,
    nativeTheme: { shouldUseDarkColors: true },
    OFFICE_DEV_ENABLED: false,
    process: { platform: 'linux', env: {} },
    is: { dev: false },
    join,
    cleanupMainWindowRuntime: () => undefined
  }
  return new Function(...Object.keys(bindings), code)(...Object.values(bindings)) as FakeWindow
}

class FakeWindow extends EventEmitter {
  webContents = Object.assign(new EventEmitter(), {
    setBackgroundThrottling: () => undefined,
    setWindowOpenHandler: () => undefined
  })
  visible: boolean
  showCount = 0
  background = ''

  constructor(readonly options: { show?: boolean; backgroundColor?: string }) {
    super()
    this.visible = options.show !== false
    this.background = options.backgroundColor ?? ''
  }

  isDestroyed(): boolean {
    return false
  }

  setBackgroundColor(color: string): void {
    this.background = color
  }

  show(): void {
    this.visible = true
    this.showCount += 1
  }

  loadFile(): Promise<void> {
    return Promise.resolve()
  }
}

test('the real app window stays hidden instead of displaying the system-dark default color before React', () => {
  const window = createMainWindowFixture()
  assert.equal(window.visible, false, 'startup must not expose the native default-color window')
  window.emit('ready-to-show')
  assert.equal(
    window.visible,
    false,
    'HTML paint alone is not proof the saved React theme is ready'
  )
})

test('saved theme background precedes the initial show in either readiness order', () => {
  for (const family of ['default', 'minimal'] as const) {
    for (const mode of ['light', 'dark'] as const) {
      for (const rendererFirst of [true, false]) {
        const theme = family === 'minimal' ? createMinimalTheme(mode) : createAppTheme(mode)
        const window = new FakeWindow({ show: false })
        const showBackgrounds: string[] = []
        window.show = () => {
          showBackgrounds.push(window.background)
          window.visible = true
        }
        const startup = createMainWindowStartup(window, () => assert.fail('unexpected failure'))
        if (rendererFirst) startup.rendererReady(theme.palette.background.default)
        else startup.painted()
        assert.equal(window.visible, false)
        if (rendererFirst) startup.painted()
        else startup.rendererReady(theme.palette.background.default)
        assert.deepEqual(showBackgrounds, [theme.palette.background.default])
        // A later theme update, a StrictMode effect, or renderer reload does not
        // reopen, restore or refocus a window the user has hidden/minimized.
        window.visible = false
        startup.rendererReady(theme.palette.background.default)
        startup.painted()
        assert.equal(window.visible, false)
        assert.equal(showBackgrounds.length, 1)
        startup.dispose()
      }
    }
  }
})

test('invalid/transparent backgrounds cannot reveal the native default color', () => {
  const window = new FakeWindow({ show: false })
  const startup = createMainWindowStartup(window, () => undefined)
  startup.painted()
  for (const color of [
    undefined,
    'transparent',
    '#fff',
    '#12345678',
    'rgb(256, 0, 0)',
    'rgba(0, 0, 0, 0)'
  ]) {
    assert.throws(() => startup.rendererReady(color), /Invalid window background/)
  }
  assert.equal(window.visible, false)
  startup.rendererReady('rgb(13, 18, 24)')
  assert.equal(window.background, 'rgb(13, 18, 24)')
  assert.equal(window.visible, true)
  startup.dispose()
})

test('missing renderer readiness gets bounded recovery and retry without showing blank content', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const failures: string[] = []
  const window = new FakeWindow({ show: false })
  const startup = createMainWindowStartup(window, (reason) => failures.push(reason), 100)
  startup.painted()
  context.mock.timers.tick(100)
  assert.deepEqual(failures, ['renderer-ready-timeout'])
  assert.equal(window.visible, false)
  startup.fail('duplicate failure')
  assert.equal(failures.length, 1)
  assert.equal(startup.retry(), true)
  startup.rendererReady('#0D1218')
  assert.equal(window.showCount, 1)
  context.mock.timers.tick(100)
  assert.equal(failures.length, 1)
  assert.equal(startup.retry(), false)
  startup.dispose()
})

test('closed startup windows clear pending recovery and ignore later readiness', (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const failures: string[] = []
  const window = new FakeWindow({ show: false })
  const startup = createMainWindowStartup(window, (reason) => failures.push(reason), 100)
  startup.dispose()
  startup.painted()
  startup.rendererReady('#0D1218')
  context.mock.timers.tick(100)
  assert.equal(window.showCount, 0)
  assert.equal(window.background, '')
  assert.deepEqual(failures, [])
})

test('late readiness after failure stays hidden until the user explicitly retries', () => {
  const failures: string[] = []
  const window = new FakeWindow({ show: false })
  const startup = createMainWindowStartup(window, (reason) => failures.push(reason))
  startup.fail('main-frame-load-failed')
  startup.painted()
  startup.rendererReady('#0D1218')
  assert.equal(window.visible, false, 'recovery must not compete with a late window reveal')
  assert.equal(window.background, '', 'late readiness from the failed attempt is ignored')
  assert.deepEqual(failures, ['main-frame-load-failed'])
  assert.equal(startup.retry(), true)
  assert.equal(window.visible, false, 'retry still needs a newly committed renderer frame')
  startup.rendererReady('#FFFFFF')
  assert.equal(window.background, '#FFFFFF')
  assert.equal(window.showCount, 1)
  startup.dispose()
})

test('the actual shared main-window guard rejects other windows and embedded frames', () => {
  const source = readFileSync('src/main/index.ts', 'utf8')
  const start = source.indexOf('function requireMainWindowRenderer(')
  const end = source.indexOf('\nfunction sendMainWindowFullscreenState(', start)
  const code = ts.transpileModule(
    `${source.slice(start, end)}; return requireMainWindowRenderer;`,
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }
  ).outputText
  const sender = { mainFrame: {}, isDestroyed: () => false }
  const window = { isDestroyed: () => false, webContents: sender }
  const authorize = new Function('mainWindow', code)(window) as (event: unknown) => unknown
  assert.equal(authorize({ sender, senderFrame: sender.mainFrame }), window)
  for (const event of [
    { sender, senderFrame: {} },
    { sender: { ...sender }, senderFrame: sender.mainFrame },
    { sender: { ...sender, isDestroyed: () => true }, senderFrame: sender.mainFrame }
  ]) {
    assert.throws(() => authorize(event), /not authorized/)
  }
})
