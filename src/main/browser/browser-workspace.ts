import type {
  BrowserActor,
  BrowserCapabilities,
  BrowserCommand,
  BrowserError,
  BrowserOutcome,
  BrowserTabSnapshot,
  BrowserWorkspaceEvent,
  BrowserWorkspaceSnapshot
} from '../../shared/browserTypes'
import {
  normalizeBrowserUrl,
  type BrowserPolicyContext,
  type BrowserUrlPolicyResult
} from './browser-policy'
import type {
  BrowserEngine,
  EngineError,
  EngineEvent,
  EngineResult,
  EngineTabState
} from './browser-engine'
import type { BrowserCheckpointStore } from './browser-checkpoints'
import {
  BrowserCheckpointCoordinator,
  BrowserWorkspaceDisposalError
} from './browser-checkpoint-coordinator'
export { BrowserWorkspaceDisposalError } from './browser-checkpoint-coordinator'
import {
  BrowserTabCollection,
  browserOriginOf,
  cloneBrowserOutcome,
  cloneBrowserWorkspaceSnapshot,
  type BrowserTabRecord as TabRecord,
  type RestoredTabBinding
} from './browser-tab-collection'

type BrowserUrlNormalizer = (input: string, context: BrowserPolicyContext) => BrowserUrlPolicyResult

export interface BrowserWorkspaceOptions {
  sessionId: string
  partition: string
  engine: BrowserEngine
  policyContext?: BrowserPolicyContext
  normalizeUrl?: BrowserUrlNormalizer
  idFactory?: () => string
  now?: () => number
  recentRequestCap?: number
  checkpointStore?: BrowserCheckpointStore
}

interface CachedOutcome {
  at: number
  outcome: BrowserOutcome
}

const DEFAULT_RECENT_REQUEST_CAP = 128
const MAX_RECENT_REQUEST_CAP = 1024

function normalizeRecentRequestCap(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_RECENT_REQUEST_CAP
  }
  return Math.min(MAX_RECENT_REQUEST_CAP, Math.floor(value))
}

function engineError(error: EngineError): BrowserError {
  if (error.code === 'NAVIGATION_FAILED') {
    return {
      code: 'NAVIGATION_FAILED',
      message: 'Page failed to load',
      retryable: true
    }
  }
  return {
    code: error.code,
    message: error.message,
    retryable: error.code === 'ENGINE_UNAVAILABLE' || error.code === 'ACTION_TIMEOUT'
  }
}

export class BrowserWorkspace {
  readonly #sessionId: string
  readonly #partition: string
  readonly #engine: BrowserEngine
  readonly #capabilities: BrowserCapabilities
  readonly #policyContext: BrowserPolicyContext
  readonly #normalizeUrl: BrowserUrlNormalizer
  readonly #idFactory: () => string
  readonly #now: () => number
  readonly #recentRequestCap: number
  readonly #checkpointCoordinator?: BrowserCheckpointCoordinator
  readonly #listeners = new Set<(event: BrowserWorkspaceEvent) => void>()
  readonly #recentRequests = new Map<string, CachedOutcome>()
  readonly #tabCollection: BrowserTabCollection
  readonly #unsubscribeEngine: () => void
  readonly #lifecycle = new AbortController()
  #revision = 0
  #nextId = 0
  #commandTail: Promise<void> = Promise.resolve()
  #disposed = false
  #disposePromise: Promise<void> | null = null

  constructor(options: BrowserWorkspaceOptions) {
    this.#sessionId = options.sessionId
    this.#partition = options.partition
    this.#engine = options.engine
    this.#capabilities = { ...options.engine.capabilities() }
    this.#policyContext = options.policyContext?.applicationOrigins
      ? { applicationOrigins: [...options.policyContext.applicationOrigins] }
      : {}
    this.#normalizeUrl = options.normalizeUrl ?? normalizeBrowserUrl
    this.#idFactory = options.idFactory ?? (() => `browser-tab-${++this.#nextId}`)
    this.#tabCollection = new BrowserTabCollection(this.#idFactory)
    this.#now = options.now ?? Date.now
    this.#recentRequestCap = normalizeRecentRequestCap(options.recentRequestCap)
    this.#checkpointCoordinator = options.checkpointStore
      ? new BrowserCheckpointCoordinator({
          sessionId: this.#sessionId,
          store: options.checkpointStore,
          onError: (error) => this.#emit({ type: 'error', error, revision: this.#revision })
        })
      : undefined
    this.#unsubscribeEngine = this.#engine.subscribe((event) => this.#reduceEngineEvent(event))
    this.#loadCheckpoint()
  }

  async execute(
    actor: BrowserActor,
    command: BrowserCommand,
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    const requestKey = this.#requestKey(actor, command.requestId)
    if (!requestKey) {
      return this.#failure({
        code: 'PERMISSION_DENIED',
        message: 'The agent cannot control another session browser',
        retryable: false
      })
    }
    if (this.#disposed) return this.#failure(this.#disposedError())

    const actionSignal = signal
      ? AbortSignal.any([signal, this.#lifecycle.signal])
      : this.#lifecycle.signal
    const run = this.#commandTail.then(() =>
      this.#executeNow(requestKey, actor, command, actionSignal)
    )
    this.#commandTail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  snapshot(): BrowserWorkspaceSnapshot {
    return cloneBrowserWorkspaceSnapshot(this.#currentSnapshot())
  }

  subscribe(listener: (event: BrowserWorkspaceEvent) => void): () => void {
    if (this.#disposed) return () => undefined
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  dispose(): Promise<void> {
    if (this.#disposePromise) return this.#disposePromise
    this.#disposed = true
    this.#lifecycle.abort()
    this.#unsubscribeEngine()
    this.#listeners.clear()
    this.#recentRequests.clear()
    const pendingCommands = this.#commandTail
    const engineDisposal = this.#engine.dispose()
    this.#disposePromise = (async () => {
      let engineFailed = false
      try {
        await engineDisposal
      } catch {
        engineFailed = true
      }
      await pendingCommands
      let checkpointFailed = false
      try {
        this.#checkpointCoordinator?.flush()
      } catch {
        checkpointFailed = true
      }
      if (engineFailed || checkpointFailed) {
        throw new BrowserWorkspaceDisposalError({
          engine: engineFailed,
          checkpoint: checkpointFailed
        })
      }
    })()
    return this.#disposePromise
  }

  #loadCheckpoint(): void {
    const checkpoint = this.#checkpointCoordinator?.load()
    if (!checkpoint) return
    this.#tabCollection.loadRestored(checkpoint.tabs, checkpoint.activeTabId)
  }

  async #executeNow(
    requestKey: string,
    actor: BrowserActor,
    command: BrowserCommand,
    signal: AbortSignal
  ): Promise<BrowserOutcome> {
    if (this.#disposed) return this.#failure(this.#disposedError())
    const cached = this.#recentRequests.get(requestKey)
    if (cached) return cloneBrowserOutcome(cached.outcome)

    let outcome: BrowserOutcome
    if (signal?.aborted) {
      outcome = this.#failure({
        code: 'ACTION_CANCELLED',
        message: 'Browser action was cancelled',
        retryable: false
      })
    } else {
      try {
        outcome = await this.#dispatch(actor, command, signal)
      } catch {
        outcome = this.#failure({
          code: 'ENGINE_UNAVAILABLE',
          message: 'Browser engine is unavailable',
          retryable: true
        })
      }
    }

    if (!this.#disposed) this.#remember(requestKey, outcome)
    return outcome
  }

  async #dispatch(
    actor: BrowserActor,
    command: BrowserCommand,
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    switch (command.type) {
      case 'open':
        return this.#open(command.url, actor.kind === 'agent', signal)
      case 'newTab':
        return this.#newTab(command.url, actor.kind === 'agent', signal)
      case 'activate':
        return this.#activate(command.tabId)
      case 'close':
        return this.#close(command.tabId)
      case 'navigate':
        return this.#navigate(
          command.tabId,
          command.url,
          command.expectedDocumentRevision,
          actor.kind === 'agent',
          signal
        )
      case 'snapshot':
        return this.#tabCollection.find(command.tabId)
          ? this.#success()
          : this.#failure(this.#tabNotFound(command.tabId))
      case 'restore':
        return this.#restore(command.tabId, actor.kind === 'agent', signal)
      default:
        return this.#failure({
          code: 'CAPABILITY_UNAVAILABLE',
          message: `Browser command is not available yet: ${command.type}`,
          retryable: false
        })
    }
  }

  async #open(
    url: string,
    isAgentControlled: boolean,
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    const normalized = this.#normalizeUrl(url, this.#policyContext)
    if (!normalized.ok) return this.#failure(normalized.error)
    return this.#createTab(normalized.url, isAgentControlled, signal)
  }

  async #newTab(
    url: string | undefined,
    isAgentControlled: boolean,
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    if (url === undefined) return this.#createTab(null, isAgentControlled, signal)
    const normalized = this.#normalizeUrl(url, this.#policyContext)
    if (!normalized.ok) return this.#failure(normalized.error)
    return this.#createTab(normalized.url, isAgentControlled, signal)
  }

  #activate(tabId: string): BrowserOutcome {
    if (!this.#tabCollection.find(tabId)) return this.#failure(this.#tabNotFound(tabId))
    if (this.#tabCollection.activate(tabId)) this.#changed()
    return this.#success()
  }

  async #close(tabId: string): Promise<BrowserOutcome> {
    const tab = this.#tabCollection.find(tabId)
    if (!tab) return this.#failure(this.#tabNotFound(tabId))
    if (tab.handle) await this.#engine.disposeTab(tab.handle)
    if (this.#disposed) return this.#failure(this.#disposedError())
    this.#tabCollection.remove(tabId)
    this.#changed()
    return this.#success()
  }

  async #createTab(
    url: string | null,
    isAgentControlled: boolean,
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    const handle = await this.#engine.createTab({ partition: this.#partition })
    if (this.#disposed || signal?.aborted) {
      await this.#engine.disposeTab(handle)
      return this.#failure(
        this.#disposed
          ? this.#disposedError()
          : {
              code: 'ACTION_CANCELLED',
              message: 'Browser action was cancelled',
              retryable: false
            }
      )
    }

    let tab: TabRecord
    let previousActiveTabId: string | null
    try {
      const created = this.#tabCollection.create(handle, isAgentControlled)
      tab = created.tab
      previousActiveTabId = created.previousActiveTabId
      this.#changed()
    } catch (error) {
      await this.#engine.disposeTab(handle)
      throw error
    }

    if (url === null) return this.#success()
    try {
      const outcome = await this.#navigateEngine(tab, url, signal)
      if (!outcome.ok && outcome.error.code !== 'NAVIGATION_FAILED') {
        await this.#rollbackCreatedTab(tab, previousActiveTabId)
        return this.#failure(outcome.error)
      }
      return outcome
    } catch (error) {
      await this.#rollbackCreatedTab(tab, previousActiveTabId)
      throw error
    }
  }

  async #rollbackCreatedTab(tab: TabRecord, previousActiveTabId: string | null): Promise<void> {
    const handle = tab.handle
    this.#tabCollection.rollbackCreated(tab, previousActiveTabId)
    this.#changed()
    if (handle) await this.#engine.disposeTab(handle)
  }

  async #navigate(
    tabId: string,
    url: string,
    expectedDocumentRevision: number | undefined,
    isAgentControlled: boolean,
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    const tab = this.#tabCollection.find(tabId)
    if (!tab) return this.#failure(this.#tabNotFound(tabId))
    if (
      expectedDocumentRevision !== undefined &&
      expectedDocumentRevision !== tab.snapshot.documentRevision
    ) {
      return this.#failure({
        code: 'STALE_DOCUMENT',
        message: 'The browser page changed before the action could run',
        retryable: true,
        tabId
      })
    }
    const normalized = this.#normalizeUrl(url, this.#policyContext)
    if (!normalized.ok) return this.#failure(normalized.error)
    if (!tab.handle) {
      return this.#materializeRestoredTab(tab, normalized.url, isAgentControlled, true, signal)
    }
    if (isAgentControlled && !tab.snapshot.isAgentControlled) {
      this.#mutateTab(tab, (snapshot) => {
        snapshot.isAgentControlled = true
      })
    }
    return this.#navigateEngine(tab, normalized.url, signal)
  }

  async #restore(
    tabId: string,
    isAgentControlled: boolean,
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    const tab = this.#tabCollection.find(tabId)
    if (!tab) return this.#failure(this.#tabNotFound(tabId))
    if (tab.handle) return this.#success()
    if (tab.snapshot.url === 'about:blank') {
      return this.#materializeRestoredTab(tab, 'about:blank', isAgentControlled, false, signal)
    }
    const normalized = this.#normalizeUrl(tab.snapshot.url, this.#policyContext)
    if (!normalized.ok) return this.#failure(normalized.error)
    return this.#materializeRestoredTab(tab, normalized.url, isAgentControlled, true, signal)
  }

  async #materializeRestoredTab(
    tab: TabRecord,
    url: string,
    isAgentControlled: boolean,
    navigate: boolean,
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    const handle = await this.#engine.createTab({ partition: this.#partition })
    if (this.#disposed || signal?.aborted) {
      await this.#engine.disposeTab(handle)
      return this.#failure(
        this.#disposed
          ? this.#disposedError()
          : {
              code: 'ACTION_CANCELLED',
              message: 'Browser action was cancelled',
              retryable: false
            }
      )
    }
    const binding = this.#tabCollection.bindRestored(tab, handle, isAgentControlled)
    this.#changed()
    if (!navigate) return this.#success()

    try {
      const outcome = await this.#navigateEngine(tab, url, signal)
      if (!outcome.ok && outcome.error.code !== 'NAVIGATION_FAILED') {
        await this.#rollbackRestoredTab(tab, binding)
        return this.#failure(outcome.error)
      }
      return outcome
    } catch (error) {
      await this.#rollbackRestoredTab(tab, binding)
      throw error
    }
  }

  async #rollbackRestoredTab(tab: TabRecord, binding: RestoredTabBinding): Promise<void> {
    this.#tabCollection.rollbackRestored(tab, binding)
    this.#changed()
    await this.#engine.disposeTab(binding.handle)
  }

  async #navigateEngine(
    tab: TabRecord,
    url: string,
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    if (!tab.handle) return this.#failure(this.#disposedError())
    const result = await this.#engine.execute(tab.handle, { type: 'navigate', url }, signal)
    if (this.#disposed) return this.#failure(this.#disposedError())
    if (!result.ok) {
      const error = engineError(result.error)
      if (error.code === 'NAVIGATION_FAILED') {
        this.#mutateTab(tab, (snapshot) => {
          snapshot.url = url
          snapshot.origin = browserOriginOf(url)
          snapshot.phase = 'failed'
          snapshot.error = { ...error, tabId: snapshot.id }
        })
      }
      return this.#failure(error)
    }
    this.#syncEngineState(tab, result)
    return this.#success()
  }

  #syncEngineState(tab: TabRecord, result: Extract<EngineResult, { ok: true }>): void {
    if (result.state.navigationRevision < tab.navigationRevision) return
    if (
      result.state.navigationRevision === tab.navigationRevision &&
      result.state.documentRevision <= tab.snapshot.documentRevision
    )
      return
    tab.navigationRevision = result.state.navigationRevision
    if (result.state.documentRevision < tab.snapshot.documentRevision) return
    this.#mutateTab(tab, (snapshot) => {
      this.#applyEngineState(snapshot, result.state)
      snapshot.error = undefined
    })
  }

  #applyEngineState(snapshot: BrowserTabSnapshot, state: EngineTabState): void {
    snapshot.url = state.url
    snapshot.origin = browserOriginOf(state.url)
    snapshot.title = state.title
    snapshot.phase = state.isLoading ? 'loading' : 'ready'
    snapshot.canGoBack = state.canGoBack
    snapshot.canGoForward = state.canGoForward
    snapshot.documentRevision = Math.max(snapshot.documentRevision, state.documentRevision)
  }

  #reduceEngineEvent(event: EngineEvent): void {
    if (this.#disposed) return
    const tab = this.#tabCollection.findByHandle(event.handle)
    if (!tab) return

    switch (event.type) {
      case 'loadingChanged':
        if (!this.#acceptNavigationEvent(tab, event.navigationRevision)) return
        this.#mutateTab(tab, (snapshot) => {
          if (event.isLoading) {
            snapshot.phase = 'loading'
            snapshot.error = undefined
          } else if (snapshot.phase === 'loading') {
            snapshot.phase = 'ready'
          }
        })
        break
      case 'navigationCommitted':
        if (event.navigationRevision < tab.navigationRevision) return
        if (event.navigationRevision > tab.navigationRevision) {
          tab.navigationRevision = event.navigationRevision
        }
        if (event.documentRevision <= tab.snapshot.documentRevision) return
        this.#mutateTab(tab, (snapshot) => {
          snapshot.url = event.url
          snapshot.origin = browserOriginOf(event.url)
          snapshot.documentRevision = event.documentRevision
          snapshot.canGoBack = event.canGoBack
          snapshot.canGoForward = event.canGoForward
          snapshot.error = undefined
        })
        break
      case 'titleChanged':
        if (!this.#acceptNavigationEvent(tab, event.navigationRevision)) return
        this.#mutateTab(tab, (snapshot) => {
          snapshot.title = event.title
        })
        break
      case 'loadFailed':
        if (!this.#acceptNavigationEvent(tab, event.navigationRevision)) return
        this.#mutateTab(tab, (snapshot) => {
          snapshot.url = event.url
          snapshot.origin = browserOriginOf(event.url)
          snapshot.phase = 'failed'
          snapshot.error = {
            code: 'NAVIGATION_FAILED',
            message: 'Page failed to load',
            retryable: true,
            tabId: snapshot.id
          }
        })
        break
      case 'crashed':
        this.#mutateTab(tab, (snapshot) => {
          snapshot.phase = 'crashed'
          snapshot.error = {
            code: 'RENDERER_CRASHED',
            message: 'The browser page stopped unexpectedly',
            retryable: true,
            tabId: snapshot.id
          }
        })
        break
      case 'popupRequested':
        this.#queuePopup(tab, event)
        break
    }
  }

  #queuePopup(source: TabRecord, event: Extract<EngineEvent, { type: 'popupRequested' }>): void {
    const sourceHandle = source.handle
    if (!sourceHandle) return
    const isAgentControlled = source.snapshot.isAgentControlled
    const queued = this.#commandTail.then(async () => {
      if (!this.#tabCollection.isBound(source, sourceHandle)) return
      if (this.#disposed || event.method !== 'GET') return
      const normalized = this.#normalizeUrl(event.url, this.#policyContext)
      if (!normalized.ok) return
      try {
        await this.#createTab(normalized.url, isAgentControlled, this.#lifecycle.signal)
      } catch {
        return
      }
    })
    this.#commandTail = queued.then(
      () => undefined,
      () => undefined
    )
  }

  #acceptNavigationEvent(tab: TabRecord, navigationRevision: number): boolean {
    if (navigationRevision < tab.navigationRevision) return false
    tab.navigationRevision = navigationRevision
    return true
  }

  #mutateTab(tab: TabRecord, mutate: (snapshot: BrowserTabSnapshot) => void): void {
    const before = JSON.stringify(tab.snapshot)
    mutate(tab.snapshot)
    if (JSON.stringify(tab.snapshot) !== before) this.#changed()
  }

  #changed(): void {
    this.#revision += 1
    this.#persistCheckpoint()
    const event: BrowserWorkspaceEvent = {
      type: 'snapshotChanged',
      snapshot: this.snapshot()
    }
    this.#emit(event)
  }

  #persistCheckpoint(): void {
    if (!this.#checkpointCoordinator) return
    this.#checkpointCoordinator.persistTabs(
      this.#tabCollection.snapshots(),
      this.#tabCollection.activeTabId
    )
  }

  #emit(event: BrowserWorkspaceEvent): void {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch {
        continue
      }
    }
  }

  #currentSnapshot(): BrowserWorkspaceSnapshot {
    return {
      sessionId: this.#sessionId,
      activeTabId: this.#tabCollection.activeTabId,
      tabs: this.#tabCollection.snapshots(),
      capabilities: this.#capabilities,
      revision: this.#revision
    }
  }

  #success(): BrowserOutcome {
    return { ok: true, snapshot: this.snapshot() }
  }

  #failure(error: BrowserError): BrowserOutcome {
    return { ok: false, error: { ...error }, snapshot: this.snapshot() }
  }

  #tabNotFound(tabId: string): BrowserError {
    return {
      code: 'TAB_NOT_FOUND',
      message: 'Browser tab was not found',
      retryable: false,
      tabId
    }
  }

  #disposedError(): BrowserError {
    return {
      code: 'ENGINE_UNAVAILABLE',
      message: 'Browser workspace is disposed',
      retryable: false
    }
  }

  #requestKey(actor: BrowserActor, requestId: string): string | null {
    if (actor.kind === 'human') return JSON.stringify(['human', requestId])
    if (actor.sessionId !== this.#sessionId) return null
    return JSON.stringify(['agent', actor.sessionId, actor.runId, actor.toolCallId, requestId])
  }

  #remember(requestKey: string, outcome: BrowserOutcome): void {
    if (this.#recentRequestCap === 0) return
    this.#recentRequests.set(requestKey, {
      at: this.#now(),
      outcome: cloneBrowserOutcome(outcome)
    })
    while (this.#recentRequests.size > this.#recentRequestCap) {
      let oldestId: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [id, cached] of this.#recentRequests) {
        if (cached.at < oldestAt) {
          oldestId = id
          oldestAt = cached.at
        }
      }
      if (oldestId === null) break
      this.#recentRequests.delete(oldestId)
    }
  }
}
