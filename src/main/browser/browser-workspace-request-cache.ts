import type { BrowserOutcome } from '../../shared/browserTypes'
import { cloneBrowserOutcome } from './browser-tab-collection'

const DEFAULT_CAP = 128
const MAX_CAP = 1024

function normalizedCap(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) return DEFAULT_CAP
  return Math.min(MAX_CAP, Math.floor(value))
}

export class BrowserWorkspaceRequestCache {
  readonly #cap: number
  readonly #now: () => number
  readonly #entries = new Map<string, { at: number; outcome: BrowserOutcome }>()

  constructor(cap: number | undefined, now: () => number) {
    this.#cap = normalizedCap(cap)
    this.#now = now
  }

  get(key: string): BrowserOutcome | undefined {
    const cached = this.#entries.get(key)
    return cached ? cloneBrowserOutcome(cached.outcome) : undefined
  }

  remember(key: string, outcome: BrowserOutcome): void {
    if (this.#cap === 0) return
    this.#entries.set(key, { at: this.#now(), outcome: cloneBrowserOutcome(outcome) })
    while (this.#entries.size > this.#cap) {
      let oldestKey: string | null = null
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [candidate, cached] of this.#entries) {
        if (cached.at < oldestAt) {
          oldestKey = candidate
          oldestAt = cached.at
        }
      }
      if (oldestKey === null) break
      this.#entries.delete(oldestKey)
    }
  }

  clear(): void {
    this.#entries.clear()
  }
}
