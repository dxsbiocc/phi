import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { BrowserViewport } from '../src/shared/browserTypes'
import {
  ElectronBrowserEngine,
  type BrowserOwningWindowLike,
  type BrowserSessionLike,
  type BrowserWebContentsLike,
  type BrowserWebContentsViewLike,
  type BrowserWebContentsViewOptions
} from '../src/main/browser/electron-browser-engine'

class FakeSession extends EventEmitter implements BrowserSessionLike {
  setPermissionCheckHandler(handler: unknown): void {
    void handler
  }
  setPermissionRequestHandler(handler: unknown): void {
    void handler
  }
}

class FakeContents extends EventEmitter implements BrowserWebContentsLike {
  readonly session = new FakeSession()
  readonly navigationHistory = {
    canGoBack: (): boolean => false,
    canGoForward: (): boolean => false,
    goBack: (): void => undefined,
    goForward: (): void => undefined
  }
  closeCalls = 0
  closeError: Error | null = null
  async loadURL(): Promise<void> {
    return
  }
  close(): void {
    this.closeCalls += 1
    if (this.closeError) throw this.closeError
  }
  reload(): void {
    return
  }
  stop(): void {
    return
  }
  closeDevTools(): void {
    return
  }
}

class FakeView implements BrowserWebContentsViewLike {
  readonly webContents = new FakeContents()
  readonly bounds: Array<{ x: number; y: number; width: number; height: number }> = []
  readonly visibility: boolean[] = []
  setBoundsError: Error | null = null
  setVisibleError: Error | null = null

  constructor(
    readonly options: BrowserWebContentsViewOptions,
    private readonly log: string[]
  ) {}

  setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
    this.log.push(`bounds:${bounds.x},${bounds.y},${bounds.width},${bounds.height}`)
    if (this.setBoundsError) throw this.setBoundsError
    this.bounds.push({ ...bounds })
  }

  setVisible(visible: boolean): void {
    this.log.push(`visible:${visible}`)
    if (this.setVisibleError) throw this.setVisibleError
    this.visibility.push(visible)
  }
}

class FakeWindow extends EventEmitter implements BrowserOwningWindowLike {
  readonly children: BrowserWebContentsViewLike[] = []
  readonly log: string[] = []
  contentBounds = { x: 500, y: 300, width: 800, height: 600 }
  minimized = false
  visible = true
  isMinimizedError: Error | null = null
  isVisibleError: Error | null = null
  failOnEvent: string | null = null
  failOffEvent: string | null = null
  addError: Error | null = null
  removeError: Error | null = null

  readonly contentView = {
    addChildView: (view: BrowserWebContentsViewLike): void => {
      this.log.push('add')
      if (this.addError) throw this.addError
      this.children.push(view)
    },
    removeChildView: (view: BrowserWebContentsViewLike): void => {
      this.log.push('remove')
      if (this.removeError) throw this.removeError
      const index = this.children.indexOf(view)
      if (index >= 0) this.children.splice(index, 1)
    }
  }

  getContentBounds(): { x: number; y: number; width: number; height: number } {
    return { ...this.contentBounds }
  }

  isMinimized(): boolean {
    if (this.isMinimizedError) throw this.isMinimizedError
    return this.minimized
  }

  isVisible(): boolean {
    if (this.isVisibleError) throw this.isVisibleError
    return this.visible
  }

  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (event === this.failOnEvent) throw new Error('raw window on failure')
    return super.on(event, listener)
  }

  override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (event === this.failOffEvent) throw new Error('raw window off failure')
    return super.off(event, listener)
  }
}

function harness(): {
  engine: ElectronBrowserEngine
  window: FakeWindow
  views: FakeView[]
  log: string[]
} {
  const window = new FakeWindow()
  const views: FakeView[] = []
  const log = window.log
  class View extends FakeView {
    constructor(options: BrowserWebContentsViewOptions) {
      super(options, log)
      views.push(this)
    }
  }
  let id = 0
  const engine = new ElectronBrowserEngine({
    WebContentsView: View,
    getOwningWindow: () => window,
    idFactory: () => `tab-${++id}`
  })
  return { engine, window, views, log }
}

const viewport = (value: Partial<BrowserViewport> = {}): BrowserViewport => ({
  x: 10,
  y: 20,
  width: 300,
  height: 200,
  ...value
})

test('keeps newly created pages hidden and unattached until a viewport is assigned', async () => {
  const { engine, window, views } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })

  assert.deepEqual(views[0].visibility, [false])
  assert.deepEqual(window.children, [])
  await engine.setViewport(handle, viewport())
  assert.deepEqual(window.children, [views[0]])
  assert.equal(views[0].visibility.at(-1), true)
})

test('clamps and integerizes viewport bounds in parent content coordinates', async () => {
  const { engine, views } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })

  await engine.setViewport(handle, viewport({ x: -10.8, y: -5.2, width: 100.1, height: 80.1 }))
  assert.deepEqual(views[0].bounds.at(-1), { x: 0, y: 0, width: 90, height: 75 })
  await engine.setViewport(handle, viewport({ x: 750.2, y: 580.2, width: 100, height: 50 }))
  assert.deepEqual(views[0].bounds.at(-1), { x: 750, y: 580, width: 50, height: 20 })
})

test('invalid or fully out-of-bounds viewport hides the current native page first', async () => {
  for (const invalid of [
    viewport({ width: 0 }),
    viewport({ height: -1 }),
    viewport({ x: Number.NaN }),
    viewport({ width: Number.POSITIVE_INFINITY }),
    viewport({ x: 900 }),
    viewport({ y: 700 })
  ]) {
    const { engine, window, views } = harness()
    const handle = await engine.createTab({ partition: 'partition-a' })
    await engine.setViewport(handle, viewport())

    await assert.rejects(
      engine.setViewport(handle, invalid),
      /Browser viewport could not be applied/
    )
    assert.equal(views[0].visibility.at(-1), false)
    assert.deepEqual(window.children, [])
  }
})

test('swaps active pages in hide-remove-hidden-bounds-add-show order', async () => {
  const { engine, window, views, log } = harness()
  const first = await engine.createTab({ partition: 'partition-a' })
  const second = await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(first, viewport())
  log.length = 0

  await engine.setViewport(second, viewport({ x: 30 }))

  assert.deepEqual(log, [
    'visible:false',
    'remove',
    'visible:false',
    'bounds:30,20,300,200',
    'add',
    'visible:true'
  ])
  assert.equal(views[0].visibility.at(-1), false)
  assert.deepEqual(window.children, [views[1]])
})

test('updates the active viewport without duplicate attachment and applies calls in order', async () => {
  const { engine, window, views } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(handle, viewport({ x: 10 }))
  await engine.setViewport(handle, viewport({ x: 20 }))
  await engine.setViewport(handle, viewport({ x: 30 }))

  assert.equal(window.children.length, 1)
  assert.deepEqual(
    views[0].bounds.slice(-3).map((item) => item.x),
    [10, 20, 30]
  )
})

test('viewport null is synchronously hidden before a following trusted action', async () => {
  const { engine, window, views, log } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(handle, viewport())
  log.length = 0

  await engine.setViewport(handle, null)
  log.push('approval')

  assert.deepEqual(log, ['visible:false', 'remove', 'approval'])
  assert.equal(views[0].visibility.at(-1), false)
  assert.deepEqual(window.children, [])
  await engine.disposeTab(handle)
  assert.equal(log.filter((entry) => entry === 'remove').length, 1)
})

test('zero-bounds hidden fallback retains attachment for a later remove retry', async () => {
  const { engine, window, views, log } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(handle, viewport())
  log.length = 0
  views[0].setVisibleError = new Error('raw visible failure')
  window.removeError = new Error('raw remove failure')

  await assert.rejects(engine.setViewport(handle, null), /Browser viewport could not be applied/)
  assert.deepEqual(views[0].bounds.at(-1), { x: 0, y: 0, width: 0, height: 0 })
  assert.equal(log.filter((entry) => entry === 'remove').length, 1)

  views[0].setVisibleError = null
  window.removeError = null
  await engine.disposeTab(handle)
  assert.equal(log.filter((entry) => entry === 'remove').length, 2)
  assert.deepEqual(window.children, [])
})

test('minimize and hide detach while restore and show re-clamp desired viewport', async () => {
  const { engine, window, views } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(handle, viewport({ x: 700, width: 200 }))

  window.minimized = true
  window.emit('minimize')
  assert.deepEqual(window.children, [])
  window.contentBounds.width = 750
  window.minimized = false
  window.emit('restore')
  assert.deepEqual(views[0].bounds.at(-1), { x: 700, y: 20, width: 50, height: 200 })
  assert.deepEqual(window.children, [views[0]])

  window.emit('hide')
  assert.deepEqual(window.children, [])
  window.emit('show')
  assert.deepEqual(window.children, [views[0]])
})

test('minimized viewport assignment remains detached and null prevents restore', async () => {
  const { engine, window } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  window.minimized = true
  window.emit('minimize')
  await engine.setViewport(handle, viewport())
  assert.deepEqual(window.children, [])

  await engine.setViewport(handle, null)
  window.minimized = false
  window.emit('restore')
  assert.deepEqual(window.children, [])
})

test('tracks hidden and minimized suspension independently across interleaved events', async () => {
  const first = harness()
  const firstHandle = await first.engine.createTab({ partition: 'partition-a' })
  first.window.emit('hide')
  await first.engine.setViewport(firstHandle, viewport())
  assert.deepEqual(first.window.children, [])
  first.window.emit('show')
  assert.deepEqual(first.window.children, [first.views[0]])

  const second = harness()
  const secondHandle = await second.engine.createTab({ partition: 'partition-a' })
  second.window.emit('minimize')
  second.window.emit('hide')
  await second.engine.setViewport(secondHandle, viewport())
  second.window.emit('restore')
  assert.deepEqual(second.window.children, [])
  second.window.emit('show')
  assert.deepEqual(second.window.children, [second.views[0]])

  const third = harness()
  const thirdHandle = await third.engine.createTab({ partition: 'partition-a' })
  third.window.emit('hide')
  third.window.emit('minimize')
  await third.engine.setViewport(thirdHandle, viewport())
  third.window.emit('show')
  assert.deepEqual(third.window.children, [])
  third.window.emit('restore')
  assert.deepEqual(third.window.children, [third.views[0]])
})

test('attached hidden records restore visibility without duplicate add', async () => {
  const { engine, window, views } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(handle, viewport())
  window.removeError = new Error('raw remove failure')
  window.emit('hide')
  assert.equal(views[0].visibility.at(-1), false)
  assert.equal(window.children.length, 1)
  window.removeError = null
  window.emit('show')
  assert.equal(views[0].visibility.at(-1), true)
  assert.equal(window.children.length, 1)
})

test('window listener install and release failures repair without duplicates', async () => {
  const install = harness()
  install.window.failOnEvent = 'restore'
  await assert.rejects(
    install.engine.createTab({ partition: 'partition-a' }),
    /Browser tab could not be created/
  )
  install.window.failOnEvent = null
  const installed = await install.engine.createTab({ partition: 'partition-a' })
  for (const event of ['minimize', 'restore', 'hide', 'show']) {
    assert.equal(install.window.listenerCount(event), 1)
  }

  install.window.failOffEvent = 'minimize'
  await assert.rejects(install.engine.disposeTab(installed), /Browser tab cleanup failed/)
  install.window.failOffEvent = null
  await install.engine.createTab({ partition: 'partition-a' })
  for (const event of ['minimize', 'restore', 'hide', 'show']) {
    assert.equal(install.window.listenerCount(event), 1)
  }
})

test('listener repair refreshes newly suspended window state before viewport attachment', async () => {
  const { engine, window, views } = harness()
  const first = await engine.createTab({ partition: 'partition-a' })
  window.failOffEvent = 'hide'
  await assert.rejects(engine.disposeTab(first), /Browser tab cleanup failed/)

  window.minimized = true
  window.visible = false
  window.failOffEvent = null
  const second = await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(second, viewport())

  assert.deepEqual(window.children, [])
  for (const event of ['minimize', 'restore', 'hide', 'show']) {
    assert.equal(window.listenerCount(event), 1)
  }

  window.minimized = false
  window.emit('restore')
  assert.deepEqual(window.children, [])
  window.visible = true
  window.emit('show')
  assert.deepEqual(window.children, [views[1]])
})

test('listener repair refreshes restored window state instead of retaining stale suspension', async () => {
  const { engine, window, views } = harness()
  const first = await engine.createTab({ partition: 'partition-a' })
  window.minimized = true
  window.visible = false
  window.emit('minimize')
  window.emit('hide')
  window.failOffEvent = 'hide'
  await assert.rejects(engine.disposeTab(first), /Browser tab cleanup failed/)

  window.minimized = false
  window.visible = true
  window.failOffEvent = null
  const second = await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(second, viewport())

  assert.deepEqual(window.children, [views[1]])
  for (const event of ['minimize', 'restore', 'hide', 'show']) {
    assert.equal(window.listenerCount(event), 1)
  }
})

test('window listener cleanup removes only controller listeners', async () => {
  const { engine, window } = harness()
  const external = (): void => undefined
  window.on('minimize', external)
  const handle = await engine.createTab({ partition: 'partition-a' })
  assert.equal(window.listenerCount('minimize'), 2)
  await engine.disposeTab(handle)
  assert.equal(window.listenerCount('minimize'), 1)
  assert.equal(window.listeners('minimize')[0], external)
})

test('window status query failures reject creation before native attachment', async () => {
  const { engine, window, views } = harness()
  window.isVisibleError = new Error('raw visibility query failure')

  await assert.rejects(
    engine.createTab({ partition: 'partition-a' }),
    (error: Error) =>
      error.message === 'Browser tab could not be created' &&
      !error.message.includes('raw visibility query failure')
  )
  assert.deepEqual(window.children, [])
  assert.equal(views[0].webContents.closeCalls, 1)
})

test('invalid parent bounds hide active content and never reach setBounds', async () => {
  const { engine, window, views } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(handle, viewport())
  const priorBounds = views[0].bounds.length
  window.contentBounds.width = Number.NaN

  await assert.rejects(
    engine.setViewport(handle, viewport({ x: 20 })),
    /Browser viewport could not be applied/
  )
  assert.equal(views[0].bounds.length, priorBounds)
  assert.equal(views[0].visibility.at(-1), false)
  assert.deepEqual(window.children, [])
})

test('close failure retains viewport ownership for later window-event removal retry', async () => {
  const { engine, window, views } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(handle, viewport())
  views[0].setVisibleError = new Error('raw visible failure')
  views[0].setBoundsError = new Error('raw zero-bounds failure')
  views[0].webContents.closeError = new Error('raw close failure')
  window.removeError = new Error('raw remove failure')

  await assert.rejects(engine.disposeTab(handle), /Browser tab cleanup failed/)
  assert.equal(views[0].webContents.closeCalls, 1)
  assert.equal(window.children.length, 1)
  assert.equal(window.listenerCount('hide') > 0, true)

  views[0].setVisibleError = null
  views[0].setBoundsError = null
  window.removeError = null
  window.emit('hide')
  assert.deepEqual(window.children, [])
  assert.equal(views[0].webContents.closeCalls, 1)
})

test('failed minimized switch cannot restore a rejected candidate', async () => {
  const { engine, window, views } = harness()
  const first = await engine.createTab({ partition: 'partition-a' })
  const second = await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(first, viewport())
  views[0].setVisibleError = new Error('raw hide failure')
  window.removeError = new Error('raw remove failure')
  window.minimized = true
  window.emit('minimize')

  await assert.rejects(
    engine.setViewport(second, viewport({ x: 40 })),
    /Browser viewport could not be applied/
  )
  views[0].setVisibleError = null
  window.removeError = null
  window.minimized = false
  window.emit('restore')
  assert.equal(window.children.includes(views[1]), false)
  assert.notEqual(views[1].visibility.at(-1), true)
})

test('isMinimized failure clears candidate state and never re-shows it', async () => {
  const { engine, window, views } = harness()
  window.isMinimizedError = new Error('raw minimized failure')

  await assert.rejects(
    engine.createTab({ partition: 'partition-a' }),
    (error: Error) =>
      error.message === 'Browser tab could not be created' &&
      !error.message.includes('raw minimized failure')
  )
  window.isMinimizedError = null
  window.emit('show')
  window.emit('restore')
  assert.deepEqual(window.children, [])
  assert.notEqual(views[0].visibility.at(-1), true)
})

test('attach failure hides and detaches the candidate with a safe error', async () => {
  const { engine, window, views } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  window.addError = new Error('raw attach secret')

  await assert.rejects(
    engine.setViewport(handle, viewport()),
    (error: Error) =>
      error.message === 'Browser viewport could not be applied' &&
      !error.message.includes('raw attach secret')
  )
  assert.equal(views[0].visibility.at(-1), false)
  assert.deepEqual(window.children, [])
})

test('dispose hides native pixels and removes window listeners without blocking close', async () => {
  const { engine, window, views } = harness()
  const first = await engine.createTab({ partition: 'partition-a' })
  await engine.createTab({ partition: 'partition-a' })
  await engine.setViewport(first, viewport())
  views[0].webContents.closeError = new Error('raw close failure')

  await assert.rejects(engine.dispose(), /Browser engine cleanup failed/)
  assert.equal(views[0].visibility.at(-1), false)
  assert.deepEqual(window.children, [])
  for (const event of ['minimize', 'restore', 'hide', 'show']) {
    assert.equal(window.listenerCount(event) > 0, true)
  }
  assert.equal(views[0].webContents.closeCalls, 1)
  assert.equal(views[1].webContents.closeCalls, 1)
})
