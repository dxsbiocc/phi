import assert from 'node:assert/strict'
import test from 'node:test'
import {
  BrowserIpcCoordinator,
  type BrowserRendererSenderLike
} from '../src/main/browser/browser-ipc'
import { BrowserWorkspace } from '../src/main/browser/browser-workspace'
import { InMemoryBrowserEngine } from '../src/main/browser/in-memory-browser-engine'
import type { BrowserCheckpointStore } from '../src/main/browser/browser-checkpoints'
import type { EngineTabHandle } from '../src/main/browser/browser-engine'
import type { BrowserViewport } from '../src/shared/browserTypes'

class ObservingEngine extends InMemoryBrowserEngine {
  created = 0
  failHide = false
  readonly viewports: Array<BrowserViewport | null> = []

  override async createTab(
    input: Parameters<InMemoryBrowserEngine['createTab']>[0]
  ): Promise<EngineTabHandle> {
    this.created += 1
    return super.createTab(input)
  }

  override async setViewport(
    handle: EngineTabHandle,
    viewport: BrowserViewport | null
  ): Promise<void> {
    this.viewports.push(viewport ? { ...viewport } : null)
    if (viewport === null && this.failHide) throw new Error('Intentional native hide failure')
    await super.setViewport(handle, viewport)
  }
}

function restoredViewportHarness(): {
  coordinator: BrowserIpcCoordinator
  workspace: BrowserWorkspace
  sender: BrowserRendererSenderLike
  engine: ObservingEngine
} {
  const store: BrowserCheckpointStore = {
    load: () => ({
      schemaVersion: 1,
      activeTabId: 'restored-tab',
      tabs: [{ id: 'restored-tab', title: 'Saved page', url: 'https://example.test/' }]
    }),
    save: () => undefined,
    remove: () => undefined
  }
  const engine = new ObservingEngine()
  const workspace = new BrowserWorkspace({
    sessionId: 'restored-session',
    partition: 'restored-partition',
    engine,
    checkpointStore: store
  })
  const sender = { isDestroyed: () => false, send: () => undefined }
  const coordinator = new BrowserIpcCoordinator({
    getRegistry: () => ({
      getOrCreate: async () => workspace,
      disposeSession: async () => undefined
    }),
    getTrustedRenderer: () => sender,
    resolveHumanSession: () => ({
      sessionId: 'restored-session',
      sessionGeneration: 1,
      owner: { kind: 'ordinary' }
    }),
    resolveAgentSession: () => undefined
  })
  return { coordinator, workspace, sender, engine }
}

test('startup viewport hiding accepts a restored page with no native view', async () => {
  const { coordinator, sender, workspace, engine } = restoredViewportHarness()
  const initial = workspace.snapshot()
  assert.equal(initial.tabs[0].restorable, true)
  const request = {
    sessionId: 'restored-session',
    sessionGeneration: 1,
    tabId: 'restored-tab',
    viewport: null
  }
  await assert.doesNotReject(coordinator.setViewportHuman(sender, request))
  await assert.doesNotReject(coordinator.setViewportHuman(sender, request))
  assert.deepEqual(workspace.snapshot(), initial)
  assert.equal(engine.created, 0)
  assert.deepEqual(engine.viewports, [])
})

test('restored hide acknowledgement does not bypass session, tab or presentation checks', async () => {
  const { coordinator, sender } = restoredViewportHarness()
  const request = {
    sessionId: 'restored-session',
    sessionGeneration: 1,
    tabId: 'restored-tab',
    viewport: null
  }
  await assert.rejects(
    coordinator.setViewportHuman(sender, { ...request, sessionGeneration: 0 }),
    /Browser session is unavailable/
  )
  await assert.rejects(
    coordinator.setViewportHuman(sender, { ...request, tabId: 'missing-tab' }),
    /Browser request failed/
  )
  await assert.rejects(
    coordinator.setViewportHuman(sender, {
      ...request,
      viewport: { x: 0, y: 0, width: 100, height: 100 }
    }),
    /Browser request failed/
  )
})

test('explicit restoration creates a view and continues to reject a real native hide failure', async () => {
  const { coordinator, sender, workspace, engine } = restoredViewportHarness()
  const restored = await workspace.execute(
    { kind: 'human' },
    { type: 'restore', requestId: 'restore-page', tabId: 'restored-tab' }
  )
  assert.equal(restored.ok, true)
  assert.equal(engine.created, 1)
  assert.equal(workspace.snapshot().tabs[0].restorable, undefined)
  const request = {
    sessionId: 'restored-session',
    sessionGeneration: 1,
    tabId: 'restored-tab',
    viewport: null
  }
  const viewport = { x: 0, y: 0, width: 100, height: 100 }
  await coordinator.setViewportHuman(sender, { ...request, viewport })
  await coordinator.setViewportHuman(sender, request)
  assert.deepEqual(engine.viewports, [viewport, null])
  engine.failHide = true
  await assert.rejects(coordinator.setViewportHuman(sender, request), /Browser request failed/)
})
