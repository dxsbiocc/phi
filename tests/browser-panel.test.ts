import assert from 'node:assert/strict'
import test from 'node:test'
import type {
  BrowserOutcome,
  BrowserRendererBridge,
  BrowserRendererEventEnvelope,
  BrowserTabSnapshot,
  BrowserUiCommand,
  BrowserWorkspaceSnapshot
} from '../src/shared/browserTypes'
import {
  activeBrowserTab,
  browserHistoryCommand,
  browserReloadCommand,
  browserRestoreCommand,
  browserRetryCommand,
  browserSubmitCommand,
  canPresentNativeBrowser,
  createBrowserWorkspaceController,
  createBrowserRequestIdFactory
} from '../src/renderer/src/features/browser/lib/browserPanelState'
import { createBrowserViewportScheduler } from '../src/renderer/src/features/browser/hooks/useBrowserViewport'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
}

const tab = (overrides: Partial<BrowserTabSnapshot> = {}): BrowserTabSnapshot => ({
  id: 'tab-1',
  title: 'Example',
  url: 'https://example.test/',
  origin: 'https://example.test',
  phase: 'ready',
  canGoBack: true,
  canGoForward: false,
  isAgentControlled: false,
  documentRevision: 2,
  ...overrides
})

const snapshot = (
  tabs: BrowserTabSnapshot[] = [tab()],
  activeTabId: string | null = tabs[0]?.id ?? null
): BrowserWorkspaceSnapshot => ({
  sessionId: 'phi-session',
  activeTabId,
  tabs,
  capabilities: {
    presentation: 'native',
    screenshot: false,
    coordinateInput: false,
    semanticInspection: false,
    downloads: false,
    recording: false,
    persistentProfile: false
  },
  revision: 1
})

test('browser panel state builds bounded single-tab UI commands', () => {
  assert.deepEqual(browserSubmitCommand(snapshot([], null), ' example.test ', 'request-1'), {
    type: 'open',
    requestId: 'request-1',
    url: 'example.test'
  })
  assert.deepEqual(browserSubmitCommand(snapshot(), 'https://next.test', 'request-2'), {
    type: 'navigate',
    requestId: 'request-2',
    tabId: 'tab-1',
    url: 'https://next.test',
    expectedDocumentRevision: 2
  })
  assert.equal(browserSubmitCommand(snapshot(), '   ', 'request-3'), null)
  assert.deepEqual(browserHistoryCommand(snapshot(), 'back', 'request-4'), {
    type: 'history',
    requestId: 'request-4',
    tabId: 'tab-1',
    direction: 'back'
  })
  assert.equal(browserHistoryCommand(snapshot(), 'forward', 'request-5'), null)
  assert.deepEqual(browserReloadCommand(snapshot(), 'request-6'), {
    type: 'reload',
    requestId: 'request-6',
    tabId: 'tab-1'
  })
  assert.deepEqual(browserReloadCommand(snapshot([tab({ phase: 'loading' })]), 'request-7'), {
    type: 'stop',
    requestId: 'request-7',
    tabId: 'tab-1'
  })
  assert.deepEqual(browserRestoreCommand(snapshot([tab({ restorable: true })]), 'request-8'), {
    type: 'restore',
    requestId: 'request-8',
    tabId: 'tab-1'
  })
  assert.deepEqual(browserRetryCommand(snapshot([tab({ phase: 'failed' })]), 'request-9'), {
    type: 'navigate',
    requestId: 'request-9',
    tabId: 'tab-1',
    url: 'https://example.test/',
    expectedDocumentRevision: 2
  })
  assert.deepEqual(browserRetryCommand(snapshot([tab({ phase: 'crashed' })]), 'request-10'), {
    type: 'reload',
    requestId: 'request-10',
    tabId: 'tab-1'
  })

  assert.equal(activeBrowserTab(snapshot())?.id, 'tab-1')
  assert.equal(canPresentNativeBrowser(tab(), true), true)
  assert.equal(canPresentNativeBrowser(tab({ restorable: true }), true), false)
  assert.equal(canPresentNativeBrowser(tab({ phase: 'failed' }), true), false)
  assert.equal(canPresentNativeBrowser(tab(), false), false)

  const nextRequestId = createBrowserRequestIdFactory(() => 1234)
  const first = nextRequestId()
  const second = nextRequestId()
  assert.notEqual(first, second)
  assert.equal(first.length <= 128, true)
  assert.equal(second.length <= 128, true)
})

test('browser workspace controller filters session events and contains failures and late updates', async () => {
  const initial = snapshot()
  const snapshotGate = deferred<BrowserWorkspaceSnapshot>()
  let eventListener: ((envelope: BrowserRendererEventEnvelope) => void) | null = null
  let unsubscribeCalls = 0
  const executeCalls: BrowserUiCommand[] = []
  const bridge: BrowserRendererBridge = {
    execute: async (command): Promise<BrowserOutcome> => {
      executeCalls.push(command)
      return {
        ok: false,
        error: { code: 'NAVIGATION_FAILED', message: 'raw failure', retryable: true },
        snapshot: { ...initial, revision: 4 }
      }
    },
    snapshot: () => snapshotGate.promise,
    setViewport: async () => undefined,
    onEvent: (listener) => {
      eventListener = listener
      return () => {
        unsubscribeCalls += 1
        eventListener = null
      }
    }
  }
  const states: Array<{
    snapshot: BrowserWorkspaceSnapshot | null
    loading: boolean
    busy: boolean
    error: string | null
  }> = []
  const controller = createBrowserWorkspaceController({
    bridge,
    sessionId: 'phi-session',
    onState: (state) => states.push(state)
  })
  controller.start()
  eventListener?.({
    sessionId: 'phi-session',
    event: { type: 'snapshotChanged', snapshot: { ...initial, revision: 2 } }
  })
  assert.equal(states.at(-1)?.snapshot?.revision, 2)
  snapshotGate.resolve(initial)
  await snapshotGate.promise
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
  assert.equal(states.at(-1)?.snapshot?.revision, 2)
  assert.equal(states.at(-1)?.error, null)

  eventListener?.({
    sessionId: 'phi-background',
    event: { type: 'snapshotChanged', snapshot: { ...initial, revision: 9 } }
  })
  assert.equal(states.at(-1)?.snapshot?.revision, 2)
  eventListener?.({
    sessionId: 'phi-session',
    event: { type: 'snapshotChanged', snapshot: { ...initial, revision: 3 } }
  })
  assert.equal(states.at(-1)?.snapshot?.revision, 3)
  eventListener?.({
    sessionId: 'phi-session',
    event: {
      type: 'error',
      revision: 2,
      error: { code: 'ENGINE_UNAVAILABLE', message: 'stale raw secret', retryable: true }
    }
  })
  assert.equal(states.at(-1)?.error, null)
  eventListener?.({
    sessionId: 'phi-session',
    event: {
      type: 'error',
      revision: 3,
      error: { code: 'ENGINE_UNAVAILABLE', message: 'raw engine secret', retryable: true }
    }
  })
  assert.match(states.at(-1)?.error ?? '', /浏览器暂时不可用/)
  assert.doesNotMatch(states.at(-1)?.error ?? '', /raw engine secret/)

  const outcome = await controller.execute({
    type: 'reload',
    requestId: 'request-controller',
    tabId: 'tab-1'
  })
  assert.equal(outcome?.ok, false)
  assert.equal(
    states.some((state) => state.busy),
    true
  )
  assert.equal(states.at(-1)?.busy, false)
  assert.match(states.at(-1)?.error ?? '', /页面加载失败/)
  assert.equal(executeCalls.length, 1)

  controller.dispose()
  controller.dispose()
  assert.equal(unsubscribeCalls, 1)
  const countAfterDispose = states.length
  eventListener?.({
    sessionId: 'phi-session',
    event: { type: 'snapshotChanged', snapshot: { ...initial, revision: 10 } }
  })
  assert.equal(states.length, countAfterDispose)

  const lateGate = deferred<BrowserWorkspaceSnapshot>()
  const lateStates: unknown[] = []
  const lateController = createBrowserWorkspaceController({
    bridge: { ...bridge, snapshot: () => lateGate.promise },
    sessionId: 'phi-late',
    onState: (state) => lateStates.push(state)
  })
  lateController.start()
  lateController.dispose()
  const lateCount = lateStates.length
  lateGate.resolve({ ...initial, sessionId: 'phi-late', revision: 11 })
  await lateGate.promise
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
  assert.equal(lateStates.length, lateCount)
})

test('browser workspace controller preserves newer state and tab-level recovery actions', async () => {
  const initial = snapshot()
  const snapshotFailure = deferred<BrowserWorkspaceSnapshot>()
  let firstListener: ((envelope: BrowserRendererEventEnvelope) => void) | null = null
  const firstStates: Array<{
    snapshot: BrowserWorkspaceSnapshot | null
    error: string | null
  }> = []
  const firstController = createBrowserWorkspaceController({
    bridge: {
      execute: async (): Promise<never> => {
        throw new Error('unused')
      },
      snapshot: () => snapshotFailure.promise,
      setViewport: async () => undefined,
      onEvent: (listener) => {
        firstListener = listener
        return () => undefined
      }
    },
    sessionId: 'phi-session',
    onState: (state) => firstStates.push(state)
  })
  firstController.start()
  firstListener?.({
    sessionId: 'phi-session',
    event: { type: 'snapshotChanged', snapshot: { ...initial, revision: 2 } }
  })
  snapshotFailure.reject(new Error('late initial snapshot failure'))
  await snapshotFailure.promise.catch(() => undefined)
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
  assert.equal(firstStates.at(-1)?.snapshot?.revision, 2)
  assert.equal(firstStates.at(-1)?.error, null)

  const oldOutcome = deferred<BrowserOutcome>()
  let secondListener: ((envelope: BrowserRendererEventEnvelope) => void) | null = null
  let executeCount = 0
  const secondStates: Array<{
    snapshot: BrowserWorkspaceSnapshot | null
    error: string | null
  }> = []
  const secondController = createBrowserWorkspaceController({
    bridge: {
      execute: async () => {
        executeCount += 1
        if (executeCount === 1) return oldOutcome.promise
        if (executeCount === 2) {
          return {
            ok: false,
            error: { code: 'INVALID_URL', message: 'raw invalid url', retryable: false },
            snapshot: { ...initial, revision: 5 }
          }
        }
        if (executeCount === 3) return { ok: true, snapshot: { ...initial, revision: 5 } }
        return {
          ok: false,
          error: { code: 'RENDERER_CRASHED', message: 'raw crash', retryable: true },
          snapshot: {
            ...initial,
            revision: 6,
            tabs: [tab({ phase: 'crashed' })]
          }
        }
      },
      snapshot: async () => initial,
      setViewport: async () => undefined,
      onEvent: (listener) => {
        secondListener = listener
        return () => undefined
      }
    },
    sessionId: 'phi-session',
    onState: (state) => secondStates.push(state)
  })
  secondController.start()
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
  const pending = secondController.execute({
    type: 'reload',
    requestId: 'old-command',
    tabId: 'tab-1'
  })
  secondListener?.({
    sessionId: 'phi-session',
    event: { type: 'snapshotChanged', snapshot: { ...initial, revision: 5 } }
  })
  oldOutcome.resolve({
    ok: false,
    error: { code: 'ENGINE_UNAVAILABLE', message: 'raw old failure', retryable: true },
    snapshot: { ...initial, revision: 4 }
  })
  await pending
  assert.equal(secondStates.at(-1)?.snapshot?.revision, 5)
  assert.equal(secondStates.at(-1)?.error, null)

  await secondController.execute({
    type: 'navigate',
    requestId: 'equal-invalid',
    tabId: 'tab-1',
    url: 'invalid'
  })
  assert.match(secondStates.at(-1)?.error ?? '', /网址/)
  await secondController.execute({
    type: 'reload',
    requestId: 'equal-success',
    tabId: 'tab-1'
  })
  assert.equal(secondStates.at(-1)?.error, null)

  await secondController.execute({
    type: 'reload',
    requestId: 'crash-recovery',
    tabId: 'tab-1'
  })
  assert.equal(secondStates.at(-1)?.snapshot?.tabs[0].phase, 'crashed')
  assert.equal(secondStates.at(-1)?.error, null)
})

test('browser workspace controller orders same-revision feedback by invocation sequence', async () => {
  const current = { ...snapshot(), revision: 5 }
  const first = deferred<BrowserOutcome>()
  const second = deferred<BrowserOutcome>()
  const outcomes = [first, second]
  let eventListener: ((envelope: BrowserRendererEventEnvelope) => void) | null = null
  const states: Array<{
    snapshot: BrowserWorkspaceSnapshot | null
    error: string | null
  }> = []
  const controller = createBrowserWorkspaceController({
    bridge: {
      execute: () => {
        const outcome = outcomes.shift()
        assert.ok(outcome)
        return outcome.promise
      },
      snapshot: async () => current,
      setViewport: async () => undefined,
      onEvent: (listener) => {
        eventListener = listener
        return () => undefined
      }
    },
    sessionId: 'phi-session',
    onState: (state) => states.push(state)
  })
  controller.start()
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))

  const olderCommand = controller.execute({
    type: 'reload',
    requestId: 'older-command',
    tabId: 'tab-1'
  })
  const newerCommand = controller.execute({
    type: 'reload',
    requestId: 'newer-command',
    tabId: 'tab-1'
  })
  second.resolve({ ok: true, snapshot: current })
  await newerCommand
  first.resolve({
    ok: false,
    error: { code: 'ENGINE_UNAVAILABLE', message: 'raw late failure', retryable: true },
    snapshot: current
  })
  await olderCommand
  assert.equal(states.at(-1)?.error, null)

  eventListener?.({
    sessionId: 'phi-session',
    event: {
      type: 'error',
      revision: 7,
      error: { code: 'ENGINE_UNAVAILABLE', message: 'raw newer event', retryable: true }
    }
  })
  eventListener?.({
    sessionId: 'phi-session',
    event: { type: 'snapshotChanged', snapshot: { ...current, revision: 6 } }
  })
  assert.equal(states.at(-1)?.snapshot?.revision, 5)
  assert.match(states.at(-1)?.error ?? '', /浏览器暂时不可用/)

  eventListener?.({
    sessionId: 'foreign-session',
    event: { type: 'snapshotChanged', snapshot: { ...current, revision: 99 } }
  })
  eventListener?.({
    sessionId: 'phi-session',
    event: { type: 'snapshotChanged', snapshot: { ...current, revision: 7 } }
  })
  assert.equal(states.at(-1)?.snapshot?.revision, 7)
  assert.equal(states.at(-1)?.error, null)
})

test('browser viewport scheduler coalesces the latest rect and cleanup prevents stale re-show', async () => {
  const viewportCalls: Array<{
    tabId: string
    viewport: { x: number; y: number; width: number; height: number } | null
  }> = []
  const bridge = {
    execute: async (): Promise<never> => {
      throw new Error('unused')
    },
    snapshot: async (): Promise<never> => {
      throw new Error('unused')
    },
    setViewport: async (input: (typeof viewportCalls)[number]): Promise<void> => {
      viewportCalls.push({
        tabId: input.tabId,
        viewport: input.viewport ? { ...input.viewport } : null
      })
    },
    onEvent: (): (() => void) => () => undefined
  } satisfies BrowserRendererBridge
  let rect = { x: 10.2, y: 20.4, width: 300.1, height: 200.2 }
  let nextFrameId = 0
  const frames = new Map<number, FrameRequestCallback>()
  const cancelled: number[] = []
  const scheduler = createBrowserViewportScheduler({
    bridge,
    tabId: 'tab-1',
    getRect: () => rect,
    requestFrame: (callback) => {
      const id = ++nextFrameId
      frames.set(id, callback)
      return id
    },
    cancelFrame: (id) => {
      cancelled.push(id)
      frames.delete(id)
    }
  })

  scheduler.schedule()
  scheduler.schedule()
  assert.equal(frames.size, 1)
  rect = { x: 30.8, y: 40.1, width: 500.4, height: 260.7 }
  const firstFrameEntry = frames.entries().next().value
  assert.ok(firstFrameEntry)
  const [firstFrameId, firstFrame] = firstFrameEntry
  frames.delete(firstFrameId)
  assert.ok(firstFrame)
  firstFrame(0)
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
  assert.deepEqual(viewportCalls, [
    {
      tabId: 'tab-1',
      viewport: { x: 30.8, y: 40.1, width: 500.4, height: 260.7 }
    }
  ])

  scheduler.hide()
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
  assert.deepEqual(viewportCalls.at(-1), { tabId: 'tab-1', viewport: null })
  scheduler.schedule()
  const resumedFrameEntry = frames.entries().next().value
  assert.ok(resumedFrameEntry)
  const [resumedFrameId, resumedFrame] = resumedFrameEntry
  frames.delete(resumedFrameId)
  resumedFrame(0)
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
  assert.deepEqual(viewportCalls.at(-1), {
    tabId: 'tab-1',
    viewport: { x: 30.8, y: 40.1, width: 500.4, height: 260.7 }
  })

  scheduler.schedule()
  const staleFrame = frames.values().next().value
  assert.ok(staleFrame)
  scheduler.dispose()
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
  assert.equal(cancelled.length, 1)
  assert.deepEqual(viewportCalls.at(-1), { tabId: 'tab-1', viewport: null })
  staleFrame(1)
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
  assert.deepEqual(viewportCalls.at(-1), { tabId: 'tab-1', viewport: null })

  const zeroScheduler = createBrowserViewportScheduler({
    bridge,
    tabId: 'tab-2',
    getRect: () => ({ x: 0, y: 0, width: 0, height: 20 }),
    requestFrame: (callback) => {
      callback(0)
      return 99
    },
    cancelFrame: () => undefined
  })
  zeroScheduler.schedule()
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
  assert.deepEqual(viewportCalls.at(-1), { tabId: 'tab-2', viewport: null })

  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)
  try {
    const failingScheduler = createBrowserViewportScheduler({
      bridge: {
        ...bridge,
        setViewport: async (): Promise<void> => {
          throw new Error('raw viewport failure')
        }
      },
      tabId: 'tab-failure',
      getRect: () => ({ x: 0, y: 0, width: 100, height: 100 }),
      requestFrame: (callback) => {
        setImmediate(() => callback(0))
        return 100
      },
      cancelFrame: () => undefined
    })
    failingScheduler.schedule()
    await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
    await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
    failingScheduler.dispose()
    await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
    assert.deepEqual(unhandled, [])
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
})
