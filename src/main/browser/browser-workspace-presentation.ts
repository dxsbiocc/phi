import type { BrowserViewport } from '../../shared/browserTypes'
import type { BrowserEngine, EngineTabHandle } from './browser-engine'

interface PresentationState {
  latestTicket: number
  tail: Promise<void>
}

export class BrowserPresentationSupersededError extends Error {
  constructor() {
    super('Browser presentation request was superseded')
    this.name = 'BrowserPresentationSupersededError'
  }
}

export class BrowserWorkspacePresentation {
  readonly #engine: BrowserEngine
  readonly #states = new Map<string, PresentationState>()

  constructor(engine: BrowserEngine) {
    this.#engine = engine
  }

  apply(
    tabId: string,
    viewport: BrowserViewport | null,
    resolveHandle: () => EngineTabHandle | null
  ): Promise<void> {
    const state = this.#states.get(tabId) ?? { latestTicket: 0, tail: Promise.resolve() }
    this.#states.set(tabId, state)
    const ticket = ++state.latestTicket
    const run = state.tail.then(async () => {
      if (ticket !== state.latestTicket) {
        if (viewport === null) throw new BrowserPresentationSupersededError()
        return
      }
      const handle = resolveHandle()
      if (!handle) throw new Error('Browser tab is not available for presentation')
      try {
        await this.#engine.setViewport(handle, viewport ? { ...viewport } : null)
      } catch {
        throw new Error('Browser viewport could not be applied')
      }
      if (ticket !== state.latestTicket) throw new BrowserPresentationSupersededError()
    })
    state.tail = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  invalidate(tabId: string): void {
    const state = this.#states.get(tabId)
    if (!state) return
    const invalidationTicket = ++state.latestTicket
    const pending = state.tail
    void pending.finally(() => {
      if (
        this.#states.get(tabId) === state &&
        state.latestTicket === invalidationTicket &&
        state.tail === pending
      ) {
        this.#states.delete(tabId)
      }
    })
  }

  clear(): void {
    for (const state of this.#states.values()) state.latestTicket += 1
    this.#states.clear()
  }
}
