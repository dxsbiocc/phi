import { getProject, type Project } from '../agent/projects'
import { facadeBindingHash } from '../agent/engine/rpc/facade-session-driver'
import { resolveRemoteWorkspaceHostBinding } from '../agent/remote-workspace-boundary'
import { resolveRuntimeSessionOrigin } from '../agent/session/runtime-origin-store'
import {
  assertRuntimeReferenceProject,
  assertRuntimeScope,
  parseRuntimeReference,
  type RemoteOmpScope
} from '../agent/session/runtime-reference'
import { findPhiSessionById, type PhiSessionManifest } from '../agent/session/session-store'
import type { SessionKeyRegistry } from '../app-state/session-key-registry'

interface OriginPromptRun {
  phiSessionId: string
}

export interface SessionOriginServices {
  findPhiSessionById: typeof findPhiSessionById
  getProject: typeof getProject
  resolveRuntimeSessionOrigin: typeof resolveRuntimeSessionOrigin
  resolveRemoteWorkspaceHostBinding: typeof resolveRemoteWorkspaceHostBinding
  facadeBindingHash: typeof facadeBindingHash
}

const defaultServices: SessionOriginServices = {
  findPhiSessionById,
  getProject,
  resolveRuntimeSessionOrigin,
  resolveRemoteWorkspaceHostBinding,
  facadeBindingHash
}

export interface SessionOriginsDeps<TPromptRun extends OriginPromptRun> {
  sessionKeys: Pick<SessionKeyRegistry, 'originFor' | 'phiSessionIdFor'>
  findActivePromptRunByRuntimeSessionId: (runtimeSessionId: string) => TPromptRun | null
  getCurrentCwd: () => string
  requireProject: (projectId: string) => Project
  projectRemoteRuntimeRoot: (project: Project) => { configured: string }
  agentDir: string
  services?: SessionOriginServices
}

export interface SessionOrigins {
  resolveOriginSession: (
    originSessionId: string | undefined
  ) => { phiSessionId: string; cwd: string } | undefined
  currentRuntimeOriginScope: (manifest: PhiSessionManifest) => RemoteOmpScope | undefined
  resolveRecoverableJobOrigin: (
    originSessionId: string | undefined
  ) => { phiSessionId: string; cwd: string } | undefined
}

export function createSessionOrigins<TPromptRun extends OriginPromptRun>(
  deps: SessionOriginsDeps<TPromptRun>
): SessionOrigins {
  const services = deps.services ?? defaultServices
  const resolveOriginSession: SessionOrigins['resolveOriginSession'] = (originSessionId) => {
    if (!originSessionId) return undefined
    const origin = deps.sessionKeys.originFor(originSessionId)
    const phiSessionId = origin
      ? deps.sessionKeys.phiSessionIdFor(origin.sessionKey)
      : deps.findActivePromptRunByRuntimeSessionId(originSessionId)?.phiSessionId
    return phiSessionId ? { phiSessionId, cwd: origin?.cwd ?? deps.getCurrentCwd() } : undefined
  }

  const currentRuntimeOriginScope: SessionOrigins['currentRuntimeOriginScope'] = (manifest) => {
    if (!manifest.runtimeRef || !manifest.projectId) return undefined
    const reference = parseRuntimeReference(manifest.runtimeRef, manifest.sessionId)
    const project = deps.requireProject(manifest.projectId)
    if (project.location.kind !== 'ssh') return undefined
    const binding = services.resolveRemoteWorkspaceHostBinding({
      sessionId: manifest.sessionId,
      projectId: project.id
    })
    const scope = {
      hostProfileId: project.location.hostProfileId,
      bindingHash: services.facadeBindingHash(binding),
      projectId: project.id,
      projectRoot: binding.canonicalRoot,
      runtimeRoot: reference.runtimeRoot
    }
    assertRuntimeReferenceProject(manifest, scope)
    assertRuntimeScope(reference, scope)
    return scope
  }

  /** Cold records recover job attribution only; all tool/control/wakeup authority uses the live resolver. */
  const resolveRecoverableJobOrigin: SessionOrigins['resolveRecoverableJobOrigin'] = (
    originSessionId
  ) => {
    if (!originSessionId) return undefined
    return (
      resolveOriginSession(originSessionId) ??
      services.resolveRuntimeSessionOrigin(
        originSessionId,
        {
          readManifest: services.findPhiSessionById,
          resolveRemoteScope: currentRuntimeOriginScope,
          resolveConfiguredRuntimeRoot: (manifest) => {
            const project = manifest.projectId ? services.getProject(manifest.projectId) : undefined
            return project?.location.kind === 'ssh'
              ? deps.projectRemoteRuntimeRoot(project).configured
              : undefined
          }
        },
        deps.agentDir
      )
    )
  }

  return { resolveOriginSession, currentRuntimeOriginScope, resolveRecoverableJobOrigin }
}
