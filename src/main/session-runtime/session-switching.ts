import { getProject, getProjectByCwd, type PermissionMode } from '../agent/projects'
import type { CurrentSessionPayload } from '../agent/session/current-session-reads'
import {
  isStaleSessionError,
  type SessionLifecycleRecord
} from '../agent/session/session-lifecycle'
import { createPhiSession } from '../agent/session/session-store'
import { phiOnlySessionPath } from '../agent/session/sessions'
import type { BrowserWorkspaceRegistry } from '../browser/browser-workspace-registry'
import { messageContentTitleText } from '../../shared/sessionTitle'
import { browserPresentationSessionId } from '../../shared/browserSessionScope'
import type { PromptRunRegistry } from '../app-state/prompt-run-registry'
import type { SessionKeyRegistry } from '../app-state/session-key-registry'
import type { SessionLifecycleRegistry } from '../app-state/session-lifecycle-registry'
import type { SessionPreferenceTable } from '../app-state/session-preferences'
import type { SessionState } from '../app-state/session-state'
import type { SessionKeyLinking } from './session-key-linking'
import type { SessionResolution } from './session-resolution'
import type { ThinkingLevel } from '../agent/runtime/model-thinking-levels'

interface SwitchingPromptRun {
  phiSessionId: string
  runId: string
  cancelled: boolean
}

interface LoadedSkillNames {
  delete(phiSessionId: string): boolean
}

export interface SessionSwitchingStores {
  getProject: typeof getProject
  getProjectByCwd: typeof getProjectByCwd
  createPhiSession: typeof createPhiSession
}

const defaultStores: SessionSwitchingStores = {
  getProject,
  getProjectByCwd,
  createPhiSession
}

export interface SessionSwitchingDeps<TSessionResult, TPromptRun extends SwitchingPromptRun> {
  state: {
    sessionState: Pick<SessionState, 'sessionKey' | 'selectedModel' | 'switchTo'>
    sessionKeys: Pick<
      SessionKeyRegistry,
      'createKey' | 'createPhiKey' | 'canonicalize' | 'phiSessionIdFor'
    >
    lifecycles: Pick<SessionLifecycleRegistry<TSessionResult>, 'forKey'>
    promptRuns: Pick<PromptRunRegistry<TPromptRun>, 'activeRun' | 'advanceGeneration'>
    permissionModes: Pick<SessionPreferenceTable<PermissionMode>, 'set'>
  }
  sessions: {
    linkPhiManagedSessionKey: SessionKeyLinking['linkPhiManagedSessionKey']
    resolveSessionPermissionMode: SessionResolution['resolveSessionPermissionMode']
    getCurrentSessionPayload: () => CurrentSessionPayload
    getNoProjectTaskFolder: () => string
  }
  creation: {
    getSelectedThinkingLevel: () => ThinkingLevel
    isRemoteOmpRpcEnabled: () => boolean
    ensureRemoteProjectAnchor: (projectId: string) => string
  }
  invalidation: {
    loadedSkillNamesBySession: LoadedSkillNames
    cancelBrowserRun: (run: TPromptRun) => void
    cleanupBrowserRunTabs: (run: TPromptRun) => Promise<void>
    cancelPendingRunWaits: (scope?: { sessionId: string; runId: string }) => void
    cleanupSessionRecord: (record: SessionLifecycleRecord<TSessionResult> | null) => Promise<void>
  }
  browser: {
    getRegistry: () => Pick<BrowserWorkspaceRegistry, 'setActiveSession'> | null | undefined
  }
  events: {
    notifySessionChanged: () => void
    writeAppLog: (entry: {
      level: 'error'
      event: 'browser_presentation_transition_failed'
    }) => void
  }
  stores?: SessionSwitchingStores
}

export interface SessionSwitching<TSessionResult> {
  createPhiManagedSession: (
    cwd: string,
    permissionMode: PermissionMode,
    title?: string
  ) => { path: string; sessionId: string; permissionMode: PermissionMode }
  createRemoteManagedSession: (projectId: string) => {
    path: string
    sessionId: string
    cwd: string
    permissionMode: PermissionMode
  }
  getCurrentResolvedSession: () => Promise<TSessionResult | null>
  invalidateAgentSession: () => Promise<void>
  disposeAndSwitchSession: (
    path: string | undefined,
    cwd?: string,
    permissionMode?: PermissionMode,
    options?: { notify?: boolean }
  ) => Promise<CurrentSessionPayload>
}

type SessionCreationOperations<TSessionResult> = Pick<
  SessionSwitching<TSessionResult>,
  'createPhiManagedSession' | 'createRemoteManagedSession'
>

function createSessionCreationOperations<TSessionResult, TPromptRun extends SwitchingPromptRun>(
  deps: SessionSwitchingDeps<TSessionResult, TPromptRun>,
  stores: SessionSwitchingStores
): SessionCreationOperations<TSessionResult> {
  const createPhiManagedSession: SessionSwitching<TSessionResult>['createPhiManagedSession'] = (
    cwd,
    permissionMode,
    title
  ) => {
    const project = stores.getProjectByCwd(cwd)
    const model =
      deps.state.sessionState.selectedModel !== undefined
        ? deps.state.sessionState.selectedModel
        : (project?.defaultModel ?? null)
    const sessionTitle = messageContentTitleText(title)
    const session = stores.createPhiSession({
      kind: project ? 'project' : 'ordinary',
      projectId: project?.id ?? null,
      cwd,
      cwdRealPath: project?.workingDirectoryRealPath ?? cwd,
      ...(sessionTitle ? { title: sessionTitle } : {}),
      permissionMode,
      model,
      thinkingLevel: project?.defaultThinkingLevel ?? deps.creation.getSelectedThinkingLevel()
    })
    const path = phiOnlySessionPath(session.sessionId)
    const key = deps.state.sessionKeys.createPhiKey(session.sessionId, cwd)
    deps.sessions.linkPhiManagedSessionKey(key, cwd, session.sessionId)
    deps.state.permissionModes.set(deps.state.sessionKeys.canonicalize(key), permissionMode)
    return { path, sessionId: session.sessionId, permissionMode }
  }

  const createRemoteManagedSession: SessionSwitching<TSessionResult>['createRemoteManagedSession'] =
    (projectId) => {
      const project = stores.getProject(projectId)
      if (!project || project.location.kind !== 'ssh') throw new Error('远程项目不存在')
      const cwd = deps.creation.ensureRemoteProjectAnchor(project.id)
      const model =
        deps.state.sessionState.selectedModel !== undefined &&
        !(deps.creation.isRemoteOmpRpcEnabled() && deps.state.sessionState.selectedModel === null)
          ? deps.state.sessionState.selectedModel
          : (project.defaultModel ?? null)
      const session = stores.createPhiSession({
        kind: 'project',
        projectId: project.id,
        projectLocation: project.location,
        cwd,
        cwdRealPath: cwd,
        permissionMode: project.permissionMode,
        model,
        ...(project.defaultThinkingLevel ? { thinkingLevel: project.defaultThinkingLevel } : {})
      })
      const path = phiOnlySessionPath(session.sessionId)
      const key = deps.state.sessionKeys.createPhiKey(session.sessionId, cwd)
      deps.sessions.linkPhiManagedSessionKey(key, cwd, session.sessionId)
      deps.state.permissionModes.set(
        deps.state.sessionKeys.canonicalize(key),
        project.permissionMode
      )
      return { path, sessionId: session.sessionId, cwd, permissionMode: project.permissionMode }
    }

  return { createPhiManagedSession, createRemoteManagedSession }
}

export function createSessionSwitching<TSessionResult, TPromptRun extends SwitchingPromptRun>(
  deps: SessionSwitchingDeps<TSessionResult, TPromptRun>
): SessionSwitching<TSessionResult> {
  const stores = deps.stores ?? defaultStores
  const sessionCreation = createSessionCreationOperations(deps, stores)

  const getCurrentResolvedSession = async (): Promise<TSessionResult | null> => {
    const lifecycle = deps.state.lifecycles.forKey(deps.state.sessionState.sessionKey)
    const record = lifecycle.currentRecord
    if (!record) return null

    try {
      const result = await record.promise
      return lifecycle.isCurrent(record) ? result : null
    } catch (error) {
      if (!isStaleSessionError(error)) {
        throw error
      }
      return null
    }
  }

  const invalidateAgentSession = async (): Promise<void> => {
    const phiSessionId = deps.state.sessionKeys.phiSessionIdFor(deps.state.sessionState.sessionKey)
    if (phiSessionId) deps.invalidation.loadedSkillNamesBySession.delete(phiSessionId)
    const lifecycle = deps.state.lifecycles.forKey(deps.state.sessionState.sessionKey)
    const previous = lifecycle.advance()
    deps.state.promptRuns.advanceGeneration(deps.state.sessionState.sessionKey)
    const activePromptRun = deps.state.promptRuns.activeRun(deps.state.sessionState.sessionKey)
    if (activePromptRun) {
      activePromptRun.cancelled = true
      deps.invalidation.cancelBrowserRun(activePromptRun)
      void deps.invalidation.cleanupBrowserRunTabs(activePromptRun)
    }
    deps.invalidation.cancelPendingRunWaits(
      activePromptRun
        ? { sessionId: activePromptRun.phiSessionId, runId: activePromptRun.runId }
        : undefined
    )
    deps.events.notifySessionChanged()
    void deps.invalidation.cleanupSessionRecord(previous)
  }

  // A user-visible conversation switch points future getAgentSession() calls at a
  // different file/cwd/permission mode. It deliberately does not abort the old
  // session: switching conversations is navigation, not stop.
  const disposeAndSwitchSession: SessionSwitching<TSessionResult>['disposeAndSwitchSession'] =
    async (
      path,
      cwd = deps.sessions.getNoProjectTaskFolder(),
      permissionMode = 'auto',
      options = {}
    ) => {
      deps.state.sessionState.switchTo(path, cwd, permissionMode, {
        createSessionKey: deps.state.sessionKeys.createKey.bind(deps.state.sessionKeys),
        resolveSessionPermissionMode: deps.sessions.resolveSessionPermissionMode,
        resolveSessionKeyAlias: deps.state.sessionKeys.canonicalize.bind(deps.state.sessionKeys),
        sessionPermissionModes: deps.state.permissionModes
      })
      const target = deps.sessions.getCurrentSessionPayload()
      try {
        await deps.browser
          .getRegistry()
          ?.setActiveSession(browserPresentationSessionId(target.phiSessionId))
      } catch {
        deps.events.writeAppLog({
          level: 'error',
          event: 'browser_presentation_transition_failed'
        })
      }
      if (options.notify !== false) {
        deps.events.notifySessionChanged()
      }
      return target
    }

  return {
    ...sessionCreation,
    getCurrentResolvedSession,
    invalidateAgentSession,
    disposeAndSwitchSession
  }
}
