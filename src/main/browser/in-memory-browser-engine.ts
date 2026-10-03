import type { BrowserCapabilities, BrowserViewport } from '../../shared/browserTypes'
import type {
  BrowserEngine,
  EngineCommand,
  EngineEvent,
  EngineResult,
  EngineTabHandle,
  EngineTabInput,
  EngineTabState,
  EngineTargetDescriptor
} from './browser-engine'

const DEFAULT_SCREENSHOT =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

const DEFAULT_CAPABILITIES: BrowserCapabilities = {
  presentation: 'native',
  screenshot: true,
  coordinateInput: true,
  semanticInspection: false,
  downloads: false,
  recording: false,
  persistentProfile: false
}

export interface InMemoryBrowserEngineOptions {
  capabilities?: BrowserCapabilities
  idFactory?: () => string
  now?: () => number
  screenshotData?: string
  screenshotSize?: { width: number; height: number }
  targetDescriptor?: EngineTargetDescriptor
}

export interface RecordedEngineAction {
  command: EngineCommand
  at: number
}

interface InMemoryTab {
  input: EngineTabInput
  state: EngineTabState
  history: string[]
  historyIndex: number
  viewport: BrowserViewport | null
  actions: RecordedEngineAction[]
}

function cloneState(state: EngineTabState): EngineTabState {
  return { ...state }
}

function cloneViewport(viewport: BrowserViewport | null): BrowserViewport | null {
  return viewport ? { ...viewport } : null
}

export class InMemoryBrowserEngine implements BrowserEngine {
  readonly #capabilities: BrowserCapabilities
  readonly #idFactory: () => string
  readonly #now: () => number
  readonly #screenshotData: string
  readonly #screenshotSize: { width: number; height: number }
  readonly #targetDescriptor?: EngineTargetDescriptor
  readonly #tabs = new Map<EngineTabHandle, InMemoryTab>()
  readonly #listeners = new Set<(event: EngineEvent) => void>()
  #nextId = 0
  #disposed = false

  constructor(options: InMemoryBrowserEngineOptions = {}) {
    this.#capabilities = { ...(options.capabilities ?? DEFAULT_CAPABILITIES) }
    this.#idFactory = options.idFactory ?? (() => `engine-tab-${++this.#nextId}`)
    this.#now = options.now ?? Date.now
    this.#screenshotData = options.screenshotData ?? DEFAULT_SCREENSHOT
    this.#screenshotSize = { ...(options.screenshotSize ?? { width: 1, height: 1 }) }
    this.#targetDescriptor = options.targetDescriptor
  }

  capabilities(): BrowserCapabilities {
    return { ...this.#capabilities }
  }

  async createTab(input: EngineTabInput): Promise<EngineTabHandle> {
    if (this.#disposed) throw new Error('Browser engine is disposed')
    const handle = this.#idFactory() as EngineTabHandle
    if (this.#tabs.has(handle)) throw new Error(`Duplicate browser engine tab ID: ${handle}`)
    this.#tabs.set(handle, {
      input: { ...input },
      state: {
        url: 'about:blank',
        title: 'New tab',
        isLoading: false,
        canGoBack: false,
        canGoForward: false,
        documentRevision: 0,
        navigationRevision: 0
      },
      history: ['about:blank'],
      historyIndex: 0,
      viewport: null,
      actions: []
    })
    return handle
  }

  async execute(
    handle: EngineTabHandle,
    command: EngineCommand,
    signal?: AbortSignal
  ): Promise<EngineResult> {
    const tab = this.#tabs.get(handle)
    if (!tab) return this.#error('TAB_NOT_FOUND', 'Browser tab was not found')
    if (signal?.aborted) return this.#error('ACTION_CANCELLED', 'Browser action was cancelled')

    if (
      ['click', 'typeText', 'keypress', 'scroll'].includes(command.type) &&
      !this.#capabilities.coordinateInput
    ) {
      return this.#error('CAPABILITY_UNAVAILABLE', 'Coordinate input is unavailable')
    }
    if (command.type === 'screenshot' && !this.#capabilities.screenshot) {
      return this.#error('CAPABILITY_UNAVAILABLE', 'Screenshots are unavailable')
    }
    tab.actions.push({ command: { ...command }, at: this.#now() })

    switch (command.type) {
      case 'navigate': {
        const navigationRevision = ++tab.state.navigationRevision
        this.#navigate(handle, tab, command.url, true, navigationRevision)
        break
      }
      case 'history': {
        const navigationRevision = ++tab.state.navigationRevision
        const nextIndex = tab.historyIndex + (command.direction === 'back' ? -1 : 1)
        if (nextIndex >= 0 && nextIndex < tab.history.length) {
          tab.historyIndex = nextIndex
          this.#commit(handle, tab, tab.history[nextIndex], navigationRevision)
        }
        break
      }
      case 'reload': {
        const navigationRevision = ++tab.state.navigationRevision
        this.#commit(handle, tab, tab.state.url, navigationRevision)
        break
      }
      case 'stop':
        if (tab.state.isLoading) this.emitLoading(handle, false)
        break
      case 'screenshot':
        return {
          ok: true,
          state: cloneState(tab.state),
          screenshot: {
            mediaType: 'image/png',
            data: this.#screenshotData,
            width: this.#screenshotSize.width,
            height: this.#screenshotSize.height,
            documentRevision: tab.state.documentRevision
          }
        }
      case 'describeTarget':
        return {
          ok: true,
          state: cloneState(tab.state),
          ...(this.#targetDescriptor ? { target: { ...this.#targetDescriptor } } : {})
        }
      case 'click':
      case 'typeText':
      case 'keypress':
      case 'scroll':
        break
    }

    return { ok: true, state: cloneState(tab.state) }
  }

  async setViewport(handle: EngineTabHandle, viewport: BrowserViewport | null): Promise<void> {
    const tab = this.#requiredTab(handle)
    tab.viewport = cloneViewport(viewport)
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  async disposeTab(handle: EngineTabHandle): Promise<void> {
    this.#tabs.delete(handle)
  }

  async dispose(): Promise<void> {
    this.#disposed = true
    this.#tabs.clear()
    this.#listeners.clear()
  }

  hasTab(handle: EngineTabHandle): boolean {
    return this.#tabs.has(handle)
  }

  tabState(handle: EngineTabHandle): EngineTabState {
    return cloneState(this.#requiredTab(handle).state)
  }

  tabInputFor(handle: EngineTabHandle): EngineTabInput {
    return { ...this.#requiredTab(handle).input }
  }

  recordedActions(handle: EngineTabHandle): RecordedEngineAction[] {
    return this.#requiredTab(handle).actions.map(({ command, at }) => ({
      command: { ...command },
      at
    }))
  }

  viewportFor(handle: EngineTabHandle): BrowserViewport | null {
    return cloneViewport(this.#requiredTab(handle).viewport)
  }

  emitLoading(handle: EngineTabHandle, isLoading: boolean, navigationRevision?: number): void {
    const tab = this.#requiredTab(handle)
    const revision = navigationRevision ?? tab.state.navigationRevision
    if (revision >= tab.state.navigationRevision) {
      tab.state.navigationRevision = revision
      tab.state.isLoading = isLoading
    }
    this.#publish({
      type: 'loadingChanged',
      handle,
      isLoading,
      navigationRevision: revision,
      at: this.#now()
    })
  }

  emitTitle(handle: EngineTabHandle, title: string, navigationRevision?: number): void {
    const tab = this.#requiredTab(handle)
    const revision = navigationRevision ?? tab.state.navigationRevision
    if (revision >= tab.state.navigationRevision) {
      tab.state.navigationRevision = revision
      tab.state.title = title
    }
    this.#publish({
      type: 'titleChanged',
      handle,
      title,
      navigationRevision: revision,
      at: this.#now()
    })
  }

  emitCrash(handle: EngineTabHandle, reason: string): void {
    this.#requiredTab(handle)
    this.#publish({ type: 'crashed', handle, reason, at: this.#now() })
  }

  emitLoadFailure(
    handle: EngineTabHandle,
    input: { url: string; errorCode: string; message: string; navigationRevision?: number }
  ): void {
    const tab = this.#requiredTab(handle)
    const navigationRevision = input.navigationRevision ?? tab.state.navigationRevision
    if (navigationRevision >= tab.state.navigationRevision) {
      tab.state.navigationRevision = navigationRevision
      tab.state.isLoading = false
    }
    this.#publish({
      type: 'loadFailed',
      handle,
      url: input.url,
      errorCode: input.errorCode,
      message: input.message,
      navigationRevision,
      at: this.#now()
    })
  }

  emitNavigationCommitted(
    handle: EngineTabHandle,
    input: {
      url: string
      documentRevision?: number
      navigationRevision?: number
      canGoBack: boolean
      canGoForward: boolean
    }
  ): void {
    const tab = this.#requiredTab(handle)
    const navigationRevision = input.navigationRevision ?? tab.state.navigationRevision
    const documentRevision = input.documentRevision ?? tab.state.documentRevision
    const isNewerPair =
      navigationRevision > tab.state.navigationRevision
        ? documentRevision >= tab.state.documentRevision
        : navigationRevision === tab.state.navigationRevision &&
          documentRevision > tab.state.documentRevision
    if (isNewerPair) {
      tab.state.navigationRevision = navigationRevision
      tab.state.documentRevision = documentRevision
      tab.state.url = input.url
      tab.state.canGoBack = input.canGoBack
      tab.state.canGoForward = input.canGoForward
    }
    this.#publish({
      type: 'navigationCommitted',
      handle,
      url: input.url,
      documentRevision,
      navigationRevision,
      canGoBack: input.canGoBack,
      canGoForward: input.canGoForward,
      at: this.#now()
    })
  }

  emitPopup(
    handle: EngineTabHandle,
    input: { url: string; method?: 'GET' | 'POST' | 'other' }
  ): void {
    this.#requiredTab(handle)
    this.#publish({
      type: 'popupRequested',
      handle,
      url: input.url,
      method: input.method ?? 'GET',
      at: this.#now()
    })
  }

  #navigate(
    handle: EngineTabHandle,
    tab: InMemoryTab,
    url: string,
    addToHistory: boolean,
    navigationRevision: number
  ): void {
    if (addToHistory) {
      tab.history.splice(tab.historyIndex + 1)
      tab.history.push(url)
      tab.historyIndex = tab.history.length - 1
    }
    this.#commit(handle, tab, url, navigationRevision)
  }

  #commit(
    handle: EngineTabHandle,
    tab: InMemoryTab,
    url: string,
    navigationRevision: number
  ): void {
    this.emitLoading(handle, true, navigationRevision)
    tab.state.url = url
    tab.state.documentRevision += 1
    tab.state.canGoBack = tab.historyIndex > 0
    tab.state.canGoForward = tab.historyIndex < tab.history.length - 1
    this.#publish({
      type: 'navigationCommitted',
      handle,
      url,
      documentRevision: tab.state.documentRevision,
      navigationRevision,
      canGoBack: tab.state.canGoBack,
      canGoForward: tab.state.canGoForward,
      at: this.#now()
    })
    this.emitLoading(handle, false, navigationRevision)
  }

  #requiredTab(handle: EngineTabHandle): InMemoryTab {
    const tab = this.#tabs.get(handle)
    if (!tab) throw new Error('Browser tab was not found')
    return tab
  }

  #error(
    code: 'TAB_NOT_FOUND' | 'ACTION_CANCELLED' | 'CAPABILITY_UNAVAILABLE',
    message: string
  ): EngineResult {
    return { ok: false as const, error: { code, message } }
  }

  #publish(event: EngineEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}
