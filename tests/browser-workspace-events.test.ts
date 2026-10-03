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

test('routes engine events only to their owning tab', async () => {
  const { engine, workspace } = createBrowserWorkspaceHarness()
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'first.test' })
  await workspace.execute(human, { type: 'open', requestId: 'open-2', url: 'second.test' })
  const secondBefore = workspace.snapshot().tabs[1]

  engine.emitTitle('engine-tab-1' as EngineTabHandle, 'First title')
  engine.emitLoading('engine-tab-1' as EngineTabHandle, true)

  const snapshot = workspace.snapshot()
  assert.equal(snapshot.tabs[0].title, 'First title')
  assert.equal(snapshot.tabs[0].phase, 'loading')
  assert.deepEqual(snapshot.tabs[1], secondBefore)
})

test('reduces loading, title, navigation, failure, and crash engine events', async () => {
  const { engine, workspace, engineHandle } = createBrowserWorkspaceHarness()
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })

  engine.emitLoading(engineHandle, true)
  assert.equal(workspace.snapshot().tabs[0].phase, 'loading')
  engine.emitTitle(engineHandle, 'Example title')
  assert.equal(workspace.snapshot().tabs[0].title, 'Example title')

  await engine.execute(engineHandle, { type: 'navigate', url: 'https://event.test/' })
  const navigated = workspace.snapshot().tabs[0]
  assert.equal(navigated.url, 'https://event.test/')
  assert.equal(navigated.phase, 'ready')

  engine.emitLoadFailure(engineHandle, {
    url: 'https://event.test/',
    errorCode: 'ERR_FAILED',
    message: 'raw engine detail'
  })
  const failed = workspace.snapshot().tabs[0]
  assert.equal(failed.phase, 'failed')
  assert.equal(failed.error?.code, 'NAVIGATION_FAILED')
  assert.equal(failed.error?.message, 'Page failed to load')

  engine.emitCrash(engineHandle, 'killed')
  const crashed = workspace.snapshot().tabs[0]
  assert.equal(crashed.phase, 'crashed')
  assert.equal(crashed.error?.code, 'RENDERER_CRASHED')
})

test('keeps workspace and document revisions monotonic', async () => {
  const { engine, workspace, engineHandle } = createBrowserWorkspaceHarness()
  const revisions: number[] = []
  workspace.subscribe((event) => {
    if (event.type === 'snapshotChanged') revisions.push(event.snapshot.revision)
  })
  const opened = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-1',
    url: 'first.test'
  })
  successful(opened)
  const firstDocumentRevision = opened.snapshot.tabs[0].documentRevision
  await engine.execute(engineHandle, { type: 'navigate', url: 'https://second.test/' })
  engine.emitTitle(engineHandle, 'Second')

  assert.equal(
    revisions.every((revision, index) => index === 0 || revision > revisions[index - 1]),
    true
  )
  assert.equal(workspace.snapshot().tabs[0].documentRevision > firstDocumentRevision, true)
})

class CrashRecoveryEngine extends InMemoryBrowserEngine {
  createCalls = 0
  failRecoveryCreate = false
  failOldCleanup = false
  readonly disposedHandles: EngineTabHandle[] = []

  override async createTab(input: { partition: string }): Promise<EngineTabHandle> {
    this.createCalls += 1
    if (this.failRecoveryCreate && this.createCalls > 1) {
      throw new Error('raw recovery create secret')
    }
    return super.createTab(input)
  }

  override async disposeTab(handle: EngineTabHandle): Promise<void> {
    this.disposedHandles.push(handle)
    if (this.failOldCleanup && handle === ('engine-tab-1' as EngineTabHandle)) {
      throw new Error('raw old cleanup secret')
    }
    // Keep the old fixture state so a delayed event can be emitted after logical disposal.
    if (handle !== ('engine-tab-1' as EngineTabHandle)) await super.disposeTab(handle)
  }
}

function crashRecoveryWorkspace(engine: CrashRecoveryEngine): BrowserWorkspace {
  return new BrowserWorkspace({
    sessionId: 'session-recovery',
    partition: 'partition-recovery',
    engine,
    idFactory: () => 'phi-tab-stable',
    now: () => 42
  })
}

test('reload recovers a crashed tab on a fresh handle without replaying POST state', async () => {
  let engineId = 0
  const engine = new CrashRecoveryEngine({ idFactory: () => `engine-tab-${++engineId}` })
  const workspace = crashRecoveryWorkspace(engine)
  const opened = await workspace.execute(human, {
    type: 'open',
    requestId: 'recovery-open',
    url: 'https://recovery.test/page'
  })
  successful(opened)
  const beforeRevision = opened.snapshot.tabs[0].documentRevision
  engine.emitCrash('engine-tab-1' as EngineTabHandle, 'crashed')

  const recovered = await workspace.execute(human, {
    type: 'reload',
    requestId: 'recovery-reload',
    tabId: 'phi-tab-stable'
  })
  successful(recovered)
  assert.equal(recovered.snapshot.tabs[0].id, 'phi-tab-stable')
  assert.equal(recovered.snapshot.tabs[0].url, 'https://recovery.test/page')
  assert.equal(recovered.snapshot.tabs[0].phase, 'ready')
  assert.equal(recovered.snapshot.tabs[0].documentRevision > beforeRevision, true)
  assert.deepEqual(engine.disposedHandles, ['engine-tab-1'])
  assert.deepEqual(engine.recordedActions('engine-tab-2' as EngineTabHandle)[0]?.command, {
    type: 'navigate',
    url: 'https://recovery.test/page'
  })
  assert.doesNotMatch(
    JSON.stringify(engine.recordedActions('engine-tab-2' as EngineTabHandle)),
    /postBody|postData|uploadData/i
  )

  engine.emitTitle('engine-tab-1' as EngineTabHandle, 'Delayed old title', 99)
  assert.notEqual(workspace.snapshot().tabs[0].title, 'Delayed old title')
})

test('crash recovery preserves the crashed tab on create failure and contains cleanup failure', async () => {
  let createFailureId = 0
  const createFailureEngine = new CrashRecoveryEngine({
    idFactory: () => `engine-tab-${++createFailureId}`
  })
  const createFailureWorkspace = crashRecoveryWorkspace(createFailureEngine)
  await createFailureWorkspace.execute(human, {
    type: 'open',
    requestId: 'create-failure-open',
    url: 'https://recovery.test/'
  })
  createFailureEngine.emitCrash('engine-tab-1' as EngineTabHandle, 'crashed')
  createFailureEngine.failRecoveryCreate = true
  const createFailed = await createFailureWorkspace.execute(human, {
    type: 'reload',
    requestId: 'create-failure-reload',
    tabId: 'phi-tab-stable'
  })
  assert.equal(createFailed.ok, false)
  assert.equal(createFailed.snapshot.tabs[0].phase, 'crashed')
  assert.deepEqual(createFailureEngine.disposedHandles, [])
  assert.equal(JSON.stringify(createFailed).includes('raw recovery create secret'), false)

  let cleanupFailureId = 0
  const cleanupFailureEngine = new CrashRecoveryEngine({
    idFactory: () => `engine-tab-${++cleanupFailureId}`
  })
  const cleanupFailureWorkspace = crashRecoveryWorkspace(cleanupFailureEngine)
  await cleanupFailureWorkspace.execute(human, {
    type: 'open',
    requestId: 'cleanup-failure-open',
    url: 'https://recovery.test/'
  })
  cleanupFailureEngine.emitCrash('engine-tab-1' as EngineTabHandle, 'crashed')
  cleanupFailureEngine.failOldCleanup = true
  const cleanupFailed = await cleanupFailureWorkspace.execute(human, {
    type: 'reload',
    requestId: 'cleanup-failure-reload',
    tabId: 'phi-tab-stable'
  })
  assert.equal(cleanupFailed.ok, false)
  assert.equal(cleanupFailed.error.code, 'ENGINE_UNAVAILABLE')
  assert.equal(JSON.stringify(cleanupFailed).includes('raw old cleanup secret'), false)
  assert.deepEqual(cleanupFailureEngine.disposedHandles, ['engine-tab-1'])
  assert.equal(cleanupFailed.snapshot.tabs[0].documentRevision >= 2, true)
})

test('about blank crash recovery exposes a new document epoch before later navigation', async () => {
  let engineId = 0
  const engine = new CrashRecoveryEngine({ idFactory: () => `engine-tab-${++engineId}` })
  const workspace = crashRecoveryWorkspace(engine)
  await workspace.execute(human, { type: 'newTab', requestId: 'blank-open' })
  engine.emitCrash('engine-tab-1' as EngineTabHandle, 'crashed')

  const recovered = await workspace.execute(human, {
    type: 'reload',
    requestId: 'blank-reload',
    tabId: 'phi-tab-stable'
  })
  successful(recovered)
  assert.equal(recovered.snapshot.tabs[0].url, 'about:blank')
  assert.equal(recovered.snapshot.tabs[0].documentRevision, 1)

  const navigated = await workspace.execute(human, {
    type: 'navigate',
    requestId: 'blank-navigate',
    tabId: 'phi-tab-stable',
    url: 'https://after-blank.test/'
  })
  successful(navigated)
  assert.equal(navigated.snapshot.tabs[0].documentRevision, 2)
})

test('keeps event-reduced page state when execute returns an equal stale revision', async () => {
  class EventAheadEngine extends InMemoryBrowserEngine {
    returnStaleResult = false
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      if (!this.returnStaleResult || command.type !== 'navigate') {
        return super.execute(handle, command, signal)
      }
      const authoritative = await super.execute(
        handle,
        { type: 'navigate', url: 'https://authoritative.test/page' },
        signal
      )
      this.emitTitle(handle, 'Authoritative title')
      if (!authoritative.ok) return authoritative
      return {
        ok: true,
        state: {
          ...authoritative.state,
          url: 'https://stale-result.test/',
          title: 'Stale result title',
          canGoBack: false,
          canGoForward: true
        }
      }
    }
  }
  const engine = new EventAheadEngine({
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
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'first.test' })
  engine.returnStaleResult = true
  await workspace.execute(human, {
    type: 'navigate',
    requestId: 'navigate-1',
    tabId: 'phi-tab-1',
    url: 'requested.test'
  })
  const tab = workspace.snapshot().tabs[0]
  assert.equal(tab.url, 'https://authoritative.test/page')
  assert.equal(tab.origin, 'https://authoritative.test')
  assert.equal(tab.title, 'Authoritative title')
  assert.equal(tab.canGoBack, true)
  assert.equal(tab.canGoForward, false)
})

test('accepts a newer document result for the current loading navigation', async () => {
  class ResultOnlyCommitEngine extends InMemoryBrowserEngine {
    returnResultOnlyCommit = false
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      if (!this.returnResultOnlyCommit || command.type !== 'navigate') {
        return super.execute(handle, command, signal)
      }
      this.emitLoading(handle, true, 2)
      return {
        ok: true,
        state: {
          url: 'https://result-only.test/page',
          title: 'Result-only title',
          isLoading: false,
          canGoBack: true,
          canGoForward: false,
          documentRevision: 2,
          navigationRevision: 2
        }
      }
    }
  }
  const engine = new ResultOnlyCommitEngine({
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
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'first.test' })
  engine.returnResultOnlyCommit = true
  const outcome = await workspace.execute(human, {
    type: 'navigate',
    requestId: 'navigate-1',
    tabId: 'phi-tab-1',
    url: 'requested.test'
  })
  successful(outcome)
  assert.equal(outcome.snapshot.tabs[0].url, 'https://result-only.test/page')
  assert.equal(outcome.snapshot.tabs[0].documentRevision, 2)
  assert.equal(outcome.snapshot.tabs[0].phase, 'ready')
})

test('ignores a duplicate commit with the same navigation and document pair', async () => {
  const { engine, workspace, engineHandle } = createBrowserWorkspaceHarness()
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'first.test' })
  await workspace.execute(human, {
    type: 'navigate',
    requestId: 'navigate-1',
    tabId: 'phi-tab-1',
    url: 'second.test'
  })
  const current = workspace.snapshot()
  engine.emitNavigationCommitted(engineHandle, {
    url: 'https://duplicate-should-not-win.test/',
    documentRevision: 2,
    navigationRevision: 2,
    canGoBack: false,
    canGoForward: true
  })
  assert.deepEqual(workspace.snapshot(), current)
})

test('ignores delayed title, failure, and loading events from an older navigation', async () => {
  const { engine, workspace, engineHandle } = createBrowserWorkspaceHarness()
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'first.test' })
  await workspace.execute(human, {
    type: 'navigate',
    requestId: 'navigate-1',
    tabId: 'phi-tab-1',
    url: 'second.test'
  })
  engine.emitTitle(engineHandle, 'Current title', 2)
  const current = workspace.snapshot()
  engine.emitTitle(engineHandle, 'Delayed old title', 1)
  engine.emitLoadFailure(engineHandle, {
    url: 'https://first.test/',
    errorCode: 'ERR_FAILED',
    message: 'delayed old failure',
    navigationRevision: 1
  })
  engine.emitLoading(engineHandle, false, 1)

  assert.deepEqual(workspace.snapshot(), current)
  assert.equal(workspace.snapshot().tabs[0].url, 'https://second.test/')
  assert.equal(workspace.snapshot().tabs[0].title, 'Current title')
  assert.equal(workspace.snapshot().tabs[0].phase, 'ready')
})
