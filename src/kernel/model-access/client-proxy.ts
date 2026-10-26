import type { SafeModelDescriptor } from '../../main/agent/engine/model-gateway-types'
import {
  ModelRegistry,
  type Api,
  type AuthCredentialSnapshotEntry,
  type AuthStorage,
  type Model
} from '../omp/model-access'
import { createReadOnlyAuthStorage } from './auth-storage'
import { ModelAccessConfigurationError, ModelAccessReadOnlyError } from './errors'
import { MemoryAuthCredentialStore } from './memory-credential-store'
import { ModelProxyReconnectController, type ModelProxyRoute } from './reconnect'
import type {
  KernelModelAccess,
  ModelAccessChangeListener,
  ModelAccessConfigureParams,
  ModelAccessProviderStatus
} from './types'

const DEFAULT_CONTEXT_WINDOW = 128_000
const DEFAULT_MAX_TOKENS = 8_192

export interface ClientProxyModelAccess extends KernelModelAccess {
  readonly requestFetch: typeof globalThis.fetch
  readonly route: ModelProxyRoute | undefined
  configure(params: ModelAccessConfigureParams): Promise<void>
  controllerAttached(): void
  controllerDetached(): void
  cancelWaiting(reason?: unknown): void
  waitUntilReady(signal?: AbortSignal): Promise<ModelProxyRoute>
}

export interface ClientProxyModelAccessOptions {
  fetch?: typeof globalThis.fetch
  createModelRegistry?(authStorage: AuthStorage): ModelRegistry
}

function validateConfiguration(params: ModelAccessConfigureParams): {
  endpoint: string
  baseUrl: string
  bearerToken: string
  models: readonly SafeModelDescriptor[]
} {
  let endpoint: URL
  try {
    endpoint = new URL(params.endpoint)
  } catch {
    throw new ModelAccessConfigurationError('Model proxy endpoint is invalid.')
  }
  if (
    (endpoint.protocol !== 'http:' && endpoint.protocol !== 'https:') ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.pathname.endsWith('/v1/pi/stream')
  ) {
    throw new ModelAccessConfigurationError(
      'Model proxy endpoint must be an HTTP(S) /v1/pi/stream URL without credentials.'
    )
  }
  if (!/^[A-Za-z0-9_-]{32,256}$/.test(params.bearerToken)) {
    throw new ModelAccessConfigurationError('Model proxy bearer is invalid.')
  }
  if (!params.models.length || params.models.length > 256) {
    throw new ModelAccessConfigurationError('Model proxy needs an approved model catalog.')
  }
  const seen = new Set<string>()
  const models = params.models.map((model): SafeModelDescriptor => {
    const key = JSON.stringify([model.provider, model.id])
    if (!model.provider || !model.id || seen.has(key)) {
      throw new ModelAccessConfigurationError('Model proxy catalog contains an invalid model.')
    }
    seen.add(key)
    return Object.freeze({
      provider: model.provider,
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: Object.freeze([...model.input]),
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      ...(model.cost ? { cost: Object.freeze({ ...model.cost }) } : {})
    })
  })
  const suffix = '/v1/pi/stream'
  const pathname = endpoint.pathname.slice(0, -suffix.length).replace(/\/+$/, '')
  endpoint.pathname = pathname || '/'
  const baseUrl = endpoint.href.replace(/\/$/, '')
  const streamEndpoint = `${baseUrl}/v1/pi/stream`
  return {
    endpoint: streamEndpoint,
    baseUrl,
    bearerToken: params.bearerToken,
    models: Object.freeze(models)
  }
}

class ClientProxyModelAccessImpl implements ClientProxyModelAccess {
  readonly authStorage: AuthStorage
  readonly modelRegistry: ModelRegistry
  readonly requestFetch: typeof globalThis.fetch
  private readonly storage: AuthStorage
  private readonly store: MemoryAuthCredentialStore
  private readonly reconnect: ModelProxyReconnectController
  private readonly listeners = new Set<ModelAccessChangeListener>()
  private readonly publishedModels = new Set<Model<Api>>()
  private configuredModels: readonly Model<Api>[] = Object.freeze([])
  private descriptors: readonly SafeModelDescriptor[] = Object.freeze([])
  private configureQueue = Promise.resolve()
  private closed = false

  constructor(options: ClientProxyModelAccessOptions) {
    this.store = new MemoryAuthCredentialStore({ onSnapshotChanged: () => this.emitChange() })
    const auth = createReadOnlyAuthStorage(this.store, {
      sourceLabel: 'client model proxy (memory only)'
    })
    this.authStorage = auth.authStorage
    this.storage = auth.storage
    this.modelRegistry =
      options.createModelRegistry?.(this.authStorage) ??
      new ModelRegistry(this.authStorage, undefined, { ignoreLocalModelConfig: true })
    this.reconnect = new ModelProxyReconnectController({
      ...(options.fetch ? { fetch: options.fetch } : {}),
      onStateChanged: () => this.emitChange()
    })
    this.requestFetch = this.reconnect.fetch
  }

  get route(): ModelProxyRoute | undefined {
    return this.reconnect.currentRoute
  }

  catalog(): readonly Model<Api>[] {
    return this.configuredModels
  }

  status(): readonly ModelAccessProviderStatus[] {
    const status = this.reconnect.ready ? ('available' as const) : ('unreachable' as const)
    return Object.freeze(
      [...new Set(this.descriptors.map((model) => model.provider))]
        .sort()
        .map((provider) => Object.freeze({ provider, status }))
    )
  }

  onChange(listener: ModelAccessChangeListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  configure(params: ModelAccessConfigureParams): Promise<void> {
    const configured = validateConfiguration(params)
    const apply = async (): Promise<void> => this.applyConfiguration(configured)
    const next = this.configureQueue.then(apply, apply)
    this.configureQueue = next.catch(() => undefined)
    return next
  }

  controllerAttached(): void {
    this.reconnect.controllerAttached()
  }

  controllerDetached(): void {
    this.reconnect.controllerDetached()
  }

  cancelWaiting(reason?: unknown): void {
    this.reconnect.cancelWaiting(reason)
  }

  waitUntilReady(signal?: AbortSignal): Promise<ModelProxyRoute> {
    return this.reconnect.waitUntilReady(signal)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.cancelWaiting(new Error('Model access closed.'))
    this.listeners.clear()
    this.storage.close()
  }

  private async applyConfiguration(
    configured: ReturnType<typeof validateConfiguration>
  ): Promise<void> {
    const providers = new Map<string, SafeModelDescriptor[]>()
    for (const descriptor of configured.models) {
      const entries = providers.get(descriptor.provider) ?? []
      entries.push(descriptor)
      providers.set(descriptor.provider, entries)
    }
    let credentialId = 1
    const credentials: AuthCredentialSnapshotEntry[] = [...providers.keys()].map((provider) => ({
      id: credentialId++,
      provider,
      credential: { type: 'api_key', key: configured.bearerToken },
      identityKey: null
    }))
    this.store.replaceSnapshot(credentials)
    await this.storage.credentials.reload()

    for (const model of this.publishedModels) {
      model.baseUrl = configured.baseUrl
      model.transport = 'pi-native'
    }
    for (const [provider, models] of providers) {
      this.modelRegistry.registerProvider(provider, {
        baseUrl: configured.baseUrl,
        api: 'openai-completions',
        transport: 'pi-native',
        oauth: {
          name: 'Phi desktop model proxy',
          login: async () => {
            throw new ModelAccessReadOnlyError('login')
          }
        },
        models: models.map((model) => ({
          id: model.id,
          name: model.name,
          reasoning: model.reasoning,
          input: [...model.input],
          cost: model.cost
            ? { ...model.cost }
            : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: model.contextWindow ?? DEFAULT_CONTEXT_WINDOW,
          maxTokens: model.maxTokens ?? DEFAULT_MAX_TOKENS
        }))
      })
    }
    const nextModels = configured.models.map((descriptor) => {
      const model = this.modelRegistry.find(descriptor.provider, descriptor.id)
      if (!model) {
        throw new ModelAccessConfigurationError(
          `Model proxy failed to register ${descriptor.provider}/${descriptor.id}.`
        )
      }
      model.baseUrl = configured.baseUrl
      model.transport = 'pi-native'
      this.publishedModels.add(model)
      return model
    })
    this.descriptors = configured.models
    this.configuredModels = Object.freeze(nextModels)
    this.reconnect.configured(configured.endpoint, configured.bearerToken)
    this.emitChange()
  }

  private emitChange(): void {
    for (const listener of [...this.listeners]) listener()
  }
}

export function createClientProxyModelAccess(
  options: ClientProxyModelAccessOptions = {}
): ClientProxyModelAccess {
  return new ClientProxyModelAccessImpl(options)
}
