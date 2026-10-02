import type {
  BrowserError,
  BrowserOutcome,
  BrowserTabSnapshot,
  BrowserWorkspaceSnapshot
} from '../../shared/browserTypes'
import type { BrowserCheckpointTab } from './browser-checkpoints'
import type { EngineTabHandle } from './browser-engine'

export function browserOriginOf(url: string): string | null {
  try {
    const origin = new URL(url).origin
    return origin === 'null' ? null : origin
  } catch {
    return null
  }
}

function cloneError(error: BrowserError | undefined): BrowserError | undefined {
  return error ? { ...error } : undefined
}

export function cloneBrowserTabSnapshot(tab: BrowserTabSnapshot): BrowserTabSnapshot {
  return { ...tab, ...(tab.error ? { error: cloneError(tab.error) } : {}) }
}

export function cloneBrowserWorkspaceSnapshot(
  snapshot: BrowserWorkspaceSnapshot
): BrowserWorkspaceSnapshot {
  return {
    ...snapshot,
    capabilities: { ...snapshot.capabilities },
    tabs: snapshot.tabs.map(cloneBrowserTabSnapshot)
  }
}

export function cloneBrowserOutcome(outcome: BrowserOutcome): BrowserOutcome {
  if (!outcome.ok) {
    return {
      ok: false,
      error: { ...outcome.error },
      snapshot: cloneBrowserWorkspaceSnapshot(outcome.snapshot)
    }
  }
  return {
    ok: true,
    snapshot: cloneBrowserWorkspaceSnapshot(outcome.snapshot),
    ...(outcome.screenshot ? { screenshot: { ...outcome.screenshot } } : {})
  }
}

export interface BrowserTabRecord {
  handle: EngineTabHandle | null
  snapshot: BrowserTabSnapshot
  navigationRevision: number
  engineNavigationRevisionOffset: number
  engineDocumentRevisionOffset: number
}

export interface RestoredTabBinding {
  handle: EngineTabHandle
  snapshot: BrowserTabSnapshot
  navigationRevision: number
  engineNavigationRevisionOffset: number
  engineDocumentRevisionOffset: number
}

export class BrowserTabCollection {
  readonly #tabs: BrowserTabRecord[] = []
  readonly #byHandle = new Map<EngineTabHandle, BrowserTabRecord>()
  readonly #idFactory: () => string
  #activeTabId: string | null = null

  constructor(idFactory: () => string) {
    this.#idFactory = idFactory
  }

  get activeTabId(): string | null {
    return this.#activeTabId
  }

  get length(): number {
    return this.#tabs.length
  }

  snapshots(): BrowserTabSnapshot[] {
    return this.#tabs.map((tab) => tab.snapshot)
  }

  find(tabId: string): BrowserTabRecord | undefined {
    return this.#tabs.find((tab) => tab.snapshot.id === tabId)
  }

  findByHandle(handle: EngineTabHandle): BrowserTabRecord | undefined {
    return this.#byHandle.get(handle)
  }

  isBound(record: BrowserTabRecord, handle: EngineTabHandle): boolean {
    return this.#byHandle.get(handle) === record
  }

  loadRestored(tabs: BrowserCheckpointTab[], activeTabId: string | null): void {
    for (const saved of tabs) {
      this.#tabs.push({
        handle: null,
        navigationRevision: 0,
        engineNavigationRevisionOffset: 0,
        engineDocumentRevisionOffset: 0,
        snapshot: {
          id: saved.id,
          title: saved.title,
          url: saved.url,
          origin: browserOriginOf(saved.url),
          phase: 'idle',
          canGoBack: false,
          canGoForward: false,
          isAgentControlled: false,
          documentRevision: 0,
          restorable: true
        }
      })
    }
    this.#activeTabId = activeTabId
  }

  create(
    handle: EngineTabHandle,
    isAgentControlled: boolean
  ): {
    tab: BrowserTabRecord
    previousActiveTabId: string | null
  } {
    const previousActiveTabId = this.#activeTabId
    const tab: BrowserTabRecord = {
      handle,
      navigationRevision: 0,
      engineNavigationRevisionOffset: 0,
      engineDocumentRevisionOffset: 0,
      snapshot: {
        id: this.#nextId(),
        title: 'New tab',
        url: 'about:blank',
        origin: null,
        phase: 'idle',
        canGoBack: false,
        canGoForward: false,
        isAgentControlled,
        documentRevision: 0
      }
    }
    this.#tabs.push(tab)
    this.#byHandle.set(handle, tab)
    this.#activeTabId = tab.snapshot.id
    return { tab, previousActiveTabId }
  }

  activate(tabId: string): boolean {
    if (!this.find(tabId) || this.#activeTabId === tabId) return false
    this.#activeTabId = tabId
    return true
  }

  remove(tabId: string): BrowserTabRecord | undefined {
    const index = this.#tabs.findIndex((tab) => tab.snapshot.id === tabId)
    if (index < 0) return undefined
    const tab = this.#tabs[index]
    if (this.#activeTabId === tabId) {
      this.#activeTabId =
        this.#tabs[index + 1]?.snapshot.id ?? this.#tabs[index - 1]?.snapshot.id ?? null
    }
    this.#tabs.splice(index, 1)
    if (tab.handle && this.#byHandle.get(tab.handle) === tab) this.#byHandle.delete(tab.handle)
    return tab
  }

  rollbackCreated(tab: BrowserTabRecord, previousActiveTabId: string | null): void {
    this.#removeRecord(tab)
    if (this.#activeTabId === tab.snapshot.id) {
      this.#activeTabId =
        previousActiveTabId && this.find(previousActiveTabId)
          ? previousActiveTabId
          : (this.#tabs.at(-1)?.snapshot.id ?? null)
    }
  }

  bindRestored(
    tab: BrowserTabRecord,
    handle: EngineTabHandle,
    isAgentControlled: boolean
  ): RestoredTabBinding {
    const binding = {
      handle,
      snapshot: cloneBrowserTabSnapshot(tab.snapshot),
      navigationRevision: tab.navigationRevision,
      engineNavigationRevisionOffset: tab.engineNavigationRevisionOffset,
      engineDocumentRevisionOffset: tab.engineDocumentRevisionOffset
    }
    tab.handle = handle
    this.#byHandle.set(handle, tab)
    delete tab.snapshot.restorable
    tab.snapshot.isAgentControlled ||= isAgentControlled
    return binding
  }

  rollbackRestored(tab: BrowserTabRecord, binding: RestoredTabBinding): void {
    if (this.#byHandle.get(binding.handle) === tab) this.#byHandle.delete(binding.handle)
    tab.handle = null
    tab.snapshot = binding.snapshot
    tab.navigationRevision = binding.navigationRevision
    tab.engineNavigationRevisionOffset = binding.engineNavigationRevisionOffset
    tab.engineDocumentRevisionOffset = binding.engineDocumentRevisionOffset
  }

  replaceHandle(tab: BrowserTabRecord, handle: EngineTabHandle): EngineTabHandle | null {
    if (!this.#tabs.includes(tab) || this.#byHandle.has(handle)) {
      throw new Error('Browser tab handle could not be replaced')
    }
    const previous = tab.handle
    if (previous && this.#byHandle.get(previous) === tab) this.#byHandle.delete(previous)
    tab.handle = handle
    this.#byHandle.set(handle, tab)
    return previous
  }

  #removeRecord(tab: BrowserTabRecord): void {
    const index = this.#tabs.indexOf(tab)
    if (index >= 0) this.#tabs.splice(index, 1)
    if (tab.handle && this.#byHandle.get(tab.handle) === tab) this.#byHandle.delete(tab.handle)
  }

  #nextId(): string {
    for (let attempt = 0; attempt < 10_000; attempt += 1) {
      const tabId = this.#idFactory()
      if (tabId.trim() && !this.find(tabId)) return tabId
    }
    throw new Error('Browser tab ID factory could not produce a unique ID')
  }
}
