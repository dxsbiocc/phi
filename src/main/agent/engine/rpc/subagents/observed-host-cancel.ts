import type { RpcConnection } from '../connection'
import type { RpcFrame } from '../types'
import { withRemoteSignal } from '../history-pager'
import type { RpcChildHostStartRequest } from '../../phi-extension/lib/rpc-child-host-start'

export function observedHostStartNativeIds(
  request: Readonly<RpcChildHostStartRequest>,
  frames: readonly RpcFrame[]
): ReadonlySet<string> {
  return new Set(
    frames.flatMap((frame) => {
      if (
        frame.type !== 'subagent_lifecycle' ||
        !frame.payload ||
        typeof frame.payload !== 'object' ||
        Array.isArray(frame.payload)
      )
        return []
      const value = frame.payload as Record<string, unknown>
      return value.status === 'started' &&
        typeof value.id === 'string' &&
        value.parentToolCallId === request.id &&
        value.agent === request.agent &&
        value.agentSource === 'user' &&
        value.detached === true
        ? [value.id]
        : []
    })
  )
}

/** Best-effort fallback after signed request reconciliation fails; it grants no quiescence proof. */
export async function cancelObservedHostStart(
  connection: RpcConnection,
  lifetime: AbortSignal,
  request: Readonly<RpcChildHostStartRequest>,
  frames: readonly RpcFrame[]
): Promise<void> {
  const nativeIds = observedHostStartNativeIds(request, frames)
  const signal = AbortSignal.any([
    lifetime,
    connection.bindControl().signal,
    AbortSignal.timeout(10000)
  ])
  for (const nativeId of nativeIds) {
    try {
      await withRemoteSignal(
        connection.request({ type: 'cancel_subagent', subagentId: nativeId }),
        signal
      )
    } catch {
      // The caller retires this generation; this fallback never proves termination.
    }
  }
}
