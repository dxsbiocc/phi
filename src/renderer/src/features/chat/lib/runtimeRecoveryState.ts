import type {
  RuntimeRecoveryModelSelection,
  RuntimeRecoveryState,
  RuntimeRecoveryTarget
} from '../../../../../shared/runtimeRecoveryTypes'

type SelectedSession = {
  activeProjectLocation?: { kind: string } | null
  activePhiSessionId?: string | null
  activeProjectId?: string | null
  activeSessionPath?: string | null
  activeSessionGeneration: number
}

export function remoteRecoveryTargetForSession(
  session: SelectedSession
): RuntimeRecoveryTarget | null {
  if (
    session.activeProjectLocation?.kind !== 'ssh' ||
    !session.activePhiSessionId ||
    !session.activeProjectId ||
    !session.activeSessionPath
  )
    return null
  return {
    sessionId: session.activePhiSessionId,
    projectId: session.activeProjectId,
    sessionPath: session.activeSessionPath,
    sessionGeneration: session.activeSessionGeneration
  }
}

export function sameRuntimeRecoveryTarget(
  left: RuntimeRecoveryTarget | null,
  right: RuntimeRecoveryTarget
): boolean {
  return (
    left !== null &&
    runtimeRecoveryViewKey(left) === runtimeRecoveryViewKey(right) &&
    left.sessionGeneration === right.sessionGeneration
  )
}

export function shouldAutoConnectRemoteSession(state: RuntimeRecoveryState): boolean {
  return state.phase === 'recovery-required' && state.issue === 'disconnected' && state.canResume
}

/** Runtime generation may advance because of this recovery; navigation changes the stable view identity. */
export function runtimeRecoveryViewKey(target: RuntimeRecoveryTarget | null): string {
  return target ? JSON.stringify([target.sessionId, target.projectId, target.sessionPath]) : ''
}
export function selectedRecoveryModel(
  value: string,
  available: readonly RuntimeRecoveryModelSelection[]
): RuntimeRecoveryModelSelection | undefined {
  const selected = available.find(
    (model) => JSON.stringify([model.providerId, model.modelId]) === value
  )
  return selected ? { providerId: selected.providerId, modelId: selected.modelId } : undefined
}
