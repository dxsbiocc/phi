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

test('preserves state and avoids engine calls for an invalid URL', async () => {
  const { engine, workspace, engineHandle } = createBrowserWorkspaceHarness()
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })
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
  let engineId = 0
  let tabId = 0
  const engine = new BlockingEngine({
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
  assert.equal(workspace.snapshot().tabs.length, 2)
  assert.equal(workspace.snapshot().tabs[1].url, 'https://second.test/')
})

test('deduplicates recent request IDs and evicts the oldest bounded entry', async () => {
  const { engine, workspace, engineHandle } = createBrowserWorkspaceHarness({
    recentRequestCap: 2
  })
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
  assert.equal(workspace.snapshot().tabs.length, 4)
  assert.equal(workspace.snapshot().tabs[3].url, 'https://fourth.test/')
})

test('isolates request IDs by actor, run, and tool-call identity', async () => {
  const { workspace } = createBrowserWorkspaceHarness()
  await workspace.execute(human, { type: 'open', requestId: 'shared', url: 'human.test' })
  await workspace.execute(
    { kind: 'agent', sessionId: 'session-1', runId: 'run-1', toolCallId: 'tool-1' },
    { type: 'open', requestId: 'shared', url: 'agent-one.test' }
  )
  await workspace.execute(
    { kind: 'agent', sessionId: 'session-1', runId: 'run-1', toolCallId: 'tool-2' },
    { type: 'open', requestId: 'shared', url: 'agent-two.test' }
  )
  assert.equal(workspace.snapshot().tabs.length, 3)
  assert.equal(workspace.snapshot().tabs[2].url, 'https://agent-two.test/')
})

test('rejects an agent from another Phi session before queueing or caching', async () => {
  const { engine, workspace } = createBrowserWorkspaceHarness()
  const denied = await workspace.execute(
    { kind: 'agent', sessionId: 'another-session', runId: 'run-1', toolCallId: 'tool-1' },
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
    const { engine, workspace, engineHandle } = createBrowserWorkspaceHarness({ recentRequestCap })
    await workspace.execute(human, { type: 'open', requestId: 'setup', url: 'setup.test' })
    await workspace.execute(human, {
      type: 'navigate',
      requestId: 'request-0',
      tabId: 'phi-tab-1',
      url: 'first.test'
    })
    for (let index = 1; index <= expectedCap; index += 1) {
      await workspace.execute(human, {
        type: 'navigate',
        requestId: `request-${index}`,
        tabId: 'phi-tab-1',
        url: `page-${index}.test`
      })
    }
    await workspace.execute(human, {
      type: 'navigate',
      requestId: 'request-0',
      tabId: 'phi-tab-1',
      url: 'reused-after-eviction.test'
    })
    assert.equal(workspace.snapshot().tabs[0].url, 'https://reused-after-eviction.test/')
    assert.equal(engine.recordedActions(engineHandle).length, expectedCap + 3)
  }
  for (const invalidCap of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
    await proveEviction(invalidCap, 128)
  }
  await proveEviction(2048, 1024)
})

test('returns deeply isolated snapshots and cached outcomes', async () => {
  const { workspace } = createBrowserWorkspaceHarness()
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

test('returns a structured error for commands deferred beyond the multi-tab task', async () => {
  const { workspace } = createBrowserWorkspaceHarness()
  await workspace.execute(human, { type: 'open', requestId: 'open-1', url: 'example.test' })
  const before = workspace.snapshot()
  const result = await workspace.execute(human, {
    type: 'history',
    requestId: 'history-1',
    tabId: 'phi-tab-1',
    direction: 'back'
  })
  assert.equal(result.ok, false)
  if (result.ok) assert.fail('history is deferred to a later task')
  assert.equal(result.error.code, 'CAPABILITY_UNAVAILABLE')
  assert.deepEqual(workspace.snapshot(), before)
})

test('defensively copies application origins from the policy context', async () => {
  const applicationOrigins = ['https://phi.internal']
  const engine = new InMemoryBrowserEngine({
    capabilities: browserCapabilities,
    idFactory: () => 'engine-tab-1'
  })
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
  const engine = new InMemoryBrowserEngine({
    capabilities: browserCapabilities,
    idFactory: () => engineHandle
  })
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
  assert.deepEqual(workspace.snapshot().tabs, [])
  assert.equal(workspace.snapshot().activeTabId, null)
})

test('disposes idempotently and returns safe outcomes after disposal', async () => {
  class CountingEngine extends InMemoryBrowserEngine {
    disposeCalls = 0
    override async dispose(): Promise<void> {
      this.disposeCalls += 1
      await super.dispose()
    }
  }
  const engine = new CountingEngine({
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
