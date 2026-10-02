import type { BrowserError, BrowserTabSnapshot } from '../../shared/browserTypes'
import {
  browserCheckpointSignature,
  canonicalizeBrowserCheckpoint,
  createBrowserCheckpoint,
  type BrowserCheckpoint,
  type BrowserCheckpointStore
} from './browser-checkpoints'

export interface BrowserCheckpointCoordinatorOptions {
  sessionId: string
  store: BrowserCheckpointStore
  onError?: (error: BrowserError) => void
}

export class BrowserCheckpointPersistenceError extends Error {
  constructor() {
    super('Browser checkpoint could not be saved')
    this.name = 'BrowserCheckpointPersistenceError'
  }
}

export class BrowserWorkspaceDisposalError extends Error {
  readonly failures: { engine: boolean; checkpoint: boolean }

  constructor(failures: { engine: boolean; checkpoint: boolean }) {
    const categories = [failures.engine ? 'engine' : '', failures.checkpoint ? 'checkpoint' : '']
      .filter(Boolean)
      .join(', ')
    super(`Browser workspace disposal failed (${categories})`)
    this.name = 'BrowserWorkspaceDisposalError'
    this.failures = { ...failures }
  }
}

function cloneCheckpoint(checkpoint: BrowserCheckpoint): BrowserCheckpoint {
  return {
    schemaVersion: 1,
    tabs: checkpoint.tabs.map((tab) => ({ ...tab })),
    activeTabId: checkpoint.activeTabId
  }
}

function signature(checkpoint: BrowserCheckpoint): string | null {
  return checkpoint.tabs.length === 0 ? null : browserCheckpointSignature(checkpoint)
}

export class BrowserCheckpointCoordinator {
  readonly #sessionId: string
  readonly #store: BrowserCheckpointStore
  readonly #onError?: (error: BrowserError) => void
  #desired: BrowserCheckpoint = { schemaVersion: 1, tabs: [], activeTabId: null }
  #desiredSignature: string | null = null
  #successfulSignature: string | null = null
  #failedSignature: string | null | undefined
  #invalidReported = false

  constructor(options: BrowserCheckpointCoordinatorOptions) {
    this.#sessionId = options.sessionId
    this.#store = options.store
    this.#onError = options.onError
  }

  load(): BrowserCheckpoint | null {
    try {
      const raw = this.#store.load(this.#sessionId)
      const checkpoint = raw ? canonicalizeBrowserCheckpoint(raw) : null
      this.#desired = checkpoint ? cloneCheckpoint(checkpoint) : this.#desired
      this.#desiredSignature = checkpoint ? signature(checkpoint) : null
      this.#successfulSignature = this.#desiredSignature
      this.#failedSignature = undefined
      return checkpoint ? cloneCheckpoint(checkpoint) : null
    } catch {
      this.#reportInvalidOnce()
      return null
    }
  }

  persist(checkpoint: BrowserCheckpoint): void {
    let canonical: BrowserCheckpoint
    try {
      canonical = canonicalizeBrowserCheckpoint(checkpoint)
    } catch {
      this.#reportInvalidOnce()
      return
    }
    this.#invalidReported = false
    this.#desired = cloneCheckpoint(canonical)
    this.#desiredSignature = signature(canonical)
    if (this.#desiredSignature === this.#successfulSignature) {
      this.#failedSignature = undefined
      return
    }
    if (this.#desiredSignature === this.#failedSignature) return
    this.#attempt(false)
  }

  persistTabs(tabs: readonly BrowserTabSnapshot[], activeTabId: string | null): void {
    try {
      this.persist(createBrowserCheckpoint(tabs, activeTabId))
    } catch {
      this.#reportInvalidOnce()
    }
  }

  flush(): void {
    if (this.#desiredSignature === this.#successfulSignature) return
    this.#attempt(true)
  }

  #attempt(throwOnFailure: boolean): void {
    try {
      if (this.#desiredSignature === null) this.#store.remove(this.#sessionId)
      else this.#store.save(this.#sessionId, this.#desired)
      this.#successfulSignature = this.#desiredSignature
      this.#failedSignature = undefined
    } catch {
      this.#failedSignature = this.#desiredSignature
      this.#reportError()
      if (throwOnFailure) throw new BrowserCheckpointPersistenceError()
    }
  }

  #reportError(): void {
    try {
      this.#onError?.({
        code: 'ENGINE_UNAVAILABLE',
        message: 'Browser checkpoint could not be saved',
        retryable: true
      })
    } catch {
      // Persistence diagnostics must not break browser commands or final cleanup.
    }
  }

  #reportInvalidOnce(): void {
    if (this.#invalidReported) return
    this.#invalidReported = true
    this.#reportError()
  }
}
