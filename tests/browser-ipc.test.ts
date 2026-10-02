import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BrowserActor,
  BrowserCommand,
  BrowserOutcome,
  BrowserViewport,
  BrowserWorkspaceEvent,
  BrowserWorkspaceSnapshot
} from '../src/shared/browserTypes'
import {
  BrowserIpcCoordinator,
  registerBrowserRendererIpc,
  type BrowserIpcSession,
  type BrowserRendererSenderLike,
  type BrowserWorkspaceLike,
  type BrowserWorkspaceRegistryLike
} from '../src/main/browser/browser-ipc'
import type {
  BrowserCheckpoint,
  BrowserCheckpointStore
} from '../src/main/browser/browser-checkpoints'
import { InMemoryBrowserEngine } from '../src/main/browser/in-memory-browser-engine'
import type { EngineTabHandle } from '../src/main/browser/browser-engine'
import { BrowserWorkspace } from '../src/main/browser/browser-workspace'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

class BlockingViewportEngine extends InMemoryBrowserEngine {
  readonly entered = deferred()
  readonly release = deferred()

  override async setViewport(
    handle: EngineTabHandle,
    viewport: BrowserViewport | null
  ): Promise<void> {
    this.entered.resolve()
    await this.release.promise
    await super.setViewport(handle, viewport)
  }
}

const snapshot = (sessionId: string): BrowserWorkspaceSnapshot => ({
  sessionId,
  activeTabId: null,
  tabs: [],
  capabilities: {
    presentation: 'native',
    screenshot: false,
    coordinateInput: false,
    semanticInspection: false,
    downloads: false,
    recording: false,
    persistentProfile: false
  },
  revision: 0
})

class FakeWorkspace implements BrowserWorkspaceLike {
  readonly executeCalls: Array<{ actor: BrowserActor; command: BrowserCommand }> = []
  readonly viewportCalls: Array<{ tabId: string; viewport: BrowserViewport | null }> = []
  readonly listeners = new Set<(event: BrowserWorkspaceEvent) => void>()
  subscribeCalls = 0

  constructor(readonly sessionId: string) {}

  async execute(actor: BrowserActor, command: BrowserCommand): Promise<BrowserOutcome> {
    this.executeCalls.push({ actor, command })
    return { ok: true, snapshot: snapshot(this.sessionId) }
  }

  snapshot(): BrowserWorkspaceSnapshot {
    return snapshot(this.sessionId)
  }

  async setViewport(tabId: string, viewport: BrowserViewport | null): Promise<void> {
    this.viewportCalls.push({ tabId, viewport: viewport ? { ...viewport } : null })
  }

  subscribe(listener: (event: BrowserWorkspaceEvent) => void): () => void {
    this.subscribeCalls += 1
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: BrowserWorkspaceEvent): void {
    for (const listener of this.listeners) listener(event)
  }
}

class FakeRegistry implements BrowserWorkspaceRegistryLike {
  readonly registrations: BrowserIpcSession[] = []
  readonly workspaces = new Map<string, FakeWorkspace>()
  readonly disposedSessions: string[] = []

  async getOrCreate(registration: BrowserIpcSession): Promise<FakeWorkspace> {
    this.registrations.push(registration)
    let workspace = this.workspaces.get(registration.sessionId)
    if (!workspace) {
      workspace = new FakeWorkspace(registration.sessionId)
      this.workspaces.set(registration.sessionId, workspace)
    }
    return workspace
  }

  async disposeSession(sessionId: string): Promise<void> {
    this.disposedSessions.push(sessionId)
  }
}

class FakeSender implements BrowserRendererSenderLike {
  destroyed = false
  throwOnSend = false
  readonly sent: Array<{ channel: string; payload: unknown }> = []

  isDestroyed(): boolean {
    return this.destroyed
  }

  send(channel: string, payload: unknown): void {
    if (this.throwOnSend) throw new Error('raw renderer send secret')
    this.sent.push({ channel, payload })
  }
}

type IpcHandler = (event: { sender: BrowserRendererSenderLike }, input?: unknown) => unknown

function harness(): {
  coordinator: BrowserIpcCoordinator
  registry: FakeRegistry
  sender: FakeSender
  foreign: FakeSender
  handlers: Map<string, IpcHandler>
  setHumanSession: (session: BrowserIpcSession | undefined) => void
  origins: Map<string, BrowserIpcSession>
} {
  const registry = new FakeRegistry()
  const sender = new FakeSender()
  const foreign = new FakeSender()
  let humanSession: BrowserIpcSession | undefined = {
    sessionId: 'phi-current',
    owner: { kind: 'ordinary' }
  }
  const origins = new Map<string, BrowserIpcSession>()
  const coordinator = new BrowserIpcCoordinator({
    getRegistry: () => registry,
    getTrustedRenderer: () => sender,
    resolveHumanSession: () => humanSession,
    resolveAgentSession: (originSessionId) => origins.get(originSessionId)
  })
  const handlers = new Map<string, IpcHandler>()
  registerBrowserRendererIpc(
    {
      handle: (channel, handler) => handlers.set(channel, handler)
    },
    coordinator
  )
  return {
    coordinator,
    registry,
    sender,
    foreign,
    handlers,
    setHumanSession: (session) => {
      humanSession = session
    },
    origins
  }
}

async function invoke(
  value: ReturnType<typeof harness>,
  channel: string,
  input?: unknown,
  sender: BrowserRendererSenderLike = value.sender
): Promise<unknown> {
  const handler = value.handlers.get(channel)
  assert.ok(handler)
  return handler({ sender }, input)
}

test('renderer execution derives human ownership from trusted main state', async () => {
  const value = harness()
  const result = await invoke(value, 'browser:execute', {
    type: 'open',
    requestId: 'request-1',
    url: 'https://example.test',
    sessionId: 'phi-forged',
    actor: { kind: 'agent', sessionId: 'phi-forged' },
    owner: { kind: 'project', location: { realPath: '/forged' } },
    ignored: 'field'
  })

  assert.equal((result as BrowserOutcome).ok, true)
  assert.deepEqual(value.registry.registrations, [
    { sessionId: 'phi-current', owner: { kind: 'ordinary' } }
  ])
  assert.deepEqual(value.registry.workspaces.get('phi-current')?.executeCalls, [
    {
      actor: { kind: 'human' },
      command: { type: 'open', requestId: 'request-1', url: 'https://example.test' }
    }
  ])
})

test('renderer calls reject foreign destroyed or sessionless callers safely', async () => {
  const value = harness()
  await assert.rejects(
    invoke(value, 'browser:snapshot', {}, value.foreign),
    /Browser renderer is not authorized/
  )
  value.sender.destroyed = true
  await assert.rejects(invoke(value, 'browser:snapshot'), /Browser renderer is not authorized/)
  value.sender.destroyed = false
  value.setHumanSession(undefined)
  await assert.rejects(invoke(value, 'browser:snapshot'), /Browser session is unavailable/)
  assert.equal(value.registry.registrations.length, 0)
})

test('runtime parser accepts every command shape and copies only bounded whitelist fields', async () => {
  const value = harness()
  const inputs: unknown[] = [
    { type: 'newTab', requestId: '1', url: 'https://example.test', extra: true },
    { type: 'activate', requestId: '2', tabId: 'tab-1' },
    { type: 'close', requestId: '3', tabId: 'tab-1' },
    {
      type: 'navigate',
      requestId: '4',
      tabId: 'tab-1',
      url: 'https://example.test/next',
      expectedDocumentRevision: 2
    },
    { type: 'history', requestId: '5', tabId: 'tab-1', direction: 'back' },
    { type: 'reload', requestId: '6', tabId: 'tab-1' },
    { type: 'stop', requestId: '7', tabId: 'tab-1' },
    { type: 'snapshot', requestId: '8', tabId: 'tab-1' },
    { type: 'restore', requestId: '9', tabId: 'tab-1' },
    {
      type: 'click',
      requestId: '10',
      tabId: 'tab-1',
      x: 1.5,
      y: -2,
      expectedDocumentRevision: 3,
      consequence: 'read'
    },
    {
      type: 'typeText',
      requestId: '11',
      tabId: 'tab-1',
      text: 'hello',
      expectedDocumentRevision: 3,
      consequence: 'write'
    },
    {
      type: 'keypress',
      requestId: '12',
      tabId: 'tab-1',
      key: 'Enter',
      expectedDocumentRevision: 3
    },
    {
      type: 'scroll',
      requestId: '13',
      tabId: 'tab-1',
      deltaX: 0,
      deltaY: 120,
      expectedDocumentRevision: 3
    }
  ]
  for (const input of inputs) await invoke(value, 'browser:execute', input)

  const calls = value.registry.workspaces.get('phi-current')?.executeCalls ?? []
  assert.equal(calls.length, inputs.length)
  assert.deepEqual(calls[0].command, {
    type: 'newTab',
    requestId: '1',
    url: 'https://example.test'
  })
  assert.equal('extra' in calls[0].command, false)
})

test('runtime parser rejects oversized nonfinite and invalid command fields before registry use', async () => {
  const invalid: unknown[] = [
    { type: 'open', requestId: '', url: 'https://example.test' },
    { type: 'open', requestId: 'x'.repeat(257), url: 'https://example.test' },
    { type: 'open', requestId: '1', url: 'x'.repeat(16_385) },
    {
      type: 'navigate',
      requestId: '1',
      tabId: 'tab',
      url: 'https://x',
      expectedDocumentRevision: 1.2
    },
    { type: 'history', requestId: '1', tabId: 'tab', direction: 'sideways' },
    {
      type: 'click',
      requestId: '1',
      tabId: 'tab',
      x: Number.NaN,
      y: 2,
      expectedDocumentRevision: 1,
      consequence: 'read'
    },
    {
      type: 'typeText',
      requestId: '1',
      tabId: 'tab',
      text: 'x'.repeat(16_385),
      expectedDocumentRevision: 1,
      consequence: 'write'
    },
    {
      type: 'keypress',
      requestId: '1',
      tabId: 'tab',
      key: 'x'.repeat(65),
      expectedDocumentRevision: 1
    },
    {
      type: 'scroll',
      requestId: '1',
      tabId: 'tab',
      deltaX: 0,
      deltaY: Number.POSITIVE_INFINITY,
      expectedDocumentRevision: 1
    }
  ]
  for (const input of invalid) {
    const value = harness()
    await assert.rejects(invoke(value, 'browser:execute', input), /Invalid browser request/)
    assert.equal(value.registry.registrations.length, 0)
  }
})

test('viewport parsing rejects invalid bounds before workspace dispatch and copies valid values', async () => {
  const value = harness()
  const source = { x: 1, y: 2, width: 300, height: 200 }
  await invoke(value, 'browser:setViewport', { tabId: 'tab-1', viewport: source })
  source.width = 999
  await invoke(value, 'browser:setViewport', { tabId: 'tab-1', viewport: null })
  assert.deepEqual(value.registry.workspaces.get('phi-current')?.viewportCalls, [
    { tabId: 'tab-1', viewport: { x: 1, y: 2, width: 300, height: 200 } },
    { tabId: 'tab-1', viewport: null }
  ])

  for (const viewport of [
    { x: Number.NaN, y: 0, width: 1, height: 1 },
    { x: 0, y: 0, width: 0, height: 1 },
    { x: 0, y: 0, width: 1, height: -1 },
    { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 1 }
  ]) {
    await assert.rejects(
      invoke(value, 'browser:setViewport', { tabId: 'tab-1', viewport }),
      /Invalid browser request/
    )
  }
  assert.equal(value.registry.workspaces.get('phi-current')?.viewportCalls.length, 2)
})

test('workspace events subscribe once and send safe session envelopes to the current renderer', async () => {
  const value = harness()
  await invoke(value, 'browser:snapshot')
  await invoke(value, 'browser:snapshot')
  const workspace = value.registry.workspaces.get('phi-current')
  assert.equal(workspace?.subscribeCalls, 1)

  const event: BrowserWorkspaceEvent = {
    type: 'snapshotChanged',
    snapshot: snapshot('phi-current')
  }
  workspace?.emit(event)
  assert.deepEqual(value.sender.sent, [
    { channel: 'browser:event', payload: { sessionId: 'phi-current', event } }
  ])
  value.sender.throwOnSend = true
  assert.doesNotThrow(() => workspace?.emit(event))
})

test('agent execution resolves trusted origin and ignores forged identities', async () => {
  const value = harness()
  value.origins.set('runtime-origin', {
    sessionId: 'phi-agent',
    owner: {
      kind: 'project',
      location: { kind: 'local', path: '/display/project', realPath: '/real/project' }
    }
  })
  await value.coordinator.executeAgent({
    originSessionId: 'runtime-origin',
    runId: 'run-1',
    toolCallId: 'tool-1',
    sessionId: 'phi-forged',
    actor: { kind: 'human' },
    command: {
      type: 'open',
      requestId: 'request-1',
      url: 'https://example.test',
      sessionId: 'phi-forged'
    }
  })

  assert.deepEqual(value.registry.workspaces.get('phi-agent')?.executeCalls, [
    {
      actor: {
        kind: 'agent',
        sessionId: 'phi-agent',
        runId: 'run-1',
        toolCallId: 'tool-1'
      },
      command: { type: 'open', requestId: 'request-1', url: 'https://example.test' }
    }
  ])
  await assert.rejects(
    value.coordinator.executeAgent({
      originSessionId: 'unknown-origin',
      runId: 'run-1',
      toolCallId: 'tool-1',
      command: { type: 'open', requestId: 'request-2', url: 'https://example.test' }
    }),
    /Browser session is unavailable/
  )
})

test('session disposal delegates to the active registry', async () => {
  const value = harness()
  await value.coordinator.disposeSession('phi-current')
  assert.deepEqual(value.registry.disposedSessions, ['phi-current'])
})

test('workspace viewport seam copies input and rejects tabs without a materialized engine page', async () => {
  const engine = new InMemoryBrowserEngine()
  const workspace = new BrowserWorkspace({
    sessionId: 'phi-current',
    partition: 'partition-a',
    engine
  })
  const opened = await workspace.execute({ kind: 'human' }, { type: 'newTab', requestId: 'open-1' })
  assert.equal(opened.ok, true)
  const tabId = opened.snapshot.activeTabId
  assert.ok(tabId)
  const viewport = { x: 1, y: 2, width: 300, height: 200 }
  const applied = workspace.setViewport(tabId, viewport)
  viewport.width = 999
  await applied
  assert.deepEqual(engine.viewportFor('engine-tab-1' as EngineTabHandle), {
    x: 1,
    y: 2,
    width: 300,
    height: 200
  })

  const checkpointStore: BrowserCheckpointStore = {
    load: (): BrowserCheckpoint => ({
      schemaVersion: 1,
      tabs: [{ id: 'restored-tab', title: 'Restored', url: 'https://example.test' }],
      activeTabId: 'restored-tab'
    }),
    save: () => undefined,
    remove: () => undefined
  }
  const restoredWorkspace = new BrowserWorkspace({
    sessionId: 'phi-restored',
    partition: 'partition-b',
    engine: new InMemoryBrowserEngine(),
    checkpointStore
  })
  await assert.rejects(
    restoredWorkspace.setViewport('restored-tab', { x: 0, y: 0, width: 100, height: 100 }),
    /Browser tab is not available for presentation/
  )
})

test('workspace viewport seam serializes close and fails safely across disposal races', async () => {
  const closeEngine = new BlockingViewportEngine()
  const closeWorkspace = new BrowserWorkspace({
    sessionId: 'phi-close',
    partition: 'partition-close',
    engine: closeEngine
  })
  const opened = await closeWorkspace.execute(
    { kind: 'human' },
    { type: 'newTab', requestId: 'open-close' }
  )
  const tabId = opened.snapshot.activeTabId
  assert.ok(tabId)
  const viewportPending = closeWorkspace.setViewport(tabId, {
    x: 0,
    y: 0,
    width: 100,
    height: 100
  })
  await closeEngine.entered.promise
  const closePending = closeWorkspace.execute(
    { kind: 'human' },
    { type: 'close', requestId: 'close-1', tabId }
  )
  assert.equal(closeEngine.hasTab('engine-tab-1' as EngineTabHandle), true)
  closeEngine.release.resolve()
  await viewportPending
  assert.equal((await closePending).ok, true)
  assert.equal(closeEngine.hasTab('engine-tab-1' as EngineTabHandle), false)

  const disposeEngine = new BlockingViewportEngine()
  const disposeWorkspace = new BrowserWorkspace({
    sessionId: 'phi-dispose',
    partition: 'partition-dispose',
    engine: disposeEngine
  })
  const disposeOpened = await disposeWorkspace.execute(
    { kind: 'human' },
    { type: 'newTab', requestId: 'open-dispose' }
  )
  const disposeTabId = disposeOpened.snapshot.activeTabId
  assert.ok(disposeTabId)
  const disposedViewport = disposeWorkspace.setViewport(disposeTabId, {
    x: 0,
    y: 0,
    width: 100,
    height: 100
  })
  await disposeEngine.entered.promise
  const disposal = disposeWorkspace.dispose()
  disposeEngine.release.resolve()
  await assert.rejects(disposedViewport, /Browser viewport could not be applied/)
  await disposal
})
