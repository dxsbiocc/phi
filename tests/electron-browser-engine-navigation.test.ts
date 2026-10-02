import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { EngineEvent } from '../src/main/browser/browser-engine'
import {
  ElectronBrowserEngine,
  type BrowserSessionLike,
  type BrowserWebContentsViewLike,
  type BrowserWebContentsViewOptions
} from '../src/main/browser/electron-browser-engine'

class FakeSession extends EventEmitter implements BrowserSessionLike {
  checkHandler: ((...args: unknown[]) => boolean) | null = null
  requestHandler: ((...args: unknown[]) => void) | null = null
  checkSets = 0
  requestSets = 0
  requestInstallError: Error | null = null
  failDownloadOn = false
  failDownloadOff = false
  failCheckReset = false
  failRequestReset = false

  setPermissionCheckHandler(handler: ((...args: unknown[]) => boolean) | null): void {
    if (handler === null && this.failCheckReset) throw new Error('check reset failed')
    this.checkHandler = handler
    this.checkSets += 1
  }

  setPermissionRequestHandler(handler: ((...args: unknown[]) => void) | null): void {
    if (handler === null && this.failRequestReset) throw new Error('request reset failed')
    if (handler && this.requestInstallError) throw this.requestInstallError
    this.requestHandler = handler
    this.requestSets += 1
  }

  override on(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (event === 'will-download' && this.failDownloadOn) throw new Error('download on failed')
    return super.on(event, listener)
  }

  override off(event: string | symbol, listener: (...args: unknown[]) => void): this {
    if (event === 'will-download' && this.failDownloadOff) throw new Error('download off failed')
    return super.off(event, listener)
  }
}

class FakeWebContents extends EventEmitter {
  readonly loadedUrls: string[] = []
  readonly navigationHistory = {
    back: false,
    forward: false,
    backCalls: 0,
    forwardCalls: 0,
    canGoBack: (): boolean => this.navigationHistory.back,
    canGoForward: (): boolean => this.navigationHistory.forward,
    goBack: (): void => {
      this.navigationHistory.backCalls += 1
    },
    goForward: (): void => {
      this.navigationHistory.forwardCalls += 1
    }
  }
  reloadCalls = 0
  stopCalls = 0
  closeCalls = 0
  closeDevToolsCalls = 0
  loadError: Error | null = null
  navigationLoadGate: Promise<void> | null = null
  emitDuringBlank = false
  closeError: Error | null = null
  securityInstalledAtFirstLoad = false

  constructor(readonly session: FakeSession) {
    super()
  }

  async loadURL(url: string): Promise<void> {
    this.loadedUrls.push(url)
    if (this.loadedUrls.length === 1) {
      this.securityInstalledAtFirstLoad =
        this.session.checkHandler !== null &&
        this.session.requestHandler !== null &&
        this.session.listenerCount('will-download') === 1 &&
        this.listenerCount('login') === 1
    }
    if (url === 'about:blank' && this.emitDuringBlank) {
      this.emit('did-start-loading')
      this.emit('did-frame-navigate', {}, 'about:blank', 200, 'OK', true)
      this.emit('did-stop-loading')
    }
    if (this.loadedUrls.length > 1 && this.navigationLoadGate) await this.navigationLoadGate
    if (this.loadError) throw this.loadError
  }

  reload(): void {
    this.reloadCalls += 1
  }

  stop(): void {
    this.stopCalls += 1
  }

  close(): void {
    this.closeCalls += 1
    if (this.closeError) throw this.closeError
  }

  closeDevTools(): void {
    this.closeDevToolsCalls += 1
  }
}

function harness(
  options: {
    session?: FakeSession
    applicationOrigins?: string[]
    emitDuringBlank?: boolean
    loadError?: Error
    closeError?: Error
    navigationLoadGate?: Promise<void>
  } = {}
): {
  engine: ElectronBrowserEngine
  session: FakeSession
  contents: FakeWebContents[]
} {
  const session = options.session ?? new FakeSession()
  const contents: FakeWebContents[] = []
  class FakeView implements BrowserWebContentsViewLike {
    readonly webContents: FakeWebContents
    constructor(readonly viewOptions: BrowserWebContentsViewOptions) {
      this.webContents = new FakeWebContents(session)
      this.webContents.emitDuringBlank = options.emitDuringBlank ?? false
      this.webContents.loadError = options.loadError ?? null
      this.webContents.closeError = options.closeError ?? null
      this.webContents.navigationLoadGate = options.navigationLoadGate ?? null
      contents.push(this.webContents)
    }
    setBounds(): void {
      return
    }
    setVisible(): void {
      return
    }
  }
  const children: BrowserWebContentsViewLike[] = []
  const windowEvents = new EventEmitter()
  const applicationOrigins = options.applicationOrigins ?? []
  const engine = new ElectronBrowserEngine({
    WebContentsView: FakeView,
    getOwningWindow: () => ({
      contentView: {
        addChildView: (view) => children.push(view),
        removeChildView: (view) => {
          const index = children.indexOf(view)
          if (index >= 0) children.splice(index, 1)
        }
      },
      getContentBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }),
      isMinimized: () => false,
      isVisible: () => true,
      on: windowEvents.on.bind(windowEvents),
      off: windowEvents.off.bind(windowEvents),
      listenerCount: windowEvents.listenerCount.bind(windowEvents)
    }),
    policyContext: { applicationOrigins },
    now: () => 123,
    idFactory: () => `tab-${contents.length + 1}`
  })
  return { engine, session, contents }
}

function navigationDetails(
  url: string,
  isMainFrame = true
): {
  url: string
  isMainFrame: boolean
  prevented: boolean
  preventDefault: () => void
} {
  const details = {
    url,
    isMainFrame,
    prevented: false,
    preventDefault(): void {
      details.prevented = true
    }
  }
  return details
}

test('executes navigation history reload and stop with navigationHistory flags', async () => {
  const { engine, contents } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  const web = contents[0]
  web.navigationHistory.back = true
  web.navigationHistory.forward = true

  const navigate = await engine.execute(handle, {
    type: 'navigate',
    url: 'https://example.test/'
  })
  assert.equal(navigate.ok && navigate.state.navigationRevision, 1)
  assert.deepEqual(web.loadedUrls, ['about:blank', 'https://example.test/'])

  await engine.execute(handle, { type: 'history', direction: 'back' })
  await engine.execute(handle, { type: 'history', direction: 'forward' })
  const reloaded = await engine.execute(handle, { type: 'reload' })
  await engine.execute(handle, { type: 'stop' })
  assert.equal(web.navigationHistory.backCalls, 1)
  assert.equal(web.navigationHistory.forwardCalls, 1)
  assert.equal(web.reloadCalls, 1)
  assert.equal(web.stopCalls, 1)
  assert.equal(reloaded.ok && reloaded.state.navigationRevision, 4)
  assert.equal(reloaded.ok && reloaded.state.canGoBack, true)
  assert.equal(reloaded.ok && reloaded.state.canGoForward, true)
})

test('returns a loading navigation state before loadURL settles so stop can preempt it', async () => {
  let releaseLoad!: () => void
  const navigationLoadGate = new Promise<void>((resolve) => {
    releaseLoad = resolve
  })
  const { engine, contents } = harness({ navigationLoadGate })
  const handle = await engine.createTab({ partition: 'partition-a' })
  let navigationSettled = false
  const navigating = engine
    .execute(handle, { type: 'navigate', url: 'https://slow.test/' })
    .then((result) => {
      navigationSettled = true
      return result
    })
  await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))

  assert.equal(navigationSettled, true)
  const loading = await navigating
  assert.equal(loading.ok && loading.state.isLoading, true)
  const stopped = await engine.execute(handle, { type: 'stop' })
  assert.equal(stopped.ok, true)
  assert.equal(stopped.ok && stopped.state.isLoading, false)
  assert.equal(contents[0].stopCalls, 1)
  releaseLoad()
  await navigationLoadGate
})

test('translates loading title and main-frame commits without counting subframes', async () => {
  const { engine, contents } = harness({ emitDuringBlank: true })
  const handle = await engine.createTab({ partition: 'partition-a' })
  const events: EngineEvent[] = []
  engine.subscribe((event) => events.push(event))
  const web = contents[0]

  web.emit('did-start-loading')
  web.emit('page-title-updated', {}, 'Example title')
  web.emit('did-frame-navigate', {}, 'https://frame.test/', 200, 'OK', false)
  web.emit('did-frame-navigate', {}, 'https://main.test/', 200, 'OK', true)
  web.emit('did-stop-loading')

  assert.deepEqual(
    events.map((event) => event.type),
    ['loadingChanged', 'titleChanged', 'navigationCommitted', 'loadingChanged']
  )
  const committed = events[2]
  assert.equal(committed.type === 'navigationCommitted' && committed.documentRevision, 1)
  assert.equal(committed.type === 'navigationCommitted' && committed.url, 'https://main.test/')
  assert.equal(
    events.every((event) => event.at === 123),
    true
  )

  const result = await engine.execute(handle, { type: 'stop' })
  assert.equal(result.ok && result.state.documentRevision, 1)
  assert.equal(result.ok && result.state.title, 'Example title')
})

test('accepts only the exact internal about:blank commit after reload', async () => {
  const { engine, contents } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  const events: EngineEvent[] = []
  engine.subscribe((event) => events.push(event))

  await engine.execute(handle, { type: 'reload' })
  contents[0].emit('did-frame-navigate', {}, 'about:blank', -1, '', true)
  const state = await engine.execute(handle, { type: 'stop' })
  assert.equal(
    events.some((event) => event.type === 'loadFailed'),
    false
  )
  assert.equal(state.ok && state.state.url, 'about:blank')
  assert.equal(state.ok && state.state.documentRevision, 1)

  const blocked = navigationDetails('about:config')
  contents[0].emit('will-redirect', blocked)
  assert.equal(blocked.prevented, true)
})

test('reports main-frame failures, ignores aborted and subframe loads, and reports crashes', async () => {
  const { engine, contents } = harness()
  await engine.createTab({ partition: 'partition-a' })
  const events: EngineEvent[] = []
  engine.subscribe((event) => events.push(event))
  const web = contents[0]

  web.emit('did-fail-load', {}, -105, 'raw dns detail', 'https://failed.test/', false)
  web.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://aborted.test/', true)
  web.emit('did-fail-load', {}, -105, 'raw dns detail', 'https://failed.test/', true)
  web.emit('render-process-gone', {}, { reason: 'crashed' })

  assert.deepEqual(
    events.map((event) => event.type),
    ['loadFailed', 'crashed']
  )
  const failed = events[0]
  assert.equal(failed.type === 'loadFailed' && failed.message, 'Page failed to load')
  assert.equal(JSON.stringify(failed).includes('raw dns detail'), false)
  assert.equal(events[1].type === 'crashed' && events[1].reason, 'renderer-process-gone')
})

test('revalidates page navigation and redirects without leaking blocked URLs', async () => {
  const { engine, contents } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  const events: EngineEvent[] = []
  engine.subscribe((event) => events.push(event))
  const web = contents[0]

  const allowed = navigationDetails('https://allowed.test/')
  web.emit('will-navigate', allowed)
  assert.equal(allowed.prevented, false)
  web.emit('did-frame-navigate', {}, 'https://allowed.test/', 200, 'OK', true)
  const state = await engine.execute(handle, { type: 'stop' })
  assert.equal(state.ok && state.state.navigationRevision, 1)

  const allowedRedirect = navigationDetails('https://redirect.test/')
  web.emit('will-redirect', allowedRedirect)
  assert.equal(allowedRedirect.prevented, false)
  const afterRedirect = await engine.execute(handle, { type: 'stop' })
  assert.equal(afterRedirect.ok && afterRedirect.state.navigationRevision, 1)

  const blocked = navigationDetails('http://public.test/private?token=secret-token')
  web.emit('will-navigate', blocked)
  const credentialRedirect = navigationDetails('https://user:password@example.test/')
  web.emit('will-redirect', credentialRedirect)
  assert.equal(blocked.prevented, true)
  assert.equal(credentialRedirect.prevented, true)
  assert.equal(web.stopCalls >= 3, true)
  const failures = events.filter((event) => event.type === 'loadFailed')
  assert.equal(failures.length, 2)
  assert.equal(
    failures.every((event) => event.url === 'https://allowed.test/'),
    true
  )
  assert.equal(JSON.stringify(failures).includes('secret-token'), false)
  assert.equal(JSON.stringify(failures).includes('password'), false)
  const preserved = await engine.execute(handle, { type: 'stop' })
  assert.equal(preserved.ok && preserved.state.url, 'https://allowed.test/')
  assert.equal(preserved.ok && preserved.state.isLoading, false)
})

test('defensively copies application origins used by page navigation policy', async () => {
  const origins = ['https://phi.internal']
  const { engine, contents } = harness({ applicationOrigins: origins })
  await engine.createTab({ partition: 'partition-a' })
  origins[0] = 'https://mutated.test'

  const blocked = navigationDetails('https://phi.internal/private')
  contents[0].emit('will-navigate', blocked)
  assert.equal(blocked.prevented, true)
})

test('denies permissions downloads HTTP auth and guest DevTools', async () => {
  const { engine, contents, session } = harness()
  await engine.createTab({ partition: 'partition-a' })
  const web = contents[0]
  assert.equal(web.securityInstalledAtFirstLoad, true)
  assert.equal(session.checkHandler?.(web, 'media', 'https://example.test', {}), false)
  let permission: boolean | null = null
  session.requestHandler?.(web, 'media', (value: boolean) => (permission = value), {})
  assert.equal(permission, false)

  const download = navigationDetails('https://download.test/file')
  session.emit('will-download', download, {}, web)
  assert.equal(download.prevented, true)

  const loginEvent = navigationDetails('https://example.test')
  let credentials: unknown[] | null = null
  web.emit('login', loginEvent, {}, {}, (...args: unknown[]) => (credentials = args))
  assert.equal(loginEvent.prevented, true)
  assert.deepEqual(credentials, [])

  web.emit('devtools-opened')
  assert.equal(web.closeDevToolsCalls, 1)
})

test('fails closed before blank load when Session policy installation fails', async () => {
  const session = new FakeSession()
  session.requestInstallError = new Error('raw permission install secret')
  const { engine, contents } = harness({ session })

  await assert.rejects(
    engine.createTab({ partition: 'partition-a' }),
    (error: Error) =>
      error.message === 'Browser tab could not be created' &&
      !error.message.includes('raw permission install secret')
  )
  assert.deepEqual(contents[0].loadedUrls, [])
  assert.equal(contents[0].closeCalls, 1)
  assert.notEqual(session.checkHandler, null)
  assert.equal(session.listenerCount('will-download'), 0)

  session.requestInstallError = null
  await engine.createTab({ partition: 'partition-a' })
  assert.equal(session.listenerCount('will-download'), 1)
})

test('shares deny policy by Session refcount and releases it after the last tab', async () => {
  const session = new FakeSession()
  const first = harness({ session })
  const second = harness({ session })
  const firstHandle = await first.engine.createTab({ partition: 'shared' })
  const secondHandle = await second.engine.createTab({ partition: 'shared' })
  assert.equal(session.checkSets, 1)
  assert.equal(session.requestSets, 1)
  assert.equal(session.listenerCount('will-download'), 1)

  await first.engine.disposeTab(firstHandle)
  assert.notEqual(session.checkHandler, null)
  assert.equal(session.listenerCount('will-download'), 1)

  await second.engine.disposeTab(secondHandle)
  assert.equal(session.checkHandler, null)
  assert.equal(session.requestHandler, null)
  assert.equal(session.listenerCount('will-download'), 0)
})

test('keeps shared deny policy fail-closed when webContents close fails', async () => {
  const session = new FakeSession()
  const { engine, contents } = harness({ session })
  const handle = await engine.createTab({ partition: 'shared' })
  contents[0].closeError = new Error('raw close secret')
  const events: EngineEvent[] = []
  engine.subscribe((event) => events.push(event))

  await assert.rejects(engine.disposeTab(handle), /Browser tab cleanup failed/)
  assert.notEqual(session.checkHandler, null)
  assert.notEqual(session.requestHandler, null)
  assert.equal(session.listenerCount('will-download'), 1)
  const unsafe = navigationDetails('javascript:alert(1)')
  contents[0].emit('will-navigate', unsafe)
  assert.equal(unsafe.prevented, true)
  assert.equal(contents[0].stopCalls > 0, true)
  assert.deepEqual(events, [])
  const login = navigationDetails('https://example.test')
  let credentials: unknown[] | null = null
  contents[0].emit('login', login, {}, {}, (...args: unknown[]) => (credentials = args))
  assert.equal(login.prevented, true)
  assert.deepEqual(credentials, [])
  contents[0].emit('devtools-opened')
  assert.equal(contents[0].closeDevToolsCalls, 1)
  await engine.disposeTab(handle)
  assert.equal(contents[0].closeCalls, 1)
  assert.equal(contents[0].listenerCount('will-navigate'), 1)
})

test('initializing rollback keeps security listeners silent when close also fails', async () => {
  const { engine, contents } = harness({
    loadError: new Error('raw load failure'),
    closeError: new Error('raw close failure')
  })
  const events: EngineEvent[] = []
  engine.subscribe((event) => events.push(event))
  await assert.rejects(
    engine.createTab({ partition: 'shared' }),
    /Browser tab could not be created/
  )

  const unsafe = navigationDetails('javascript:alert(1)')
  contents[0].emit('will-navigate', unsafe)
  assert.equal(unsafe.prevented, true)
  assert.equal(contents[0].stopCalls > 0, true)
  const login = navigationDetails('https://example.test')
  let credentials: unknown[] | null = null
  contents[0].emit('login', login, {}, {}, (...args: unknown[]) => (credentials = args))
  assert.equal(login.prevented, true)
  assert.deepEqual(credentials, [])
  assert.deepEqual(events, [])
})

test('repairs partial Session release before allowing a later blank load', async () => {
  for (const failure of ['off', 'request-reset'] as const) {
    const session = new FakeSession()
    const first = harness({ session })
    const firstHandle = await first.engine.createTab({ partition: `shared-${failure}` })
    if (failure === 'off') session.failDownloadOff = true
    else session.failRequestReset = true
    await assert.rejects(first.engine.disposeTab(firstHandle), /Browser tab cleanup failed/)

    session.failDownloadOff = false
    session.failRequestReset = false
    const second = harness({ session })
    await second.engine.createTab({ partition: `shared-${failure}` })
    assert.equal(second.contents[0].securityInstalledAtFirstLoad, true)
    assert.notEqual(session.checkHandler, null)
    assert.notEqual(session.requestHandler, null)
    assert.equal(session.listenerCount('will-download'), 1)
  }
})

test('rejects reacquire before load while poisoned Session repair still fails', async () => {
  const session = new FakeSession()
  const first = harness({ session })
  const firstHandle = await first.engine.createTab({ partition: 'shared' })
  session.failRequestReset = true
  session.failDownloadOn = true
  await assert.rejects(first.engine.disposeTab(firstHandle), /Browser tab cleanup failed/)

  const blocked = harness({ session })
  await assert.rejects(
    blocked.engine.createTab({ partition: 'shared' }),
    /Browser tab could not be created/
  )
  assert.deepEqual(blocked.contents[0].loadedUrls, [])
  assert.equal(blocked.contents[0].closeCalls, 1)

  session.failRequestReset = false
  session.failDownloadOn = false
  const repaired = harness({ session })
  await repaired.engine.createTab({ partition: 'shared' })
  assert.equal(repaired.contents[0].securityInstalledAtFirstLoad, true)
  assert.equal(session.listenerCount('will-download'), 1)
})

test('removes per-tab listeners and isolates throwing engine subscribers', async () => {
  const { engine, contents } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  let delivered = 0
  engine.subscribe(() => {
    throw new Error('listener failure')
  })
  engine.subscribe(() => {
    delivered += 1
  })

  contents[0].emit('page-title-updated', {}, 'Title')
  assert.equal(delivered, 1)
  assert.equal(contents[0].listenerCount('page-title-updated') > 0, true)
  await engine.disposeTab(handle)
  assert.equal(contents[0].eventNames().length, 0)
})

test('contains asynchronous loadURL rejection without blocking or leaking raw errors', async () => {
  const { engine, contents } = harness()
  const handle = await engine.createTab({ partition: 'partition-a' })
  contents[0].loadError = new Error('raw navigation secret')
  const unhandled: unknown[] = []
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason)
  }
  process.on('unhandledRejection', onUnhandled)

  try {
    const result = await engine.execute(handle, {
      type: 'navigate',
      url: 'https://example.test/'
    })
    assert.equal(result.ok, true)
    assert.equal(result.ok && result.state.isLoading, true)
    await new Promise((resolveMicrotask) => setImmediate(resolveMicrotask))
    assert.deepEqual(unhandled, [])
    assert.equal(JSON.stringify(result).includes('raw navigation secret'), false)
  } finally {
    process.removeListener('unhandledRejection', onUnhandled)
  }
})
