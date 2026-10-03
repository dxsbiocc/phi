import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { HandlerDetails, WindowOpenHandlerResponse } from 'electron'
import {
  MAX_BROWSER_SCREENSHOT_BYTES,
  type EngineTabHandle
} from '../src/main/browser/browser-engine'
import {
  ElectronBrowserEngine,
  type BrowserSessionLike,
  type BrowserWebContentsLike,
  type BrowserWebContentsViewLike,
  type BrowserWebContentsViewOptions
} from '../src/main/browser/electron-browser-engine'

class RequiredSession extends EventEmitter implements BrowserSessionLike {
  setPermissionCheckHandler(handler: unknown): void {
    void handler
  }
  setPermissionRequestHandler(handler: unknown): void {
    void handler
  }
}

class RequiredWebContents extends EventEmitter implements BrowserWebContentsLike {
  readonly session = new RequiredSession()
  windowOpenHandlerSets = 0
  readonly navigationHistory = {
    canGoBack: (): boolean => false,
    canGoForward: (): boolean => false,
    goBack: (): void => undefined,
    goForward: (): void => undefined
  }
  capturePage(): Promise<{
    toPNG: () => Buffer
    getSize: () => { width: number; height: number }
  }> {
    return Promise.resolve({
      toPNG: () => Buffer.from('png'),
      getSize: () => ({ width: 1, height: 1 })
    })
  }
  isDestroyed(): boolean {
    return false
  }
  async loadURL(): Promise<void> {
    return
  }
  close(): void {
    return
  }
  reload(): void {
    return
  }
  stop(): void {
    return
  }
  focus(): void {
    return
  }
  sendInputEvent(): void {
    return
  }
  closeDevTools(): void {
    return
  }
  setWindowOpenHandler(handler: (details: HandlerDetails) => WindowOpenHandlerResponse): void {
    void handler
    this.windowOpenHandlerSets += 1
  }
}

interface HarnessOptions {
  loadGate?: Promise<void>
  loadError?: Error
  addError?: Error
  removeError?: Error
  closeErrorAt?: number
  captureGate?: Promise<void>
  captureError?: Error
  capturePng?: Buffer
  captureSize?: { width: number; height: number }
  destroyed?: boolean
  focused?: boolean
  inputErrorAt?: number
  navigateOnFocus?: boolean
  setBoundsErrorAt?: number
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

  class FakeWebContents extends RequiredWebContents {
    readonly id = nextWebContentsId++
    readonly loadedUrls: string[] = []
    closeCalls = 0
    captureCalls = 0
    readonly captureOptions: Array<{ stayHidden?: boolean } | undefined> = []
    readonly inputEvents: Array<Record<string, unknown>> = []
    focusCalls = 0

    async loadURL(url: string): Promise<void> {
      this.loadedUrls.push(url)
      if (options.loadGate) await options.loadGate
      if (options.loadError) throw options.loadError
    }

    override close(): void {
      this.closeCalls += 1
      if (options.closeErrorAt === this.id) throw new Error('raw close failure')
    }

    override async capturePage(
      _rect?: { x: number; y: number; width: number; height: number },
      captureOptions?: { stayHidden?: boolean }
    ): Promise<{
      toPNG: () => Buffer
      getSize: () => { width: number; height: number }
    }> {
      this.captureCalls += 1
      this.captureOptions.push(captureOptions ? { ...captureOptions } : undefined)
      if (options.captureGate) await options.captureGate
      if (options.captureError) throw options.captureError
      return {
        toPNG: () => options.capturePng ?? Buffer.from('png'),
        getSize: () => options.captureSize ?? { width: 1280, height: 720 }
      }
    }

    override isDestroyed(): boolean {
      return options.destroyed ?? false
    }

    override focus(): void {
      this.focusCalls += 1
      if (options.navigateOnFocus) {
        const url = 'http://localhost:3000/changed'
        this.emit('will-navigate', { url, isMainFrame: true })
        this.emit('did-frame-navigate', {}, url, 200, 'OK', true)
      }
    }

    override sendInputEvent(event: Record<string, unknown>): void {
      this.inputEvents.push({ ...event })
      if (options.inputErrorAt === this.inputEvents.length) throw new Error('raw input failure')
    }
  }

  class FakeView implements BrowserWebContentsViewLike {
    readonly webContents = new FakeWebContents()
    readonly visibility: boolean[] = []
    bounds = { x: 0, y: 0, width: 0, height: 0 }
    setBoundsCalls = 0
    setBounds(value: { x: number; y: number; width: number; height: number }): void {
      this.setBoundsCalls += 1
      if (options.setBoundsErrorAt === this.setBoundsCalls) {
        throw new Error('raw bounds failure')
      }
      this.bounds = { ...value }
    }
    getBounds(): { x: number; y: number; width: number; height: number } {
      return { ...this.bounds }
    }
    setVisible(value: boolean): void {
      this.visibility.push(value)
    }
    constructor(readonly options: BrowserWebContentsViewOptions) {
      views.push(this)
    }
  }

  const windowEvents = new EventEmitter()
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
    },
    getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
    isMinimized: () => false,
    isVisible: () => true,
    isFocused: () => options.focused ?? true,
    on: windowEvents.on.bind(windowEvents),
    off: windowEvents.off.bind(windowEvents),
    listenerCount: windowEvents.listenerCount.bind(windowEvents)
  }
  let nextHandle = 0
  const engine = new ElectronBrowserEngine({
    WebContentsView: FakeView,
    getOwningWindow: () => window,
    idFactory: () => `phi-engine-tab-${++nextHandle}`
  })
  return { engine, views, children, addCalls, removeCalls }
}

test('maps screenshot pixels to integer Electron coordinates and sends one paired click', async () => {
  const { engine, views } = createHarness({ captureSize: { width: 1600, height: 900 } })
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await engine.setViewport(handle, { x: 5, y: 7, width: 800, height: 450 })
  const captured = await engine.execute(handle, { type: 'screenshot' })
  assert.equal(captured.ok, true)

  const result = await engine.execute(handle, {
    type: 'click',
    x: 400,
    y: 450,
    expectedDocumentRevision: 0
  })

  assert.equal(result.ok, true)
  assert.deepEqual(views[0].webContents.inputEvents, [
    { type: 'mouseDown', x: 200, y: 225, button: 'left', clickCount: 1 },
    { type: 'mouseUp', x: 200, y: 225, button: 'left', clickCount: 1 }
  ])
  assert.equal(views[0].webContents.focusCalls, 1)
  assert.equal(engine.capabilities().coordinateInput, true)
})

test('rejects stale, outside, resized, hidden, unfocused, and pre-cancelled input before delivery', async () => {
  const value = createHarness({ captureSize: { width: 1000, height: 500 } })
  const handle = await value.engine.createTab({ partition: 'browser-project-a' })
  await value.engine.setViewport(handle, { x: 0, y: 0, width: 500, height: 250 })

  for (const command of [
    { type: 'click' as const, x: 0, y: 0, expectedDocumentRevision: 0 },
    { type: 'scroll' as const, deltaX: 0, deltaY: 120, expectedDocumentRevision: 0 },
    { type: 'keypress' as const, key: 'Tab', expectedDocumentRevision: 0 }
  ]) {
    const result = await value.engine.execute(handle, command)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'STALE_DOCUMENT')
  }

  await value.engine.execute(handle, { type: 'screenshot' })
  const outside = await value.engine.execute(handle, {
    type: 'click',
    x: 1000,
    y: 1,
    expectedDocumentRevision: 0
  })
  assert.equal(outside.ok, false)
  if (!outside.ok) assert.equal(outside.error.code, 'STALE_DOCUMENT')

  await value.engine.setViewport(handle, { x: 0, y: 0, width: 400, height: 250 })
  const resized = await value.engine.execute(handle, {
    type: 'keypress',
    key: 'Escape',
    expectedDocumentRevision: 0
  })
  assert.equal(resized.ok, false)
  if (!resized.ok) assert.equal(resized.error.code, 'STALE_DOCUMENT')

  await value.engine.execute(handle, { type: 'screenshot' })
  await value.engine.setViewport(handle, null)
  const hidden = await value.engine.execute(handle, {
    type: 'scroll',
    deltaX: 0,
    deltaY: 120,
    expectedDocumentRevision: 0
  })
  assert.equal(hidden.ok, false)
  if (!hidden.ok) assert.equal(hidden.error.code, 'STALE_DOCUMENT')

  const unfocused = createHarness({ focused: false })
  const unfocusedHandle = await unfocused.engine.createTab({ partition: 'browser-project-a' })
  await unfocused.engine.setViewport(unfocusedHandle, { x: 0, y: 0, width: 500, height: 250 })
  await unfocused.engine.execute(unfocusedHandle, { type: 'screenshot' })
  const notFocused = await unfocused.engine.execute(unfocusedHandle, {
    type: 'keypress',
    key: 'Tab',
    expectedDocumentRevision: 0
  })
  assert.equal(notFocused.ok, false)
  if (!notFocused.ok) assert.equal(notFocused.error.code, 'CAPABILITY_UNAVAILABLE')

  await value.engine.setViewport(handle, { x: 0, y: 0, width: 400, height: 250 })
  await value.engine.execute(handle, { type: 'screenshot' })
  const controller = new AbortController()
  controller.abort()
  await value.engine.execute(
    handle,
    { type: 'keypress', key: 'Tab', expectedDocumentRevision: 0 },
    controller.signal
  )
  assert.deepEqual(value.views[0].webContents.inputEvents, [])
})

test('sends bounded scroll and safe key pairs at the captured viewport center', async () => {
  const { engine, views } = createHarness({ captureSize: { width: 1200, height: 800 } })
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await engine.setViewport(handle, { x: 0, y: 0, width: 600, height: 400 })
  await engine.execute(handle, { type: 'screenshot' })

  assert.equal(
    (
      await engine.execute(handle, {
        type: 'scroll',
        deltaX: -40,
        deltaY: 240,
        expectedDocumentRevision: 0
      })
    ).ok,
    true
  )
  await engine.execute(handle, { type: 'screenshot' })
  assert.equal(
    (
      await engine.execute(handle, {
        type: 'keypress',
        key: 'Tab',
        modifiers: ['shift'],
        expectedDocumentRevision: 0
      })
    ).ok,
    true
  )
  await engine.execute(handle, { type: 'screenshot' })
  const unsafe = await engine.execute(handle, {
    type: 'keypress',
    key: 'Enter',
    expectedDocumentRevision: 0
  })
  assert.equal(unsafe.ok, false)
  if (!unsafe.ok) assert.equal(unsafe.error.code, 'PERMISSION_DENIED')
  assert.deepEqual(views[0].webContents.inputEvents, [
    {
      type: 'mouseWheel',
      x: 300,
      y: 200,
      deltaX: -40,
      deltaY: 240,
      canScroll: true,
      hasPreciseScrollingDeltas: true
    },
    { type: 'keyDown', keyCode: 'Tab', modifiers: ['shift'] },
    { type: 'keyUp', keyCode: 'Tab', modifiers: ['shift'] }
  ])
})

test('rechecks the engine revision after guest focus and before the first input event', async () => {
  const { engine, views } = createHarness({ navigateOnFocus: true })
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await engine.setViewport(handle, { x: 0, y: 0, width: 600, height: 400 })
  await engine.execute(handle, { type: 'screenshot' })

  const result = await engine.execute(handle, {
    type: 'click',
    x: 20,
    y: 20,
    expectedDocumentRevision: 0
  })

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'STALE_DOCUMENT')
  assert.deepEqual(views[0].webContents.inputEvents, [])
})

test('best-effort releases a paired input after a second-event failure without raw errors', async () => {
  for (const command of [
    { type: 'click' as const, x: 1, y: 1, expectedDocumentRevision: 0 },
    {
      type: 'keypress' as const,
      key: 'Tab',
      modifiers: ['shift'] as const,
      expectedDocumentRevision: 0
    }
  ]) {
    const { engine, views } = createHarness({ inputErrorAt: 2 })
    const handle = await engine.createTab({ partition: 'browser-project-a' })
    await engine.setViewport(handle, { x: 0, y: 0, width: 600, height: 400 })
    await engine.execute(handle, { type: 'screenshot' })

    const result = await engine.execute(handle, command)
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(result.error.code, 'CAPABILITY_UNAVAILABLE')
      assert.doesNotMatch(result.error.message, /raw input failure/)
    }
    assert.equal(views[0].webContents.inputEvents.length, 3)
    assert.equal(
      views[0].webContents.inputEvents[1]?.type,
      views[0].webContents.inputEvents[2]?.type
    )
    const retry = await engine.execute(handle, command)
    assert.equal(retry.ok, false)
    if (!retry.ok) assert.equal(retry.error.code, 'STALE_DOCUMENT')
    assert.equal(views[0].webContents.inputEvents.length, 3)
  }
})

test('a failed viewport application clears presentation and screenshot input state', async () => {
  const { engine, views } = createHarness({ setBoundsErrorAt: 2 })
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await engine.setViewport(handle, { x: 0, y: 0, width: 600, height: 400 })
  await engine.execute(handle, { type: 'screenshot' })

  await assert.rejects(
    engine.setViewport(handle, { x: 0, y: 0, width: 500, height: 400 }),
    /could not be applied/i
  )
  const result = await engine.execute(handle, {
    type: 'click',
    x: 10,
    y: 10,
    expectedDocumentRevision: 0
  })

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'STALE_DOCUMENT')
  assert.deepEqual(views[0].webContents.inputEvents, [])
})

test('a screenshot captured while navigation is pending cannot restore input authority', async () => {
  const { engine, views } = createHarness()
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await engine.setViewport(handle, { x: 0, y: 0, width: 600, height: 400 })
  await engine.execute(handle, { type: 'screenshot' })
  views[0].webContents.emit('will-navigate', {
    url: 'http://localhost:3000/pending',
    isMainFrame: true
  })
  const observed = await engine.execute(handle, { type: 'screenshot' })
  assert.equal(observed.ok, true)

  const result = await engine.execute(handle, {
    type: 'click',
    x: 10,
    y: 10,
    expectedDocumentRevision: 0
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'STALE_DOCUMENT')
  assert.deepEqual(views[0].webContents.inputEvents, [])
})

test('did-start-loading invalidates same-revision screenshot input before delivery', async () => {
  const { engine, views } = createHarness()
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await engine.setViewport(handle, { x: 0, y: 0, width: 600, height: 400 })
  await engine.execute(handle, { type: 'screenshot' })
  views[0].webContents.emit('did-start-loading')

  const result = await engine.execute(handle, {
    type: 'keypress',
    key: 'Tab',
    expectedDocumentRevision: 0
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'STALE_DOCUMENT')
  assert.deepEqual(views[0].webContents.inputEvents, [])
})

test('creates an isolated about:blank child view with secure preferences', async () => {
  const { engine, views, children, addCalls } = createHarness()
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  assert.equal(handle, 'phi-engine-tab-1')
  assert.notEqual(handle, String(views[0].webContents.id))
  assert.deepEqual(views[0].webContents.loadedUrls, ['about:blank'])
  assert.equal(views[0].webContents.windowOpenHandlerSets, 1)
  assert.deepEqual(views[0].visibility, [false])
  assert.deepEqual(children, [])
  await engine.setViewport(handle, { x: 0, y: 0, width: 500, height: 400 })
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
    screenshot: true,
    coordinateInput: true,
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
  assert.equal(views[0].webContents.windowOpenHandlerSets, 1)
  assert.equal(views[1].webContents.windowOpenHandlerSets, 1)
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
    readonly webContents = new RequiredWebContents()
    setBounds(): void {
      return
    }
    setVisible(): void {
      return
    }
    constructor(readonly options: BrowserWebContentsViewOptions) {
      views.push(this)
    }
  }
  const children: BrowserWebContentsViewLike[] = []
  const windowEvents = new EventEmitter()
  const engine = new ElectronBrowserEngine({
    WebContentsView: ReservedView,
    getOwningWindow: () => ({
      contentView: {
        addChildView: (view) => children.push(view),
        removeChildView: (view) => {
          const index = children.indexOf(view)
          if (index >= 0) children.splice(index, 1)
        }
      },
      getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
      isMinimized: () => false,
      isVisible: () => true,
      on: windowEvents.on.bind(windowEvents),
      off: windowEvents.off.bind(windowEvents),
      listenerCount: windowEvents.listenerCount.bind(windowEvents)
    }),
    idFactory: () => candidates.shift() ?? 'unexpected-handle'
  })

  const [first, second] = await Promise.all([
    engine.createTab({ partition: 'browser-project-a' }),
    engine.createTab({ partition: 'browser-project-a' })
  ])
  assert.deepEqual([first, second], ['shared-handle', 'second-handle'])
  assert.equal(engine.tabCountForTesting(), 2)
  assert.equal(children.length, 0)
})

test('wraps id factory failures without exposing injected error text', async () => {
  class NeverCreatedView implements BrowserWebContentsViewLike {
    readonly webContents = new RequiredWebContents()
    setBounds(): void {
      return
    }
    setVisible(): void {
      return
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

  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await assert.rejects(
    engine.setViewport(handle, { x: 0, y: 0, width: 500, height: 400 }),
    /Browser viewport could not be applied/
  )
  assert.deepEqual(removeCalls, [views[0]])
  assert.deepEqual(children, [])
  assert.equal(views[0].webContents.closeCalls, 0)
  await engine.disposeTab(handle)
  assert.equal(views[0].webContents.closeCalls, 1)
})

test('disposeTab removes ownership and closes webContents exactly once', async () => {
  const { engine, views, children, removeCalls } = createHarness()
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await engine.setViewport(handle, { x: 0, y: 0, width: 500, height: 400 })

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
  await engine.setViewport(handle, { x: 0, y: 0, width: 500, height: 400 })

  await assert.rejects(
    engine.disposeTab(handle),
    (error: Error) =>
      error.message === 'Browser tab cleanup failed' &&
      !error.message.includes('raw remove failure')
  )

  assert.equal(views[0].webContents.closeCalls, 1)
  assert.equal(engine.tabCountForTesting(), 0)
})

test('dispose preserves cleanup debt after a tab cleanup failure', async () => {
  const { engine, views } = createHarness({ removeError: new Error('raw remove debt secret') })
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await engine.setViewport(handle, { x: 0, y: 0, width: 100, height: 100 })

  await assert.rejects(engine.disposeTab(handle), /Browser tab cleanup failed/)
  const first = engine.dispose()
  const second = engine.dispose()
  assert.equal(first, second)
  await assert.rejects(first, (error: Error) => {
    return (
      error.message === 'Browser engine cleanup failed' &&
      !error.message.includes('raw remove debt secret')
    )
  })
  assert.equal(views[0].webContents.closeCalls, 1)
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

  const screenshot = await engine.execute(handle, { type: 'screenshot' })
  assert.equal(screenshot.ok, true)
})

test('captures a bounded PNG with dimensions and the current engine revision', async () => {
  const png = Buffer.from('bounded-png')
  const { engine, views } = createHarness({
    capturePng: png,
    captureSize: { width: 1600, height: 900 }
  })
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  const captured = await engine.execute(handle, { type: 'screenshot' })

  assert.deepEqual(captured, {
    ok: true,
    state: {
      url: 'about:blank',
      title: 'New tab',
      isLoading: false,
      canGoBack: false,
      canGoForward: false,
      documentRevision: 0,
      navigationRevision: 0
    },
    screenshot: {
      mediaType: 'image/png',
      data: png.toString('base64'),
      width: 1600,
      height: 900,
      documentRevision: 0
    }
  })
  assert.equal(views[0].webContents.captureCalls, 1)
  assert.deepEqual(views[0].webContents.captureOptions, [{ stayHidden: true }])
})

test('rejects destroyed, failed, empty, and oversized captures without raw errors', async () => {
  const cases = [
    {
      name: 'destroyed',
      options: { destroyed: true },
      code: 'RENDERER_CRASHED'
    },
    {
      name: 'capture failure',
      options: { captureError: new Error('raw capture secret') },
      code: 'RENDERER_CRASHED'
    },
    {
      name: 'empty',
      options: { capturePng: Buffer.alloc(0) },
      code: 'CAPABILITY_UNAVAILABLE'
    },
    {
      name: 'oversized',
      options: { capturePng: Buffer.alloc(MAX_BROWSER_SCREENSHOT_BYTES + 1) },
      code: 'CAPABILITY_UNAVAILABLE'
    }
  ] as const

  for (const entry of cases) {
    const { engine } = createHarness(entry.options)
    const handle = await engine.createTab({ partition: 'browser-project-a' })
    const captured = await engine.execute(handle, { type: 'screenshot' })
    assert.equal(captured.ok, false, entry.name)
    assert.equal(!captured.ok && captured.error.code, entry.code, entry.name)
    assert.equal(JSON.stringify(captured).includes('raw capture secret'), false, entry.name)
  }
})

test('returns capability unavailable when the capture primitive is missing', async () => {
  const { engine, views } = createHarness()
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  views[0].webContents.capturePage = undefined

  const captured = await engine.execute(handle, { type: 'screenshot' })

  assert.deepEqual(captured, {
    ok: false,
    error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Browser command is unavailable' }
  })
})

test('discards a delayed capture after abort or tab disposal', async () => {
  let releaseAbort!: () => void
  const abortGate = new Promise<void>((resolve) => {
    releaseAbort = resolve
  })
  const abortedHarness = createHarness({ captureGate: abortGate })
  const abortedHandle = await abortedHarness.engine.createTab({ partition: 'browser-project-a' })
  const controller = new AbortController()
  const pendingAbort = abortedHarness.engine.execute(
    abortedHandle,
    { type: 'screenshot' },
    controller.signal
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  controller.abort()
  const abortResult = await Promise.race([
    pendingAbort,
    new Promise<'capture-still-pending'>((resolve) =>
      setTimeout(() => resolve('capture-still-pending'), 20)
    )
  ])
  assert.notEqual(abortResult, 'capture-still-pending')
  assert.deepEqual(abortResult, {
    ok: false,
    error: { code: 'ACTION_CANCELLED', message: 'Browser action was cancelled' }
  })
  releaseAbort()

  let releaseDisposed!: () => void
  const disposedGate = new Promise<void>((resolve) => {
    releaseDisposed = resolve
  })
  const disposedHarness = createHarness({ captureGate: disposedGate })
  const disposedHandle = await disposedHarness.engine.createTab({ partition: 'browser-project-a' })
  const pendingDisposed = disposedHarness.engine.execute(disposedHandle, { type: 'screenshot' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  await disposedHarness.engine.disposeTab(disposedHandle)
  const disposedResult = await Promise.race([
    pendingDisposed,
    new Promise<'capture-still-pending'>((resolve) =>
      setTimeout(() => resolve('capture-still-pending'), 20)
    )
  ])
  assert.notEqual(disposedResult, 'capture-still-pending')
  assert.deepEqual(disposedResult, {
    ok: false,
    error: { code: 'TAB_NOT_FOUND', message: 'Browser tab was not found' }
  })
  releaseDisposed()
})

test('rejects a delayed capture when its document revision changes', async () => {
  let releaseCapture!: () => void
  const captureGate = new Promise<void>((resolve) => {
    releaseCapture = resolve
  })
  const { engine, views } = createHarness({ captureGate })
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  const pending = engine.execute(handle, { type: 'screenshot' })
  await new Promise<void>((resolve) => setImmediate(resolve))
  views[0].webContents.emit('did-frame-navigate', {}, 'https://new-document.test/', 200, 'OK', true)
  releaseCapture()

  assert.deepEqual(await pending, {
    ok: false,
    error: { code: 'STALE_DOCUMENT', message: 'Browser page changed during capture' }
  })
})
