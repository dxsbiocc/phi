import type { WebPreferences } from 'electron'
import type { BrowserCapabilities, BrowserViewport } from '../../shared/browserTypes'
import type {
  BrowserEngine,
  EngineCommand,
  EngineEvent,
  EngineResult,
  EngineTabHandle,
  EngineTabInput
} from './browser-engine'

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

export interface BrowserWebContentsViewOptions {
  webPreferences: SecureBrowserWebPreferences
}

export interface BrowserWebContentsLike {
  loadURL(url: string): Promise<unknown>
  close(): void
}

export interface BrowserWebContentsViewLike {
  webContents: BrowserWebContentsLike
}

export interface BrowserWebContentsViewConstructor {
  new (options: BrowserWebContentsViewOptions): BrowserWebContentsViewLike
}

export interface BrowserOwningWindowLike {
  contentView: {
    addChildView(view: BrowserWebContentsViewLike): void
    removeChildView(view: BrowserWebContentsViewLike): void
  }
}

export interface ElectronBrowserEngineOptions {
  WebContentsView: BrowserWebContentsViewConstructor
  getOwningWindow: () => BrowserOwningWindowLike | null
  idFactory?: () => string
}

interface ElectronTabRecord {
  view: BrowserWebContentsViewLike
  window: BrowserOwningWindowLike
  attachAttempted: boolean
  closed: boolean
}

const CAPABILITIES: BrowserCapabilities = {
  presentation: 'native',
  screenshot: false,
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

export class ElectronBrowserEngine implements BrowserEngine {
  readonly #WebContentsView: BrowserWebContentsViewConstructor
  readonly #getOwningWindow: () => BrowserOwningWindowLike | null
  readonly #idFactory: () => string
  readonly #tabs = new Map<EngineTabHandle, ElectronTabRecord>()
  readonly #listeners = new Set<(event: EngineEvent) => void>()
  #nextId = 0
  #disposed = false
  #disposePromise: Promise<void> | null = null

  constructor(options: ElectronBrowserEngineOptions) {
    this.#WebContentsView = options.WebContentsView
    this.#getOwningWindow = options.getOwningWindow
    this.#idFactory = options.idFactory ?? (() => `electron-browser-tab-${++this.#nextId}`)
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
      record = { view, window, attachAttempted: false, closed: false }
      this.#tabs.set(handle, record)
      await view.webContents.loadURL('about:blank')
      if (this.#disposed || record.closed || this.#tabs.get(handle) !== record) {
        throw new Error('engine disposed during creation')
      }
      record.attachAttempted = true
      window.contentView.addChildView(view)
      return handle
    } catch {
      if (handle && record && this.#tabs.get(handle) === record) this.#tabs.delete(handle)
      if (record) this.#cleanupRecord(record)
      throw new Error('Browser tab could not be created')
    }
  }

  async execute(
    handle: EngineTabHandle,
    _command: EngineCommand,
    signal?: AbortSignal
  ): Promise<EngineResult> {
    if (!this.#tabs.has(handle)) {
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
    return {
      ok: false,
      error: { code: 'CAPABILITY_UNAVAILABLE', message: 'Browser command is unavailable' }
    }
  }

  async setViewport(handle: EngineTabHandle, viewport: BrowserViewport | null): Promise<void> {
    if (!this.#tabs.has(handle)) throw new Error('Browser tab was not found')
    void viewport
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
    if (this.#cleanupRecord(record)) throw new Error('Browser tab cleanup failed')
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposed = true
    this.#listeners.clear()
    const records = [...this.#tabs.values()]
    this.#tabs.clear()
    this.#disposePromise = Promise.resolve().then(() => {
      let failed = false
      for (const record of records) failed = this.#cleanupRecord(record) || failed
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

  #nextHandle(): EngineTabHandle {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const value = this.#idFactory()
      const handle = value as EngineTabHandle
      if (value.trim() && !this.#tabs.has(handle)) return handle
    }
    throw new Error('Browser tab could not be created')
  }

  #cleanupRecord(record: ElectronTabRecord): boolean {
    if (record.closed) return false
    record.closed = true
    let failed = false
    if (record.attachAttempted) {
      try {
        record.window.contentView.removeChildView(record.view)
      } catch {
        failed = true
      }
    }
    try {
      record.view.webContents.close()
    } catch {
      failed = true
    }
    return failed
  }
}
