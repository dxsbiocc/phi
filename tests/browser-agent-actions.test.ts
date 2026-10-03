import assert from 'node:assert/strict'
import test from 'node:test'

import type {
  BrowserEngine,
  EngineCommand,
  EngineResult,
  EngineTabHandle
} from '../src/main/browser/browser-engine'
import { InMemoryBrowserEngine } from '../src/main/browser/in-memory-browser-engine'
import { BrowserWorkspace } from '../src/main/browser/browser-workspace'
import { buildBrowserTool } from '../src/main/agent/browser/browser-tool'
import type { BrowserActor, BrowserCommand, BrowserOutcome } from '../src/shared/browserTypes'
import { browserCapabilities, successful } from './helpers/browserWorkspaceHarness'

const runA: BrowserActor = {
  kind: 'agent',
  sessionId: 'session-1',
  runId: 'run-a',
  toolCallId: 'tool-a'
}
const runB: BrowserActor = {
  kind: 'agent',
  sessionId: 'session-1',
  runId: 'run-b',
  toolCallId: 'tool-b'
}

function harness(engine: InMemoryBrowserEngine = new InMemoryBrowserEngine()): {
  workspace: BrowserWorkspace
  engine: InMemoryBrowserEngine
} {
  let tabId = 0
  return {
    engine,
    workspace: new BrowserWorkspace({
      sessionId: 'session-1',
      partition: 'browser-project-a',
      engine,
      idFactory: () => `tab-${++tabId}`,
      actionStabilityMs: 0
    })
  }
}

async function openAndSnapshot(
  workspace: BrowserWorkspace,
  actor: BrowserActor = runA,
  url = 'http://localhost:3000/'
): Promise<{ tabId: string; revision: number }> {
  const opened = await workspace.execute(actor, { type: 'open', requestId: 'open', url })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  const captured = await workspace.execute(actor, {
    type: 'snapshot',
    requestId: 'snapshot',
    tabId
  })
  successful(captured)
  return { tabId, revision }
}

test('agent click is active, revision-bound, read-only, loopback-only, and returns a screenshot', async () => {
  const { workspace, engine } = harness()
  const { tabId, revision } = await openAndSnapshot(workspace)

  const clicked = await workspace.execute(runA, {
    type: 'click',
    requestId: 'click-1',
    tabId,
    x: 0,
    y: 0,
    expectedDocumentRevision: revision,
    consequence: 'read',
    requireActive: true
  })
  successful(clicked)
  assert.equal(clicked.screenshot?.documentRevision, revision)
  assert.equal(clicked.screenshot?.tabId, tabId)

  const handle = 'engine-tab-1' as EngineTabHandle
  assert.deepEqual(
    engine
      .recordedActions(handle)
      .filter(({ command }) => command.type === 'click')
      .map(({ command }) => command),
    [
      {
        type: 'click',
        x: 0,
        y: 0,
        expectedDocumentRevision: 1,
        expectedTarget: {
          descriptor: { tagName: 'DIV', editable: false, submitsForm: false },
          fingerprint: 'target-1'
        }
      }
    ]
  )

  const outsideScreenshot = await workspace.execute(runA, {
    type: 'click',
    requestId: 'outside-screenshot',
    tabId,
    x: 1,
    y: 0,
    expectedDocumentRevision: revision,
    consequence: 'read',
    requireActive: true
  })
  assert.equal(outsideScreenshot.ok, false)
  assert.equal(
    engine.recordedActions(handle).filter(({ command }) => command.type === 'click').length,
    1
  )

  for (const invalid of [
    {
      type: 'click' as const,
      requestId: 'stale',
      tabId,
      x: 0,
      y: 0,
      expectedDocumentRevision: revision - 1,
      consequence: 'read' as const,
      requireActive: true as const
    },
    {
      type: 'click' as const,
      requestId: 'write',
      tabId,
      x: 0,
      y: 0,
      expectedDocumentRevision: revision,
      consequence: 'write' as const,
      requireActive: true as const
    }
  ]) {
    const outcome = await workspace.execute(runA, invalid)
    assert.equal(outcome.ok, false)
  }
  assert.equal(
    engine.recordedActions(handle).filter(({ command }) => command.type === 'click').length,
    1
  )

  const external = harness()
  const externalTab = await openAndSnapshot(external.workspace, runA, 'https://example.test/')
  const denied = await external.workspace.execute(runA, {
    type: 'scroll',
    requestId: 'external-scroll',
    tabId: externalTab.tabId,
    deltaX: 0,
    deltaY: 120,
    expectedDocumentRevision: externalTab.revision,
    requireActive: true
  })
  assert.equal(denied.ok, false)
  if (!denied.ok) assert.equal(denied.error.code, 'PERMISSION_DENIED')
})

test('agent typeText inserts bounded multiline text into an ordinary focused field and returns a fresh screenshot', async () => {
  const engine = new InMemoryBrowserEngine({
    targetDescriptor: {
      tagName: 'INPUT',
      inputType: 'text',
      role: 'textbox',
      accessibleLabel: 'Notes',
      editable: true,
      submitsForm: false
    }
  })
  const { workspace } = harness(engine)
  const { tabId, revision } = await openAndSnapshot(workspace)
  const text = 'first line\nsecond line'

  const typed = await workspace.execute(runA, {
    type: 'typeText',
    requestId: 'type-1',
    tabId,
    text,
    expectedDocumentRevision: revision,
    consequence: 'write',
    requireActive: true
  })

  successful(typed)
  assert.equal(typed.screenshot?.documentRevision, revision)
  assert.deepEqual(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'describeTarget' || command.type === 'typeText')
      .map(({ command }) => command.type),
    ['describeTarget', 'typeText']
  )
})

test('agent typeText hands password, file, and one-time-code fields back to the user without delivery', async () => {
  for (const inputType of ['password', 'file', 'one-time-code']) {
    const engine = new InMemoryBrowserEngine({
      targetDescriptor: {
        tagName: 'INPUT',
        inputType,
        editable: true,
        submitsForm: false
      }
    })
    const { workspace } = harness(engine)
    const { tabId, revision } = await openAndSnapshot(workspace)

    const result = await workspace.execute(runA, {
      type: 'typeText',
      requestId: `type-${inputType}`,
      tabId,
      text: 'private sentinel',
      expectedDocumentRevision: revision,
      consequence: 'write',
      requireActive: true
    })

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'USER_HANDOFF_REQUIRED')
    assert.equal(
      engine
        .recordedActions('engine-tab-1' as EngineTabHandle)
        .filter(({ command }) => command.type === 'typeText').length,
      0
    )
  }
})

test('agent typeText accepts textarea and contenteditable targets but rejects their noneditable state', async () => {
  for (const descriptor of [
    { tagName: 'TEXTAREA', editable: true, submitsForm: false },
    { tagName: 'DIV', inputType: 'contenteditable', editable: true, submitsForm: false }
  ]) {
    const engine = new InMemoryBrowserEngine({ targetDescriptor: descriptor })
    const { workspace } = harness(engine)
    const { tabId, revision } = await openAndSnapshot(workspace)
    const result = await workspace.execute(runA, {
      type: 'typeText',
      requestId: `allowed-${descriptor.tagName}-${descriptor.inputType ?? 'native'}`,
      tabId,
      text: 'multiline\ntext',
      expectedDocumentRevision: revision,
      consequence: 'write',
      requireActive: true
    })
    successful(result)
  }

  for (const tagName of ['INPUT', 'TEXTAREA']) {
    const engine = new InMemoryBrowserEngine({
      targetDescriptor: {
        tagName,
        ...(tagName === 'INPUT' ? { inputType: 'text' } : {}),
        editable: false,
        submitsForm: false
      }
    })
    const { workspace } = harness(engine)
    const { tabId, revision } = await openAndSnapshot(workspace)
    const result = await workspace.execute(runA, {
      type: 'typeText',
      requestId: `readonly-${tagName}`,
      tabId,
      text: 'must not be delivered',
      expectedDocumentRevision: revision,
      consequence: 'write',
      requireActive: true
    })
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, 'PERMISSION_DENIED')
  }
})

test('external-site typeText remains denied before target inspection until Task 20 approval exists', async () => {
  const engine = new InMemoryBrowserEngine({
    targetDescriptor: {
      tagName: 'INPUT',
      inputType: 'text',
      editable: true,
      submitsForm: false
    }
  })
  const { workspace } = harness(engine)
  const { tabId, revision } = await openAndSnapshot(workspace, runA, 'https://example.test/form')
  const result = await workspace.execute(runA, {
    type: 'typeText',
    requestId: 'external-type',
    tabId,
    text: 'private sentinel',
    expectedDocumentRevision: revision,
    consequence: 'write',
    requireActive: true
  })

  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'PERMISSION_DENIED')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'describeTarget' || command.type === 'typeText')
      .length,
    0
  )
})

test('agent input fails closed for a noneditable focused target and a submit-capable click target', async () => {
  for (const value of [
    {
      descriptor: { tagName: 'DIV', editable: false, submitsForm: false },
      command: (tabId: string, revision: number): BrowserCommand => ({
        type: 'typeText',
        requestId: 'noneditable-type',
        tabId,
        text: 'must not be delivered',
        expectedDocumentRevision: revision,
        consequence: 'write',
        requireActive: true
      }),
      code: 'PERMISSION_DENIED'
    },
    {
      descriptor: {
        tagName: 'BUTTON',
        role: 'button',
        formMethod: 'post',
        formAction: 'http://localhost:3000/submit',
        editable: false,
        submitsForm: true
      },
      command: (tabId: string, revision: number): BrowserCommand => ({
        type: 'click',
        requestId: 'submit-click',
        tabId,
        x: 0,
        y: 0,
        expectedDocumentRevision: revision,
        consequence: 'read',
        requireActive: true
      }),
      code: 'USER_HANDOFF_REQUIRED'
    },
    {
      descriptor: { tagName: 'WEBVIEW', editable: false, submitsForm: false },
      command: (tabId: string, revision: number): BrowserCommand => ({
        type: 'click',
        requestId: 'embedded-click',
        tabId,
        x: 0,
        y: 0,
        expectedDocumentRevision: revision,
        consequence: 'read',
        requireActive: true
      }),
      code: 'PERMISSION_DENIED'
    }
  ] as const) {
    const engine = new InMemoryBrowserEngine({ targetDescriptor: value.descriptor })
    const { workspace } = harness(engine)
    const { tabId, revision } = await openAndSnapshot(workspace)
    const result = await workspace.execute(runA, value.command(tabId, revision))

    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error.code, value.code)
    assert.equal(
      engine
        .recordedActions('engine-tab-1' as EngineTabHandle)
        .filter(({ command }) => command.type === 'typeText' || command.type === 'click').length,
      0
    )
  }
})

test('loading state invalidates a workspace screenshot lease before input dispatch', async () => {
  const { workspace, engine } = harness()
  const { tabId, revision } = await openAndSnapshot(workspace)
  engine.emitLoading('engine-tab-1' as EngineTabHandle, true)

  const result = await workspace.execute(runA, {
    type: 'keypress',
    requestId: 'loading-key',
    tabId,
    key: 'Tab',
    expectedDocumentRevision: revision,
    requireActive: true
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'STALE_DOCUMENT')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'keypress').length,
    0
  )
})

test('input cannot reuse another run screenshot and only succeeds after current snapshot takeover', async () => {
  const { workspace, engine } = harness()
  const { tabId, revision } = await openAndSnapshot(workspace, runA)

  const dedicated = await workspace.execute(runB, {
    type: 'keypress',
    requestId: 'cross-run-dedicated',
    tabId,
    key: 'Tab',
    expectedDocumentRevision: revision,
    requireActive: true
  })
  assert.equal(dedicated.ok, false)
  if (!dedicated.ok) assert.equal(dedicated.error.code, 'PERMISSION_DENIED')

  const currentWithoutSnapshot = await workspace.execute(runB, {
    type: 'keypress',
    requestId: 'cross-run-current',
    tabId,
    key: 'Tab',
    expectedDocumentRevision: revision,
    requireActive: true
  })
  assert.equal(currentWithoutSnapshot.ok, false)
  if (!currentWithoutSnapshot.ok)
    assert.equal(currentWithoutSnapshot.error.code, 'PERMISSION_DENIED')

  const claimed = await workspace.execute(runB, {
    type: 'snapshot',
    requestId: 'claim-current',
    tabId,
    expectedDocumentRevision: revision,
    requireActive: true
  })
  successful(claimed)
  const current = await workspace.execute(runB, {
    type: 'keypress',
    requestId: 'cross-run-after-snapshot',
    tabId,
    key: 'Tab',
    expectedDocumentRevision: revision,
    requireActive: true
  })
  successful(current)
  assert.equal(current.snapshot.tabs[0].isAgentControlled, true)
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'keypress').length,
    1
  )
})

test('browser actions serialize, honor queued cancellation, and do not replay duplicate requests', async () => {
  let releaseFirst!: () => void
  let firstStarted!: () => void
  const started = new Promise<void>((resolve) => {
    firstStarted = resolve
  })
  const gate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  class BlockingActionEngine extends InMemoryBrowserEngine implements BrowserEngine {
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      if (command.type === 'click') {
        firstStarted()
        await gate
      }
      return super.execute(handle, command, signal)
    }
  }
  const { workspace, engine } = harness(
    new BlockingActionEngine({ capabilities: browserCapabilities })
  )
  const { tabId, revision } = await openAndSnapshot(workspace)
  const first = workspace.execute(runA, {
    type: 'click',
    requestId: 'serialized-click',
    tabId,
    x: 0,
    y: 0,
    expectedDocumentRevision: revision,
    consequence: 'read',
    requireActive: true
  })
  await started
  const controller = new AbortController()
  const queued = workspace.execute(
    runA,
    {
      type: 'scroll',
      requestId: 'cancelled-scroll',
      tabId,
      deltaX: 0,
      deltaY: 120,
      expectedDocumentRevision: revision,
      requireActive: true
    },
    controller.signal
  )
  controller.abort()
  releaseFirst()
  successful(await first)
  const cancelled = await queued
  assert.equal(cancelled.ok, false)
  if (!cancelled.ok) assert.equal(cancelled.error.code, 'ACTION_CANCELLED')

  const replay = await workspace.execute(runA, {
    type: 'click',
    requestId: 'serialized-click',
    tabId,
    x: 0,
    y: 0,
    expectedDocumentRevision: revision,
    consequence: 'read',
    requireActive: true
  })
  assert.equal(replay.ok, false)
  if (!replay.ok) assert.equal(replay.error.code, 'CAPABILITY_UNAVAILABLE')
  const actions = engine.recordedActions('engine-tab-1' as EngineTabHandle)
  assert.equal(actions.filter(({ command }) => command.type === 'click').length, 1)
  assert.equal(actions.filter(({ command }) => command.type === 'scroll').length, 0)
})

test('post-action navigation returns a consistent new-revision screenshot without replaying input', async () => {
  class NavigatingClickEngine extends InMemoryBrowserEngine {
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      const result = await super.execute(handle, command, signal)
      if (command.type === 'click' && result.ok) {
        return super.execute(
          handle,
          { type: 'navigate', url: 'http://localhost:3000/next' },
          signal
        )
      }
      return result
    }
  }
  const { workspace, engine } = harness(new NavigatingClickEngine())
  const { tabId, revision } = await openAndSnapshot(workspace)
  const result: BrowserOutcome = await workspace.execute(runA, {
    type: 'click',
    requestId: 'navigate-click',
    tabId,
    x: 0,
    y: 0,
    expectedDocumentRevision: revision,
    consequence: 'read',
    requireActive: true
  })
  successful(result)
  const tab = result.snapshot.tabs[0]
  assert.equal(result.screenshot?.documentRevision, tab.documentRevision)
  assert.equal(tab.documentRevision, revision + 1)
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'click').length,
    1
  )
})

test('post-delivery observation failure is non-retryable and a duplicate request never resends input', async () => {
  class FailingPostActionCaptureEngine extends InMemoryBrowserEngine {
    delivered = false
    postCaptureAttempts = 0
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      if (command.type === 'screenshot' && this.delivered) {
        this.postCaptureAttempts += 1
        return {
          ok: false,
          error: { code: 'STALE_DOCUMENT', message: 'capture stayed stale' }
        }
      }
      const result = await super.execute(handle, command, signal)
      if (command.type === 'click') this.delivered = true
      return result
    }
  }
  const engine = new FailingPostActionCaptureEngine()
  const { workspace } = harness(engine)
  const { tabId, revision } = await openAndSnapshot(workspace)
  const command = {
    type: 'click' as const,
    requestId: 'uncertain-click',
    tabId,
    x: 0,
    y: 0,
    expectedDocumentRevision: revision,
    consequence: 'read' as const,
    requireActive: true as const
  }

  const first = await workspace.execute(runA, command)
  assert.equal(first.ok, false)
  if (!first.ok) {
    assert.equal(first.error.code, 'ACTION_TIMEOUT')
    assert.equal(first.error.retryable, false)
    assert.match(first.error.message, /input was delivered/i)
  }
  const retry = await workspace.execute(runA, {
    ...command,
    requestId: 'uncertain-click-new-request'
  })
  assert.equal(retry.ok, false)
  if (!retry.ok) assert.equal(retry.error.code, 'STALE_DOCUMENT')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command: action }) => action.type === 'click').length,
    1
  )
  assert.equal(engine.postCaptureAttempts, 2)
})

test('viewport resize invalidates the run screenshot lease before workspace input dispatch', async () => {
  const { workspace, engine } = harness()
  const opened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'viewport-open',
    url: 'http://localhost:3000/'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 600, height: 400 })
  successful(await workspace.execute(runA, { type: 'snapshot', requestId: 'viewport-shot', tabId }))
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 500, height: 400 })

  const result = await workspace.execute(runA, {
    type: 'scroll',
    requestId: 'viewport-scroll',
    tabId,
    deltaX: 0,
    deltaY: 120,
    expectedDocumentRevision: revision,
    requireActive: true
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'STALE_DOCUMENT')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'scroll').length,
    0
  )
})

test('workspace viewport failure invalidates leases before a new request can send input', async () => {
  class FailingViewportEngine extends InMemoryBrowserEngine {
    viewportCalls = 0
    override async setViewport(
      handle: EngineTabHandle,
      viewport: { x: number; y: number; width: number; height: number } | null
    ): Promise<void> {
      this.viewportCalls += 1
      if (this.viewportCalls === 2) throw new Error('raw viewport failure')
      await super.setViewport(handle, viewport)
    }
  }
  const engine = new FailingViewportEngine()
  const { workspace } = harness(engine)
  const opened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'failed-viewport-open',
    url: 'http://localhost:3000/'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 600, height: 400 })
  successful(
    await workspace.execute(runA, {
      type: 'snapshot',
      requestId: 'failed-viewport-shot',
      tabId
    })
  )
  await assert.rejects(
    workspace.setViewport(tabId, { x: 0, y: 0, width: 500, height: 400 }),
    /could not be applied/i
  )

  const result = await workspace.execute(runA, {
    type: 'scroll',
    requestId: 'failed-viewport-scroll',
    tabId,
    deltaX: 0,
    deltaY: 120,
    expectedDocumentRevision: revision,
    requireActive: true
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'STALE_DOCUMENT')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'scroll').length,
    0
  )
})

test('a pending asynchronous viewport update revokes the old screenshot lease immediately', async () => {
  let releaseViewport!: () => void
  const viewportGate = new Promise<void>((resolve) => {
    releaseViewport = resolve
  })
  class DeferredViewportEngine extends InMemoryBrowserEngine {
    viewportCalls = 0
    override async setViewport(
      handle: EngineTabHandle,
      viewport: { x: number; y: number; width: number; height: number } | null
    ): Promise<void> {
      this.viewportCalls += 1
      if (this.viewportCalls === 2) await viewportGate
      await super.setViewport(handle, viewport)
    }
  }
  const engine = new DeferredViewportEngine()
  const { workspace } = harness(engine)
  const opened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'pending-viewport-open',
    url: 'http://localhost:3000/'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 600, height: 400 })
  successful(
    await workspace.execute(runA, {
      type: 'snapshot',
      requestId: 'pending-viewport-shot',
      tabId
    })
  )

  const pendingViewport = workspace.setViewport(tabId, {
    x: 0,
    y: 0,
    width: 500,
    height: 400
  })
  const result = await workspace.execute(runA, {
    type: 'scroll',
    requestId: 'pending-viewport-scroll',
    tabId,
    deltaX: 0,
    deltaY: 120,
    expectedDocumentRevision: revision,
    requireActive: true
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'STALE_DOCUMENT')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'scroll').length,
    0
  )
  releaseViewport()
  await pendingViewport
})

test('switching away and back invalidates the earlier active-tab screenshot lease', async () => {
  const { workspace, engine } = harness()
  const first = await openAndSnapshot(workspace)
  const second = await workspace.execute(runA, {
    type: 'open',
    requestId: 'switch-open',
    url: 'http://localhost:3001/'
  })
  successful(second)
  await workspace.execute(runA, {
    type: 'close',
    requestId: 'switch-close',
    tabId: second.snapshot.activeTabId as string
  })

  const result = await workspace.execute(runA, {
    type: 'keypress',
    requestId: 'switch-key',
    tabId: first.tabId,
    key: 'Tab',
    expectedDocumentRevision: first.revision,
    requireActive: true
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'STALE_DOCUMENT')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'keypress').length,
    0
  )
})

test('cancellation during the stability window stops observation without replaying delivered input', async () => {
  let delivered!: () => void
  const inputDelivered = new Promise<void>((resolve) => {
    delivered = resolve
  })
  class DeliverySignalEngine extends InMemoryBrowserEngine {
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      const result = await super.execute(handle, command, signal)
      if (command.type === 'click') delivered()
      return result
    }
  }
  const engine = new DeliverySignalEngine()
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `stable-tab-${++tabNumber}`,
    actionStabilityMs: 500
  })
  const { tabId, revision } = await openAndSnapshot(workspace)
  const controller = new AbortController()
  const command = {
    type: 'click' as const,
    requestId: 'stability-cancel',
    tabId,
    x: 0,
    y: 0,
    expectedDocumentRevision: revision,
    consequence: 'read' as const,
    requireActive: true as const
  }
  const pending = workspace.execute(runA, command, controller.signal)
  await inputDelivered
  controller.abort()

  const result = await pending
  assert.equal(result.ok, false)
  if (!result.ok) {
    assert.equal(result.error.code, 'ACTION_CANCELLED')
    assert.equal(result.error.retryable, false)
    assert.match(result.error.message, /may have been delivered/i)
  }
  const retry = await workspace.execute(runA, {
    ...command,
    requestId: 'stability-cancel-new-request'
  })
  assert.equal(retry.ok, false)
  if (!retry.ok) assert.equal(retry.error.code, 'STALE_DOCUMENT')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command: action }) => action.type === 'click').length,
    1
  )
})

test('an uncertain engine delivery consumes the lease before a different request can retry', async () => {
  class PartialDeliveryEngine extends InMemoryBrowserEngine {
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      const result = await super.execute(handle, command, signal)
      return command.type === 'click'
        ? {
            ok: false,
            error: { code: 'CAPABILITY_UNAVAILABLE', message: 'delivery uncertain' }
          }
        : result
    }
  }
  const engine = new PartialDeliveryEngine()
  const { workspace } = harness(engine)
  const { tabId, revision } = await openAndSnapshot(workspace)
  const action = {
    type: 'click' as const,
    tabId,
    x: 0,
    y: 0,
    expectedDocumentRevision: revision,
    consequence: 'read' as const,
    requireActive: true as const
  }

  const first = await workspace.execute(runA, {
    ...action,
    requestId: 'partial-delivery-1'
  })
  assert.equal(first.ok, false)
  const retry = await workspace.execute(runA, {
    ...action,
    requestId: 'partial-delivery-2'
  })
  assert.equal(retry.ok, false)
  if (!retry.ok) assert.equal(retry.error.code, 'STALE_DOCUMENT')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'click').length,
    1
  )
})

test('replayed tool calls share a stable request while distinct tool calls remain independent', async () => {
  const { workspace, engine } = harness()
  const { tabId, revision } = await openAndSnapshot(workspace)
  const requestIds: string[] = []
  const tool = buildBrowserTool('session-1', async (request, signal) => {
    requestIds.push(request.requestId)
    return workspace.execute(
      {
        kind: 'agent',
        sessionId: 'session-1',
        runId: 'run-a',
        toolCallId: request.toolCallId
      },
      request.command as BrowserCommand,
      signal
    )
  })
  const params = {
    action: 'click',
    tabId,
    x: 0,
    y: 0,
    expectedDocumentRevision: revision,
    consequence: 'read'
  }

  await tool.execute('stable-tool-call', params, undefined, {} as never)
  await tool.execute('stable-tool-call', params, undefined, {} as never)
  await tool.execute('distinct-tool-call', params, undefined, {} as never)

  assert.deepEqual(requestIds, ['stable-tool-call', 'stable-tool-call', 'distinct-tool-call'])
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'click').length,
    2
  )
})

test('replayed typeText tool calls never resend text for the same stable tool call id', async () => {
  const engine = new InMemoryBrowserEngine({
    targetDescriptor: {
      tagName: 'INPUT',
      inputType: 'text',
      editable: true,
      submitsForm: false
    }
  })
  const { workspace } = harness(engine)
  const { tabId, revision } = await openAndSnapshot(workspace)
  const tool = buildBrowserTool(
    'session-1',
    (request, signal) =>
      workspace.execute(
        {
          kind: 'agent',
          sessionId: 'session-1',
          runId: 'run-a',
          toolCallId: request.toolCallId
        },
        request.command as BrowserCommand,
        signal
      ),
    { takeText: (_toolCallId, text) => ({ text }) }
  )
  const params = {
    action: 'typeText',
    tabId,
    expectedDocumentRevision: revision,
    text: 'private sentinel'
  }

  await tool.execute('stable-type-call', params, undefined, {} as never)
  await tool.execute('stable-type-call', params, undefined, {} as never)
  await tool.execute('distinct-type-call', params, undefined, {} as never)

  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'typeText').length,
    2
  )
})
