import {
  getProject,
  getProjectByCwd,
  type ModelSelection,
  type PermissionMode,
  type Project
} from '../agent/projects'
import type { ThinkingLevel } from '../agent/runtime/model-thinking-levels'
import type { SessionSnapshot } from '../agent/session/session-lifecycle'
import { phiSessionIdFromPath } from '../agent/session/sessions'
import {
  findPhiSessionById,
  findPhiSessionByRuntimePath,
  listPhiSessions,
  type PhiSessionManifest
} from '../agent/session/session-store'
import type { PromptRunRegistry } from '../app-state/prompt-run-registry'
import type { SessionKeyRegistry } from '../app-state/session-key-registry'
import type { SessionPreferenceTable } from '../app-state/session-preferences'

interface PhiSessionPromptRun {
  phiSessionId: string
}

export interface SessionResolutionStores {
  listPhiSessions: typeof listPhiSessions
  findPhiSessionById: typeof findPhiSessionById
  findPhiSessionByRuntimePath: typeof findPhiSessionByRuntimePath
  getProject: typeof getProject
  getProjectByCwd: typeof getProjectByCwd
}

const defaultStores: SessionResolutionStores = {
  listPhiSessions,
  findPhiSessionById,
  findPhiSessionByRuntimePath,
  getProject,
  getProjectByCwd
}

export interface SessionResolutionDeps<TPromptRun extends PhiSessionPromptRun> {
  promptRuns: Pick<PromptRunRegistry<TPromptRun>, 'activeRun'>
  sessionKeys: Pick<SessionKeyRegistry, 'canonicalize' | 'phiSessionIdFor'>
  modelSelections: SessionPreferenceTable<ModelSelection | null>
  thinkingLevels: SessionPreferenceTable<ThinkingLevel>
  permissionModes: SessionPreferenceTable<PermissionMode>
  getSelectedModel: () => ModelSelection | null
  getDefaultThinkingLevel: () => ThinkingLevel
  stores?: SessionResolutionStores
}

export interface SessionResolution {
  findPhiManifestForSession: (
    sessionKey: string,
    path: string | undefined,
    cwd: string
  ) => PhiSessionManifest | null
  projectForSession: (
    sessionKey: string,
    snapshot: Pick<SessionSnapshot, 'path' | 'cwd'>
  ) => Project | undefined
  resolveSessionModelSelection: (
    sessionKey: string,
    snapshot: SessionSnapshot
  ) => ModelSelection | null
  resolveSessionThinkingLevel: (sessionKey: string, snapshot: SessionSnapshot) => ThinkingLevel
  resolveSessionPermissionMode: (
    sessionKey: string,
    snapshot: Pick<SessionSnapshot, 'path' | 'cwd'>
  ) => PermissionMode
}

type ProjectForSession = SessionResolution['projectForSession']

export function createSessionResolution<TPromptRun extends PhiSessionPromptRun>(
  deps: SessionResolutionDeps<TPromptRun>
): SessionResolution {
  const stores = deps.stores ?? defaultStores
  const findPhiManifestForSession = (
    sessionKey: string,
    path: string | undefined,
    cwd: string
  ): PhiSessionManifest | null => {
    const phiSessionId =
      deps.promptRuns.activeRun(sessionKey)?.phiSessionId ??
      deps.sessionKeys.phiSessionIdFor(sessionKey)
    if (phiSessionId) {
      return (
        stores.listPhiSessions().find((manifest) => manifest.sessionId === phiSessionId) ?? null
      )
    }
    if (!path) return null
    const phiOnlySessionId = phiSessionIdFromPath(path)
    return phiOnlySessionId
      ? stores.findPhiSessionById(phiOnlySessionId)
      : stores.findPhiSessionByRuntimePath(path, cwd)
  }

  const projectForSession: ProjectForSession = (sessionKey, snapshot) => {
    const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
    return manifest?.projectId
      ? stores.getProject(manifest.projectId)
      : stores.getProjectByCwd(snapshot.cwd)
  }

  const resolveSessionModelSelection = (
    sessionKey: string,
    snapshot: SessionSnapshot
  ): ModelSelection | null => {
    const canonicalKey = deps.sessionKeys.canonicalize(sessionKey)
    if (deps.modelSelections.has(canonicalKey)) {
      return deps.modelSelections.get(canonicalKey) ?? null
    }
    const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
    if (manifest?.model !== undefined) return manifest.model
    return projectForSession(sessionKey, snapshot)?.defaultModel ?? deps.getSelectedModel() ?? null
  }

  const resolveSessionThinkingLevel = (
    sessionKey: string,
    snapshot: SessionSnapshot
  ): ThinkingLevel => {
    const canonicalKey = deps.sessionKeys.canonicalize(sessionKey)
    if (deps.thinkingLevels.has(canonicalKey)) {
      return deps.thinkingLevels.get(canonicalKey) ?? deps.getDefaultThinkingLevel()
    }
    const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
    return (
      manifest?.thinkingLevel ??
      projectForSession(sessionKey, snapshot)?.defaultThinkingLevel ??
      deps.getDefaultThinkingLevel()
    )
  }

  const resolveSessionPermissionMode = (
    sessionKey: string,
    snapshot: Pick<SessionSnapshot, 'path' | 'cwd'>
  ): PermissionMode => {
    const canonicalKey = deps.sessionKeys.canonicalize(sessionKey)
    const manifest = findPhiManifestForSession(sessionKey, snapshot.path, snapshot.cwd)
    if (manifest) {
      deps.permissionModes.set(canonicalKey, manifest.permissionMode)
      return manifest.permissionMode
    }
    if (deps.permissionModes.has(canonicalKey)) {
      return deps.permissionModes.get(canonicalKey) ?? 'auto'
    }
    return projectForSession(sessionKey, snapshot)?.permissionMode ?? 'auto'
  }

  return {
    findPhiManifestForSession,
    projectForSession,
    resolveSessionModelSelection,
    resolveSessionThinkingLevel,
    resolveSessionPermissionMode
  }
}
