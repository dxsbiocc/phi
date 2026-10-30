import { getProject, getProjectByCwd, type Project } from '../agent/projects'
import type { CurrentSessionPayload } from '../agent/session/current-session-reads'
import { phiOnlySessionPath } from '../agent/session/sessions'
import type { PhiSessionManifest } from '../agent/session/session-store'
import type { SessionRunnerRegistry } from '../agent/session/session-runner-registry'
import type { ProjectLocation } from '../../shared/projectLocation'
import type { PromptRunRegistry } from '../app-state/prompt-run-registry'
import type { SessionKeyRegistry } from '../app-state/session-key-registry'
import type { SessionLifecycleRegistry } from '../app-state/session-lifecycle-registry'
import type { SessionState } from '../app-state/session-state'
import type { SessionResolution } from './session-resolution'
import { isLegacyRemoteSession } from '../agent/session/legacy-remote-session'
import { fieldsFromMode, modeFromFields } from '../../shared/sessionMode'
import { messageContentTitleText } from '../../shared/sessionTitle'

interface CurrentSessionPromptRun {
  phiSessionId: string
  runId: string
  cancelled: boolean
}

export interface CurrentSessionPayloadStores {
  getProject: typeof getProject
  getProjectByCwd: typeof getProjectByCwd
}

const defaultStores: CurrentSessionPayloadStores = {
  getProject,
  getProjectByCwd
}

export interface CurrentSessionPayloadDeps<
  TSessionResult,
  TPromptRun extends CurrentSessionPromptRun
> {
  sessionState: Pick<
    SessionState,
    'sessionKey' | 'sessionPath' | 'cwd' | 'permissionMode' | 'refreshPermissionMode'
  >
  sessionKeys: Pick<SessionKeyRegistry, 'phiSessionIdFor'>
  lifecycles: Pick<SessionLifecycleRegistry<TSessionResult>, 'forKey'>
  promptRuns: Pick<PromptRunRegistry<TPromptRun>, 'activeRun'>
  runners: Pick<SessionRunnerRegistry, 'getActiveRun'>
  sessionResolution: Pick<
    SessionResolution,
    'findPhiManifestForSession' | 'resolveSessionPermissionMode'
  >
  stores?: CurrentSessionPayloadStores
}

type SessionStatusPayload = Pick<
  CurrentSessionPayload,
  | 'status'
  | 'unreadKind'
  | 'lastRunOutcome'
  | 'currentRunId'
  | 'currentRunStartedAt'
  | 'lastActivityAt'
>

export interface CurrentSessionPayloadOperations {
  getSessionStatusPayload: (
    sessionKey: string,
    path: string | undefined,
    cwd: string
  ) => SessionStatusPayload
  getCurrentSessionPayload: () => CurrentSessionPayload
}

function sessionStatusPayload<TSessionResult, TPromptRun extends CurrentSessionPromptRun>(
  deps: Pick<
    CurrentSessionPayloadDeps<TSessionResult, TPromptRun>,
    'promptRuns' | 'runners' | 'sessionResolution'
  >,
  sessionKey: string,
  path: string | undefined,
  cwd: string
): SessionStatusPayload {
  const promptRun = deps.promptRuns.activeRun(sessionKey)
  const activeRun = promptRun ? deps.runners.getActiveRun(promptRun.phiSessionId) : null
  if (activeRun) {
    return {
      status: activeRun.status,
      unreadKind:
        activeRun.status === 'needs_approval'
          ? 'approval'
          : activeRun.status === 'needs_input'
            ? 'input'
            : null,
      currentRunId: activeRun.runId,
      currentRunStartedAt: activeRun.startedAt
    }
  }
  const manifest = deps.sessionResolution.findPhiManifestForSession(sessionKey, path, cwd)
  // Remote setup can still be connecting or resolving uploaded resources after prompt
  // admission but before the session runner exists. The prompt registry is authoritative
  // for that gap; local snapshots retain their existing manifest-driven behaviour.
  if (promptRun && !promptRun.cancelled && manifest?.projectLocation?.kind === 'ssh') {
    return { status: 'running', unreadKind: null, currentRunId: promptRun.runId }
  }
  if (manifest) {
    return {
      status: manifest.status,
      unreadKind: manifest.unreadKind,
      lastRunOutcome: manifest.lastRunOutcome,
      currentRunId: manifest.currentRunId,
      currentRunStartedAt: manifest.currentRunStartedAt,
      lastActivityAt: manifest.lastActivityAt
    }
  }
  return { status: 'idle', unreadKind: null }
}

function selectCurrentSessionProjectPayloadFields(
  manifest: Pick<PhiSessionManifest, 'projectId'> | null,
  project: Pick<Project, 'id'> | undefined,
  projectLocation: ProjectLocation | undefined
): Pick<CurrentSessionPayload, 'projectId' | 'projectLocation'> {
  return {
    ...(manifest?.projectId || project?.id
      ? { projectId: manifest?.projectId ?? project?.id }
      : {}),
    ...(projectLocation ? { projectLocation } : {})
  }
}

export function createCurrentSessionPayload<
  TSessionResult,
  TPromptRun extends CurrentSessionPromptRun
>(deps: CurrentSessionPayloadDeps<TSessionResult, TPromptRun>): CurrentSessionPayloadOperations {
  const stores = deps.stores ?? defaultStores
  const getSessionStatusPayload: CurrentSessionPayloadOperations['getSessionStatusPayload'] = (
    sessionKey,
    path,
    cwd
  ) => sessionStatusPayload(deps, sessionKey, path, cwd)

  const getCurrentSessionPayload = (): CurrentSessionPayload => {
    deps.sessionState.refreshPermissionMode(deps.sessionResolution.resolveSessionPermissionMode)
    const manifest = deps.sessionResolution.findPhiManifestForSession(
      deps.sessionState.sessionKey,
      deps.sessionState.sessionPath,
      deps.sessionState.cwd
    )
    const phiSessionId =
      manifest?.sessionId ?? deps.sessionKeys.phiSessionIdFor(deps.sessionState.sessionKey)
    const path = phiSessionId
      ? phiOnlySessionPath(phiSessionId)
      : (deps.sessionState.sessionPath ?? null)
    const project = manifest?.projectId
      ? stores.getProject(manifest.projectId)
      : stores.getProjectByCwd(deps.sessionState.cwd)
    const projectLocation = manifest?.projectLocation ?? project?.location
    const name = messageContentTitleText(manifest?.title)
    return {
      path,
      ...(phiSessionId ? { phiSessionId } : {}),
      ...(name ? { name } : {}),
      cwd: deps.sessionState.cwd,
      displayCwd:
        projectLocation?.kind === 'ssh' ? projectLocation.remoteRoot : deps.sessionState.cwd,
      ...selectCurrentSessionProjectPayloadFields(manifest, project, projectLocation),
      ...(isLegacyRemoteSession(manifest) ? { legacyRemoteSession: true } : {}),
      sessionGeneration: deps.lifecycles.forKey(deps.sessionState.sessionKey).currentGeneration,
      permissionMode: deps.sessionState.permissionMode,
      workMode:
        manifest?.workMode ??
        fieldsFromMode(modeFromFields({ permissionMode: deps.sessionState.permissionMode }))
          .workMode,
      ...getSessionStatusPayload(
        deps.sessionState.sessionKey,
        deps.sessionState.sessionPath,
        deps.sessionState.cwd
      )
    }
  }

  return { getSessionStatusPayload, getCurrentSessionPayload }
}
