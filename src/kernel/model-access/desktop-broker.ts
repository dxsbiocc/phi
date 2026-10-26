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
import {
  projectDesktopBrokerModelsConfig,
  type DesktopBrokerModelsConfigProjection
} from './desktop-model-config'
import { DesktopCredentialBrokerDisconnectedError } from './errors'
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

function isCapabilityUnavailable(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === 'object' &&
    'code' in error &&
    error.code === 'CAPABILITY_UNAVAILABLE'
  )
}

function desktopBrokerError(error: unknown): unknown {
  return isCapabilityUnavailable(error) ? new DesktopCredentialBrokerDisconnectedError() : error
}

function createBrokerAwareModelRegistry(
  registry: ModelRegistry,
  authStorage: AuthStorage,
  credentialProviders: ReadonlySet<string>,
  authHeaderProviders: ReadonlySet<string>,
  syncConfig: () => void
): ModelRegistry {
  if (credentialProviders.size === 0) return registry
  const decorated = new WeakSet<Model<Api>>()
  const decorate = (model: Model<Api>): Model<Api> => {
    if (!authHeaderProviders.has(model.provider) || decorated.has(model)) return model
    decorated.add(model)
    const configuredHeaders = model.resolveHeaders
    model.resolveHeaders = async (signal) => {
      const [headers, apiKey] = await Promise.all([
        configuredHeaders?.(signal),
        authStorage.keys.get(model.provider, undefined, {
          baseUrl: model.baseUrl,
          modelId: model.id,
          signal
        })
      ])
      return headers || apiKey
        ? { ...(headers ?? {}), ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) }
        : undefined
    }
    return model
  }
  const decorateResult = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map((model) => decorate(model as Model<Api>))
      : value && typeof value === 'object' && 'provider' in value
        ? decorate(value as Model<Api>)
        : value
  const reloadMethods = new Set([
    'refresh',
    'refreshProvider',
    'reapplyModelPolicies',
    'refreshInBackground',
    'clearSourceRegistrations',
    'unregisterProvider'
  ])
  const methods = new Map<PropertyKey, unknown>()
  return new Proxy(registry, {
    get(target, property) {
      if (methods.has(property)) return methods.get(property)
      let method: unknown
      if (property === 'hasConfiguredAuth') {
        method = (model: Model<Api>) =>
          credentialProviders.has(model.provider)
            ? authStorage.keys.source(model.provider, { env: 'none' }) !== undefined ||
              authStorage.keys.keyless(model.provider)
            : target.hasConfiguredAuth(model)
      } else if (property === 'hasConcreteAuth') {
        method = (provider: string) =>
          credentialProviders.has(provider)
            ? authStorage.keys.source(provider, { env: 'none' })?.concrete === true ||
              authStorage.keys.keyless(provider)
            : target.hasConcreteAuth(provider)
      } else {
        const value = Reflect.get(target, property, target)
        if (typeof value !== 'function') return value
        method = (...args: unknown[]) => {
          if (reloadMethods.has(String(property))) syncConfig()
          const result = Reflect.apply(value, target, args)
          return result instanceof Promise
            ? result.then((resolved) => decorateResult(resolved))
            : decorateResult(result)
        }
      }
      methods.set(property, method)
      return method
    }
  })
}

class DesktopBrokerModelAccess implements KernelModelAccess {
  readonly authStorage: AuthStorage
  readonly modelRegistry: ModelRegistry
  private readonly storage: AuthStorage
  private readonly store: MemoryAuthCredentialStore
  private readonly configProjection: DesktopBrokerModelsConfigProjection | undefined
  private readonly sourceRegistry: ModelRegistry
  private readonly listeners = new Set<ModelAccessChangeListener>()
  private offlineCatalogRefreshes = 0
  private brokerDisconnected = false
  private closed = false

  private constructor(private readonly options: DesktopBrokerModelAccessOptions) {
    const config = options.createModelRegistry
      ? undefined
      : projectDesktopBrokerModelsConfig(options.modelsPath)
    this.configProjection = config
    this.store = new MemoryAuthCredentialStore({
      refreshSnapshot: () =>
        this.offlineCatalogRefreshes > 0
          ? Promise.resolve(this.store.credentialSnapshot())
          : this.loadCredentials(),
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
      brokerBackedProviders: config?.credentialProviders,
      reloadBeforeCredentialRead: async (provider) => {
        try {
          const entries = await this.loadCredentials(provider)
          if (provider) this.store.replaceProviderSnapshot(provider, entries)
          else this.store.replaceSnapshot(entries)
          await this.storage.credentials.reload()
        } catch (error) {
          if (this.offlineCatalogRefreshes === 0) throw error
        }
      }
    })
    this.authStorage = auth.authStorage
    this.storage = auth.storage
    try {
      const registry =
        options.createModelRegistry?.(this.authStorage) ??
        new ModelRegistry(this.authStorage, config?.modelsPath ?? options.modelsPath, {
          ignoreLocalModelConfig: options.modelsPath === undefined,
          cacheDbPath: options.cacheDbPath
        })
      this.sourceRegistry = registry
      this.modelRegistry = createBrokerAwareModelRegistry(
        registry,
        this.authStorage,
        config?.credentialProviders ?? new Set(),
        config?.authHeaderProviders ?? new Set(),
        () => config?.sync()
      )
    } catch (error) {
      config?.dispose()
      throw error
    }
  }

  static async create(options: DesktopBrokerModelAccessOptions): Promise<DesktopBrokerModelAccess> {
    const access = new DesktopBrokerModelAccess(options)
    if (options.hydrate === false) return access
    try {
      await access.storage.credentials.revalidate()
    } catch {
      // Initial broker absence is reflected by `status()`; construction remains usable.
    }
    return access
  }

  catalog(): readonly Model<Api>[] {
    return this.modelRegistry.getAll()
  }

  async refreshCatalog(): Promise<void> {
    this.configProjection?.sync()
    this.offlineCatalogRefreshes += 1
    try {
      await this.storage.credentials.revalidate()
      await this.sourceRegistry.reapplyModelPolicies()
    } finally {
      this.offlineCatalogRefreshes -= 1
    }
  }

  status(): readonly ModelAccessProviderStatus[] {
    const modelsByProvider = new Map<string, Model<Api>[]>()
    for (const model of this.catalog()) {
      const models = modelsByProvider.get(model.provider) ?? []
      models.push(model)
      modelsByProvider.set(model.provider, models)
    }
    return Object.freeze(
      [...modelsByProvider]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([provider, models]) =>
          models.some((model) => this.modelRegistry.hasConfiguredAuth(model))
            ? Object.freeze({ provider, status: 'available' as const })
            : Object.freeze({
                provider,
                status: 'unauthenticated' as const,
                ...(this.brokerDisconnected
                  ? { reason: 'desktop_credential_broker_not_connected' as const }
                  : {})
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
      // `loadCredentials` already removed credentials the desktop cannot currently serve.
    }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.listeners.clear()
    this.storage.close()
    this.configProjection?.dispose()
  }

  private async loadCredentials(
    provider?: string
  ): Promise<readonly AuthCredentialSnapshotEntry[]> {
    try {
      const result = await this.options.requestCredentials(provider ? { provider } : {})
      this.setBrokerDisconnected(false)
      return result.credentials
    } catch (error) {
      if (provider) this.store.replaceProviderSnapshot(provider, [])
      else this.store.replaceSnapshot([])
      if (isCapabilityUnavailable(error)) this.setBrokerDisconnected(true)
      throw desktopBrokerError(error)
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
      this.setBrokerDisconnected(false)
      return entry
    } catch (error) {
      this.store.replaceProviderSnapshot(provider, [])
      if (isCapabilityUnavailable(error)) this.setBrokerDisconnected(true)
      throw desktopBrokerError(error)
    }
  }

  private setBrokerDisconnected(disconnected: boolean): void {
    if (this.brokerDisconnected === disconnected) return
    this.brokerDisconnected = disconnected
    this.emitChange()
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
