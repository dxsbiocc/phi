import type { BrowserEngine, EngineTabHandle } from './browser-engine'

export class BrowserWorkspaceEngineCleanupError extends Error {
  constructor() {
    super('Browser engine cleanup failed')
    this.name = 'BrowserWorkspaceEngineCleanupError'
  }
}

export class BrowserWorkspaceCleanup {
  readonly #engine: BrowserEngine
  #engineFailed = false

  constructor(engine: BrowserEngine) {
    this.#engine = engine
  }

  get engineFailed(): boolean {
    return this.#engineFailed
  }

  async release(handle: EngineTabHandle): Promise<void> {
    try {
      await this.#engine.disposeTab(handle)
    } catch {
      this.#engineFailed = true
      throw new BrowserWorkspaceEngineCleanupError()
    }
  }

  async disposeEngine(): Promise<boolean> {
    try {
      await this.#engine.dispose()
    } catch {
      this.#engineFailed = true
    }
    return this.#engineFailed
  }
}
