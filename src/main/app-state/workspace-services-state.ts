import type { BrowserWorkspaceRegistry } from '../browser/browser-workspace-registry'
import type { TerminalDraftService } from '../terminal/terminal-command-draft'
import type { TerminalManager } from '../terminal/terminal-manager'

type BrowserRegistryLifecycle = 'idle' | 'disposing' | 'failed'

export class WorkspaceServicesState {
  private currentBrowserWorkspaceRegistry: BrowserWorkspaceRegistry | null = null
  private currentBrowserWorkspaceRegistryLifecycle: BrowserRegistryLifecycle = 'idle'
  private currentBrowserWorkspaceRegistryDisposal: Promise<void> | null = null
  private currentTerminalManager: TerminalManager | null = null
  private currentTerminalDraftService: TerminalDraftService | null = null

  get browserWorkspaceRegistry(): BrowserWorkspaceRegistry | null {
    return this.currentBrowserWorkspaceRegistry
  }

  get browserWorkspaceRegistryLifecycle(): BrowserRegistryLifecycle {
    return this.currentBrowserWorkspaceRegistryLifecycle
  }

  get browserWorkspaceRegistryDisposal(): Promise<void> | null {
    return this.currentBrowserWorkspaceRegistryDisposal
  }

  get terminalManager(): TerminalManager | null {
    return this.currentTerminalManager
  }

  get terminalDraftService(): TerminalDraftService | null {
    return this.currentTerminalDraftService
  }

  setBrowserWorkspaceRegistry(registry: BrowserWorkspaceRegistry): void {
    this.currentBrowserWorkspaceRegistry = registry
  }

  markBrowserWorkspaceRegistryDisposing(): void {
    this.currentBrowserWorkspaceRegistryLifecycle = 'disposing'
  }

  setBrowserWorkspaceRegistryDisposal(disposal: Promise<void>): void {
    this.currentBrowserWorkspaceRegistryDisposal = disposal
  }

  markBrowserWorkspaceRegistryDisposalFailed(): void {
    this.currentBrowserWorkspaceRegistryLifecycle = 'failed'
  }

  failBrowserWorkspaceRegistryDisposal(
    registry: BrowserWorkspaceRegistry,
    disposal: Promise<void>
  ): boolean {
    if (
      this.currentBrowserWorkspaceRegistry !== registry ||
      this.currentBrowserWorkspaceRegistryDisposal !== disposal
    ) {
      return false
    }
    this.currentBrowserWorkspaceRegistryLifecycle = 'failed'
    return true
  }

  completeBrowserWorkspaceRegistryDisposal(
    registry: BrowserWorkspaceRegistry,
    disposal: Promise<void>
  ): void {
    if (
      this.currentBrowserWorkspaceRegistry !== registry ||
      this.currentBrowserWorkspaceRegistryDisposal !== disposal
    ) {
      return
    }
    this.currentBrowserWorkspaceRegistry = null
    this.currentBrowserWorkspaceRegistryDisposal = null
    this.currentBrowserWorkspaceRegistryLifecycle = 'idle'
  }

  setTerminalManager(manager: TerminalManager): void {
    this.currentTerminalManager = manager
  }

  setTerminalDraftService(draftService: TerminalDraftService): void {
    this.currentTerminalDraftService = draftService
  }

  takeTerminalServices(): {
    draftService: TerminalDraftService | null
    manager: TerminalManager | null
  } {
    const draftService = this.currentTerminalDraftService
    const manager = this.currentTerminalManager
    this.currentTerminalDraftService = null
    this.currentTerminalManager = null
    return { draftService, manager }
  }
}
