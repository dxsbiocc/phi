import type {
  TeamPackRendererApi,
  TeamPackResult,
  TeamSourceView as IpcTeamSourceView
} from '../../../../../shared/teamPackTypes'

import type { TeamSourceState, TeamSourceView } from './teamTypes'

export function teamPackApi(): TeamPackRendererApi {
  return (window.api as typeof window.api & { teamPack: TeamPackRendererApi }).teamPack
}

export function resultValue<T>(result: TeamPackResult<T>): T {
  if (!result.ok) throw result.error
  return result.value
}

export function resultErrorCode(cause: unknown): string {
  if (
    typeof cause === 'object' &&
    cause !== null &&
    'code' in cause &&
    typeof cause.code === 'string'
  ) {
    return cause.code
  }
  return 'UNKNOWN'
}

function sourceState(source: IpcTeamSourceView): TeamSourceState {
  const code = source.status.lastErrorCode
  if (code === 'NOT_A_MEMBER') return 'not-member'
  if (code === 'RELEASE_WITHDRAWN') return 'withdrawn'
  if (code === 'STORE_UNAVAILABLE' && source.status.lastSuccessfulRelease !== null) return 'cached'
  if (code) return 'error'
  return 'healthy'
}

export function sourceView(source: IpcTeamSourceView): TeamSourceView {
  return {
    id: source.id,
    teamId: source.teamId,
    teamName: source.teamName,
    publicKeyFingerprint: source.publicKeyFingerprint,
    location: source.location,
    addedAt: source.addedAt,
    status: {
      ...source.status,
      state: sourceState(source),
      credentialProviders: source.status.configuredProviders
    }
  }
}
