import type { OfficeServiceCleanup } from './office-service-cleanup'
import type { OfficeCreationFlow } from './office-service-create'
import type { OfficeOpeningFlow } from './office-service-open'
import type { OfficeServiceSelectionFacade } from './office-service-selection'
import type { OwnedOfficeDocument } from './office-service-state'
import type { OfficeTargetRegistry } from './office-targets'

interface OfficeServiceShutdownState {
  readonly creation: OfficeCreationFlow
  readonly opening: OfficeOpeningFlow
  readonly cleanup: OfficeServiceCleanup
  readonly owned: ReadonlyMap<string, OwnedOfficeDocument>
  readonly closingArtifacts: Set<string>
  readonly targets: OfficeTargetRegistry
  readonly selection: OfficeServiceSelectionFacade
  readonly forgetRegisteredBlankSession: (sessionId: string) => void
  readonly kill?: (pid: number, signal: NodeJS.Signals) => void
}

export interface OfficeDisposeOptions {
  /**
   * Application quit only waits a couple of seconds in total, so the service must finish inside
   * its own share. Documents are already flushed to disk after every write; whatever is still
   * running at the deadline is terminated and any leftover is handled by the next launch's
   * stale-process cleanup instead of delaying quit.
   */
  readonly deadlineMs?: number
}

export class OfficeServiceShutdown {
  constructor(private readonly state: OfficeServiceShutdownState) {}

  async dispose(options: OfficeDisposeOptions = {}): Promise<void> {
    const owned = [...this.state.owned.values()]
    if (options.deadlineMs === undefined) return this.disposeFully()
    const cleanupBudgetMs = Math.min(200, Math.max(1, Math.floor(options.deadlineMs / 4)))
    const gracefulDeadlineMs = Math.max(0, options.deadlineMs - cleanupBudgetMs)
    let timer: ReturnType<typeof setTimeout> | undefined
    const deadline = new Promise<'deadline'>((resolve) => {
      timer = setTimeout(() => resolve('deadline'), gracefulDeadlineMs)
    })
    try {
      const outcome = await Promise.race([
        this.disposeFully().then(
          () => 'done' as const,
          () => 'done' as const
        ),
        deadline
      ])
      if (outcome === 'deadline') {
        this.terminateOwnedProcesses(owned)
        await this.forceCleanupActiveImports(cleanupBudgetMs)
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private async forceCleanupActiveImports(timeoutMs: number): Promise<void> {
    const cleanup = this.state.creation.forceCleanupActiveImports?.(this.state.kill)
    if (!cleanup) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private terminateOwnedProcesses(entries: readonly OwnedOfficeDocument[]): void {
    const kill = this.state.kill ?? signalOwnedProcess
    for (const entry of entries) {
      for (const pid of [entry.document.residentPid, entry.document.watchPid]) {
        if (Number.isSafeInteger(pid) && pid > 0) kill(pid, 'SIGTERM')
      }
    }
  }

  private async disposeFully(): Promise<void> {
    await this.state.creation.cancelMatching(() => true)
    await this.state.opening.waitForPending()
    const owned = [...this.state.owned.values()]
    this.beginRelease(owned)
    await Promise.all(owned.map((entry) => entry.operations.drain()))
    try {
      await this.state.cleanup.finish([
        this.state.cleanup.releaseEntries(owned),
        this.state.cleanup.retryPending(() => true)
      ])
    } finally {
      for (const entry of owned) this.state.targets.clearSession(entry.document.sessionId)
      this.finishRelease(owned)
      this.state.selection.dispose()
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    await this.state.creation.cancelMatching((control) => control.sessionId === sessionId)
    await this.state.opening.waitForPending()
    const owned = [...this.state.owned.values()].filter(
      (entry) => entry.document.sessionId === sessionId
    )
    this.beginRelease(owned)
    await Promise.all(owned.map((entry) => entry.operations.drain()))
    try {
      await this.state.cleanup.finish([
        this.state.cleanup.releaseEntries(owned),
        this.state.cleanup.retryPending((entry) => entry.artifact.sessionId === sessionId)
      ])
    } finally {
      this.state.targets.clearSession(sessionId)
      this.finishRelease(owned)
    }
    this.state.forgetRegisteredBlankSession(sessionId)
  }

  private beginRelease(entries: readonly OwnedOfficeDocument[]): void {
    for (const entry of entries) {
      this.state.closingArtifacts.add(entry.document.artifactId)
      this.state.targets.markArtifactReleased(entry.document.artifactId)
      entry.operations.cancel()
    }
  }

  private finishRelease(entries: readonly OwnedOfficeDocument[]): void {
    for (const entry of entries) {
      if (!this.state.owned.has(entry.document.artifactId)) {
        this.state.closingArtifacts.delete(entry.document.artifactId)
      }
    }
  }
}

function signalOwnedProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // Already gone.
  }
}
