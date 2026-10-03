import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  BrowserCheckpoint,
  BrowserCheckpointStore
} from '../src/main/browser/browser-checkpoints'
import { InMemoryBrowserEngine } from '../src/main/browser/in-memory-browser-engine'
import { BrowserWorkspace } from '../src/main/browser/browser-workspace'
import type { BrowserActor } from '../src/shared/browserTypes'
import type {
  EngineCommand,
  EngineResult,
  EngineTabHandle
} from '../src/main/browser/browser-engine'
import { createBrowserWorkspaceHarness, human, successful } from './helpers/browserWorkspaceHarness'

const agent = (runId: string, toolCallId: string): BrowserActor => ({
  kind: 'agent' as const,
  sessionId: 'session-1',
  runId,
  toolCallId
})

test('an agent run owns its dedicated tabs across background use and other runs are denied', async () => {
  const { workspace } = createBrowserWorkspaceHarness()
  const opened = await workspace.execute(agent('run-1', 'open-tool'), {
    type: 'open',
    requestId: 'agent-open',
    url: 'https://owned.test'
  })
  successful(opened)
  const ownedTabId = opened.snapshot.activeTabId
  assert.ok(ownedTabId)

  await workspace.execute(human, {
    type: 'open',
    requestId: 'human-open',
    url: 'https://human.test'
  })
  assert.notEqual(workspace.snapshot().activeTabId, ownedTabId)

  const sameRunNavigate = await workspace.execute(agent('run-1', 'navigate-tool'), {
    type: 'navigate',
    requestId: 'same-run-navigate',
    tabId: ownedTabId,
    url: 'https://owned.test/background'
  })
  successful(sameRunNavigate)
  const sameRunSnapshot = await workspace.execute(agent('run-1', 'snapshot-tool'), {
    type: 'snapshot',
    requestId: 'same-run-snapshot',
    tabId: ownedTabId
  })
  successful(sameRunSnapshot)

  for (const outcome of [
    await workspace.execute(agent('run-2', 'navigate-tool'), {
      type: 'navigate',
      requestId: 'cross-run-navigate',
      tabId: ownedTabId,
      url: 'https://forbidden.test'
    }),
    await workspace.execute(agent('run-2', 'snapshot-tool'), {
      type: 'snapshot',
      requestId: 'cross-run-snapshot',
      tabId: ownedTabId
    })
  ]) {
    assert.equal(outcome.ok, false)
    if (!outcome.ok) assert.equal(outcome.error.code, 'PERMISSION_DENIED')
  }
})

test('claiming a human tab requires current target and an atomic active revision match', async () => {
  const { workspace } = createBrowserWorkspaceHarness()
  const first = await workspace.execute(human, {
    type: 'open',
    requestId: 'human-first',
    url: 'https://first.test'
  })
  successful(first)
  const firstTabId = first.snapshot.activeTabId
  const firstRevision = first.snapshot.tabs[0].documentRevision
  assert.ok(firstTabId)
  await workspace.execute(human, {
    type: 'open',
    requestId: 'human-second',
    url: 'https://second.test'
  })

  const inactive = await workspace.execute(agent('run-1', 'claim-inactive'), {
    type: 'navigate',
    requestId: 'claim-inactive',
    tabId: firstTabId,
    url: 'https://must-not-open.test',
    expectedDocumentRevision: firstRevision,
    requireActive: true
  })
  assert.equal(inactive.ok, false)
  if (!inactive.ok) assert.equal(inactive.error.code, 'PERMISSION_DENIED')

  await workspace.execute(human, {
    type: 'activate',
    requestId: 'reactivate-first',
    tabId: firstTabId
  })
  const stale = await workspace.execute(agent('run-1', 'claim-stale'), {
    type: 'navigate',
    requestId: 'claim-stale',
    tabId: firstTabId,
    url: 'https://must-not-open.test',
    expectedDocumentRevision: firstRevision + 1,
    requireActive: true
  })
  assert.equal(stale.ok, false)
  if (!stale.ok) assert.equal(stale.error.code, 'STALE_DOCUMENT')

  const claimed = await workspace.execute(agent('run-1', 'claim-current'), {
    type: 'navigate',
    requestId: 'claim-current',
    tabId: firstTabId,
    url: 'https://claimed.test',
    expectedDocumentRevision: firstRevision,
    requireActive: true
  })
  successful(claimed)
  assert.equal(claimed.snapshot.tabs[0].isAgentControlled, true)

  await workspace.execute(human, {
    type: 'activate',
    requestId: 'switch-away',
    tabId: claimed.snapshot.tabs[1].id
  })
  const ownedInBackground = await workspace.execute(agent('run-1', 'owned-background'), {
    type: 'snapshot',
    requestId: 'owned-background',
    tabId: firstTabId
  })
  successful(ownedInBackground)
})

test('snapshot only claims an active human tab with explicit current revision binding', async () => {
  const { workspace } = createBrowserWorkspaceHarness()
  const opened = await workspace.execute(human, {
    type: 'open',
    requestId: 'human-open',
    url: 'https://human.test'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId
  const revision = opened.snapshot.tabs[0].documentRevision
  assert.ok(tabId)

  const implicit = await workspace.execute(agent('run-1', 'implicit-snapshot'), {
    type: 'snapshot',
    requestId: 'implicit-snapshot',
    tabId
  })
  assert.equal(implicit.ok, false)
  if (!implicit.ok) assert.equal(implicit.error.code, 'PERMISSION_DENIED')

  const explicit = await workspace.execute(agent('run-1', 'current-snapshot'), {
    type: 'snapshot',
    requestId: 'current-snapshot',
    tabId,
    expectedDocumentRevision: revision,
    requireActive: true
  })
  successful(explicit)
  assert.equal(explicit.screenshot?.documentRevision, revision)
  assert.equal(explicit.snapshot.tabs[0].isAgentControlled, true)
})

test('a later run can explicitly rebind an active owned tab but not an inactive one', async () => {
  const { workspace } = createBrowserWorkspaceHarness()
  const first = await workspace.execute(agent('run-1', 'open-first'), {
    type: 'open',
    requestId: 'open-first',
    url: 'https://owned.test'
  })
  successful(first)
  const ownedTabId = first.snapshot.activeTabId
  const ownedRevision = first.snapshot.tabs[0].documentRevision
  assert.ok(ownedTabId)
  const second = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-second',
    url: 'https://other.test'
  })
  successful(second)

  const inactive = await workspace.execute(agent('run-2', 'rebind-inactive'), {
    type: 'snapshot',
    requestId: 'rebind-inactive',
    tabId: ownedTabId,
    expectedDocumentRevision: ownedRevision,
    requireActive: true
  })
  assert.equal(inactive.ok, false)
  if (!inactive.ok) assert.equal(inactive.error.code, 'PERMISSION_DENIED')

  await workspace.execute(human, {
    type: 'activate',
    requestId: 'activate-owned',
    tabId: ownedTabId
  })
  const rebound = await workspace.execute(agent('run-2', 'rebind-current'), {
    type: 'snapshot',
    requestId: 'rebind-current',
    tabId: ownedTabId,
    expectedDocumentRevision: ownedRevision,
    requireActive: true
  })
  successful(rebound)

  const previousRun = await workspace.execute(agent('run-1', 'old-owner'), {
    type: 'snapshot',
    requestId: 'old-owner',
    tabId: ownedTabId
  })
  assert.equal(previousRun.ok, false)
  if (!previousRun.ok) assert.equal(previousRun.error.code, 'PERMISSION_DENIED')
  successful(
    await workspace.execute(agent('run-2', 'new-owner'), {
      type: 'snapshot',
      requestId: 'new-owner',
      tabId: ownedTabId
    })
  )
})

test('failed current navigation and screenshot do not claim a human tab', async () => {
  const navigation = createBrowserWorkspaceHarness()
  const opened = await navigation.workspace.execute(human, {
    type: 'open',
    requestId: 'open-human-navigation',
    url: 'https://human.test'
  })
  successful(opened)
  const navigationTabId = opened.snapshot.activeTabId
  const navigationRevision = opened.snapshot.tabs[0].documentRevision
  assert.ok(navigationTabId)

  const invalid = await navigation.workspace.execute(agent('run-1', 'invalid-current'), {
    type: 'navigate',
    requestId: 'invalid-current',
    tabId: navigationTabId,
    url: 'javascript:secret()',
    expectedDocumentRevision: navigationRevision,
    requireActive: true
  })
  assert.equal(invalid.ok, false)
  assert.equal(navigation.workspace.snapshot().tabs[0].isAgentControlled, false)
  const implicitAfterInvalid = await navigation.workspace.execute(
    agent('run-1', 'implicit-after-invalid'),
    { type: 'snapshot', requestId: 'implicit-after-invalid', tabId: navigationTabId }
  )
  assert.equal(implicitAfterInvalid.ok, false)
  if (!implicitAfterInvalid.ok) {
    assert.equal(implicitAfterInvalid.error.code, 'PERMISSION_DENIED')
  }

  const screenshot = createBrowserWorkspaceHarness()
  const screenshotOpened = await screenshot.workspace.execute(human, {
    type: 'open',
    requestId: 'open-human-screenshot',
    url: 'https://human.test'
  })
  successful(screenshotOpened)
  const screenshotTabId = screenshotOpened.snapshot.activeTabId
  const screenshotRevision = screenshotOpened.snapshot.tabs[0].documentRevision
  assert.ok(screenshotTabId)
  screenshot.engine.emitCrash(screenshot.engineHandle, 'renderer-gone')

  const failedCapture = await screenshot.workspace.execute(agent('run-1', 'failed-current'), {
    type: 'snapshot',
    requestId: 'failed-current',
    tabId: screenshotTabId,
    expectedDocumentRevision: screenshotRevision,
    requireActive: true
  })
  assert.equal(failedCapture.ok, false)
  assert.equal(screenshot.workspace.snapshot().tabs[0].isAgentControlled, false)
  const implicitAfterFailure = await screenshot.workspace.execute(
    agent('run-1', 'implicit-after-failure'),
    { type: 'snapshot', requestId: 'implicit-after-failure', tabId: screenshotTabId }
  )
  assert.equal(implicitAfterFailure.ok, false)
  if (!implicitAfterFailure.ok) {
    assert.equal(implicitAfterFailure.error.code, 'PERMISSION_DENIED')
  }
})

test('cancelled and failed live navigation never claim a human tab', async () => {
  class CurrentFailureEngine extends InMemoryBrowserEngine {
    calls = 0
    constructor(readonly failure: 'cancel' | 'throw' | 'navigation') {
      super({ idFactory: () => 'engine-current-failure' })
    }
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      this.calls += 1
      if (this.calls === 2 && command.type === 'navigate') {
        if (this.failure === 'throw') throw new Error('raw engine failure')
        if (this.failure === 'navigation') {
          return { ok: false, error: { code: 'NAVIGATION_FAILED', message: 'raw failure' } }
        }
        return new Promise<EngineResult>((resolve) => {
          const cancelled = (): void => {
            resolve({
              ok: false,
              error: { code: 'ACTION_CANCELLED', message: 'Browser action was cancelled' }
            })
          }
          if (signal?.aborted) cancelled()
          else signal?.addEventListener('abort', cancelled, { once: true })
        })
      }
      return super.execute(handle, command, signal)
    }
  }

  for (const failure of ['cancel', 'throw', 'navigation'] as const) {
    const engine = new CurrentFailureEngine(failure)
    const workspace = new BrowserWorkspace({
      sessionId: 'session-1',
      partition: 'browser-project-a',
      engine,
      idFactory: () => `tab-${failure}`
    })
    const opened = await workspace.execute(human, {
      type: 'open',
      requestId: `human-${failure}`,
      url: 'https://human.test'
    })
    successful(opened)
    const tabId = opened.snapshot.activeTabId
    const revision = opened.snapshot.tabs[0].documentRevision
    assert.ok(tabId)
    const controller = new AbortController()
    const pending = workspace.execute(
      agent('run-1', `current-${failure}`),
      {
        type: 'navigate',
        requestId: `current-${failure}`,
        tabId,
        url: 'https://next.test',
        expectedDocumentRevision: revision,
        requireActive: true
      },
      controller.signal
    )
    if (failure === 'cancel') controller.abort()
    const outcome = await pending
    assert.equal(outcome.ok, false)
    assert.equal(workspace.snapshot().tabs[0].isAgentControlled, false)
    const implicit = await workspace.execute(agent('run-1', `implicit-${failure}`), {
      type: 'snapshot',
      requestId: `implicit-${failure}`,
      tabId
    })
    assert.equal(implicit.ok, false)
    if (!implicit.ok) assert.equal(implicit.error.code, 'PERMISSION_DENIED')
  }
})

test('a failed restorable-tab materialization does not claim the tab', async () => {
  class FailingCreateEngine extends InMemoryBrowserEngine {
    override async createTab(): Promise<never> {
      throw new Error('raw create failure')
    }
  }
  const store: BrowserCheckpointStore = {
    load: () => ({
      schemaVersion: 1,
      tabs: [{ id: 'restorable-tab', title: 'Saved', url: 'https://saved.test' }],
      activeTabId: 'restorable-tab'
    }),
    save: () => undefined,
    remove: () => undefined
  }
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine: new FailingCreateEngine(),
    checkpointStore: store
  })

  const failed = await workspace.execute(agent('run-1', 'restore-current'), {
    type: 'navigate',
    requestId: 'restore-current',
    tabId: 'restorable-tab',
    url: 'https://next.test',
    expectedDocumentRevision: 0,
    requireActive: true
  })
  assert.equal(failed.ok, false)
  assert.equal(workspace.snapshot().tabs[0].isAgentControlled, false)

  const implicit = await workspace.execute(agent('run-1', 'implicit-after-create-failure'), {
    type: 'snapshot',
    requestId: 'implicit-after-create-failure',
    tabId: 'restorable-tab'
  })
  assert.equal(implicit.ok, false)
  if (!implicit.ok) assert.equal(implicit.error.code, 'PERMISSION_DENIED')
})

test('a genuine restorable navigation failure keeps the failed tab human-owned', async () => {
  class FailedRestorableNavigationEngine extends InMemoryBrowserEngine {
    override async execute(
      _handle: EngineTabHandle,
      command: EngineCommand
    ): Promise<EngineResult> {
      if (command.type === 'navigate') {
        return { ok: false, error: { code: 'NAVIGATION_FAILED', message: 'raw failure' } }
      }
      return { ok: false, error: { code: 'CAPABILITY_UNAVAILABLE', message: 'unavailable' } }
    }
  }
  const store: BrowserCheckpointStore = {
    load: () => ({
      schemaVersion: 1,
      tabs: [{ id: 'restorable-tab', title: 'Saved', url: 'https://saved.test' }],
      activeTabId: 'restorable-tab'
    }),
    save: () => undefined,
    remove: () => undefined
  }
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine: new FailedRestorableNavigationEngine(),
    checkpointStore: store
  })

  const failed = await workspace.execute(agent('run-1', 'failed-restorable'), {
    type: 'navigate',
    requestId: 'failed-restorable',
    tabId: 'restorable-tab',
    url: 'https://next.test',
    expectedDocumentRevision: 0,
    requireActive: true
  })
  assert.equal(failed.ok, false)
  assert.equal(workspace.snapshot().tabs[0].phase, 'failed')
  assert.equal(workspace.snapshot().tabs[0].isAgentControlled, false)
  const implicit = await workspace.execute(agent('run-1', 'implicit-after-nav-failure'), {
    type: 'snapshot',
    requestId: 'implicit-after-nav-failure',
    tabId: 'restorable-tab'
  })
  assert.equal(implicit.ok, false)
  if (!implicit.ok) assert.equal(implicit.error.code, 'PERMISSION_DENIED')
})

test('agent run ownership remains private and never enters browser checkpoints', async () => {
  const saved: BrowserCheckpoint[] = []
  const store: BrowserCheckpointStore = {
    load: () => null,
    save: (_sessionId, checkpoint) => {
      saved.push(structuredClone(checkpoint))
    },
    remove: () => undefined
  }
  const { engine } = createBrowserWorkspaceHarness()
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    checkpointStore: store,
    idFactory: () => 'owned-tab'
  })

  await workspace.execute(agent('run-secret', 'open-tool'), {
    type: 'open',
    requestId: 'agent-open',
    url: 'https://owned.test'
  })

  assert.ok(saved)
  assert.doesNotMatch(JSON.stringify(saved), /run-secret|agentRunId/)
})

test('disposing a run closes dedicated tabs but releases claimed human tabs', async () => {
  const engine = new InMemoryBrowserEngine()
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `run-tab-${++tabNumber}`
  })
  const humanOpened = await workspace.execute(human, {
    type: 'open',
    requestId: 'run-human-open',
    url: 'https://human.test'
  })
  successful(humanOpened)
  const claimedTabId = humanOpened.snapshot.activeTabId
  assert.ok(claimedTabId)
  const claimedRevision = humanOpened.snapshot.tabs[0].documentRevision
  successful(
    await workspace.execute(agent('run-a', 'claim-human'), {
      type: 'snapshot',
      requestId: 'run-claim-human',
      tabId: claimedTabId,
      expectedDocumentRevision: claimedRevision,
      requireActive: true
    })
  )
  const dedicatedA = await workspace.execute(agent('run-a', 'open-a'), {
    type: 'open',
    requestId: 'run-open-a',
    url: 'https://agent-a.test'
  })
  successful(dedicatedA)
  const dedicatedAId = dedicatedA.snapshot.activeTabId
  assert.ok(dedicatedAId)
  const dedicatedB = await workspace.execute(agent('run-b', 'open-b'), {
    type: 'open',
    requestId: 'run-open-b',
    url: 'https://agent-b.test'
  })
  successful(dedicatedB)
  const dedicatedBId = dedicatedB.snapshot.activeTabId
  assert.ok(dedicatedBId)
  const humanSecond = await workspace.execute(human, {
    type: 'open',
    requestId: 'run-human-second',
    url: 'https://human-second.test'
  })
  successful(humanSecond)
  const humanSecondId = humanSecond.snapshot.activeTabId
  assert.ok(humanSecondId)

  await workspace.disposeRun('run-a')

  const tabs = workspace.snapshot().tabs
  assert.equal(
    tabs.some((tab) => tab.id === dedicatedAId),
    false
  )
  assert.equal(tabs.find((tab) => tab.id === claimedTabId)?.isAgentControlled, false)
  assert.equal(tabs.find((tab) => tab.id === dedicatedBId)?.isAgentControlled, true)
  assert.equal(tabs.find((tab) => tab.id === humanSecondId)?.isAgentControlled, false)
  assert.equal(engine.hasTab('engine-tab-1' as EngineTabHandle), true)
  assert.equal(engine.hasTab('engine-tab-2' as EngineTabHandle), false)
  assert.equal(engine.hasTab('engine-tab-3' as EngineTabHandle), true)
  assert.equal(engine.hasTab('engine-tab-4' as EngineTabHandle), true)
})

test('run disposal continues after one dedicated tab cleanup fails', async () => {
  class PartialCleanupEngine extends InMemoryBrowserEngine {
    readonly disposeCalls: EngineTabHandle[] = []
    override async disposeTab(handle: EngineTabHandle): Promise<void> {
      this.disposeCalls.push(handle)
      if (handle === ('engine-tab-2' as EngineTabHandle)) {
        throw new Error('raw cleanup secret')
      }
      await super.disposeTab(handle)
    }
  }
  const engine = new PartialCleanupEngine()
  const saved: BrowserCheckpoint[] = []
  const checkpointStore: BrowserCheckpointStore = {
    load: () => null,
    save: (_sessionId, checkpoint) => {
      saved.push(structuredClone(checkpoint))
    },
    remove: () => undefined
  }
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    checkpointStore,
    idFactory: () => `partial-tab-${++tabNumber}`
  })
  const humanOpened = await workspace.execute(human, {
    type: 'open',
    requestId: 'partial-human',
    url: 'https://human.test'
  })
  successful(humanOpened)
  const humanTabId = humanOpened.snapshot.activeTabId
  assert.ok(humanTabId)
  successful(
    await workspace.execute(agent('run-a', 'partial-claim'), {
      type: 'snapshot',
      requestId: 'partial-claim',
      tabId: humanTabId,
      expectedDocumentRevision: humanOpened.snapshot.tabs[0].documentRevision,
      requireActive: true
    })
  )
  const firstDedicated = await workspace.execute(agent('run-a', 'partial-open-1'), {
    type: 'open',
    requestId: 'partial-open-1',
    url: 'https://one.test'
  })
  successful(firstDedicated)
  const firstDedicatedId = firstDedicated.snapshot.activeTabId
  assert.ok(firstDedicatedId)
  const secondDedicated = await workspace.execute(agent('run-a', 'partial-open-2'), {
    type: 'open',
    requestId: 'partial-open-2',
    url: 'https://two.test'
  })
  successful(secondDedicated)
  const secondDedicatedId = secondDedicated.snapshot.activeTabId

  await assert.rejects(
    workspace.disposeRun('run-a'),
    (error: Error) =>
      error.message === 'Browser run cleanup failed' &&
      !error.message.includes('raw cleanup secret')
  )
  assert.deepEqual(engine.disposeCalls, ['engine-tab-2', 'engine-tab-3'])
  assert.equal(
    workspace.snapshot().tabs.some((tab) => tab.id === firstDedicatedId),
    false
  )
  assert.equal(
    workspace.snapshot().tabs.find((tab) => tab.id === humanTabId)?.isAgentControlled,
    false
  )
  assert.equal(
    workspace.snapshot().tabs.some((tab) => tab.id === secondDedicatedId),
    false
  )
  const persisted = saved.at(-1)
  assert.ok(persisted)
  assert.equal(
    persisted.tabs.some((tab) => tab.id === firstDedicatedId || tab.id === secondDedicatedId),
    false
  )
})
