import type { PhiSessionManifest } from './session-store'
import { CodedError, LEGACY_REMOTE_SESSION_PROMPT_ERROR_CODE } from '../../../shared/errorCodes'

export { LEGACY_REMOTE_SESSION_PROMPT_ERROR_CODE }

type LegacyRemoteSessionManifest = Pick<
  PhiSessionManifest,
  'projectLocation' | 'remoteRuntime' | 'runtimeRef' | 'runtimeRecoveryError'
>

/**
 * Old SSH histories have no RPC reference or explicit pending-RPC marker.
 * A recovery diagnostic is different: manifest loading removed an invalid RPC reference, so the
 * session remains on the explicit RPC recovery/read-only path instead of becoming legacy-local.
 */
export function isLegacyRemoteSession(manifest: LegacyRemoteSessionManifest | null): boolean {
  return Boolean(
    manifest?.projectLocation?.kind === 'ssh' &&
    !manifest.runtimeRef &&
    !manifest.runtimeRecoveryError &&
    manifest.remoteRuntime !== 'rpc'
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
