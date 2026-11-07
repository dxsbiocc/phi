import type { PhiSessionManifest } from './session-store'
import { CodedError, LEGACY_REMOTE_SESSION_PROMPT_ERROR_CODE } from '../../../shared/errorCodes'

export { LEGACY_REMOTE_SESSION_PROMPT_ERROR_CODE }

type LegacyRemoteSessionManifest = Pick<
  PhiSessionManifest,
  'projectLocation' | 'remoteRuntime' | 'runtimeRef' | 'kernelRuntimeRef' | 'runtimeRecoveryError'
>

/**
 * A fresh SSH draft carries the pending-RPC marker until the kernel records its own reference.
 * Every other pre-kernel SSH manifest is history-only after K5-2, including RPC-era references
 * and invalid-reference diagnostics.
 */
export function isLegacyRemoteSession(manifest: LegacyRemoteSessionManifest | null): boolean {
  return Boolean(
    manifest?.projectLocation?.kind === 'ssh' &&
    !manifest.kernelRuntimeRef &&
    (Boolean(manifest.runtimeRef) ||
      Boolean(manifest.runtimeRecoveryError) ||
      manifest.remoteRuntime !== 'rpc')
  )
}

export function assertLegacyRemoteSessionCanPrompt(
  manifest: LegacyRemoteSessionManifest | null
): void {
  if (isLegacyRemoteSession(manifest)) {
    throw new CodedError(
      LEGACY_REMOTE_SESSION_PROMPT_ERROR_CODE,
      LEGACY_REMOTE_SESSION_PROMPT_ERROR_CODE
    )
  }
}
