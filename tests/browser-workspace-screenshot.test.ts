import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserCapabilities } from '../src/shared/browserTypes'
import type {
  EngineCommand,
  EngineResult,
  EngineTabHandle
} from '../src/main/browser/browser-engine'
import { InMemoryBrowserEngine } from '../src/main/browser/in-memory-browser-engine'
import type {
  BrowserCheckpoint,
  BrowserCheckpointStore
} from '../src/main/browser/browser-checkpoints'
import { BrowserWorkspace } from '../src/main/browser/browser-workspace'
import { browserCapabilities, human, successful } from './helpers/browserWorkspaceHarness'

test('captures an inactive live tab with stable workspace metadata', async () => {
  let engineId = 0
  let tabId = 0
  const engine = new InMemoryBrowserEngine({
    capabilities: browserCapabilities,
    idFactory: () => `engine-tab-${++engineId}`,
    screenshotData: 'page-one-png',
    screenshotSize: { width: 1440, height: 900 }
  })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-screenshot',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `phi-tab-${++tabId}`
  })
  const first = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-first',
    url: 'https://first.test/page'
  })
  successful(first)
  const second = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-second',
    url: 'https://second.test/'
  })
  successful(second)
  assert.equal(second.snapshot.activeTabId, 'phi-tab-2')

  const captured = await workspace.execute(human, {
    type: 'snapshot',
    requestId: 'capture-first',
    tabId: 'phi-tab-1'
  })

  successful(captured)
  assert.deepEqual(captured.screenshot, {
    mediaType: 'image/png',
    data: 'page-one-png',
    width: 1440,
    height: 900,
    tabId: 'phi-tab-1',
    url: 'https://first.test/page',
    documentRevision: first.snapshot.tabs[0].documentRevision
  })
  assert.equal(captured.snapshot.activeTabId, 'phi-tab-2')

  const repeated = await workspace.execute(human, {
    type: 'snapshot',
    requestId: 'capture-first',
    tabId: 'phi-tab-1'
  })
  successful(repeated)
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'screenshot').length,
    2
  )
})

test('rejects unavailable, missing, restorable, and crashed screenshot targets safely', async () => {
  const unavailableCapabilities: BrowserCapabilities = {
    ...browserCapabilities,
    screenshot: false
  }
  const unavailableEngine = new InMemoryBrowserEngine({
    capabilities: unavailableCapabilities,
    idFactory: () => 'engine-unavailable'
  })
  const unavailableWorkspace = new BrowserWorkspace({
    sessionId: 'session-unavailable',
    partition: 'browser-project-a',
    engine: unavailableEngine,
    idFactory: () => 'phi-unavailable'
  })
  await unavailableWorkspace.execute(human, { type: 'newTab', requestId: 'new-unavailable' })
  const unavailable = await unavailableWorkspace.execute(human, {
    type: 'snapshot',
    requestId: 'capture-unavailable',
    tabId: 'phi-unavailable'
  })
  assert.equal(unavailable.ok, false)
  assert.equal(!unavailable.ok && unavailable.error.code, 'CAPABILITY_UNAVAILABLE')

  const missing = await unavailableWorkspace.execute(human, {
    type: 'snapshot',
    requestId: 'capture-missing',
    tabId: 'missing'
  })
  assert.equal(missing.ok, false)
  assert.equal(!missing.ok && missing.error.code, 'TAB_NOT_FOUND')

  const checkpoint: BrowserCheckpoint = {
    schemaVersion: 1,
    tabs: [{ id: 'restorable-tab', title: 'Saved', url: 'https://saved.test/' }],
    activeTabId: 'restorable-tab'
  }
  const store: BrowserCheckpointStore = {
    load: () => checkpoint,
    save: () => undefined,
    remove: () => undefined
  }
  const restorableWorkspace = new BrowserWorkspace({
    sessionId: 'session-restorable',
    partition: 'browser-project-a',
    engine: new InMemoryBrowserEngine({ capabilities: browserCapabilities }),
    checkpointStore: store
  })
  const restorable = await restorableWorkspace.execute(human, {
    type: 'snapshot',
    requestId: 'capture-restorable',
    tabId: 'restorable-tab'
  })
  assert.equal(restorable.ok, false)
  assert.equal(!restorable.ok && restorable.error.code, 'CAPABILITY_UNAVAILABLE')

  const crashEngine = new InMemoryBrowserEngine({
    capabilities: browserCapabilities,
    idFactory: () => 'engine-crashed'
  })
  const crashWorkspace = new BrowserWorkspace({
    sessionId: 'session-crashed',
    partition: 'browser-project-a',
    engine: crashEngine,
    idFactory: () => 'phi-crashed'
  })
  await crashWorkspace.execute(human, { type: 'newTab', requestId: 'new-crashed' })
  crashEngine.emitCrash('engine-crashed' as EngineTabHandle, 'renderer-gone')
  const crashed = await crashWorkspace.execute(human, {
    type: 'snapshot',
    requestId: 'capture-crashed',
    tabId: 'phi-crashed'
  })
  assert.equal(crashed.ok, false)
  assert.equal(!crashed.ok && crashed.error.code, 'RENDERER_CRASHED')
})

test('maps screenshot revisions across a recovered engine epoch without emitting state changes', async () => {
  let engineId = 0
  const engine = new InMemoryBrowserEngine({
    capabilities: browserCapabilities,
    idFactory: () => `engine-recovery-${++engineId}`,
    screenshotData: 'recovered-png',
    screenshotSize: { width: 800, height: 600 }
  })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-recovery',
    partition: 'browser-project-a',
    engine,
    idFactory: () => 'phi-recovery'
  })
  const opened = await workspace.execute(human, {
    type: 'open',
    requestId: 'recovery-open',
    url: 'https://recovery.test/'
  })
  successful(opened)
  engine.emitCrash('engine-recovery-1' as EngineTabHandle, 'renderer-gone')
  const recovered = await workspace.execute(human, {
    type: 'reload',
    requestId: 'recovery-reload',
    tabId: 'phi-recovery'
  })
  successful(recovered)
  const revisions: number[] = []
  workspace.subscribe((event) => {
    if (event.type === 'snapshotChanged') revisions.push(event.snapshot.revision)
  })

  const captured = await workspace.execute(human, {
    type: 'snapshot',
    requestId: 'recovery-capture',
    tabId: 'phi-recovery'
  })

  successful(captured)
  assert.equal(captured.screenshot?.documentRevision, recovered.snapshot.tabs[0].documentRevision)
  assert.equal(captured.screenshot?.url, recovered.snapshot.tabs[0].url)
  assert.deepEqual(revisions, [])
})

test('rejects a screenshot whose engine revision is stale for the visible document', async () => {
  class StaleScreenshotEngine extends InMemoryBrowserEngine {
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      const result = await super.execute(handle, command, signal)
      if (!result.ok || command.type !== 'screenshot' || !result.screenshot) return result
      return {
        ...result,
        screenshot: { ...result.screenshot, documentRevision: 0 }
      }
    }
  }
  const engine = new StaleScreenshotEngine({
    capabilities: browserCapabilities,
    idFactory: () => 'engine-stale'
  })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-stale',
    partition: 'browser-project-a',
    engine,
    idFactory: () => 'phi-stale'
  })
  await workspace.execute(human, {
    type: 'open',
    requestId: 'stale-open',
    url: 'https://stale.test/'
  })

  const captured = await workspace.execute(human, {
    type: 'snapshot',
    requestId: 'stale-capture',
    tabId: 'phi-stale'
  })

  assert.equal(captured.ok, false)
  assert.equal(!captured.ok && captured.error.code, 'STALE_DOCUMENT')
  assert.equal('screenshot' in captured, false)
})

class DeferredScreenshotEngine extends InMemoryBrowserEngine {
  readonly captureStarted: Promise<void>
  #markCaptureStarted!: () => void
  readonly captureGate: Promise<void>
  #releaseCapture!: () => void

  constructor() {
    super({ capabilities: browserCapabilities, idFactory: () => 'engine-deferred' })
    this.captureStarted = new Promise<void>((resolve) => {
      this.#markCaptureStarted = resolve
    })
    this.captureGate = new Promise<void>((resolve) => {
      this.#releaseCapture = resolve
    })
  }

  releaseCapture(): void {
    this.#releaseCapture()
  }

  override async execute(
    handle: EngineTabHandle,
    command: EngineCommand,
    signal?: AbortSignal
  ): Promise<EngineResult> {
    if (command.type === 'screenshot') {
      this.#markCaptureStarted()
      await this.captureGate
    }
    return super.execute(handle, command, signal)
  }
}

test('cancels a workspace capture without publishing or persisting screenshot data', async () => {
  const engine = new DeferredScreenshotEngine()
  const saved: BrowserCheckpoint[] = []
  const store: BrowserCheckpointStore = {
    load: () => null,
    save: (_sessionId, checkpoint) => saved.push(checkpoint),
    remove: () => undefined
  }
  const workspace = new BrowserWorkspace({
    sessionId: 'session-abort',
    partition: 'browser-project-a',
    engine,
    idFactory: () => 'phi-abort',
    checkpointStore: store
  })
  await workspace.execute(human, {
    type: 'open',
    requestId: 'abort-open',
    url: 'https://abort.test/'
  })
  const saveCount = saved.length
  const events: unknown[] = []
  workspace.subscribe((event) => events.push(event))
  const controller = new AbortController()
  const pending = workspace.execute(
    human,
    { type: 'snapshot', requestId: 'abort-capture', tabId: 'phi-abort' },
    controller.signal
  )
  await engine.captureStarted
  controller.abort()
  engine.releaseCapture()

  const captured = await pending

  assert.equal(captured.ok, false)
  assert.equal(!captured.ok && captured.error.code, 'ACTION_CANCELLED')
  assert.equal(saved.length, saveCount)
  assert.deepEqual(events, [])
  assert.equal(JSON.stringify(saved).includes('iVBOR'), false)
})

test('does not accept a delayed screenshot after its page crashes', async () => {
  const engine = new DeferredScreenshotEngine()
  const workspace = new BrowserWorkspace({
    sessionId: 'session-delayed-crash',
    partition: 'browser-project-a',
    engine,
    idFactory: () => 'phi-delayed-crash'
  })
  await workspace.execute(human, {
    type: 'open',
    requestId: 'delayed-open',
    url: 'https://delayed.test/'
  })
  const pending = workspace.execute(human, {
    type: 'snapshot',
    requestId: 'delayed-capture',
    tabId: 'phi-delayed-crash'
  })
  await engine.captureStarted
  engine.emitCrash('engine-deferred' as EngineTabHandle, 'renderer-gone')
  engine.releaseCapture()

  const captured = await pending

  assert.equal(captured.ok, false)
  assert.equal(!captured.ok && captured.error.code, 'RENDERER_CRASHED')
  assert.equal('screenshot' in captured, false)
})
