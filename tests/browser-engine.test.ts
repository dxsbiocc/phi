import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserCapabilities } from '../src/shared/browserTypes'
import type { EngineEvent } from '../src/main/browser/browser-engine'
import { InMemoryBrowserEngine } from '../src/main/browser/in-memory-browser-engine'

const capabilities: BrowserCapabilities = {
  presentation: 'native',
  screenshot: true,
  coordinateInput: true,
  semanticInspection: false,
  downloads: false,
  recording: false,
  persistentProfile: false
}

function createEngine(): InMemoryBrowserEngine {
  let nextId = 0
  return new InMemoryBrowserEngine({
    capabilities,
    idFactory: () => `engine-tab-${++nextId}`,
    now: () => 42,
    screenshotData: 'synthetic-png-base64'
  })
}

test('creates a deterministic blank tab', async () => {
  const engine = createEngine()
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  assert.equal(handle, 'engine-tab-1')
  assert.deepEqual(engine.capabilities(), capabilities)
  assert.deepEqual(engine.tabState(handle), {
    url: 'about:blank',
    title: 'New tab',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    documentRevision: 0,
    navigationRevision: 0
  })
})

test('navigates with deterministic document revisions', async () => {
  const engine = createEngine()
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  const first = await engine.execute(handle, { type: 'navigate', url: 'https://first.test/' })
  const second = await engine.execute(handle, { type: 'navigate', url: 'https://second.test/' })

  assert.equal(first.ok, true)
  assert.equal(first.ok && first.state.documentRevision, 1)
  assert.equal(second.ok, true)
  assert.deepEqual(second.ok && second.state, {
    url: 'https://second.test/',
    title: 'New tab',
    isLoading: false,
    canGoBack: true,
    canGoForward: false,
    documentRevision: 2,
    navigationRevision: 2
  })
})

test('moves backward and forward through page history', async () => {
  const engine = createEngine()
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await engine.execute(handle, { type: 'navigate', url: 'https://first.test/' })
  await engine.execute(handle, { type: 'navigate', url: 'https://second.test/' })

  const back = await engine.execute(handle, { type: 'history', direction: 'back' })
  const forward = await engine.execute(handle, { type: 'history', direction: 'forward' })

  assert.equal(back.ok, true)
  assert.equal(back.ok && back.state.url, 'https://first.test/')
  assert.equal(back.ok && back.state.canGoForward, true)
  assert.equal(forward.ok, true)
  assert.equal(forward.ok && forward.state.url, 'https://second.test/')
  assert.equal(forward.ok && forward.state.documentRevision, 4)
})

test('reloads and stops a tab', async () => {
  const engine = createEngine()
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await engine.execute(handle, { type: 'navigate', url: 'https://example.test/' })

  engine.emitLoading(handle, true)
  const stopped = await engine.execute(handle, { type: 'stop' })
  const reloaded = await engine.execute(handle, { type: 'reload' })

  assert.equal(stopped.ok, true)
  assert.equal(stopped.ok && stopped.state.isLoading, false)
  assert.equal(reloaded.ok, true)
  assert.equal(reloaded.ok && reloaded.state.documentRevision, 2)
  assert.equal(reloaded.ok && reloaded.state.navigationRevision, 2)
  assert.deepEqual(
    engine.recordedActions(handle).map((entry) => entry.command.type),
    ['navigate', 'stop', 'reload']
  )
})

test('returns the configured screenshot fixture', async () => {
  const engine = new InMemoryBrowserEngine({
    capabilities,
    screenshotData: 'synthetic-png-base64',
    screenshotSize: { width: 1280, height: 720 }
  })
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  const result = await engine.execute(handle, { type: 'screenshot' })

  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.screenshot, {
    mediaType: 'image/png',
    data: 'synthetic-png-base64',
    width: 1280,
    height: 720,
    documentRevision: 0
  })
})

test('describes a bounded action target without enabling semantic inspection', async () => {
  const targetDescriptor = {
    tagName: 'input',
    inputType: 'password',
    role: 'textbox',
    accessibleLabel: 'Password',
    editable: true,
    submitsForm: false
  }
  const engine = new InMemoryBrowserEngine({ capabilities, targetDescriptor })
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  assert.equal(engine.capabilities().semanticInspection, false)
  const result = await engine.execute(handle, { type: 'describeTarget', x: 12, y: 34 })
  assert.equal(result.ok, true)
  assert.deepEqual(result.ok && result.target, targetDescriptor)
})

test('rejects unavailable screenshot and coordinate capabilities without recording actions', async () => {
  const engine = new InMemoryBrowserEngine({
    capabilities: { ...capabilities, screenshot: false, coordinateInput: false }
  })
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  const screenshot = await engine.execute(handle, { type: 'screenshot' })
  const click = await engine.execute(handle, {
    type: 'click',
    x: 1,
    y: 2,
    expectedDocumentRevision: 0
  })

  assert.deepEqual(screenshot, {
    ok: false,
    error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Screenshots are unavailable' }
  })
  assert.deepEqual(click, {
    ok: false,
    error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Coordinate input is unavailable' }
  })
  assert.deepEqual(engine.recordedActions(handle), [])
})

test('does not record or mutate a pre-cancelled action', async () => {
  const engine = createEngine()
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  const before = engine.tabState(handle)
  const controller = new AbortController()
  controller.abort()

  const result = await engine.execute(
    handle,
    { type: 'navigate', url: 'https://cancelled.test/' },
    controller.signal
  )

  assert.deepEqual(result, {
    ok: false,
    error: { code: 'ACTION_CANCELLED', message: 'Browser action was cancelled' }
  })
  assert.deepEqual(engine.tabState(handle), before)
  assert.deepEqual(engine.recordedActions(handle), [])
})

test('records coordinate and keyboard input without mutating page state', async () => {
  const engine = createEngine()
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  await engine.execute(handle, {
    type: 'click',
    x: 12,
    y: 34,
    expectedDocumentRevision: 0
  })
  await engine.execute(handle, { type: 'typeText', text: 'hello' })
  await engine.execute(handle, { type: 'keypress', key: 'Enter', expectedDocumentRevision: 0 })
  await engine.execute(handle, {
    type: 'scroll',
    deltaX: 0,
    deltaY: 240,
    expectedDocumentRevision: 0
  })

  assert.deepEqual(
    engine.recordedActions(handle).map(({ command, at }) => ({ command, at })),
    [
      {
        command: { type: 'click', x: 12, y: 34, expectedDocumentRevision: 0 },
        at: 42
      },
      { command: { type: 'typeText', text: 'hello' }, at: 42 },
      { command: { type: 'keypress', key: 'Enter', expectedDocumentRevision: 0 }, at: 42 },
      {
        command: { type: 'scroll', deltaX: 0, deltaY: 240, expectedDocumentRevision: 0 },
        at: 42
      }
    ]
  )
  assert.equal(engine.tabState(handle).documentRevision, 0)
})

test('publishes explicit load, title, and crash events', async () => {
  const engine = createEngine()
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  const events: unknown[] = []
  const unsubscribe = engine.subscribe((event) => events.push(event))

  engine.emitLoading(handle, true)
  engine.emitTitle(handle, 'Example')
  engine.emitCrash(handle, 'killed')
  unsubscribe()
  engine.emitLoading(handle, false)

  assert.deepEqual(events, [
    { type: 'loadingChanged', handle, isLoading: true, navigationRevision: 0, at: 42 },
    { type: 'titleChanged', handle, title: 'Example', navigationRevision: 0, at: 42 },
    { type: 'crashed', handle, reason: 'killed', at: 42 }
  ])
})

test('publishes navigation events in commit order with monotonic revisions', async () => {
  const engine = createEngine()
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  const events: EngineEvent[] = []
  engine.subscribe((event) => events.push(event))

  await engine.execute(handle, { type: 'navigate', url: 'https://first.test/' })
  await engine.execute(handle, { type: 'navigate', url: 'https://second.test/' })
  await engine.execute(handle, { type: 'history', direction: 'back' })
  await engine.execute(handle, { type: 'reload' })

  assert.deepEqual(
    events.map((event) =>
      event.type === 'navigationCommitted'
        ? `${event.type}:${event.navigationRevision}:${event.documentRevision}`
        : event.type === 'loadingChanged'
          ? `${event.type}:${event.navigationRevision}:${event.isLoading}`
          : event.type
    ),
    [
      'loadingChanged:1:true',
      'navigationCommitted:1:1',
      'loadingChanged:1:false',
      'loadingChanged:2:true',
      'navigationCommitted:2:2',
      'loadingChanged:2:false',
      'loadingChanged:3:true',
      'navigationCommitted:3:3',
      'loadingChanged:3:false',
      'loadingChanged:4:true',
      'navigationCommitted:4:4',
      'loadingChanged:4:false'
    ]
  )
})

test('truncates forward history after navigating from a back entry', async () => {
  const engine = createEngine()
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  await engine.execute(handle, { type: 'navigate', url: 'https://first.test/' })
  await engine.execute(handle, { type: 'navigate', url: 'https://second.test/' })
  await engine.execute(handle, { type: 'history', direction: 'back' })
  await engine.execute(handle, { type: 'navigate', url: 'https://third.test/' })

  const forward = await engine.execute(handle, { type: 'history', direction: 'forward' })

  assert.equal(forward.ok, true)
  assert.equal(forward.ok && forward.state.url, 'https://third.test/')
  assert.equal(forward.ok && forward.state.canGoForward, false)
  assert.equal(forward.ok && forward.state.documentRevision, 4)
})

test('preserves document revision at history boundaries', async () => {
  const engine = createEngine()
  const handle = await engine.createTab({ partition: 'browser-project-a' })

  const back = await engine.execute(handle, { type: 'history', direction: 'back' })
  const forward = await engine.execute(handle, { type: 'history', direction: 'forward' })

  assert.equal(back.ok, true)
  assert.equal(back.ok && back.state.documentRevision, 0)
  assert.equal(back.ok && back.state.navigationRevision, 1)
  assert.equal(forward.ok, true)
  assert.equal(forward.ok && forward.state.documentRevision, 0)
  assert.equal(forward.ok && forward.state.navigationRevision, 2)
})

test('assigns and clears a tab viewport', async () => {
  const engine = createEngine()
  const handle = await engine.createTab({ partition: 'browser-project-a' })
  const viewport = { x: 10, y: 20, width: 800, height: 600 }

  await engine.setViewport(handle, viewport)
  assert.deepEqual(engine.viewportFor(handle), viewport)

  await engine.setViewport(handle, null)
  assert.equal(engine.viewportFor(handle), null)
})

test('disposes individual tabs and the complete engine', async () => {
  const engine = createEngine()
  const first = await engine.createTab({ partition: 'browser-project-a' })
  const second = await engine.createTab({ partition: 'browser-project-a' })

  await engine.disposeTab(first)
  const missing = await engine.execute(first, { type: 'stop' })
  assert.deepEqual(missing, {
    ok: false,
    error: { code: 'TAB_NOT_FOUND', message: 'Browser tab was not found' }
  })

  await engine.dispose()
  assert.equal(engine.hasTab(second), false)
  await assert.rejects(
    () => engine.createTab({ partition: 'browser-project-a' }),
    /Browser engine is disposed/
  )
})
