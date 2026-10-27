import type { AuthCredentialSnapshotEntry, AuthStorage } from '@oh-my-pi/pi-ai'
import type {
  KernelHostCapabilityParams,
  KernelHostCapabilityResult
} from '../../../../shared/kernel-protocol'
import type { KernelProtocolClient } from '../kernel-client'

export const MODEL_ACCESS_BROKER_CAPABILITIES = [
  'modelAccess.credentials',
  'modelAccess.refresh'
] as const

export const DESKTOP_MODEL_ACCESS_WORKER_METHODS = {
  credentials: 'desktopModelAccess.credentials',
  refresh: 'desktopModelAccess.refresh'
} as const

export type ModelAccessCredentialsParams = KernelHostCapabilityParams<'modelAccess.credentials'>

export type ModelAccessCredentialsResult = KernelHostCapabilityResult<'modelAccess.credentials'>

export type ModelAccessRefreshParams = KernelHostCapabilityParams<'modelAccess.refresh'>

export type ModelAccessRefreshReason = NonNullable<ModelAccessRefreshParams['reason']>

export interface ModelAccessBrokerContext {
  readonly signal?: AbortSignal
}

export interface ModelAccessAuthStorage {
  readonly credentials: Pick<AuthStorage['credentials'], 'snapshot'>
  readonly oauth: Pick<AuthStorage['oauth'], 'refresh'>
}

export type ModelAccessBrokerErrorCode = 'REFRESH_ABORTED' | 'REFRESH_FAILED'

export class ModelAccessBrokerError extends Error {
  constructor(readonly code: ModelAccessBrokerErrorCode) {
    super(
      code === 'REFRESH_ABORTED'
        ? 'Model credential refresh was cancelled.'
        : 'Model credential refresh failed.'
    )
    this.name = 'ModelAccessBrokerError'
  }
}

interface ModelAccessRefreshFlight {
  readonly promise: Promise<AuthCredentialSnapshotEntry>
  readonly controller: AbortController
  waiters: number
  settled: boolean
}

function waitForRefresh(
  refresh: ModelAccessRefreshFlight,
  signal: AbortSignal | undefined
): Promise<AuthCredentialSnapshotEntry> {
  if (signal?.aborted) return Promise.reject(new ModelAccessBrokerError('REFRESH_ABORTED'))

  refresh.waiters += 1
  return new Promise((resolve, reject) => {
    let waiting = true
    const finish = (complete: () => void): void => {
      if (!waiting) return
      waiting = false
      signal?.removeEventListener('abort', aborted)
      refresh.waiters -= 1
      complete()
      if (refresh.waiters === 0 && !refresh.settled) refresh.controller.abort()
    }
    const aborted = (): void => finish(() => reject(new ModelAccessBrokerError('REFRESH_ABORTED')))
    signal?.addEventListener('abort', aborted, { once: true })
    refresh.promise.then(
      (result) => {
        finish(() => resolve(result))
      },
      (error: unknown) => {
        finish(() => reject(error))
      }
    )
  })
}

export interface ModelAccessBroker {
  credentials(
    params: ModelAccessCredentialsParams
  ): ModelAccessCredentialsResult | Promise<ModelAccessCredentialsResult>
  refresh(
    params: ModelAccessRefreshParams,
    context?: ModelAccessBrokerContext
  ): Promise<AuthCredentialSnapshotEntry>
}

export interface SynchronousModelAccessBroker extends ModelAccessBroker {
  credentials(params: ModelAccessCredentialsParams): ModelAccessCredentialsResult
}

export function createModelAccessBroker(
  authStorage: ModelAccessAuthStorage
): SynchronousModelAccessBroker {
  const refreshes = new Map<number, ModelAccessRefreshFlight>()

  return {
    credentials({ provider }) {
      const entries = authStorage.credentials.snapshot().credentials
      return {
        credentials: entries
          .filter((entry) => provider === undefined || entry.provider === provider)
          .map((entry) => ({
            ...entry,
            credential: { ...entry.credential }
          }))
      }
    },

    refresh({ credentialId, reason }, context = {}) {
      if (context.signal?.aborted) {
        return Promise.reject(new ModelAccessBrokerError('REFRESH_ABORTED'))
      }
      const existing = refreshes.get(credentialId)
      if (existing) return waitForRefresh(existing, context.signal)

      const controller = new AbortController()
      const result = Promise.withResolvers<AuthCredentialSnapshotEntry>()
      const refresh = { promise: result.promise, controller, waiters: 0, settled: false }
      refreshes.set(credentialId, refresh)
      const settle = (): void => {
        refresh.settled = true
        if (refreshes.get(credentialId) === refresh) refreshes.delete(credentialId)
      }
      try {
        const operation = authStorage.oauth.refresh(
          credentialId,
          controller.signal,
          reason === undefined ? undefined : { reason }
        )
        void operation
          .then(result.resolve, () => {
            result.reject(
              new ModelAccessBrokerError(
                controller.signal.aborted ? 'REFRESH_ABORTED' : 'REFRESH_FAILED'
              )
            )
          })
          .finally(settle)
      } catch {
        result.reject(new ModelAccessBrokerError('REFRESH_FAILED'))
        settle()
      }
      return waitForRefresh(refresh, context.signal)
    }
  }
}

export function registerModelAccessBroker(
  client: KernelProtocolClient,
  broker: ModelAccessBroker
): () => void {
  const unregisterCredentials = client.registerHostCapability('modelAccess.credentials', (params) =>
    broker.credentials(params)
  )
  const unregisterRefresh = client.registerHostCapability(
    'modelAccess.refresh',
    (params, context) => broker.refresh(params, { signal: context.signal })
  )
  return () => {
    unregisterRefresh()
    unregisterCredentials()
  }
}
