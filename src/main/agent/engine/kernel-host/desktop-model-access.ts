import type { AuthCredentialSnapshotEntry } from '@oh-my-pi/pi-ai'

import { KernelClientError } from '../kernel-client'
import type { OmpRequestOptions } from '../omp-bridge'
import {
  DESKTOP_MODEL_ACCESS_WORKER_METHODS,
  ModelAccessBrokerError,
  type ModelAccessBroker,
  type ModelAccessRefreshParams
} from './model-access-broker'

export interface DesktopModelAccessBridge {
  request<T = unknown>(method: string, params?: unknown, options?: OmpRequestOptions): Promise<T>
}

export interface DesktopModelAccessOwner {
  readonly broker: ModelAccessBroker
  close(): void
}

type RefreshResult =
  | { ok: true; credential: AuthCredentialSnapshotEntry }
  | { ok: false; code: 'REFRESH_ABORTED' | 'REFRESH_FAILED' }

function disconnected(): KernelClientError {
  return new KernelClientError({
    code: 'CAPABILITY_UNAVAILABLE',
    message: 'The desktop credential broker is not connected.',
    detail: { reason: 'desktop_credential_broker_disconnected' }
  })
}

async function requestCredentials(
  bridge: DesktopModelAccessBridge,
  agentDir: string,
  provider: string | undefined
): Promise<Awaited<ReturnType<ModelAccessBroker['credentials']>>> {
  try {
    return await bridge.request(DESKTOP_MODEL_ACCESS_WORKER_METHODS.credentials, {
      agentDir,
      ...(provider ? { provider } : {})
    })
  } catch {
    throw disconnected()
  }
}

async function requestRefresh(
  bridge: DesktopModelAccessBridge,
  agentDir: string,
  params: ModelAccessRefreshParams,
  signal?: AbortSignal
): Promise<AuthCredentialSnapshotEntry> {
  let result: RefreshResult
  try {
    result = await bridge.request<RefreshResult>(
      DESKTOP_MODEL_ACCESS_WORKER_METHODS.refresh,
      { agentDir, ...params },
      { signal }
    )
  } catch {
    if (signal?.aborted) throw new ModelAccessBrokerError('REFRESH_ABORTED')
    throw disconnected()
  }
  if (!result.ok) throw new ModelAccessBrokerError(result.code)
  return result.credential
}

export function createDesktopModelAccessOwner(
  agentDir: string,
  bridge: DesktopModelAccessBridge
): DesktopModelAccessOwner {
  let closed = false
  const activeBridge = (): DesktopModelAccessBridge => {
    if (closed) throw disconnected()
    return bridge
  }
  return {
    broker: {
      credentials: ({ provider }) => requestCredentials(activeBridge(), agentDir, provider),
      refresh: (params, context) =>
        requestRefresh(activeBridge(), agentDir, params, context?.signal)
    },
    close: () => {
      closed = true
    }
  }
}
