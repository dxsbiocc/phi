import { getProjectByCwd, type PermissionMode } from '../agent/projects'
import type { SessionSnapshot } from '../agent/session/session-lifecycle'
import {
  createPhiSession,
  findPhiSessionById,
  updateSessionManifest
} from '../agent/session/session-store'
import { isPhiOnlySessionPath, phiOnlySessionPath } from '../agent/session/sessions'
import type { SessionKeyRegistry } from '../app-state/session-key-registry'
import type { SessionRuntime } from '../app-state/session-runtime'
import type { SessionState } from '../app-state/session-state'
import type { SessionResolution } from './session-resolution'
import { messageContentTitleText } from '../../shared/sessionTitle'

export interface SessionKeyLinkingStores {
  findPhiSessionById: typeof findPhiSessionById
  updateSessionManifest: typeof updateSessionManifest
  createPhiSession: typeof createPhiSession
  getProjectByCwd: typeof getProjectByCwd
}

const defaultStores: SessionKeyLinkingStores = {
  findPhiSessionById,
  updateSessionManifest,
  createPhiSession,
  getProjectByCwd
}

export interface SessionKeyLinkingDeps {
  sessionRuntime: Pick<SessionRuntime, 'alias'>
  sessionKeys: Pick<
    SessionKeyRegistry,
    'createKey' | 'createPhiKey' | 'phiSessionIdFor' | 'setPhiSessionId' | 'sameCanonical'
  >
  sessionState: Pick<SessionState, 'linkPhiManagedSessionKey'>
  sessionResolution: Pick<
    SessionResolution,
    'findPhiManifestForSession' | 'resolveSessionModelSelection' | 'resolveSessionThinkingLevel'
  >
  stores?: SessionKeyLinkingStores
}

export interface SessionKeyLinking {
  aliasMaterializedSessionPath: (sessionKey: string, path: string, cwd: string) => void
  linkPhiManagedSessionKey: (sessionKey: string, cwd: string, phiSessionId: string) => string
  updatePhiRuntimeSessionPath: (sessionId: string, path: string) => void
  runtimeSessionPath: (path: string | undefined) => string | undefined
  ensurePhiSessionId: (
    sessionKey: string,
    snapshot: SessionSnapshot & { permissionMode: PermissionMode },
    title?: string
  ) => string
}

type LinkPhiManagedSessionKey = SessionKeyLinking['linkPhiManagedSessionKey']

export function createSessionKeyLinking(deps: SessionKeyLinkingDeps): SessionKeyLinking {
  const stores = deps.stores ?? defaultStores
  const aliasMaterializedSessionPath: SessionKeyLinking['aliasMaterializedSessionPath'] = (
    sessionKey,
    path,
    cwd
  ) => {
    deps.sessionRuntime.alias(deps.sessionKeys.createKey(path, cwd), sessionKey)
  }

  const linkPhiManagedSessionKey: LinkPhiManagedSessionKey = (sessionKey, cwd, phiSessionId) => {
    const stablePath = phiOnlySessionPath(phiSessionId)
    const stableKey = deps.sessionKeys.createPhiKey(phiSessionId, cwd)
    deps.sessionRuntime.alias(stableKey, sessionKey)
    deps.sessionKeys.setPhiSessionId(sessionKey, phiSessionId)
    deps.sessionKeys.setPhiSessionId(stableKey, phiSessionId)
    deps.sessionState.linkPhiManagedSessionKey(
      sessionKey,
      stablePath,
      stableKey,
      deps.sessionKeys.sameCanonical.bind(deps.sessionKeys)
    )
    return stablePath
  }

  const updatePhiRuntimeSessionPath: SessionKeyLinking['updatePhiRuntimeSessionPath'] = (
    sessionId,
    path
  ) => {
    const manifest = stores.findPhiSessionById(sessionId)
    if (manifest?.runtimeSessionPath === path) return
    stores.updateSessionManifest(sessionId, { runtimeSessionPath: path })
  }

  const runtimeSessionPath: SessionKeyLinking['runtimeSessionPath'] = (path) => {
    return isPhiOnlySessionPath(path) ? undefined : path
  }

  const ensurePhiSessionId: SessionKeyLinking['ensurePhiSessionId'] = (
    sessionKey,
    snapshot,
    title
  ) => {
    const existing = deps.sessionKeys.phiSessionIdFor(sessionKey)
    if (existing && stores.findPhiSessionById(existing)) {
      linkPhiManagedSessionKey(sessionKey, snapshot.cwd, existing)
      return existing
    }
    const manifest = deps.sessionResolution.findPhiManifestForSession(
      sessionKey,
      snapshot.path,
      snapshot.cwd
    )
    if (manifest) {
      linkPhiManagedSessionKey(sessionKey, manifest.cwd, manifest.sessionId)
      return manifest.sessionId
    }

    const project = stores.getProjectByCwd(snapshot.cwd)
    const model = deps.sessionResolution.resolveSessionModelSelection(sessionKey, snapshot)
    const sessionTitle = messageContentTitleText(title)
    const session = stores.createPhiSession({
      kind: project ? 'project' : 'ordinary',
      projectId: project?.id ?? null,
      cwd: snapshot.cwd,
      cwdRealPath: project?.workingDirectoryRealPath ?? snapshot.cwd,
      ...(sessionTitle ? { title: sessionTitle } : {}),
      ...(runtimeSessionPath(snapshot.path) ? { runtimeSessionPath: snapshot.path } : {}),
      permissionMode: snapshot.permissionMode,
      model,
      thinkingLevel: deps.sessionResolution.resolveSessionThinkingLevel(sessionKey, snapshot)
    })
    linkPhiManagedSessionKey(sessionKey, snapshot.cwd, session.sessionId)
    return session.sessionId
  }

  return {
    aliasMaterializedSessionPath,
    linkPhiManagedSessionKey,
    updatePhiRuntimeSessionPath,
    runtimeSessionPath,
    ensurePhiSessionId
  }
}
