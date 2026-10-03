import type {
  BrowserActor,
  BrowserCapabilities,
  BrowserCommand,
  BrowserError,
  BrowserOutcome,
  BrowserScreenshot,
  BrowserTabSnapshot,
  BrowserViewport,
  BrowserWorkspaceEvent,
  BrowserWorkspaceSnapshot
} from '../../shared/browserTypes'
import {
  normalizeBrowserUrl,
  type BrowserPolicyContext,
  type BrowserUrlPolicyResult
} from './browser-policy'
import type { BrowserEngine, EngineEvent } from './browser-engine'
import type { BrowserCheckpointStore } from './browser-checkpoints'
import {
  BrowserCheckpointCoordinator,
  BrowserWorkspaceDisposalError
} from './browser-checkpoint-coordinator'
export { BrowserWorkspaceDisposalError } from './browser-checkpoint-coordinator'
import {
  BrowserTabCollection,
  browserOriginOf,
  cloneBrowserWorkspaceSnapshot,
  type BrowserTabRecord as TabRecord,
  type RestoredTabBinding
} from './browser-tab-collection'
import {
  reconcileEngineResult,
  reduceBrowserEngineEvent,
  safeBrowserEngineError,
  workspaceEngineResult
} from './browser-workspace-engine-state'
import { prepareCrashedTabRecovery } from './browser-workspace-recovery'
import { BrowserWorkspaceCleanup } from './browser-workspace-cleanup'
import { BrowserWorkspacePresentation } from './browser-workspace-presentation'
import { BrowserWorkspaceRequestCache } from './browser-workspace-request-cache'
import { openActiveBrowserTabExternally } from './browser-workspace-external'
import { captureBrowserWorkspaceScreenshot } from './browser-workspace-screenshot'

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
  openExternal?: (url: string) => Promise<void>
}

export class BrowserWorkspace {
  readonly #sessionId: string
  readonly #partition: string
  readonly #engine: BrowserEngine
  readonly #cleanup: BrowserWorkspaceCleanup
  readonly #presentation: BrowserWorkspacePresentation
  readonly #capabilities: BrowserCapabilities
  readonly #policyContext: BrowserPolicyContext
  readonly #normalizeUrl: BrowserUrlNormalizer
  readonly #idFactory: () => string
  readonly #requestCache: BrowserWorkspaceRequestCache
  readonly #checkpointCoordinator?: BrowserCheckpointCoordinator
  readonly #openExternal?: (url: string) => Promise<void>
  readonly #listeners = new Set<(event: BrowserWorkspaceEvent) => void>()
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
    this.#cleanup = new BrowserWorkspaceCleanup(options.engine)
    this.#presentation = new BrowserWorkspacePresentation(options.engine)
    this.#capabilities = { ...options.engine.capabilities() }
    this.#policyContext = options.policyContext?.applicationOrigins
      ? { applicationOrigins: [...options.policyContext.applicationOrigins] }
      : {}
    this.#normalizeUrl = options.normalizeUrl ?? normalizeBrowserUrl
    this.#idFactory = options.idFactory ?? (() => `browser-tab-${++this.#nextId}`)
    this.#tabCollection = new BrowserTabCollection(this.#idFactory)
    this.#requestCache = new BrowserWorkspaceRequestCache(
      options.recentRequestCap,
      options.now ?? Date.now
    )
    this.#openExternal = options.openExternal
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

  setViewport(tabId: string, viewport: BrowserViewport | null): Promise<void> {
    const copiedViewport = viewport ? { ...viewport } : null
    if (this.#disposed) return Promise.reject(new Error('Browser workspace is disposed'))
    if (!this.#tabCollection.find(tabId)?.handle) {
      return Promise.reject(new Error('Browser tab is not available for presentation'))
    }
    return this.#presentation.apply(
      tabId,
      copiedViewport,
      () => this.#tabCollection.find(tabId)?.handle ?? null
    )
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
    this.#requestCache.clear()
    this.#presentation.clear()
    const pendingCommands = this.#commandTail
    const engineDisposal = this.#cleanup.disposeEngine()
    this.#disposePromise = (async () => {
      const disposalFailed = await engineDisposal
      await pendingCommands
      const engineFailed = disposalFailed || this.#cleanup.engineFailed
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
    const cacheable = command.type !== 'snapshot'
    const cached = cacheable ? this.#requestCache.get(requestKey) : undefined
    if (cached) return cached

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

    if (!this.#disposed && cacheable) this.#requestCache.remember(requestKey, outcome)
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
      case 'history':
        return this.#executeEngineCommand(
          command.tabId,
          {
            type: 'history',
            direction: command.direction
          },
          signal
        )
      case 'reload':
        return this.#reload(command.tabId, signal)
      case 'stop':
        return this.#executeEngineCommand(command.tabId, { type: 'stop' }, signal)
      case 'openExternal': {
        const activeTabId = this.#tabCollection.activeTabId
        const result = await openActiveBrowserTabExternally({
          actor,
          requestedTabId: command.tabId,
          expectedDocumentRevision: command.expectedDocumentRevision,
          activeTab: activeTabId ? this.#tabCollection.find(activeTabId)?.snapshot : undefined,
          policyContext: this.#policyContext,
          normalizeUrl: this.#normalizeUrl,
          ...(this.#openExternal ? { openExternal: this.#openExternal } : {})
        })
        return result.ok ? this.#success() : this.#failure(result.error)
      }
      case 'snapshot':
        return this.#captureScreenshot(command.tabId, signal)
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
    this.#presentation.invalidate(tabId)
    if (tab.handle) await this.#cleanup.release(tab.handle)
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
      await this.#cleanup.release(handle)
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
      await this.#cleanup.release(handle)
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
    this.#presentation.invalidate(tab.snapshot.id)
    this.#tabCollection.rollbackCreated(tab, previousActiveTabId)
    this.#changed()
    if (handle) await this.#cleanup.release(handle)
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
      await this.#cleanup.release(handle)
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
    this.#presentation.invalidate(tab.snapshot.id)
    this.#tabCollection.rollbackRestored(tab, binding)
    this.#changed()
    await this.#cleanup.release(binding.handle)
  }

  async #navigateEngine(
    tab: TabRecord,
    url: string,
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    if (!tab.handle) return this.#failure(this.#disposedError())
    const engineResult = await this.#engine.execute(tab.handle, { type: 'navigate', url }, signal)
    const result = workspaceEngineResult(tab, engineResult)
    if (this.#disposed) return this.#failure(this.#disposedError())
    if (!result.ok) {
      const error = safeBrowserEngineError(result.error)
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
    if (reconcileEngineResult(tab, result)) this.#changed()
    return this.#success()
  }

  async #executeEngineCommand(
    tabId: string,
    command: { type: 'history'; direction: 'back' | 'forward' } | { type: 'reload' | 'stop' },
    signal?: AbortSignal
  ): Promise<BrowserOutcome> {
    const tab = this.#tabCollection.find(tabId)
    if (!tab) return this.#failure(this.#tabNotFound(tabId))
    if (!tab.handle) {
      return this.#failure({
        code: 'CAPABILITY_UNAVAILABLE',
        message: 'Restore the page before using browser controls',
        retryable: false,
        tabId
      })
    }
    const engineResult = await this.#engine.execute(tab.handle, command, signal)
    const result = workspaceEngineResult(tab, engineResult)
    if (this.#disposed) return this.#failure(this.#disposedError())
    if (!result.ok) return this.#failure(safeBrowserEngineError(result.error))
    if (reconcileEngineResult(tab, result)) this.#changed()
    return this.#success()
  }

  async #captureScreenshot(tabId: string, signal?: AbortSignal): Promise<BrowserOutcome> {
    const tab = this.#tabCollection.find(tabId)
    if (!tab) return this.#failure(this.#tabNotFound(tabId))
    const result = await captureBrowserWorkspaceScreenshot({
      engine: this.#engine,
      tabs: this.#tabCollection,
      tab,
      screenshotAvailable: this.#capabilities.screenshot,
      signal,
      isDisposed: () => this.#disposed
    })
    return result.ok ? this.#success(result.screenshot) : this.#failure(result.error)
  }

  async #reload(tabId: string, signal?: AbortSignal): Promise<BrowserOutcome> {
    const tab = this.#tabCollection.find(tabId)
    if (!tab) return this.#failure(this.#tabNotFound(tabId))
    if (tab.snapshot.phase !== 'crashed') {
      return this.#executeEngineCommand(tabId, { type: 'reload' }, signal)
    }
    if (!tab.handle) return this.#failure(this.#tabNotFound(tabId))
    const normalized =
      tab.snapshot.url === 'about:blank'
        ? { ok: true as const, url: 'about:blank' }
        : this.#normalizeUrl(tab.snapshot.url, this.#policyContext)
    if (!normalized.ok) return this.#failure(normalized.error)
    this.#presentation.invalidate(tabId)

    const recovery = await prepareCrashedTabRecovery({
      engine: this.#engine,
      release: (handle) => this.#cleanup.release(handle),
      tabs: this.#tabCollection,
      tab,
      partition: this.#partition,
      signal,
      isDisposed: () => this.#disposed,
      ...(normalized.url === 'about:blank'
        ? {
            exposeInitialDocument: () => {
              this.#mutateTab(tab, (snapshot) => {
                snapshot.documentRevision += 1
                snapshot.phase = 'idle'
                snapshot.error = undefined
              })
            }
          }
        : {})
    })
    if (!recovery.ok) {
      if (recovery.cancelled) {
        return this.#failure(
          this.#disposed
            ? this.#disposedError()
            : safeBrowserEngineError({ code: 'ACTION_CANCELLED', message: 'cancelled' })
        )
      }
      return this.#failure({
        code: 'ENGINE_UNAVAILABLE',
        message: 'Browser engine is unavailable',
        retryable: true,
        tabId
      })
    }

    let outcome: BrowserOutcome
    if (normalized.url === 'about:blank') {
      outcome = this.#success()
    } else {
      outcome = await this.#navigateEngine(tab, normalized.url, signal)
    }
    if (recovery.cleanupFailed) {
      return this.#failure({
        code: 'ENGINE_UNAVAILABLE',
        message: 'Browser engine cleanup failed',
        retryable: true,
        tabId
      })
    }
    return outcome
  }

  #reduceEngineEvent(rawEvent: EngineEvent): void {
    if (this.#disposed) return
    const tab = this.#tabCollection.findByHandle(rawEvent.handle)
    if (!tab) return
    const reduction = reduceBrowserEngineEvent(tab, rawEvent)
    if ('popup' in reduction) {
      this.#queuePopup(tab, reduction.popup)
    } else if (reduction.changed) {
      this.#changed()
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

  #success(screenshot?: BrowserScreenshot): BrowserOutcome {
    return {
      ok: true,
      snapshot: this.snapshot(),
      ...(screenshot ? { screenshot: { ...screenshot } } : {})
    }
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
}
