import {
  ModelRegistry,
  type Api,
  type AuthCredentialSnapshotEntry,
  type AuthStorage,
  type Model,
  type OAuthCredential,
  type OAuthRefreshReason,
  type Provider
} from '../omp/model-access'

import { createReadOnlyAuthStorage } from './auth-storage'
import { MemoryAuthCredentialStore } from './memory-credential-store'
import type {
  KernelModelAccess,
  ModelAccessChangeListener,
  ModelAccessProviderStatus
} from './types'

export type DesktopBrokerCredentialEntry = AuthCredentialSnapshotEntry

export interface DesktopBrokerModelAccessOptions {
  requestCredentials(
    params: { provider?: string },
    context?: { signal?: AbortSignal }
  ):
    | { credentials: readonly DesktopBrokerCredentialEntry[] }
    | Promise<{ credentials: readonly DesktopBrokerCredentialEntry[] }>
  requestRefresh(
    params: { credentialId: number; reason?: OAuthRefreshReason },
    context?: { signal?: AbortSignal }
  ): DesktopBrokerCredentialEntry | Promise<DesktopBrokerCredentialEntry>
  createModelRegistry?(authStorage: AuthStorage): ModelRegistry
  modelsPath?: string
  cacheDbPath?: string
  /** Kernel bootstrap defers the first host read until hello has installed a controller. */
  hydrate?: boolean
}

class DesktopBrokerModelAccess implements KernelModelAccess {
  readonly authStorage: AuthStorage
  readonly modelRegistry: ModelRegistry
  private readonly storage: AuthStorage
  private readonly store: MemoryAuthCredentialStore
  private readonly listeners = new Set<ModelAccessChangeListener>()
  private reachable = true
  private closed = false

  private constructor(private readonly options: DesktopBrokerModelAccessOptions) {
    this.store = new MemoryAuthCredentialStore({
      refreshSnapshot: () => this.loadCredentials(),
      refreshCredential: (
        provider: Provider,
        credentialId: number,
        _credential: OAuthCredential,
        signal?: AbortSignal,
        reason?: OAuthRefreshReason
      ) => this.refreshCredential(provider, credentialId, signal, reason),
      onSnapshotChanged: () => this.emitChange()
    })
    const auth = createReadOnlyAuthStorage(this.store, {
      sourceLabel: 'desktop model-access broker',
      reloadBeforeCredentialRead: async (provider) => {
        const entries = await this.loadCredentials(provider)
        if (provider) this.store.replaceProviderSnapshot(provider, entries)
        else this.store.replaceSnapshot(entries)
        await this.storage.credentials.reload()
      }
    })
    this.authStorage = auth.authStorage
    this.storage = auth.storage
    this.modelRegistry =
      options.createModelRegistry?.(this.authStorage) ??
      new ModelRegistry(this.authStorage, options.modelsPath, {
        ignoreLocalModelConfig: options.modelsPath === undefined,
        cacheDbPath: options.cacheDbPath
      })
  }

  static async create(options: DesktopBrokerModelAccessOptions): Promise<DesktopBrokerModelAccess> {
    const access = new DesktopBrokerModelAccess(options)
    if (options.hydrate === false) return access
    try {
      await access.storage.credentials.revalidate()
    } catch {
      access.reachable = false
    }
    return access
  }

  catalog(): readonly Model<Api>[] {
    return this.modelRegistry.getAll()
  }

  status(): readonly ModelAccessProviderStatus[] {
    const providers = new Set(this.catalog().map((model) => model.provider))
    return Object.freeze(
      [...providers].sort().map((provider) =>
        Object.freeze({
          provider,
          status: !this.reachable
            ? ('unreachable' as const)
            : this.authStorage.keys.source(provider) !== undefined ||
                this.authStorage.keys.keyless(provider)
              ? ('available' as const)
              : ('unauthenticated' as const)
        })
      )
    )
  }

  onChange(listener: ModelAccessChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  controllerAttached(): void {
    void this.hydrate()
  }

  async hydrate(): Promise<void> {
    try {
      await this.storage.credentials.revalidate()
    } catch {
      // `loadCredentials` already changed provider status to unreachable.
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    this.storage.close()
  }

  private async loadCredentials(
    provider?: string
  ): Promise<readonly AuthCredentialSnapshotEntry[]> {
    try {
      const result = await this.options.requestCredentials(provider ? { provider } : {})
      const changed = !this.reachable
      this.reachable = true
      if (changed) this.emitChange()
      return result.credentials
    } catch (error) {
      const changed = this.reachable
      this.reachable = false
      if (changed) this.emitChange()
      throw error
    }
  }

  private async refreshCredential(
    provider: Provider,
    credentialId: number,
    signal?: AbortSignal,
    reason?: OAuthRefreshReason
  ): Promise<AuthCredentialSnapshotEntry> {
    try {
      const entry = await this.options.requestRefresh(
        { credentialId, ...(reason ? { reason } : {}) },
        { signal }
      )
      if (entry.provider !== provider) {
        throw new Error('Desktop credential refresh returned the wrong provider.')
      }
      const changed = !this.reachable
      this.reachable = true
      if (changed) this.emitChange()
      return entry
    } catch (error) {
      const changed = this.reachable
      this.reachable = false
      if (changed) this.emitChange()
      throw error
    }
  }

  private emitChange(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

export function createDesktopBrokerModelAccess(
  options: DesktopBrokerModelAccessOptions
): Promise<KernelModelAccess> {
  return DesktopBrokerModelAccess.create(options)
}
