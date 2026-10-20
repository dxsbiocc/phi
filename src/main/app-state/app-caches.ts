import type { SessionTitleGenerator } from '../agent/session/session-title-generation'
import type { PackageUpdate } from '../agent/packages/installer'
import type { MacLaunchServicesHandler } from '../local-file-icons'

export class AppCaches {
  private currentMacLaunchServicesHandlers: Promise<MacLaunchServicesHandler[]> | null = null
  private currentPackageUpdates: PackageUpdate[] = []
  private currentPreventSleepBlockerId: number | null = null
  private currentSessionTitleGenerator: SessionTitleGenerator | null = null

  get macLaunchServicesHandlers(): Promise<MacLaunchServicesHandler[]> | null {
    return this.currentMacLaunchServicesHandlers
  }

  get cachedPackageUpdates(): PackageUpdate[] {
    return this.currentPackageUpdates
  }

  get preventSleepBlockerId(): number | null {
    return this.currentPreventSleepBlockerId
  }

  get sessionTitleGenerator(): SessionTitleGenerator | null {
    return this.currentSessionTitleGenerator
  }

  setMacLaunchServicesHandlers(handlers: Promise<MacLaunchServicesHandler[]>): void {
    this.currentMacLaunchServicesHandlers = handlers
  }

  replaceCachedPackageUpdates(updates: PackageUpdate[]): void {
    this.currentPackageUpdates = updates
  }

  clearCachedPackageUpdates(): void {
    this.currentPackageUpdates = []
  }

  setPreventSleepBlockerId(id: number): void {
    this.currentPreventSleepBlockerId = id
  }

  clearPreventSleepBlockerId(): void {
    this.currentPreventSleepBlockerId = null
  }

  setSessionTitleGenerator(generator: SessionTitleGenerator): void {
    this.currentSessionTitleGenerator = generator
  }

  disposeSessionTitleGenerator(): void {
    this.currentSessionTitleGenerator?.dispose()
  }
}
