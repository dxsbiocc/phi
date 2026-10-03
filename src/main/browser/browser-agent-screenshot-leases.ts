import type { BrowserViewport } from '../../shared/browserTypes'

export type BrowserAgentScreenshotLease = {
  runId: string
  documentRevision: number
  width: number
  height: number
}

export class BrowserAgentScreenshotLeases {
  readonly #leases = new Map<string, BrowserAgentScreenshotLease>()
  readonly #viewports = new Map<string, BrowserViewport | null>()
  readonly #presentationWaiters = new Map<string, Set<(presented: boolean) => void>>()

  get(tabId: string): BrowserAgentScreenshotLease | undefined {
    return this.#leases.get(tabId)
  }

  remember(tabId: string, lease: BrowserAgentScreenshotLease): void {
    this.#leases.set(tabId, lease)
  }

  consume(tabId: string, runId: string, documentRevision: number): boolean {
    const lease = this.#leases.get(tabId)
    if (lease?.runId !== runId || lease.documentRevision !== documentRevision) return false
    this.#leases.delete(tabId)
    return true
  }

  matches(tabId: string, runId: string, documentRevision: number): boolean {
    const lease = this.#leases.get(tabId)
    return lease?.runId === runId && lease.documentRevision === documentRevision
  }

  isPresented(tabId: string): boolean {
    return Boolean(this.#viewports.get(tabId))
  }

  waitUntilPresented(tabId: string, signal: AbortSignal, timeoutMs: number): Promise<boolean> {
    if (this.#viewports.get(tabId)) return Promise.resolve(true)
    if (signal.aborted) return Promise.resolve(false)
    return new Promise<boolean>((resolve) => {
      let settled = false
      const waiters = this.#presentationWaiters.get(tabId) ?? new Set()
      this.#presentationWaiters.set(tabId, waiters)
      const finish = (presented: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        waiters.delete(finish)
        if (waiters.size === 0) this.#presentationWaiters.delete(tabId)
        resolve(presented)
      }
      const onAbort = (): void => finish(false)
      const timer = setTimeout(() => finish(false), timeoutMs)
      signal.addEventListener('abort', onAbort, { once: true })
      waiters.add(finish)
    })
  }

  invalidate(tabId: string): void {
    this.#leases.delete(tabId)
  }

  remove(tabId: string): void {
    this.#leases.delete(tabId)
    this.#viewports.delete(tabId)
    this.#resolvePresentationWaiters(tabId, false)
  }

  viewportApplied(tabId: string, viewport: BrowserViewport | null): void {
    if (JSON.stringify(this.#viewports.get(tabId)) !== JSON.stringify(viewport)) {
      this.#leases.delete(tabId)
    }
    this.#viewports.set(tabId, viewport ? { ...viewport } : null)
    if (viewport) this.#resolvePresentationWaiters(tabId, true)
    if (!viewport) return
    for (const otherTabId of this.#viewports.keys()) {
      if (otherTabId !== tabId) this.#leases.delete(otherTabId)
    }
  }

  clear(): void {
    this.#leases.clear()
    this.#viewports.clear()
    for (const tabId of this.#presentationWaiters.keys()) {
      this.#resolvePresentationWaiters(tabId, false)
    }
  }

  invalidateAll(): void {
    this.#leases.clear()
  }

  #resolvePresentationWaiters(tabId: string, presented: boolean): void {
    for (const waiter of [...(this.#presentationWaiters.get(tabId) ?? [])]) waiter(presented)
  }
}
