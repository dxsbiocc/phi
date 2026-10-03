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
import { BrowserToolHostCoordinator } from '../src/main/agent/browser/browser-tool-host'
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
    ['describeTarget', 'describeTarget', 'typeText']
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

test('external-site typeText asks once for the exact tool call before delivering text', async () => {
  const engine = new InMemoryBrowserEngine({
    targetDescriptor: {
      tagName: 'INPUT',
      inputType: 'text',
      editable: true,
      submitsForm: false
    }
  })
  const approvals: Array<Record<string, unknown>> = []
  let tabIdCounter = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `tab-${++tabIdCounter}`,
    actionStabilityMs: 0,
    approveAgentAction: async (request) => {
      approvals.push({ ...request })
      return 'approved'
    }
  })
  const { tabId, revision } = await openAndSnapshot(workspace, runA, 'https://example.test/form')
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 800, height: 600 })
  successful(
    await workspace.execute(runA, {
      type: 'snapshot',
      requestId: 'external-presented-snapshot',
      tabId
    })
  )
  const result = await workspace.execute(runA, {
    type: 'typeText',
    requestId: 'external-type',
    tabId,
    text: 'private sentinel',
    expectedDocumentRevision: revision,
    consequence: 'write',
    requireActive: true
  })

  successful(result)
  assert.deepEqual(approvals, [
    {
      sessionId: 'session-1',
      runId: 'run-a',
      toolCallId: 'tool-a',
      origin: 'https://example.test',
      action: 'typeText',
      consequence: 'write',
      reason: 'external_origin'
    }
  ])
  assert.doesNotMatch(JSON.stringify(approvals), /private sentinel/)
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'describeTarget' || command.type === 'typeText')
      .map(({ command }) => command.type)
      .join(','),
    'describeTarget,describeTarget,typeText'
  )
})

test('approved external input waits for the trusted overlay viewport to return before delivery', async () => {
  const engine = new InMemoryBrowserEngine({
    targetDescriptor: {
      tagName: 'INPUT',
      inputType: 'text',
      editable: true,
      submitsForm: false
    }
  })
  let approvalStarted!: () => void
  const started = new Promise<void>((resolve) => {
    approvalStarted = resolve
  })
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `overlay-tab-${++tabNumber}`,
    actionStabilityMs: 0,
    approvalRestoreTimeoutMs: 500,
    approveAgentAction: async () => {
      await workspace.setViewport('overlay-tab-1', null)
      approvalStarted()
      return 'approved'
    }
  })
  const opened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'overlay-open',
    url: 'https://example.test/form'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 800, height: 600 })
  successful(await workspace.execute(runA, { type: 'snapshot', requestId: 'overlay-shot', tabId }))

  const action = workspace.execute(runA, {
    type: 'typeText',
    requestId: 'overlay-type',
    tabId,
    text: 'private sentinel',
    expectedDocumentRevision: revision,
    consequence: 'write',
    requireActive: true
  })
  await started
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'typeText').length,
    0
  )

  await workspace.setViewport(tabId, { x: 0, y: 0, width: 800, height: 600 })
  successful(await action)
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'typeText').length,
    1
  )
})

test('approval fails closed when the restored viewport produces different screenshot bounds', async () => {
  class ResizedAfterOverlayEngine extends InMemoryBrowserEngine {
    hidden = false
    restored = false
    override async setViewport(
      handle: EngineTabHandle,
      viewport: { x: number; y: number; width: number; height: number } | null
    ): Promise<void> {
      if (!viewport) this.hidden = true
      else if (this.hidden) this.restored = true
      await super.setViewport(handle, viewport)
    }
    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      const result = await super.execute(handle, command, signal)
      if (command.type === 'screenshot' && this.restored && result.ok && result.screenshot) {
        return {
          ...result,
          screenshot: { ...result.screenshot, width: result.screenshot.width + 1 }
        }
      }
      return result
    }
  }
  const engine = new ResizedAfterOverlayEngine()
  let approvalStarted!: () => void
  const started = new Promise<void>((resolve) => {
    approvalStarted = resolve
  })
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `resize-tab-${++tabNumber}`,
    actionStabilityMs: 0,
    approvalRestoreTimeoutMs: 500,
    approveAgentAction: async () => {
      await workspace.setViewport('resize-tab-1', null)
      approvalStarted()
      return 'approved'
    }
  })
  const opened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'resize-open',
    url: 'https://example.test/'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 800, height: 600 })
  successful(await workspace.execute(runA, { type: 'snapshot', requestId: 'resize-shot', tabId }))
  const pending = workspace.execute(runA, {
    type: 'scroll',
    requestId: 'resize-scroll',
    tabId,
    deltaX: 0,
    deltaY: 120,
    expectedDocumentRevision: revision,
    requireActive: true
  })
  await started
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 700, height: 600 })
  const result = await pending
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'STALE_DOCUMENT')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'scroll').length,
    0
  )
})

test('trusted run stop aborts an approved action before viewport restore or engine input', async () => {
  const engine = new InMemoryBrowserEngine()
  let approvalStarted!: () => void
  const started = new Promise<void>((resolve) => {
    approvalStarted = resolve
  })
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `stop-tab-${++tabNumber}`,
    actionStabilityMs: 0,
    approvalRestoreTimeoutMs: 500,
    approveAgentAction: async () => {
      await workspace.setViewport('stop-tab-1', null)
      approvalStarted()
      return 'approved'
    }
  })
  const opened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'stop-open',
    url: 'https://example.test/'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 800, height: 600 })
  successful(await workspace.execute(runA, { type: 'snapshot', requestId: 'stop-shot', tabId }))

  const host = new BrowserToolHostCoordinator({
    resolveActiveRun: () => ({ runId: 'run-a', cancelled: false }),
    executeAgent: (input, signal) => {
      const trusted = input as {
        runId: string
        toolCallId: string
        command: BrowserCommand
      }
      return workspace.execute(
        {
          kind: 'agent',
          sessionId: 'session-1',
          runId: trusted.runId,
          toolCallId: trusted.toolCallId
        },
        trusted.command,
        signal
      )
    }
  })
  const pending = host.execute({
    originSessionId: 'runtime-session-1',
    requestId: 'stop-scroll',
    toolCallId: 'stop-tool',
    command: {
      type: 'scroll',
      requestId: 'stop-scroll',
      tabId,
      deltaX: 0,
      deltaY: 120,
      expectedDocumentRevision: revision,
      requireActive: true
    }
  })
  await started
  host.cancelRun('run-a', 'runtime-session-1')
  const result = await pending
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'ACTION_CANCELLED')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'scroll').length,
    0
  )
})

test('external input denial and cancellation deliver no native input', async () => {
  for (const decision of ['denied', 'cancelled'] as const) {
    const engine = new InMemoryBrowserEngine()
    let tabNumber = 0
    const workspace = new BrowserWorkspace({
      sessionId: 'session-1',
      partition: 'browser-project-a',
      engine,
      idFactory: () => `decision-tab-${++tabNumber}`,
      actionStabilityMs: 0,
      approveAgentAction: async () => decision
    })
    const opened = await workspace.execute(runA, {
      type: 'open',
      requestId: `decision-open-${decision}`,
      url: 'https://example.test/'
    })
    successful(opened)
    const tabId = opened.snapshot.activeTabId as string
    const revision = opened.snapshot.tabs[0].documentRevision
    await workspace.setViewport(tabId, { x: 0, y: 0, width: 800, height: 600 })
    successful(
      await workspace.execute(runA, {
        type: 'snapshot',
        requestId: `decision-shot-${decision}`,
        tabId
      })
    )
    const result = await workspace.execute(runA, {
      type: 'scroll',
      requestId: `decision-scroll-${decision}`,
      tabId,
      deltaX: 0,
      deltaY: 120,
      expectedDocumentRevision: revision,
      requireActive: true
    })
    assert.equal(result.ok, false)
    if (!result.ok) {
      assert.equal(
        result.error.code,
        decision === 'denied' ? 'PERMISSION_DENIED' : 'ACTION_CANCELLED'
      )
    }
    assert.equal(
      engine
        .recordedActions('engine-tab-1' as EngineTabHandle)
        .filter(({ command }) => command.type === 'scroll').length,
      0
    )
  }
})

test('manual navigation during a pending approval revokes the action without blocking browsing', async () => {
  const engine = new InMemoryBrowserEngine()
  let approvalStarted!: () => void
  const started = new Promise<void>((resolve) => {
    approvalStarted = resolve
  })
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `manual-tab-${++tabNumber}`,
    actionStabilityMs: 0,
    approveAgentAction: (_prompt, signal) => {
      approvalStarted()
      return new Promise<'approved'>((resolve) => {
        signal.addEventListener('abort', () => resolve('approved'), { once: true })
      })
    }
  })
  const opened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'manual-open',
    url: 'https://example.test/'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 800, height: 600 })
  successful(await workspace.execute(runA, { type: 'snapshot', requestId: 'manual-shot', tabId }))
  const pending = workspace.execute(runA, {
    type: 'scroll',
    requestId: 'manual-pending-scroll',
    tabId,
    deltaX: 0,
    deltaY: 120,
    expectedDocumentRevision: revision,
    requireActive: true
  })
  await started
  const navigated = await workspace.execute(
    { kind: 'human' },
    {
      type: 'navigate',
      requestId: 'manual-navigate',
      tabId,
      url: 'https://other.example.test/'
    }
  )
  successful(navigated)
  const result = await pending
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'ACTION_CANCELLED')
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'scroll').length,
    0
  )
})

test('external approval is per tool call and never becomes an origin allowlist', async () => {
  const engine = new InMemoryBrowserEngine()
  const prompts: unknown[] = []
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `once-tab-${++tabNumber}`,
    actionStabilityMs: 0,
    approveAgentAction: async (prompt) => {
      prompts.push(prompt)
      return 'approved'
    }
  })
  const opened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'once-open',
    url: 'https://example.test/'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 800, height: 600 })
  successful(await workspace.execute(runA, { type: 'snapshot', requestId: 'once-shot', tabId }))

  for (const [index, toolCallId] of ['tool-once-1', 'tool-once-2'].entries()) {
    successful(
      await workspace.execute(
        { ...runA, toolCallId },
        {
          type: 'scroll',
          requestId: `once-scroll-${index}`,
          tabId,
          deltaX: 0,
          deltaY: 120,
          expectedDocumentRevision: revision,
          requireActive: true
        }
      )
    )
  }
  assert.equal(prompts.length, 2)
  assert.deepEqual(
    prompts.map((prompt) => (prompt as { toolCallId: string }).toolCallId),
    ['tool-once-1', 'tool-once-2']
  )
})

test('one screenshot cannot preflight two concurrent external actions on the same tab', async () => {
  const engine = new InMemoryBrowserEngine()
  const decisionResolvers: Array<(decision: 'approved') => void> = []
  const promptToolCalls: string[] = []
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `mutex-tab-${++tabNumber}`,
    actionStabilityMs: 0,
    approveAgentAction: (prompt) => {
      promptToolCalls.push(prompt.toolCallId)
      return new Promise<'approved'>((resolve) => decisionResolvers.push(resolve))
    }
  })
  const opened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'mutex-open',
    url: 'https://example.test/'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  await workspace.setViewport(tabId, { x: 0, y: 0, width: 800, height: 600 })
  successful(await workspace.execute(runA, { type: 'snapshot', requestId: 'mutex-shot', tabId }))
  const action = (toolCallId: string, requestId: string): Promise<BrowserOutcome> =>
    workspace.execute(
      { ...runA, toolCallId },
      {
        type: 'scroll',
        requestId,
        tabId,
        deltaX: 0,
        deltaY: 120,
        expectedDocumentRevision: revision,
        requireActive: true
      }
    )
  const first = action('mutex-tool-1', 'mutex-action-1')
  await new Promise((resolve) => setImmediate(resolve))
  const second = action('mutex-tool-2', 'mutex-action-2')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(promptToolCalls, ['mutex-tool-1'])

  const refused = await second
  assert.equal(refused.ok, false)
  if (!refused.ok) assert.equal(refused.error.code, 'STALE_DOCUMENT')
  decisionResolvers[0]?.('approved')
  successful(await first)
  assert.deepEqual(promptToolCalls, ['mutex-tool-1'])
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'scroll').length,
    1
  )
})

test('an approval queued behind another tab never publishes a stale origin prompt', async () => {
  const engine = new InMemoryBrowserEngine()
  let releaseFirst!: () => void
  const firstDecision = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  const prompts: Array<{ toolCallId: string; origin: string }> = []
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `tail-tab-${++tabNumber}`,
    actionStabilityMs: 0,
    approveAgentAction: async (prompt) => {
      prompts.push({ toolCallId: prompt.toolCallId, origin: prompt.origin })
      if (prompts.length === 1) await firstDecision
      return 'approved'
    }
  })
  const firstOpened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'tail-open-a',
    url: 'https://a.example.test/'
  })
  successful(firstOpened)
  const firstTabId = firstOpened.snapshot.activeTabId as string
  const firstRevision = firstOpened.snapshot.tabs[0].documentRevision
  await workspace.setViewport(firstTabId, { x: 0, y: 0, width: 800, height: 600 })
  successful(
    await workspace.execute(runA, { type: 'snapshot', requestId: 'tail-shot-a', tabId: firstTabId })
  )
  const first = workspace.execute(
    { ...runA, toolCallId: 'tail-tool-a' },
    {
      type: 'scroll',
      requestId: 'tail-action-a',
      tabId: firstTabId,
      deltaX: 0,
      deltaY: 120,
      expectedDocumentRevision: firstRevision,
      requireActive: true
    }
  )
  while (prompts.length === 0) await new Promise((resolve) => setImmediate(resolve))

  const secondOpened = await workspace.execute(
    { kind: 'human' },
    { type: 'open', requestId: 'tail-open-b', url: 'https://b.example.test/' }
  )
  successful(secondOpened)
  const secondTabId = secondOpened.snapshot.activeTabId as string
  const secondTab = secondOpened.snapshot.tabs.find((tab) => tab.id === secondTabId)
  assert.ok(secondTab)
  await workspace.setViewport(secondTabId, { x: 0, y: 0, width: 800, height: 600 })
  successful(
    await workspace.execute(runA, {
      type: 'snapshot',
      requestId: 'tail-shot-b',
      tabId: secondTabId,
      expectedDocumentRevision: secondTab.documentRevision,
      requireActive: true
    })
  )
  const second = workspace.execute(
    { ...runA, toolCallId: 'tail-tool-b' },
    {
      type: 'scroll',
      requestId: 'tail-action-b',
      tabId: secondTabId,
      deltaX: 0,
      deltaY: 120,
      expectedDocumentRevision: secondTab.documentRevision,
      requireActive: true
    }
  )
  await new Promise((resolve) => setImmediate(resolve))
  successful(
    await workspace.execute(
      { kind: 'human' },
      {
        type: 'navigate',
        requestId: 'tail-navigate-b',
        tabId: secondTabId,
        url: 'https://changed.example.test/'
      }
    )
  )
  releaseFirst()
  const [firstResult, secondResult] = await Promise.all([first, second])
  assert.equal(firstResult.ok, false)
  assert.equal(secondResult.ok, false)
  assert.deepEqual(prompts, [{ toolCallId: 'tail-tool-a', origin: 'https://a.example.test' }])
  assert.equal(
    engine
      .recordedActions('engine-tab-2' as EngineTabHandle)
      .filter(({ command }) => command.type === 'scroll').length,
    0
  )
})

test('loopback form submission and declared irreversible input require explicit confirmation', async () => {
  for (const value of [
    {
      descriptor: {
        tagName: 'BUTTON',
        role: 'button',
        accessibleLabel: 'Save changes',
        formMethod: 'post',
        formAction: 'http://localhost:3000/submit',
        editable: false,
        submitsForm: true
      },
      consequence: 'write' as const,
      reason: 'form_submission'
    },
    {
      descriptor: {
        tagName: 'A',
        role: 'link',
        accessibleLabel: 'Finalize draft',
        editable: false,
        submitsForm: false
      },
      consequence: 'irreversible' as const,
      reason: 'irreversible'
    }
  ]) {
    const engine = new InMemoryBrowserEngine({ targetDescriptor: value.descriptor })
    const reasons: string[] = []
    let tabNumber = 0
    const workspace = new BrowserWorkspace({
      sessionId: 'session-1',
      partition: 'browser-project-a',
      engine,
      idFactory: () => `confirm-tab-${++tabNumber}`,
      actionStabilityMs: 0,
      approveAgentAction: async (prompt) => {
        reasons.push(prompt.reason)
        return 'approved'
      }
    })
    const opened = await workspace.execute(runA, {
      type: 'open',
      requestId: `confirm-open-${value.reason}`,
      url: 'http://localhost:3000/form'
    })
    successful(opened)
    const tabId = opened.snapshot.activeTabId as string
    const revision = opened.snapshot.tabs[0].documentRevision
    await workspace.setViewport(tabId, { x: 0, y: 0, width: 800, height: 600 })
    successful(
      await workspace.execute(runA, {
        type: 'snapshot',
        requestId: `confirm-shot-${value.reason}`,
        tabId
      })
    )
    successful(
      await workspace.execute(runA, {
        type: 'click',
        requestId: `confirm-click-${value.reason}`,
        tabId,
        x: 0,
        y: 0,
        expectedDocumentRevision: revision,
        consequence: value.consequence,
        requireActive: true
      })
    )
    assert.deepEqual(reasons, [value.reason])
  }
})

test('purchase-labelled external targets require handoff and cannot be approved', async () => {
  const engine = new InMemoryBrowserEngine({
    targetDescriptor: {
      tagName: 'BUTTON',
      role: 'button',
      accessibleLabel: 'Buy now',
      editable: false,
      submitsForm: true
    }
  })
  let approvals = 0
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `purchase-tab-${++tabNumber}`,
    actionStabilityMs: 0,
    approveAgentAction: async () => {
      approvals += 1
      return 'approved'
    }
  })
  const opened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'purchase-open',
    url: 'https://shop.example.test/'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  successful(await workspace.execute(runA, { type: 'snapshot', requestId: 'purchase-shot', tabId }))
  const result = await workspace.execute(runA, {
    type: 'click',
    requestId: 'purchase-click',
    tabId,
    x: 0,
    y: 0,
    expectedDocumentRevision: revision,
    consequence: 'write',
    requireActive: true
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'USER_HANDOFF_REQUIRED')
  assert.equal(approvals, 0)
})

test('external click approval only accepts a structural navigation allowlist', async () => {
  for (const value of [
    {
      descriptor: {
        tagName: 'A',
        role: 'link',
        accessibleLabel: 'Read details',
        editable: false,
        submitsForm: false
      },
      expectedOk: true
    },
    {
      descriptor: {
        tagName: 'BUTTON',
        role: 'button',
        accessibleLabel: 'Continue',
        editable: false,
        submitsForm: false
      },
      expectedOk: false
    }
  ]) {
    const engine = new InMemoryBrowserEngine({ targetDescriptor: value.descriptor })
    let approvals = 0
    let tabNumber = 0
    const workspace = new BrowserWorkspace({
      sessionId: 'session-1',
      partition: 'browser-project-a',
      engine,
      idFactory: () => `external-click-tab-${++tabNumber}`,
      actionStabilityMs: 0,
      approveAgentAction: async () => {
        approvals += 1
        return 'approved'
      }
    })
    const opened = await workspace.execute(runA, {
      type: 'open',
      requestId: `external-click-open-${value.descriptor.tagName}`,
      url: 'https://example.test/'
    })
    successful(opened)
    const tabId = opened.snapshot.activeTabId as string
    const revision = opened.snapshot.tabs[0].documentRevision
    await workspace.setViewport(tabId, { x: 0, y: 0, width: 800, height: 600 })
    successful(
      await workspace.execute(runA, {
        type: 'snapshot',
        requestId: `external-click-shot-${value.descriptor.tagName}`,
        tabId
      })
    )
    const result = await workspace.execute(runA, {
      type: 'click',
      requestId: `external-click-${value.descriptor.tagName}`,
      tabId,
      x: 0,
      y: 0,
      expectedDocumentRevision: revision,
      consequence: 'read',
      requireActive: true
    })
    assert.equal(result.ok, value.expectedOk)
    assert.equal(approvals, value.expectedOk ? 1 : 0)
    if (!result.ok) assert.equal(result.error.code, 'USER_HANDOFF_REQUIRED')
  }
})

test('external POST submission requires handoff before approval or input', async () => {
  const engine = new InMemoryBrowserEngine({
    targetDescriptor: {
      tagName: 'BUTTON',
      role: 'button',
      accessibleLabel: 'Continue',
      formMethod: 'post',
      formAction: 'https://example.test/submit',
      editable: false,
      submitsForm: true
    }
  })
  let approvals = 0
  let tabNumber = 0
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => `post-tab-${++tabNumber}`,
    actionStabilityMs: 0,
    approveAgentAction: async () => {
      approvals += 1
      return 'approved'
    }
  })
  const opened = await workspace.execute(runA, {
    type: 'open',
    requestId: 'post-open',
    url: 'https://example.test/form'
  })
  successful(opened)
  const tabId = opened.snapshot.activeTabId as string
  const revision = opened.snapshot.tabs[0].documentRevision
  successful(await workspace.execute(runA, { type: 'snapshot', requestId: 'post-shot', tabId }))
  const result = await workspace.execute(runA, {
    type: 'click',
    requestId: 'post-click',
    tabId,
    x: 0,
    y: 0,
    expectedDocumentRevision: revision,
    consequence: 'write',
    requireActive: true
  })
  assert.equal(result.ok, false)
  if (!result.ok) assert.equal(result.error.code, 'USER_HANDOFF_REQUIRED')
  assert.equal(approvals, 0)
  assert.equal(
    engine
      .recordedActions('engine-tab-1' as EngineTabHandle)
      .filter(({ command }) => command.type === 'click').length,
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
      code: 'PERMISSION_DENIED'
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
      code: 'USER_HANDOFF_REQUIRED'
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

test('browser actions serialize, reject a second same-snapshot action, and do not replay duplicate requests', async () => {
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
  if (!cancelled.ok) assert.equal(cancelled.error.code, 'STALE_DOCUMENT')

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
    text: 'private sentinel',
    consequence: 'write'
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
