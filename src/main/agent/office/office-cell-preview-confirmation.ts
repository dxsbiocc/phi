import type { OfficeCellPatch } from './office-selection-events'
import type { OfficePreviewConfirmation } from './office-write-contract'

interface CellPatchWaiter {
  readonly sheet: string
  readonly pendingCells: Set<string>
  readonly resolve: (confirmed: boolean) => void
  readonly timer: NodeJS.Timeout
  writeDispatched: boolean
  fullRefreshEligible: boolean
  readonly baselineFullVersion?: number
}

export class OfficeCellPreviewConfirmationManager {
  private readonly waiters = new Map<string, Set<CellPatchWaiter>>()
  private readonly fullVersions = new Map<string, number>()

  constructor(private readonly timeoutMs: number) {}

  arm(artifactId: string, sheet: string, cells: readonly string[]): OfficePreviewConfirmation {
    let waiter: CellPatchWaiter
    const promise = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => this.settle(artifactId, waiter, false), this.timeoutMs)
      timer.unref()
      waiter = {
        sheet,
        pendingCells: new Set(cells),
        resolve,
        timer,
        writeDispatched: false,
        fullRefreshEligible: false,
        baselineFullVersion: this.fullVersions.get(artifactId)
      }
      const waiters = this.waiters.get(artifactId) ?? new Set<CellPatchWaiter>()
      waiters.add(waiter)
      this.waiters.set(artifactId, waiters)
    })
    return {
      promise,
      cancel: () => this.settle(artifactId, waiter, false),
      markDispatched: () => {
        waiter.writeDispatched = true
        waiter.fullRefreshEligible = waiter.baselineFullVersion !== undefined
      }
    }
  }

  publishPatch(artifactId: string, patch: OfficeCellPatch): void {
    for (const waiter of [...(this.waiters.get(artifactId) ?? [])]) {
      if (
        waiter.writeDispatched &&
        waiter.sheet === patch.sheet &&
        waiter.pendingCells.delete(patch.cell) &&
        waiter.pendingCells.size === 0
      ) {
        this.settle(artifactId, waiter, true)
      }
    }
  }

  publishFull(artifactId: string, version: number): void {
    this.fullVersions.set(artifactId, version)
    for (const waiter of [...(this.waiters.get(artifactId) ?? [])]) {
      if (
        waiter.fullRefreshEligible &&
        waiter.baselineFullVersion !== undefined &&
        version > waiter.baselineFullVersion
      ) {
        this.settle(artifactId, waiter, true)
      }
    }
  }

  establishBaseline(artifactId: string, version: number): void {
    this.fullVersions.set(artifactId, version)
  }

  clear(artifactId: string): void {
    for (const waiter of [...(this.waiters.get(artifactId) ?? [])]) {
      this.settle(artifactId, waiter, false)
    }
    this.fullVersions.delete(artifactId)
  }

  private settle(artifactId: string, waiter: CellPatchWaiter, confirmed: boolean): void {
    const waiters = this.waiters.get(artifactId)
    if (!waiters?.delete(waiter)) return
    clearTimeout(waiter.timer)
    if (waiters.size === 0) this.waiters.delete(artifactId)
    waiter.resolve(confirmed)
  }
}
