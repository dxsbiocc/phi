import assert from 'node:assert/strict'
import test from 'node:test'
import type { BrowserCapabilities, BrowserOutcome } from '../src/shared/browserTypes'
import type {
  EngineCommand,
  EngineResult,
  EngineTabHandle
} from '../src/main/browser/browser-engine'
import { InMemoryBrowserEngine } from '../src/main/browser/in-memory-browser-engine'
import { BrowserWorkspace } from '../src/main/browser/browser-workspace'

const human = { kind: 'human' } as const

const capabilities: BrowserCapabilities = {
  presentation: 'native',
  screenshot: true,
  coordinateInput: true,
  semanticInspection: false,
  downloads: false,
  recording: false,
  persistentProfile: false
}

function createHarness(options: { recentRequestCap?: number } = {}): {
  engine: InMemoryBrowserEngine
  workspace: BrowserWorkspace
  engineHandle: EngineTabHandle
} {
  const engineHandle = 'engine-tab-1' as EngineTabHandle
  const engine = new InMemoryBrowserEngine({
    capabilities,
    idFactory: () => engineHandle,
    now: () => 42
  })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    policyContext: { applicationOrigins: ['https://phi.internal'] },
    idFactory: () => 'phi-tab-1',
    now: () => 42,
    recentRequestCap: options.recentRequestCap
  })
  return { engine, workspace, engineHandle }
}

function successful(
  outcome: BrowserOutcome
): asserts outcome is Extract<BrowserOutcome, { ok: true }> {
  assert.equal(outcome.ok, true)
}

test('opens, navigates, and snapshots one stable Phi tab', async () => {
  const { workspace } = createHarness()

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

test('reduces loading, title, navigation, failure, and crash engine events', async () => {
  const { engine, workspace, engineHandle } = createHarness()
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
  const { engine, workspace, engineHandle } = createHarness()
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
  const engine = new EventAheadEngine({ capabilities, idFactory: () => 'engine-tab-1' })
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
  const engine = new ResultOnlyCommitEngine({ capabilities, idFactory: () => 'engine-tab-1' })
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
  const { engine, workspace, engineHandle } = createHarness()
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
  const { engine, workspace, engineHandle } = createHarness()
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

test('preserves state and avoids engine calls for an invalid URL', async () => {
  const { engine, workspace, engineHandle } = createHarness()
  const opened = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-1',
    url: 'example.test'
  })
  successful(opened)
  const before = workspace.snapshot()
  const actionCount = engine.recordedActions(engineHandle).length

  const rejected = await workspace.execute(human, {
    type: 'navigate',
    requestId: 'navigate-invalid',
    tabId: 'phi-tab-1',
    url: 'http://public.test/private'
  })

  assert.equal(rejected.ok, false)
  if (rejected.ok) assert.fail('public HTTP must be rejected')
  assert.equal(rejected.error.code, 'SCHEME_BLOCKED')
  assert.deepEqual(workspace.snapshot(), before)
  assert.equal(engine.recordedActions(engineHandle).length, actionCount)
})

test('serializes concurrent commands before reaching the engine', async () => {
  let releaseFirst!: () => void
  const firstGate = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  class BlockingEngine extends InMemoryBrowserEngine {
    readonly starts: string[] = []
    #callCount = 0

    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      this.starts.push(command.type === 'navigate' ? command.url : command.type)
      this.#callCount += 1
      if (this.#callCount === 1) await firstGate
      return super.execute(handle, command, signal)
    }
  }
  const engine = new BlockingEngine({ capabilities, idFactory: () => 'engine-tab-1' })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => 'phi-tab-1',
    now: () => 42
  })

  const first = workspace.execute(human, {
    type: 'open',
    requestId: 'open-1',
    url: 'first.test'
  })
  const second = workspace.execute(human, {
    type: 'open',
    requestId: 'open-2',
    url: 'second.test'
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(engine.starts, ['https://first.test/'])

  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(engine.starts, ['https://first.test/', 'https://second.test/'])
  assert.equal(workspace.snapshot().tabs[0].url, 'https://second.test/')
})

test('deduplicates recent request IDs and evicts the oldest bounded entry', async () => {
  const { engine, workspace, engineHandle } = createHarness({ recentRequestCap: 2 })

  const first = await workspace.execute(human, {
    type: 'open',
    requestId: 'request-1',
    url: 'first.test'
  })
  const duplicate = await workspace.execute(human, {
    type: 'open',
    requestId: 'request-1',
    url: 'ignored.test'
  })
  assert.deepEqual(duplicate, first)
  assert.equal(engine.recordedActions(engineHandle).length, 1)

  await workspace.execute(human, { type: 'open', requestId: 'request-2', url: 'second.test' })
  await workspace.execute(human, { type: 'open', requestId: 'request-3', url: 'third.test' })
  await workspace.execute(human, { type: 'open', requestId: 'request-1', url: 'fourth.test' })

  assert.equal(workspace.snapshot().tabs[0].url, 'https://fourth.test/')
  assert.equal(engine.recordedActions(engineHandle).length, 4)
})

test('isolates request IDs by actor, run, and tool-call identity', async () => {
  const { engine, workspace, engineHandle } = createHarness()
  await workspace.execute(human, { type: 'open', requestId: 'shared', url: 'human.test' })
  await workspace.execute(
    {
      kind: 'agent',
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'tool-1'
    },
    { type: 'open', requestId: 'shared', url: 'agent-one.test' }
  )
  await workspace.execute(
    {
      kind: 'agent',
      sessionId: 'session-1',
      runId: 'run-1',
      toolCallId: 'tool-2'
    },
    { type: 'open', requestId: 'shared', url: 'agent-two.test' }
  )

  assert.equal(workspace.snapshot().tabs[0].url, 'https://agent-two.test/')
  assert.equal(engine.recordedActions(engineHandle).length, 3)
})

test('rejects an agent from another Phi session before queueing or caching', async () => {
  const { engine, workspace } = createHarness()

  const denied = await workspace.execute(
    {
      kind: 'agent',
      sessionId: 'another-session',
      runId: 'run-1',
      toolCallId: 'tool-1'
    },
    { type: 'open', requestId: 'shared', url: 'denied.test' }
  )
  assert.equal(denied.ok, false)
  if (denied.ok) assert.fail('cross-session agents must be denied')
  assert.equal(denied.error.code, 'PERMISSION_DENIED')
  assert.deepEqual(workspace.snapshot().tabs, [])

  const allowed = await workspace.execute(human, {
    type: 'open',
    requestId: 'shared',
    url: 'allowed.test'
  })
  successful(allowed)
  assert.equal(allowed.snapshot.tabs[0].url, 'https://allowed.test/')
  assert.equal(engine.recordedActions('engine-tab-1' as EngineTabHandle).length, 1)
})

test('normalizes invalid request-cache caps to bounded safe limits with tied clocks', async () => {
  async function proveEviction(recentRequestCap: number, expectedCap: number): Promise<void> {
    const { engine, workspace, engineHandle } = createHarness({ recentRequestCap })
    await workspace.execute(human, { type: 'open', requestId: 'request-0', url: 'first.test' })
    for (let index = 1; index <= expectedCap; index += 1) {
      await workspace.execute(human, {
        type: 'open',
        requestId: `request-${index}`,
        url: `page-${index}.test`
      })
    }
    await workspace.execute(human, {
      type: 'open',
      requestId: 'request-0',
      url: 'reused-after-eviction.test'
    })

    assert.equal(workspace.snapshot().tabs[0].url, 'https://reused-after-eviction.test/')
    assert.equal(engine.recordedActions(engineHandle).length, expectedCap + 2)
  }

  for (const invalidCap of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    await proveEviction(invalidCap, 128)
  }
  await proveEviction(2048, 1024)
})

test('returns deeply isolated snapshots and cached outcomes', async () => {
  const { workspace } = createHarness()
  const outcome = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-1',
    url: 'example.test'
  })
  successful(outcome)

  outcome.snapshot.capabilities.screenshot = false
  outcome.snapshot.tabs[0].title = 'tampered'
  outcome.snapshot.tabs[0].error = {
    code: 'ENGINE_UNAVAILABLE',
    message: 'tampered',
    retryable: false
  }

  const fresh = workspace.snapshot()
  assert.equal(fresh.capabilities.screenshot, true)
  assert.equal(fresh.tabs[0].title, 'New tab')
  assert.equal(fresh.tabs[0].error, undefined)

  const duplicate = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-1',
    url: 'ignored.test'
  })
  successful(duplicate)
  assert.equal(duplicate.snapshot.capabilities.screenshot, true)
  assert.equal(duplicate.snapshot.tabs[0].title, 'New tab')
})

test('returns a structured error for commands deferred beyond the single-tab task', async () => {
  const { workspace } = createHarness()
  const before = workspace.snapshot()

  const result = await workspace.execute(human, {
    type: 'newTab',
    requestId: 'new-tab-1',
    url: 'example.test'
  })

  assert.equal(result.ok, false)
  if (result.ok) assert.fail('newTab is deferred to the multi-tab task')
  assert.equal(result.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.deepEqual(workspace.snapshot(), before)
})

test('defensively copies application origins from the policy context', async () => {
  const applicationOrigins = ['https://phi.internal']
  const engine = new InMemoryBrowserEngine({ capabilities, idFactory: () => 'engine-tab-1' })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    policyContext: { applicationOrigins },
    idFactory: () => 'phi-tab-1',
    now: () => 42
  })
  applicationOrigins.splice(0, 1, 'https://mutated.test')

  const result = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-1',
    url: 'https://phi.internal/private'
  })

  assert.equal(result.ok, false)
  if (result.ok) assert.fail('the copied application origin must remain blocked')
  assert.equal(result.error.code, 'SCHEME_BLOCKED')
  assert.deepEqual(workspace.snapshot().tabs, [])
})

test('cleans up a created engine tab when Phi tab registration fails', async () => {
  const engineHandle = 'engine-tab-1' as EngineTabHandle
  const engine = new InMemoryBrowserEngine({ capabilities, idFactory: () => engineHandle })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => {
      throw new Error('ID generation failed')
    },
    now: () => 42
  })

  const result = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-1',
    url: 'example.test'
  })

  assert.equal(result.ok, false)
  assert.equal(engine.hasTab(engineHandle), false)
  assert.deepEqual(workspace.snapshot().tabs, [])
})

test('aborts in-flight work, skips queued commands, and ignores late updates during disposal', async () => {
  class AbortAwareBlockingEngine extends InMemoryBrowserEngine {
    readonly starts: string[] = []
    observedSignal: AbortSignal | undefined
    disposeCalls = 0
    release: () => void = () => undefined

    override async execute(
      handle: EngineTabHandle,
      command: EngineCommand,
      signal?: AbortSignal
    ): Promise<EngineResult> {
      this.starts.push(command.type === 'navigate' ? command.url : command.type)
      if (this.starts.length > 1) return super.execute(handle, command, signal)
      this.observedSignal = signal
      return new Promise<EngineResult>((resolve) => {
        let finished = false
        const finish = (): void => {
          if (finished) return
          finished = true
          this.emitTitle(handle, 'Late title')
          resolve({
            ok: true,
            state: {
              url: 'https://late-result.test/',
              title: 'Late result',
              isLoading: false,
              canGoBack: true,
              canGoForward: false,
              documentRevision: 99,
              navigationRevision: 99
            }
          })
        }
        this.release = finish
        signal?.addEventListener('abort', finish, { once: true })
      })
    }

    override async dispose(): Promise<void> {
      this.disposeCalls += 1
      await super.dispose()
    }
  }
  const engine = new AbortAwareBlockingEngine({
    capabilities,
    idFactory: () => 'engine-tab-1'
  })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => 'phi-tab-1',
    now: () => 42
  })
  const first = workspace.execute(human, {
    type: 'open',
    requestId: 'open-1',
    url: 'first.test'
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const second = workspace.execute(human, {
    type: 'open',
    requestId: 'open-2',
    url: 'second.test'
  })
  let lateListenerCalls = 0

  const disposing = workspace.dispose()
  workspace.subscribe(() => {
    lateListenerCalls += 1
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  const wasAborted = engine.observedSignal?.aborted === true
  engine.release()
  const [firstOutcome, secondOutcome] = await Promise.all([first, second, disposing]).then(
    ([firstResult, secondResult]) => [firstResult, secondResult]
  )

  assert.equal(wasAborted, true)
  assert.deepEqual(engine.starts, ['https://first.test/'])
  assert.equal(firstOutcome.ok, false)
  assert.equal(secondOutcome.ok, false)
  assert.equal(engine.disposeCalls, 1)
  assert.equal(lateListenerCalls, 0)
  assert.equal(workspace.snapshot().tabs[0].title, 'New tab')
  assert.equal(workspace.snapshot().tabs[0].url, 'about:blank')
})

test('disposes idempotently and returns safe outcomes after disposal', async () => {
  class CountingEngine extends InMemoryBrowserEngine {
    disposeCalls = 0

    override async dispose(): Promise<void> {
      this.disposeCalls += 1
      await super.dispose()
    }
  }
  const engine = new CountingEngine({ capabilities, idFactory: () => 'engine-tab-1' })
  const workspace = new BrowserWorkspace({
    sessionId: 'session-1',
    partition: 'browser-project-a',
    engine,
    idFactory: () => 'phi-tab-1',
    now: () => 42
  })
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })

  await Promise.all([workspace.dispose(), workspace.dispose()])
  assert.equal(engine.disposeCalls, 1)

  const result = await workspace.execute(human, {
    type: 'open',
    requestId: 'open-after-dispose',
    url: 'after.test'
  })
  assert.equal(result.ok, false)
  if (result.ok) assert.fail('disposed workspaces cannot execute commands')
  assert.equal(result.error.code, 'ENGINE_UNAVAILABLE')

  let calls = 0
  const unsubscribe = workspace.subscribe(() => {
    calls += 1
  })
  unsubscribe()
  unsubscribe()
  assert.equal(calls, 0)
})
