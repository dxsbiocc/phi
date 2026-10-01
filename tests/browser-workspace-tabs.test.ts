import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  EngineCommand,
  EngineResult,
  EngineTabHandle
} from '../src/main/browser/browser-engine'
import { InMemoryBrowserEngine } from '../src/main/browser/in-memory-browser-engine'
import { BrowserWorkspace } from '../src/main/browser/browser-workspace'
import {
  browserCapabilities,
  createBrowserWorkspaceHarness,
  human,
  successful
} from './helpers/browserWorkspaceHarness'

test('opens, navigates, and snapshots one stable Phi tab', async () => {
  const { workspace } = createBrowserWorkspaceHarness()
  const opened = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-1',
    url: 'example.test'
  })
  successful(opened)
  assert.equal(opened.snapshot.activeTabId, 'phi-tab-1')
  assert.deepEqual(
    opened.snapshot.tabs.map(({ id, url }) => ({ id, url })),
    [{ id: 'phi-tab-1', url: 'https://example.test/' }]
  )
  assert.equal(JSON.stringify(opened.snapshot).includes('engine-tab-1'), false)

  const navigated = await workspace.execute(human, {
    type: 'navigate',
    requestId: 'navigate-1',
    tabId: 'phi-tab-1',
    url: 'https://second.test/path'
  })
  successful(navigated)
  assert.equal(navigated.snapshot.tabs[0].id, 'phi-tab-1')
  assert.equal(navigated.snapshot.tabs[0].url, 'https://second.test/path')

  const snapshot = await workspace.execute(human, {
    type: 'snapshot',
    requestId: 'snapshot-1',
    tabId: 'phi-tab-1'
  })
  successful(snapshot)
  assert.deepEqual(snapshot.snapshot, workspace.snapshot())
})

test('open creates and activates a new tab every time', async () => {
  const { workspace } = createBrowserWorkspaceHarness()
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'first.test' })
  const second = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-2',
    url: 'second.test'
  })
  successful(second)
  assert.deepEqual(
    second.snapshot.tabs.map(({ id, url }) => ({ id, url })),
    [
      { id: 'phi-tab-1', url: 'https://first.test/' },
      { id: 'phi-tab-2', url: 'https://second.test/' }
    ]
  )
  assert.equal(second.snapshot.activeTabId, 'phi-tab-2')
})

test('newTab creates an active blank tab or navigates its optional URL', async () => {
  const { engine, workspace } = createBrowserWorkspaceHarness()
  const blank = await workspace.execute(human, { type: 'newTab', requestId: 'new-blank' })
  successful(blank)
  assert.equal(blank.snapshot.activeTabId, 'phi-tab-1')
  assert.equal(blank.snapshot.tabs[0].url, 'about:blank')
  assert.equal(blank.snapshot.tabs[0].phase, 'idle')

  const navigated = await workspace.execute(human, {
    type: 'newTab',
    requestId: 'new-url',
    url: 'example.test'
  })
  successful(navigated)
  assert.equal(navigated.snapshot.activeTabId, 'phi-tab-2')
  assert.equal(navigated.snapshot.tabs[1].url, 'https://example.test/')
  assert.equal(engine.tabInputFor('engine-tab-1' as EngineTabHandle).partition, 'browser-project-a')
  assert.equal(engine.tabInputFor('engine-tab-2' as EngineTabHandle).partition, 'browser-project-a')
})

test('activate selects a known tab without changing either page', async () => {
  const { workspace } = createBrowserWorkspaceHarness()
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'first.test' })
  await workspace.execute(human, { type: 'open', requestId: 'open-2', url: 'second.test' })
  const before = workspace.snapshot().tabs

  const activated = await workspace.execute(human, {
    type: 'activate',
    requestId: 'activate-1',
    tabId: 'phi-tab-1'
  })
  successful(activated)
  assert.equal(activated.snapshot.activeTabId, 'phi-tab-1')
  assert.deepEqual(activated.snapshot.tabs, before)
})

test('closing an inactive tab preserves the active tab', async () => {
  const { engine, workspace } = createBrowserWorkspaceHarness()
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'first.test' })
  await workspace.execute(human, { type: 'open', requestId: 'open-2', url: 'second.test' })
  const closed = await workspace.execute(human, {
    type: 'close',
    requestId: 'close-1',
    tabId: 'phi-tab-1'
  })
  successful(closed)
  assert.equal(closed.snapshot.activeTabId, 'phi-tab-2')
  assert.deepEqual(
    closed.snapshot.tabs.map((tab) => tab.id),
    ['phi-tab-2']
  )
  assert.equal(engine.hasTab('engine-tab-1' as EngineTabHandle), false)
  assert.equal(engine.hasTab('engine-tab-2' as EngineTabHandle), true)
})

test('closing the active tab selects right, then left, then null', async () => {
  const { workspace } = createBrowserWorkspaceHarness()
  for (const [requestId, url] of [
    ['open-1', 'first.test'],
    ['open-2', 'second.test'],
    ['open-3', 'third.test']
  ]) {
    await workspace.execute(human, { type: 'open', requestId, url })
  }
  await workspace.execute(human, {
    type: 'activate',
    requestId: 'activate-2',
    tabId: 'phi-tab-2'
  })

  const right = await workspace.execute(human, {
    type: 'close',
    requestId: 'close-2',
    tabId: 'phi-tab-2'
  })
  successful(right)
  assert.equal(right.snapshot.activeTabId, 'phi-tab-3')

  const left = await workspace.execute(human, {
    type: 'close',
    requestId: 'close-3',
    tabId: 'phi-tab-3'
  })
  successful(left)
  assert.equal(left.snapshot.activeTabId, 'phi-tab-1')

  const empty = await workspace.execute(human, {
    type: 'close',
    requestId: 'close-4',
    tabId: 'phi-tab-1'
  })
  successful(empty)
  assert.equal(empty.snapshot.activeTabId, null)
  assert.deepEqual(empty.snapshot.tabs, [])
})

test('repeating the same close request disposes its engine tab once', async () => {
  class CountingDisposeEngine extends InMemoryBrowserEngine {
    disposeTabCalls = 0
    override async disposeTab(handle: EngineTabHandle): Promise<void> {
      this.disposeTabCalls += 1
      await super.disposeTab(handle)
    }
  }
  const engine = new CountingDisposeEngine({
    capabilities: browserCapabilities,
    idFactory: () => 'engine-tab-1'
  })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => 'phi-tab-1',
    now: () => 42
  })
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })
  const close = { type: 'close', requestId: 'close-1', tabId: 'phi-tab-1' } as const
  const first = await workspace.execute(human, close)
  const duplicate = await workspace.execute(human, close)
  assert.deepEqual(duplicate, first)
  assert.equal(engine.disposeTabCalls, 1)
})

test('queues an allowed GET popup as a new active tab in the source partition', async () => {
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  class PopupQueueEngine extends InMemoryBrowserEngine {
    calls = 0
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      this.calls += 1
      if (this.calls === 1) await firstGate
      return super.execute(handle, command, signal)
    }
  }
  let engineId = 0
  let tabId = 0
  const engine = new PopupQueueEngine({
    capabilities: browserCapabilities,
    idFactory: () => `engine-tab-${++engineId}`
  })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `phi-tab-${++tabId}`,
    now: () => 42
  })
  const opened = workspace.execute(
    { kind: 'agent', sessionId: 'session-1', runId: 'run-1', toolCallId: 'tool-1' },
    { type: 'open', requestId: 'open-1', url: 'source.test' }
  )
  await new Promise<void>((resolve) => setImmediate(resolve))
  engine.emitPopup('engine-tab-1' as EngineTabHandle, {
    url: 'https://popup.test/path',
    method: 'GET'
  })
  assert.equal(workspace.snapshot().tabs.length, 1)
  releaseFirst()
  await opened
  await workspace.execute(human, {
    type: 'snapshot',
    requestId: 'after-popup',
    tabId: 'phi-tab-1'
  })
  const snapshot = workspace.snapshot()
  assert.equal(snapshot.tabs.length, 2)
  assert.equal(snapshot.activeTabId, 'phi-tab-2')
  assert.equal(snapshot.tabs[1].url, 'https://popup.test/path')
  assert.equal(snapshot.tabs[1].isAgentControlled, true)
  assert.equal(engine.tabInputFor('engine-tab-2' as EngineTabHandle).partition, 'browser-project-a')
})

test('denies unsafe popup requests without changing the workspace snapshot', async () => {
  const { engine, workspace, engineHandle } = createBrowserWorkspaceHarness()
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'source.test' })
  const before = workspace.snapshot()
  const denied = [
    { url: 'https://post.test/', method: 'POST' as const },
    { url: 'https://other.test/', method: 'other' as const },
    { url: 'javascript:alert(1)', method: 'GET' as const },
    { url: 'https://user:password@credential.test/', method: 'GET' as const },
    { url: 'https://phi.internal/private', method: 'GET' as const }
  ]
  for (const [index, popup] of denied.entries()) {
    engine.emitPopup(engineHandle, popup)
    await workspace.execute(human, {
      type: 'snapshot',
      requestId: `after-denied-${index}`,
      tabId: 'phi-tab-1'
    })
  }
  assert.deepEqual(workspace.snapshot(), before)
})

test('ignores popup events after workspace disposal', async () => {
  class RetainedFakeEngine extends InMemoryBrowserEngine {
    override dispose(): Promise<void> {
      return Promise.resolve()
    }
  }
  const engine = new RetainedFakeEngine({
    capabilities: browserCapabilities,
    idFactory: () => 'engine-tab-1'
  })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => 'phi-tab-1',
    now: () => 42
  })
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'source.test' })
  await workspace.dispose()
  const before = workspace.snapshot()
  engine.emitPopup('engine-tab-1' as EngineTabHandle, {
    url: 'https://late-popup.test/',
    method: 'GET'
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(workspace.snapshot(), before)
})

test('ignores a popup queued synchronously while its source tab is closing', async () => {
  class PopupDuringCloseEngine extends InMemoryBrowserEngine {
    override async disposeTab(handle: EngineTabHandle): Promise<void> {
      this.emitPopup(handle, { url: 'https://must-not-open.test/', method: 'GET' })
      await super.disposeTab(handle)
    }
  }
  let engineId = 0
  const engine = new PopupDuringCloseEngine({
    capabilities: browserCapabilities,
    idFactory: () => `engine-tab-${++engineId}`
  })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => 'phi-tab-1',
    now: () => 42
  })
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'source.test' })
  await workspace.execute(human, {
    type: 'close',
    requestId: 'close-1',
    tabId: 'phi-tab-1'
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(workspace.snapshot().tabs, [])
  assert.equal(engine.hasTab('engine-tab-2' as EngineTabHandle), false)
})

async function createFailureWorkspace(
  engine: InMemoryBrowserEngine,
  tabIdFactory: () => string
): Promise<BrowserWorkspace> {
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: tabIdFactory,
    now: () => 42
  })
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'source.test' })
  return workspace
}

test('rolls back a new tab and restores active selection when navigation throws', async () => {
  class ThrowingNavigateEngine extends InMemoryBrowserEngine {
    calls = 0
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      this.calls += 1
      if (this.calls === 2) throw new Error('navigation failed unexpectedly')
      return super.execute(handle, command, signal)
    }
  }
  let engineId = 0
  let tabId = 0
  const engine = new ThrowingNavigateEngine({
    capabilities: browserCapabilities,
    idFactory: () => `engine-tab-${++engineId}`
  })
  const workspace = await createFailureWorkspace(engine, () => `phi-tab-${++tabId}`)
  const failed = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-2',
    url: 'throw.test'
  })
  assert.equal(failed.ok, false)
  if (failed.ok) assert.fail('throwing navigation must fail')
  assert.equal(failed.error.code, 'ENGINE_UNAVAILABLE')
  assert.deepEqual(
    workspace.snapshot().tabs.map((tab) => tab.id),
    ['phi-tab-1']
  )
  assert.equal(workspace.snapshot().activeTabId, 'phi-tab-1')
  assert.equal(engine.hasTab('engine-tab-2' as EngineTabHandle), false)
})

test('rolls back a new tab for non-navigation engine failures', async () => {
  class CancelledNavigateEngine extends InMemoryBrowserEngine {
    calls = 0
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      this.calls += 1
      if (this.calls === 2) {
        return {
          ok: false,
          error: { code: 'ACTION_CANCELLED', message: 'Browser action was cancelled' }
        }
      }
      return super.execute(handle, command, signal)
    }
  }
  let engineId = 0
  let tabId = 0
  const engine = new CancelledNavigateEngine({
    capabilities: browserCapabilities,
    idFactory: () => `engine-tab-${++engineId}`
  })
  const workspace = await createFailureWorkspace(engine, () => `phi-tab-${++tabId}`)
  const failed = await workspace.execute(human, {
    type: 'newTab',
    requestId: 'new-2',
    url: 'cancelled.test'
  })
  assert.equal(failed.ok, false)
  if (failed.ok) assert.fail('cancelled navigation must fail')
  assert.equal(failed.error.code, 'ACTION_CANCELLED')
  assert.deepEqual(
    workspace.snapshot().tabs.map((tab) => tab.id),
    ['phi-tab-1']
  )
  assert.equal(workspace.snapshot().activeTabId, 'phi-tab-1')
  assert.equal(engine.hasTab('engine-tab-2' as EngineTabHandle), false)
})

test('retains a safely failed new tab for a genuine navigation failure', async () => {
  class FailedNavigationEngine extends InMemoryBrowserEngine {
    calls = 0
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      this.calls += 1
      if (this.calls === 2) {
        return {
          ok: false,
          error: { code: 'NAVIGATION_FAILED', message: 'raw secret engine failure' }
        }
      }
      return super.execute(handle, command, signal)
    }
  }
  let engineId = 0
  let tabId = 0
  const engine = new FailedNavigationEngine({
    capabilities: browserCapabilities,
    idFactory: () => `engine-tab-${++engineId}`
  })
  const workspace = await createFailureWorkspace(engine, () => `phi-tab-${++tabId}`)
  const failed = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-2',
    url: 'failed.test'
  })
  assert.equal(failed.ok, false)
  if (failed.ok) assert.fail('failed navigation must report failure')
  assert.equal(failed.error.code, 'NAVIGATION_FAILED')
  assert.equal(failed.error.message, 'Page failed to load')
  assert.equal(failed.snapshot.activeTabId, 'phi-tab-2')
  assert.equal(failed.snapshot.tabs[1].url, 'https://failed.test/')
  assert.equal(failed.snapshot.tabs[1].phase, 'failed')
  assert.equal(failed.snapshot.tabs[1].error?.message, 'Page failed to load')
  assert.equal(JSON.stringify(failed).includes('raw secret'), false)
  assert.equal(engine.hasTab('engine-tab-2' as EngineTabHandle), true)
})
