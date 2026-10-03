import type {
  NavigationHistory,
  BrowserWindow,
  WebContents,
  WebContentsViewConstructorOptions,
  WebPreferences
} from 'electron'
import type { BrowserCapabilities, BrowserViewport } from '../../shared/browserTypes'
import type {
  BrowserEngine,
  EngineCommand,
  EngineEvent,
  EngineResult,
  EngineTabHandle,
  EngineTabInput,
  EngineTabState
} from './browser-engine'
import {
  normalizeBrowserUrl,
  type BrowserPolicyContext,
  type BrowserUrlPolicyResult
} from './browser-policy'
import {
  acquireBrowserSessionPolicy,
  type BrowserSessionLike
} from './electron-browser-session-policy'
import {
  ElectronBrowserViewportController,
  type NativeBrowserViewLike,
  type NativeBrowserWindowLike
} from './electron-browser-viewport'
import {
  captureElectronBrowserScreenshot,
  type ElectronScreenshotWebContentsLike
} from './electron-browser-screenshot'
export type { BrowserSessionLike } from './electron-browser-session-policy'

export type SecureBrowserWebPreferences = Pick<
  WebPreferences,
  | 'partition'
  | 'nodeIntegration'
  | 'nodeIntegrationInWorker'
  | 'nodeIntegrationInSubFrames'
  | 'contextIsolation'
  | 'sandbox'
  | 'webSecurity'
  | 'webviewTag'
  | 'allowRunningInsecureContent'
  | 'navigateOnDragDrop'
  | 'devTools'
>

export type BrowserWebContentsViewOptions = Omit<
  WebContentsViewConstructorOptions,
  'webPreferences'
> & { webPreferences: SecureBrowserWebPreferences }

export type BrowserNavigationHistoryLike = Pick<
  NavigationHistory,
  'canGoBack' | 'canGoForward' | 'goBack' | 'goForward'
>

export type BrowserWebContentsLike = Pick<
  WebContents,
  'loadURL' | 'close' | 'reload' | 'stop' | 'closeDevTools' | 'setWindowOpenHandler' | 'on' | 'off'
> & {
  session: BrowserSessionLike
  navigationHistory: BrowserNavigationHistoryLike
} & ElectronScreenshotWebContentsLike

export interface BrowserWebContentsViewLike extends NativeBrowserViewLike {
  webContents: BrowserWebContentsLike
}

export interface BrowserWebContentsViewConstructor {
  new (options: BrowserWebContentsViewOptions): BrowserWebContentsViewLike
}

type AssertWebContentsViewConstructor<T extends BrowserWebContentsViewConstructor> = T
export type ElectronWebContentsViewConstructorCompatibility = AssertWebContentsViewConstructor<
  typeof import('electron').WebContentsView
>

export type BrowserOwningWindowLike = Pick<
  BrowserWindow,
  'contentView' | 'getContentBounds' | 'isMinimized' | 'isVisible' | 'on' | 'off' | 'listenerCount'
>

type AssertBrowserWindow<T extends BrowserOwningWindowLike> = T
export type ElectronBrowserWindowCompatibility = AssertBrowserWindow<
  import('electron').BrowserWindow
>

export interface ElectronBrowserEngineOptions {
  WebContentsView: BrowserWebContentsViewConstructor
  getOwningWindow: () => BrowserOwningWindowLike | null
  idFactory?: () => string
  policyContext?: BrowserPolicyContext
  now?: () => number
}

interface ElectronTabRecord {
  handle: EngineTabHandle
  view: BrowserWebContentsViewLike
  window: BrowserOwningWindowLike
  cleanupAttempted: boolean
  closeSucceeded: boolean
  initializing: boolean
  lifecycle: AbortController
  state: EngineTabState
  listeners: Array<{ event: string; listener: (...args: unknown[]) => void }>
  releaseSessionPolicy?: () => boolean
}

interface GenericEventSource {
  on(event: string, listener: (...args: unknown[]) => void): unknown
  off(event: string, listener: (...args: unknown[]) => void): unknown
}

const CAPABILITIES: BrowserCapabilities = {
  presentation: 'native',
  screenshot: true,
  coordinateInput: false,
  semanticInspection: false,
  downloads: false,
  recording: false,
  persistentProfile: false
}

function safePreferences(partition: string): SecureBrowserWebPreferences {
  return {
    partition,
    nodeIntegration: false,
    nodeIntegrationInWorker: false,
    nodeIntegrationInSubFrames: false,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    allowRunningInsecureContent: false,
    navigateOnDragDrop: false,
    devTools: false
  }
}

function normalizeElectronEventUrl(
  url: string,
  context: BrowserPolicyContext
): BrowserUrlPolicyResult {
  return url === 'about:blank' ? { ok: true, url } : normalizeBrowserUrl(url, context)
}

function initialState(): EngineTabState {
  return {
    url: 'about:blank',
    title: 'New tab',
    isLoading: false,
    canGoBack: false,
    canGoForward: false,
    documentRevision: 0,
    navigationRevision: 0
  }
}

export class ElectronBrowserEngine implements BrowserEngine {
  readonly #WebContentsView: BrowserWebContentsViewConstructor
  readonly #getOwningWindow: () => BrowserOwningWindowLike | null
  readonly #idFactory: () => string
  readonly #policyContext: BrowserPolicyContext
  readonly #now: () => number
  readonly #tabs = new Map<EngineTabHandle, ElectronTabRecord>()
  readonly #listeners = new Set<(event: EngineEvent) => void>()
  readonly #viewportController = new ElectronBrowserViewportController<EngineTabHandle>()
  #nextId = 0
  #disposed = false
  #cleanupDebt = false
  #disposePromise: Promise<void> | null = null

  constructor(options: ElectronBrowserEngineOptions) {
    this.#WebContentsView = options.WebContentsView
    this.#getOwningWindow = options.getOwningWindow
    this.#idFactory = options.idFactory ?? (() => `electron-browser-tab-${++this.#nextId}`)
    this.#policyContext = options.policyContext?.applicationOrigins
      ? { applicationOrigins: [...options.policyContext.applicationOrigins] }
      : {}
    this.#now = options.now ?? Date.now
  }

  capabilities(): BrowserCapabilities {
    return { ...CAPABILITIES }
  }

  async createTab(input: EngineTabInput): Promise<EngineTabHandle> {
    if (this.#disposed) throw new Error('Browser engine is disposed')
    let handle: EngineTabHandle | null = null
    let record: ElectronTabRecord | null = null
    try {
      handle = this.#nextHandle()
      const window = this.#getOwningWindow()
      if (!window) throw new Error('window unavailable')
      const view = new this.#WebContentsView({
        webPreferences: safePreferences(input.partition)
      })
      record = {
        handle,
        view,
        window,
        cleanupAttempted: false,
        closeSucceeded: false,
        initializing: true,
        lifecycle: new AbortController(),
        state: initialState(),
        listeners: []
      }
      this.#tabs.set(handle, record)
      this.#assertRequiredHooks(view.webContents)
      this.#installWindowOpenHandler(handle, record)
      record.releaseSessionPolicy = acquireBrowserSessionPolicy(view.webContents.session)
      this.#registerTabListeners(handle, record)
      await view.webContents.loadURL('about:blank')
      if (this.#disposed || record.cleanupAttempted || this.#tabs.get(handle) !== record) {
        throw new Error('engine disposed during creation')
      }
      this.#viewportController.register(handle, view, window as unknown as NativeBrowserWindowLike)
      record.initializing = false
      return handle
    } catch {
      if (handle && record && this.#tabs.get(handle) === record) this.#tabs.delete(handle)
      if (record && this.#cleanupRecord(record)) this.#cleanupDebt = true
      throw new Error('Browser tab could not be created')
    }
  }

  async execute(
    handle: EngineTabHandle,
    command: EngineCommand,
    signal?: AbortSignal
  ): Promise<EngineResult> {
    const record = this.#tabs.get(handle)
    if (!record) {
      return {
        ok: false,
        error: { code: 'TAB_NOT_FOUND', message: 'Browser tab was not found' }
      }
    }
    if (signal?.aborted) {
      return {
        ok: false,
        error: { code: 'ACTION_CANCELLED', message: 'Browser action was cancelled' }
      }
    }
    try {
      switch (command.type) {
        case 'navigate': {
          const normalized = normalizeBrowserUrl(command.url, this.#policyContext)
          if (!normalized.ok) {
            return {
              ok: false,
              error: { code: normalized.error.code, message: 'Browser navigation was blocked' }
            }
          }
          record.state.navigationRevision += 1
          record.state.isLoading = true
          void Promise.resolve(record.view.webContents.loadURL(normalized.url)).catch(
            () => undefined
          )
          break
        }
        case 'history': {
          const history = record.view.webContents.navigationHistory
          if (!history) return this.#unavailable()
          record.state.navigationRevision += 1
          if (command.direction === 'back' && history.canGoBack()) history.goBack()
          if (command.direction === 'forward' && history.canGoForward()) history.goForward()
          break
        }
        case 'reload':
          record.state.navigationRevision += 1
          record.view.webContents.reload()
          break
        case 'stop':
          record.view.webContents.stop()
          if (record.state.isLoading) {
            record.state.isLoading = false
            this.#publish({
              type: 'loadingChanged',
              handle,
              isLoading: false,
              navigationRevision: record.state.navigationRevision,
              at: this.#now()
            })
          }
          break
        case 'screenshot':
          return await captureElectronBrowserScreenshot({
            webContents: record.view.webContents,
            state: record.state,
            signal,
            invalidated: record.lifecycle.signal,
            isCurrent: () => this.#tabs.get(handle) === record && !record.cleanupAttempted
          })
        default:
          return this.#unavailable()
      }
      this.#refreshHistory(record)
      return { ok: true, state: { ...record.state } }
    } catch {
      return {
        ok: false,
        error: {
          code: command.type === 'navigate' ? 'NAVIGATION_FAILED' : 'ENGINE_UNAVAILABLE',
          message:
            command.type === 'navigate' ? 'Browser navigation failed' : 'Browser command failed'
        }
      }
    }
  }

  async setViewport(handle: EngineTabHandle, viewport: BrowserViewport | null): Promise<void> {
    if (!this.#tabs.has(handle)) throw new Error('Browser tab was not found')
    try {
      this.#viewportController.setViewport(handle, viewport)
    } catch {
      throw new Error('Browser viewport could not be applied')
    }
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    if (this.#disposed) return () => undefined
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async disposeTab(handle: EngineTabHandle): Promise<void> {
    const record = this.#tabs.get(handle)
    if (!record) return
    this.#tabs.delete(handle)
    if (this.#cleanupRecord(record)) {
      this.#cleanupDebt = true
      throw new Error('Browser tab cleanup failed')
    }
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposed = true
    this.#listeners.clear()
    const records = [...this.#tabs.values()]
    this.#tabs.clear()
    this.#disposePromise = Promise.resolve().then(() => {
      let failed = this.#cleanupDebt
      for (const record of records) failed = this.#cleanupRecord(record) || failed
      this.#cleanupDebt ||= failed
      if (failed) throw new Error('Browser engine cleanup failed')
    })
    return this.#disposePromise
  }

  tabCountForTesting(): number {
    return this.#tabs.size
  }

  listenerCountForTesting(): number {
    return this.#listeners.size
  }

  #unavailable(): EngineResult {
    return {
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Browser command is unavailable' }
    }
  }

  #assertRequiredHooks(webContents: BrowserWebContentsLike): void {
    const session = webContents.session
    const history = webContents.navigationHistory
    if (
      !session ||
      typeof session.setPermissionCheckHandler !== 'function' ||
      typeof session.setPermissionRequestHandler !== 'function' ||
      typeof session.on !== 'function' ||
      typeof session.off !== 'function' ||
      !history ||
      typeof history.canGoBack !== 'function' ||
      typeof history.canGoForward !== 'function' ||
      typeof history.goBack !== 'function' ||
      typeof history.goForward !== 'function' ||
      typeof webContents.on !== 'function' ||
      typeof webContents.off !== 'function' ||
      typeof webContents.reload !== 'function' ||
      typeof webContents.stop !== 'function' ||
      typeof webContents.closeDevTools !== 'function' ||
      typeof webContents.setWindowOpenHandler !== 'function'
    ) {
      throw new Error('required browser security hooks unavailable')
    }
  }

  #refreshHistory(record: ElectronTabRecord): void {
    const history = record.view.webContents.navigationHistory
    if (!history) return
    record.state.canGoBack = history.canGoBack()
    record.state.canGoForward = history.canGoForward()
  }

  #suppressProductEvents(record: ElectronTabRecord): boolean {
    return record.initializing || record.cleanupAttempted
  }

  #installWindowOpenHandler(handle: EngineTabHandle, record: ElectronTabRecord): void {
    record.view.webContents.setWindowOpenHandler((details) => {
      try {
        if (this.#disposed || this.#suppressProductEvents(record) || details.postBody != null) {
          return { action: 'deny' }
        }
        const normalized = normalizeBrowserUrl(details.url, this.#policyContext)
        if (!normalized.ok) return { action: 'deny' }
        this.#publish({
          type: 'popupRequested',
          handle,
          url: normalized.url,
          method: 'GET',
          at: this.#now()
        })
      } catch {
        // A popup must remain denied even if policy evaluation or event delivery fails.
      }
      return { action: 'deny' }
    })
  }

  #registerTabListeners(handle: EngineTabHandle, record: ElectronTabRecord): void {
    const webContents = record.view.webContents
    this.#listen(record, 'did-start-loading', () => {
      if (this.#suppressProductEvents(record)) return
      record.state.isLoading = true
      this.#publish({
        type: 'loadingChanged',
        handle,
        isLoading: true,
        navigationRevision: record.state.navigationRevision,
        at: this.#now()
      })
    })
    this.#listen(record, 'did-stop-loading', () => {
      if (this.#suppressProductEvents(record)) return
      record.state.isLoading = false
      this.#refreshHistory(record)
      this.#publish({
        type: 'loadingChanged',
        handle,
        isLoading: false,
        navigationRevision: record.state.navigationRevision,
        at: this.#now()
      })
    })
    this.#listen(record, 'page-title-updated', (...args: unknown[]) => {
      if (this.#suppressProductEvents(record)) return
      const title = typeof args[1] === 'string' ? args[1] : ''
      record.state.title = title
      this.#publish({
        type: 'titleChanged',
        handle,
        title,
        navigationRevision: record.state.navigationRevision,
        at: this.#now()
      })
    })
    this.#listen(record, 'did-frame-navigate', (...args: unknown[]) => {
      if (this.#suppressProductEvents(record) || args[4] !== true || typeof args[1] !== 'string')
        return
      const normalized = normalizeElectronEventUrl(args[1], this.#policyContext)
      if (!normalized.ok) {
        this.#rejectNavigation(handle, record, {}, normalized.error.code)
        return
      }
      record.state.url = normalized.url
      record.state.documentRevision += 1
      this.#refreshHistory(record)
      this.#publish({
        type: 'navigationCommitted',
        handle,
        url: record.state.url,
        documentRevision: record.state.documentRevision,
        navigationRevision: record.state.navigationRevision,
        canGoBack: record.state.canGoBack,
        canGoForward: record.state.canGoForward,
        at: this.#now()
      })
    })
    this.#listen(record, 'did-fail-load', (...args: unknown[]) => {
      if (this.#suppressProductEvents(record) || args[4] !== true || args[1] === -3) return
      record.state.isLoading = false
      this.#publish({
        type: 'loadFailed',
        handle,
        url: typeof args[3] === 'string' ? args[3] : record.state.url,
        errorCode: typeof args[1] === 'number' ? String(args[1]) : 'NAVIGATION_FAILED',
        message: 'Page failed to load',
        navigationRevision: record.state.navigationRevision,
        at: this.#now()
      })
    })
    this.#listen(record, 'render-process-gone', () => {
      if (this.#suppressProductEvents(record)) return
      this.#publish({
        type: 'crashed',
        handle,
        reason: 'renderer-process-gone',
        at: this.#now()
      })
    })
    this.#listen(record, 'will-navigate', (...args: unknown[]) => {
      const details = args[0] as
        { url?: string; isMainFrame?: boolean; preventDefault?: () => void } | undefined
      if (!details?.url || details.isMainFrame === false) return
      if (record.initializing && details.url === 'about:blank') return
      const normalized = normalizeElectronEventUrl(details.url, this.#policyContext)
      if (!normalized.ok)
        return this.#rejectNavigation(handle, record, details, normalized.error.code)
      record.state.navigationRevision += 1
    })
    this.#listen(record, 'will-redirect', (...args: unknown[]) => {
      const details = args[0] as
        { url?: string; isMainFrame?: boolean; preventDefault?: () => void } | undefined
      if (!details?.url || details.isMainFrame === false) return
      if (record.initializing && details.url === 'about:blank') return
      const normalized = normalizeElectronEventUrl(details.url, this.#policyContext)
      if (!normalized.ok) this.#rejectNavigation(handle, record, details, normalized.error.code)
    })
    this.#listen(record, 'login', (...args: unknown[]) => {
      const event = args[0] as { preventDefault?: () => void } | undefined
      event?.preventDefault?.()
      const callback = args[3]
      if (typeof callback === 'function') (callback as () => void)()
    })
    this.#listen(record, 'devtools-opened', () => {
      try {
        webContents.closeDevTools()
      } catch {
        // devTools stays disabled in webPreferences even if defensive closing fails.
      }
    })
  }

  #listen(record: ElectronTabRecord, event: string, listener: (...args: unknown[]) => void): void {
    const events = record.view.webContents as unknown as GenericEventSource
    events.on(event, listener)
    record.listeners.push({ event, listener })
  }

  #rejectNavigation(
    handle: EngineTabHandle,
    record: ElectronTabRecord,
    details: { preventDefault?: () => void },
    errorCode: string
  ): void {
    details.preventDefault?.()
    try {
      record.view.webContents.stop()
    } catch {
      // The blocked navigation remains prevented even if stop itself fails.
    }
    record.state.isLoading = false
    if (this.#suppressProductEvents(record)) return
    this.#publish({
      type: 'loadFailed',
      handle,
      url: record.state.url,
      errorCode,
      message: 'Browser navigation was blocked',
      navigationRevision: record.state.navigationRevision,
      at: this.#now()
    })
  }

  #publish(event: EngineEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        continue
      }
    }
  }

  #nextHandle(): EngineTabHandle {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const value = this.#idFactory()
      const handle = value as EngineTabHandle
      if (value.trim() && !this.#tabs.has(handle) && !this.#viewportController.has(handle))
        return handle
    }
    throw new Error('Browser tab could not be created')
  }

  #cleanupRecord(record: ElectronTabRecord): boolean {
    if (record.cleanupAttempted) return !record.closeSucceeded
    record.cleanupAttempted = true
    record.lifecycle.abort()
    let failed = this.#viewportController.prepareForClose(record.handle)
    try {
      record.view.webContents.close()
      record.closeSucceeded = true
    } catch {
      failed = true
    }
    failed = this.#viewportController.completeClose(record.handle, record.closeSucceeded) || failed
    if (!record.closeSucceeded) return true
    for (const { event, listener } of record.listeners) {
      try {
        const events = record.view.webContents as unknown as GenericEventSource
        events.off(event, listener)
      } catch {
        failed = true
      }
    }
    record.listeners.length = 0
    if (record.releaseSessionPolicy) {
      failed = record.releaseSessionPolicy() || failed
      record.releaseSessionPolicy = undefined
    }
    return failed
  }
}
