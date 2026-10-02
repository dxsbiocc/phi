import assert from 'node:assert/strict'
import test from 'node:test'
import type { EngineTabHandle } from '../src/main/browser/browser-engine'
import {
  ElectronBrowserEngine,
  type BrowserWebContentsViewLike,
  type BrowserWebContentsViewOptions
} from '../src/main/browser/electron-browser-engine'

interface HarnessOptions {
  loadGate?: Promise<void>
  loadError?: Error
  addError?: Error
  removeError?: Error
  closeErrorAt?: number
}

function createHarness(options: HarnessOptions = {}): {
  engine: ElectronBrowserEngine
  views: FakeView[]
  children: FakeView[]
  addCalls: FakeView[]
  removeCalls: FakeView[]
} {
  const views: FakeView[] = []
  const children: FakeView[] = []
  const addCalls: FakeView[] = []
  const removeCalls: FakeView[] = []
  let nextWebContentsId = 900

  class FakeWebContents {
    readonly id = nextWebContentsId++
    readonly loadedUrls: string[] = []
    closeCalls = 0

    async loadURL(url: string): Promise<void> {
      this.loadedUrls.push(url)
      if (options.loadGate) await options.loadGate
      if (options.loadError) throw options.loadError
    }

    close(): void {
      this.closeCalls += 1
      if (options.closeErrorAt === this.id) throw new Error('raw close failure')
    }
  }

  class FakeView implements BrowserWebContentsViewLike {
    readonly webContents = new FakeWebContents()
    constructor(readonly options: BrowserWebContentsViewOptions) {
      views.push(this)
    }
  }

  const window = {
    contentView: {
      addChildView(view: BrowserWebContentsViewLike): void {
        const typed = view as FakeView
        addCalls.push(typed)
        children.push(typed)
        if (options.addError) throw options.addError
      },
      removeChildView(view: BrowserWebContentsViewLike): void {
        const typed = view as FakeView
        removeCalls.push(typed)
        const index = children.indexOf(typed)
        if (index >= 0) children.splice(index, 1)
        if (options.removeError) throw options.removeError
      }
    }
  }
  let nextHandle = 0
  const engine = new ElectronBrowserEngine({
    WebContentsView: FakeView,
    getOwningWindow: () => window,
    idFactory: () => `phi-engine-tab-${++nextHandle}`
  })
  return { engine, views, children, addCalls, removeCalls }
}

test('creates an isolated about:blank child view with secure preferences', async () => {
  const { engine, views, children, addCalls } = createHarness()
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  assert.equal(handle, 'phi-engine-tab-1')
  assert.notEqual(handle, String(views[0].webContents.id))
  assert.deepEqual(views[0].webContents.loadedUrls, ['about:blank'])
  assert.deepEqual(children, [views[0]])
  assert.deepEqual(addCalls, [views[0]])
  assert.deepEqual(views[0].options.webPreferences, {
    partition: 'browser-project-a',
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    devTools: false
  })
  assert.equal('preload' in views[0].options.webPreferences, false)
  assert.deepEqual(engine.capabilities(), {
    presentation: 'native',
    screenshot: false,
    coordinateInput: false,
    semanticInspection: false,
    downloads: false,
    recording: false,
    persistentProfile: false
  })
})

test('uses the requested partition independently for every tab', async () => {
  const { engine, views } = createHarness()
  await engine.createTab({ partition: 'browser-project-a' })
  await engine.createTab({ partition: 'browser-project-b' })

  assert.equal(views[0].options.webPreferences.partition, 'browser-project-a')
  assert.equal(views[1].options.webPreferences.partition, 'browser-project-b')
})

test('dispose owns and closes a pending blank load before create can attach it', async () => {
  let releaseLoad!: () => void
  const loadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve
  })
  const { engine, views, addCalls } = createHarness({ loadGate })
  const creating = engine.createTab({ partition: 'browser-project-a' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(engine.tabCountForTesting(), 1)

  await engine.dispose()
  assert.equal(views[0].webContents.closeCalls, 1)
  releaseLoad()
  await assert.rejects(creating, /Browser tab could not be created/)
  assert.deepEqual(addCalls, [])
  assert.equal(engine.tabCountForTesting(), 0)
})

test('reserves candidate handles across concurrent creates without overwrite', async () => {
  const candidates = ['shared-handle', 'shared-handle', 'second-handle']
  const views: BrowserWebContentsViewLike[] = []
  class ReservedView implements BrowserWebContentsViewLike {
    readonly webContents = {
      loadURL: async (): Promise<void> => undefined,
      close: (): void => undefined
    }
    constructor(readonly options: BrowserWebContentsViewOptions) {
      views.push(this)
    }
  }
  const children: BrowserWebContentsViewLike[] = []
  const engine = new ElectronBrowserEngine({
    WebContentsView: ReservedView,
    getOwningWindow: () => ({
      contentView: {
        addChildView: (view) => children.push(view),
        removeChildView: (view) => {
          const index = children.indexOf(view)
          if (index >= 0) children.splice(index, 1)
        }
      }
    }),
    idFactory: () => candidates.shift() ?? 'unexpected-handle'
  })

  const [first, second] = await Promise.all([
    engine.createTab({ partition: 'browser-project-a' }),
    engine.createTab({ partition: 'browser-project-a' })
  ])
  assert.deepEqual([first, second], ['shared-handle', 'second-handle'])
  assert.equal(engine.tabCountForTesting(), 2)
  assert.equal(children.length, 2)
})

test('wraps id factory failures without exposing injected error text', async () => {
  class NeverCreatedView implements BrowserWebContentsViewLike {
    readonly webContents = {
      loadURL: async (): Promise<void> => undefined,
      close: (): void => undefined
    }
  }
  const engine = new ElectronBrowserEngine({
    WebContentsView: NeverCreatedView,
    getOwningWindow: () => null,
    idFactory: () => {
      throw new Error('raw id factory secret')
    }
  })

  await assert.rejects(
    engine.createTab({ partition: 'browser-project-a' }),
    (error: Error) =>
      error.message === 'Browser tab could not be created' &&
      !error.message.includes('raw id factory secret')
  )
})

test('rolls back and closes a partially created view when blank loading fails', async () => {
  const { engine, views, children } = createHarness({
    loadError: new Error('raw load secret')
  })

  await assert.rejects(
    engine.createTab({ partition: 'browser-project-a' }),
    (error: Error) =>
      error.message === 'Browser tab could not be created' &&
      !error.message.includes('raw load secret')
  )
  assert.equal(views[0].webContents.closeCalls, 1)
  assert.deepEqual(children, [])
  assert.equal(engine.tabCountForTesting(), 0)
})

test('removes and closes a view if child attachment fails', async () => {
  const { engine, views, children, removeCalls } = createHarness({
    addError: new Error('raw add failure')
  })

  await assert.rejects(
    engine.createTab({ partition: 'browser-project-a' }),
    /Browser tab could not be created/
  )
  assert.deepEqual(removeCalls, [views[0]])
  assert.deepEqual(children, [])
  assert.equal(views[0].webContents.closeCalls, 1)
})

test('disposeTab removes ownership and closes webContents exactly once', async () => {
  const { engine, views, children, removeCalls } = createHarness()
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  await engine.disposeTab(handle)
  await engine.disposeTab(handle)

  assert.deepEqual(removeCalls, [views[0]])
  assert.deepEqual(children, [])
  assert.equal(views[0].webContents.closeCalls, 1)
  assert.equal(engine.tabCountForTesting(), 0)
})

test('disposeTab still closes webContents when removeChildView fails', async () => {
  const { engine, views } = createHarness({ removeError: new Error('raw remove failure') })
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  await assert.rejects(
    engine.disposeTab(handle),
    (error: Error) =>
      error.message === 'Browser tab cleanup failed' &&
      !error.message.includes('raw remove failure')
  )

  assert.equal(views[0].webContents.closeCalls, 1)
  assert.equal(engine.tabCountForTesting(), 0)
})

test('dispose attempts every tab and safely rejects after partial close failure', async () => {
  const harness = createHarness()
  const first = await harness.engine.createTab({ partition: 'browser-project-a' })
  await harness.engine.createTab({ partition: 'browser-project-a' })
  const firstView = harness.views[0]
  firstView.webContents.close = (): void => {
    firstView.webContents.closeCalls += 1
    throw new Error('raw close failure')
  }

  const firstDispose = harness.engine.dispose()
  const repeatedDispose = harness.engine.dispose()
  assert.equal(firstDispose, repeatedDispose)
  await assert.rejects(
    firstDispose,
    (error: Error) =>
      error.message === 'Browser engine cleanup failed' &&
      !error.message.includes('raw close failure')
  )

  assert.equal(first, 'phi-engine-tab-1')
  assert.equal(harness.views[0].webContents.closeCalls, 1)
  assert.equal(harness.views[1].webContents.closeCalls, 1)
  assert.equal(harness.engine.tabCountForTesting(), 0)
  await assert.rejects(
    harness.engine.createTab({ partition: 'browser-project-a' }),
    /Browser engine is disposed/
  )
})

test('subscribe, unsubscribe, and dispose do not leak listeners', async () => {
  const { engine } = createHarness()
  const unsubscribeFirst = engine.subscribe(() => undefined)
  engine.subscribe(() => undefined)
  assert.equal(engine.listenerCountForTesting(), 2)

  unsubscribeFirst()
  unsubscribeFirst()
  assert.equal(engine.listenerCountForTesting(), 1)

  await engine.dispose()
  assert.equal(engine.listenerCountForTesting(), 0)
  const unsubscribeAfterDispose = engine.subscribe(() => undefined)
  assert.equal(engine.listenerCountForTesting(), 0)
  unsubscribeAfterDispose()
})

test('returns safe structured errors for missing, cancelled, and unsupported commands', async () => {
  const { engine } = createHarness()
  const missing = await engine.execute('missing' as EngineTabHandle, { type: 'stop' })
  assert.deepEqual(missing, {
    ok: false,
    error: { code: 'TAB_NOT_FOUND', message: 'Browser tab was not found' }
  })

  const handle = await engine.createTab({ partition: 'browser-project-a' })
  const controller = new AbortController()
  controller.abort()
  const cancelled = await engine.execute(handle, { type: 'stop' }, controller.signal)
  assert.deepEqual(cancelled, {
    ok: false,
    error: { code: 'ACTION_CANCELLED', message: 'Browser action was cancelled' }
  })

  const unsupported = await engine.execute(handle, { type: 'reload' })
  assert.deepEqual(unsupported, {
    ok: false,
    error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Browser command is unavailable' }
  })
})
