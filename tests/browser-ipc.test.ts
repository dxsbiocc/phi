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
  routeBrowserAppShellWindowOpen,
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
import type {
  EngineCommand,
  EngineResult,
  EngineTabHandle
} from '../src/main/browser/browser-engine'
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

class BlockingNavigationEngine extends InMemoryBrowserEngine {
  readonly navigationEntered = deferred()
  readonly releaseNavigation = deferred()
  readonly viewportCalls: Array<BrowserViewport | null> = []

  override async execute(
    handle: EngineTabHandle,
    command: EngineCommand,
    signal?: AbortSignal
  ): Promise<EngineResult> {
    if (command.type === 'navigate') {
      this.navigationEntered.resolve()
      await this.releaseNavigation.promise
    }
    return super.execute(handle, command, signal)
  }

  override async setViewport(
    handle: EngineTabHandle,
    viewport: BrowserViewport | null
  ): Promise<void> {
    this.viewportCalls.push(viewport ? { ...viewport } : null)
    await super.setViewport(handle, viewport)
  }
}

class SequencedPresentationEngine extends InMemoryBrowserEngine {
  readonly firstShowEntered = deferred()
  readonly releaseFirstShow = deferred()
  readonly viewportCalls: Array<BrowserViewport | null> = []
  #blockedFirstShow = false

  override async setViewport(
    handle: EngineTabHandle,
    viewport: BrowserViewport | null
  ): Promise<void> {
    this.viewportCalls.push(viewport ? { ...viewport } : null)
    if (viewport && !this.#blockedFirstShow) {
      this.#blockedFirstShow = true
      this.firstShowEntered.resolve()
      await this.releaseFirstShow.promise
    }
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
  readonly executeCalls: Array<{
    actor: BrowserActor
    command: BrowserCommand
    signal?: AbortSignal
  }> = []
  readonly viewportCalls: Array<{ tabId: string; viewport: BrowserViewport | null }> = []
  readonly listeners = new Set<(event: BrowserWorkspaceEvent) => void>()
  subscribeCalls = 0
  executeOutcome: BrowserOutcome | null = null

  constructor(readonly sessionId: string) {}

  async execute(
    actor: BrowserActor,
    command: BrowserCommand,
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    this.executeCalls.push({ actor, command, ...(signal ? { signal } : {}) })
    return this.executeOutcome ?? { ok: true, snapshot: snapshot(this.sessionId) }
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
    sessionGeneration: 1,
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

test('app-shell routing always denies native windows and contains synchronous external failures', async () => {
  const value = harness()
  assert.doesNotThrow(() =>
    routeBrowserAppShellWindowOpen({
      details: {
        url: 'https://external.example/path',
        disposition: 'background-tab'
      },
      coordinator: value.coordinator,
      openExternal: () => {
        throw new Error('raw synchronous shell failure')
      }
    })
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(value.registry.registrations.length, 0)
  assert.deepEqual(value.sender.sent.at(-1), {
    channel: 'browser:event',
    payload: {
      sessionId: null,
      event: { type: 'appShellOpenFailed', reason: 'browserUnavailable' }
    }
  })

  assert.deepEqual(
    routeBrowserAppShellWindowOpen({
      details: { url: 'https://PHI.INTERNAL.:443/private', disposition: 'default' },
      coordinator: value.coordinator,
      policyContext: { applicationOrigins: ['https://phi.internal'] },
      openExternal: async () => undefined
    }),
    { action: 'deny' }
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(value.registry.registrations.length, 0)
})

test('app-shell routing requests the matching panel and reports no-session failures without shell fallback', async () => {
  const value = harness()
  assert.deepEqual(
    routeBrowserAppShellWindowOpen({
      details: { url: 'https://in-app.example/path', disposition: 'default' },
      coordinator: value.coordinator,
      openExternal: async () => assert.fail('successful in-app routing must not open externally')
    }),
    { action: 'deny' }
  )
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(value.sender.sent, [
    {
      channel: 'browser:event',
      payload: {
        sessionId: 'phi-current',
        event: { type: 'panelRequested', reason: 'appShellOpen', revision: 0 }
      }
    }
  ])

  const fallbackUrls: string[] = []
  value.setHumanSession(undefined)
  routeBrowserAppShellWindowOpen({
    details: { url: 'https://fallback.example/path', disposition: 'default' },
    coordinator: value.coordinator,
    openExternal: async (url) => {
      fallbackUrls.push(url)
    }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fallbackUrls, [])
  assert.deepEqual(value.sender.sent.at(-1), {
    channel: 'browser:event',
    payload: {
      sessionId: null,
      event: { type: 'appShellOpenFailed', reason: 'browserUnavailable' }
    }
  })
})

test('app-shell routing reports workspace failures without opening the system browser', async () => {
  const value = harness()
  await invoke(value, 'browser:snapshot')
  const workspace = value.registry.workspaces.get('phi-current')
  assert.ok(workspace)
  workspace.executeOutcome = {
    ok: false,
    error: { code: 'ENGINE_UNAVAILABLE', message: 'safe failure', retryable: true },
    snapshot: snapshot('phi-current')
  }
  const openedExternal: string[] = []
  routeBrowserAppShellWindowOpen({
    details: { url: 'https://failed.example/path', disposition: 'new-window' },
    coordinator: value.coordinator,
    openExternal: async (url) => {
      openedExternal.push(url)
    }
  })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(openedExternal, [])
  assert.deepEqual(value.sender.sent.at(-1), {
    channel: 'browser:event',
    payload: {
      sessionId: null,
      event: { type: 'appShellOpenFailed', reason: 'browserUnavailable' }
    }
  })
})

test('app-shell routing rejects oversized URLs before in-app or external dispatch', async () => {
  const value = harness()
  const openedExternal: string[] = []
  const url = `https://example.test/${'x'.repeat(16 * 1024)}`
  for (const disposition of ['default', 'background-tab']) {
    assert.deepEqual(
      routeBrowserAppShellWindowOpen({
        details: { url, disposition },
        coordinator: value.coordinator,
        openExternal: async (target) => {
          openedExternal.push(target)
        }
      }),
      { action: 'deny' }
    )
  }
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(openedExternal, [])
  assert.equal(value.registry.registrations.length, 0)
})

test('runtime parser accepts every command shape and copies only bounded whitelist fields', async () => {
  const value = harness()
  const inputs: unknown[] = [
    { type: 'newTab', requestId: '1', url: 'https://example.test', extra: true },
    {
      type: 'openExternal',
      requestId: 'external',
      tabId: 'tab-1',
      expectedDocumentRevision: 2
    },
    { type: 'activate', requestId: '2', tabId: 'tab-1' },
    { type: 'close', requestId: '3', tabId: 'tab-1' },
    {
      type: 'navigate',
      requestId: '4',
      tabId: 'tab-1',
      url: 'https://example.test/next',
      expectedDocumentRevision: 2,
      requireActive: true
    },
    { type: 'history', requestId: '5', tabId: 'tab-1', direction: 'back' },
    { type: 'reload', requestId: '6', tabId: 'tab-1' },
    { type: 'stop', requestId: '7', tabId: 'tab-1' },
    {
      type: 'snapshot',
      requestId: '8',
      tabId: 'tab-1',
      expectedDocumentRevision: 3,
      requireActive: true
    },
    { type: 'restore', requestId: '9', tabId: 'tab-1' },
    {
      type: 'click',
      requestId: '10',
      tabId: 'tab-1',
      x: 1.5,
      y: 2,
      expectedDocumentRevision: 3,
      consequence: 'read',
      requireActive: true
    },
    {
      type: 'typeText',
      requestId: '11',
      tabId: 'tab-1',
      text: 'hello',
      expectedDocumentRevision: 3,
      consequence: 'write',
      requireActive: true
    },
    {
      type: 'keypress',
      requestId: '12',
      tabId: 'tab-1',
      key: 'Tab',
      expectedDocumentRevision: 3,
      requireActive: true
    },
    {
      type: 'scroll',
      requestId: '13',
      tabId: 'tab-1',
      deltaX: 0,
      deltaY: 120,
      expectedDocumentRevision: 3,
      requireActive: true
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
  assert.deepEqual(calls[1].command, {
    type: 'openExternal',
    requestId: 'external',
    tabId: 'tab-1',
    expectedDocumentRevision: 2
  })
  assert.deepEqual(calls[4].command, {
    type: 'navigate',
    requestId: '4',
    tabId: 'tab-1',
    url: 'https://example.test/next',
    expectedDocumentRevision: 2,
    requireActive: true
  })
  assert.deepEqual(calls[8].command, {
    type: 'snapshot',
    requestId: '8',
    tabId: 'tab-1',
    expectedDocumentRevision: 3,
    requireActive: true
  })
  assert.deepEqual(calls[11].command, {
    type: 'typeText',
    requestId: '11',
    tabId: 'tab-1',
    text: 'hello',
    expectedDocumentRevision: 3,
    consequence: 'write',
    requireActive: true
  })
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
    {
      type: 'navigate',
      requestId: '1',
      tabId: 'tab',
      url: 'https://x',
      expectedDocumentRevision: 1,
      requireActive: false
    },
    {
      type: 'snapshot',
      requestId: '1',
      tabId: 'tab',
      expectedDocumentRevision: 1,
      requireActive: false
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
      type: 'click',
      requestId: '1',
      tabId: 'tab',
      x: -1,
      y: 2,
      expectedDocumentRevision: 1,
      consequence: 'read',
      requireActive: true
    },
    {
      type: 'typeText',
      requestId: '1',
      tabId: 'tab',
      text: 'private',
      expectedDocumentRevision: 1,
      consequence: 'write',
      requireActive: true,
      selector: '#secret'
    },
    {
      type: 'typeText',
      requestId: '1',
      tabId: 'tab',
      text: '',
      expectedDocumentRevision: 1,
      consequence: 'write',
      requireActive: true
    },
    {
      type: 'typeText',
      requestId: '1',
      tabId: 'tab',
      text: 'x'.repeat(16_385),
      expectedDocumentRevision: 1,
      consequence: 'write',
      requireActive: true
    },
    {
      type: 'typeText',
      requestId: '1',
      tabId: 'tab',
      text: 'private',
      expectedDocumentRevision: 1,
      consequence: 'read',
      requireActive: true
    },
    {
      type: 'typeText',
      requestId: '1',
      tabId: 'tab',
      text: 'private',
      expectedDocumentRevision: 1,
      consequence: 'write',
      requireActive: false
    },
    {
      type: 'keypress',
      requestId: '1',
      tabId: 'tab',
      key: 'x'.repeat(65),
      expectedDocumentRevision: 1
    },
    {
      type: 'keypress',
      requestId: '1',
      tabId: 'tab',
      key: 'Enter',
      expectedDocumentRevision: 1,
      requireActive: true
    },
    {
      type: 'keypress',
      requestId: '1',
      tabId: 'tab',
      key: 'Tab',
      modifiers: ['control'],
      expectedDocumentRevision: 1,
      requireActive: true
    },
    {
      type: 'scroll',
      requestId: '1',
      tabId: 'tab',
      deltaX: 0,
      deltaY: Number.POSITIVE_INFINITY,
      expectedDocumentRevision: 1
    },
    {
      type: 'scroll',
      requestId: '1',
      tabId: 'tab',
      deltaX: 0,
      deltaY: 0,
      expectedDocumentRevision: 1,
      requireActive: true
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
  await invoke(value, 'browser:setViewport', {
    sessionId: 'phi-current',
    sessionGeneration: 1,
    tabId: 'tab-1',
    viewport: source
  })
  source.width = 999
  await invoke(value, 'browser:setViewport', {
    sessionId: 'phi-current',
    sessionGeneration: 1,
    tabId: 'tab-1',
    viewport: null
  })
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
      invoke(value, 'browser:setViewport', {
        sessionId: 'phi-current',
        sessionGeneration: 1,
        tabId: 'tab-1',
        viewport
      }),
      /Invalid browser request/
    )
  }
  assert.equal(value.registry.workspaces.get('phi-current')?.viewportCalls.length, 2)
})

test('viewport IPC rejects stale session generations before same-tab routing', async () => {
  const value = harness()
  value.setHumanSession({
    sessionId: 'phi-a',
    sessionGeneration: 1,
    owner: { kind: 'ordinary' }
  })
  await invoke(value, 'browser:setViewport', {
    sessionId: 'phi-a',
    sessionGeneration: 1,
    tabId: 'shared-tab',
    viewport: { x: 0, y: 0, width: 100, height: 100 }
  })
  value.setHumanSession({
    sessionId: 'phi-b',
    sessionGeneration: 2,
    owner: { kind: 'ordinary' }
  })
  await assert.rejects(
    invoke(value, 'browser:setViewport', {
      sessionId: 'phi-a',
      sessionGeneration: 1,
      tabId: 'shared-tab',
      viewport: null
    }),
    /Browser session is unavailable/
  )
  value.setHumanSession({
    sessionId: 'phi-a',
    sessionGeneration: 3,
    owner: { kind: 'ordinary' }
  })
  await assert.rejects(
    invoke(value, 'browser:setViewport', {
      sessionId: 'phi-a',
      sessionGeneration: 1,
      tabId: 'shared-tab',
      viewport: null
    }),
    /Browser session is unavailable/
  )
  assert.deepEqual(value.registry.workspaces.get('phi-a')?.viewportCalls, [
    {
      tabId: 'shared-tab',
      viewport: { x: 0, y: 0, width: 100, height: 100 }
    }
  ])
  assert.equal(value.registry.workspaces.has('phi-b'), false)
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
  const controller = new AbortController()
  await value.coordinator.executeAgent(
    {
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
    },
    controller.signal
  )

  assert.deepEqual(value.registry.workspaces.get('phi-agent')?.executeCalls, [
    {
      actor: {
        kind: 'agent',
        sessionId: 'phi-agent',
        runId: 'run-1',
        toolCallId: 'tool-1'
      },
      command: { type: 'open', requestId: 'request-1', url: 'https://example.test' },
      signal: controller.signal
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
  assert.equal((await closePending).ok, true)
  assert.equal(closeEngine.hasTab('engine-tab-1' as EngineTabHandle), false)
  closeEngine.release.resolve()
  await assert.rejects(viewportPending, /Browser viewport could not be applied|superseded/)

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

test('workspace presentation runs independently from a blocked browser command', async () => {
  const engine = new BlockingNavigationEngine()
  const workspace = new BrowserWorkspace({
    sessionId: 'phi-preempt',
    partition: 'partition-preempt',
    engine
  })
  const opened = await workspace.execute(
    { kind: 'human' },
    { type: 'newTab', requestId: 'preempt-open' }
  )
  const tabId = opened.snapshot.activeTabId
  assert.ok(tabId)

  const navigating = workspace.execute(
    { kind: 'human' },
    {
      type: 'navigate',
      requestId: 'preempt-navigate',
      tabId,
      url: 'https://slow.test'
    }
  )
  await engine.navigationEntered.promise

  await workspace.setViewport(tabId, null)
  assert.deepEqual(engine.viewportCalls, [null])
  await workspace.setViewport(tabId, { x: 5, y: 6, width: 120, height: 80 })
  assert.deepEqual(engine.viewportCalls, [null, { x: 5, y: 6, width: 120, height: 80 }])

  engine.releaseNavigation.resolve()
  await navigating
})

test('presentation tickets order in-flight hide and skip superseded queued visibility', async () => {
  const engine = new SequencedPresentationEngine()
  const workspace = new BrowserWorkspace({
    sessionId: 'phi-presentation',
    partition: 'partition-presentation',
    engine
  })
  const opened = await workspace.execute(
    { kind: 'human' },
    { type: 'newTab', requestId: 'presentation-open' }
  )
  const tabId = opened.snapshot.activeTabId
  assert.ok(tabId)

  const inFlightShow = workspace.setViewport(tabId, { x: 0, y: 0, width: 100, height: 100 })
  await engine.firstShowEntered.promise
  const queuedShow = workspace.setViewport(tabId, { x: 1, y: 2, width: 90, height: 80 })
  const hide = workspace.setViewport(tabId, null)
  assert.deepEqual(engine.viewportCalls, [{ x: 0, y: 0, width: 100, height: 100 }])
  engine.releaseFirstShow.resolve()
  await assert.rejects(inFlightShow, /superseded/)
  await queuedShow
  await hide
  assert.deepEqual(engine.viewportCalls, [{ x: 0, y: 0, width: 100, height: 100 }, null])

  const supersededHide = workspace.setViewport(tabId, null)
  const latestShow = workspace.setViewport(tabId, { x: 5, y: 6, width: 120, height: 80 })
  await assert.rejects(supersededHide, /superseded/)
  await latestShow
  assert.deepEqual(engine.viewportCalls.slice(-2), [null, { x: 5, y: 6, width: 120, height: 80 }])
})

test('workspace presentation suspension hides and resumes the same owned tab without disposal', async () => {
  const engine = new InMemoryBrowserEngine()
  const workspace = new BrowserWorkspace({
    sessionId: 'phi-suspend',
    partition: 'partition-suspend',
    engine
  })
  const actor: BrowserActor = {
    kind: 'agent',
    sessionId: 'phi-suspend',
    runId: 'run-suspend',
    toolCallId: 'tool-open'
  }
  const opened = await workspace.execute(actor, {
    type: 'open',
    requestId: 'suspend-open',
    url: 'https://example.test'
  })
  assert.equal(opened.ok, true)
  const tabId = opened.snapshot.activeTabId
  assert.ok(tabId)
  const viewport = { x: 4, y: 5, width: 300, height: 180 }
  await workspace.setViewport(tabId, viewport)

  await workspace.suspendPresentation()
  assert.equal(engine.viewportFor('engine-tab-1' as EngineTabHandle), null)
  assert.equal(workspace.snapshot().tabs[0].isAgentControlled, true)
  const backgroundSnapshot = await workspace.execute(
    { ...actor, toolCallId: 'tool-snapshot' },
    { type: 'snapshot', requestId: 'suspend-snapshot', tabId }
  )
  assert.equal(backgroundSnapshot.ok, true)

  await workspace.resumePresentation()
  assert.equal(engine.viewportFor('engine-tab-1' as EngineTabHandle), null)
  await workspace.setViewport(tabId, viewport)
  assert.deepEqual(engine.viewportFor('engine-tab-1' as EngineTabHandle), viewport)
  assert.equal(engine.hasTab('engine-tab-1' as EngineTabHandle), true)
  assert.equal(workspace.snapshot().tabs[0].isAgentControlled, true)
})

test('suspension supersedes an in-flight show and resumes its latest desired viewport', async () => {
  const engine = new SequencedPresentationEngine()
  const workspace = new BrowserWorkspace({
    sessionId: 'phi-suspend-race',
    partition: 'partition-suspend-race',
    engine
  })
  const opened = await workspace.execute(
    { kind: 'human' },
    { type: 'newTab', requestId: 'suspend-race-open' }
  )
  const tabId = opened.snapshot.activeTabId
  assert.ok(tabId)
  const viewport = { x: 7, y: 8, width: 240, height: 160 }
  const showing = workspace.setViewport(tabId, viewport)
  await engine.firstShowEntered.promise
  const suspending = workspace.suspendPresentation()
  engine.releaseFirstShow.resolve()
  await assert.rejects(showing, /superseded/)
  await suspending
  assert.equal(engine.viewportFor('engine-tab-1' as EngineTabHandle), null)
  await workspace.resumePresentation()
  assert.equal(engine.viewportFor('engine-tab-1' as EngineTabHandle), null)
  await workspace.setViewport(tabId, viewport)
  assert.deepEqual(engine.viewportFor('engine-tab-1' as EngineTabHandle), viewport)
})
