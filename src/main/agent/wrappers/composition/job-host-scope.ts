import type { PhiHostRequestContext } from '../../engine/types'
import type { Project } from '../../projects'
import type { RemoteWorkspaceHostBinding } from '../../remote-workspace-boundary'
import type { PhiSessionManifest } from '../../session/session-store'
import type { WrapperRun } from '../types'
import { createWrapperJobHostScope, type WrapperJobHostScope } from './job-host-handlers'

interface WrapperOrigin {
  phiSessionId: string
  cwd: string
}

type WrapperRemoteTarget =
  | { reason: string }
  | {
      target: {
        connection: { host: string }
        workspaceRoot: string
      }
    }

type RemoteWrapperProject = Project & {
  location: Extract<Project['location'], { kind: 'ssh' }>
}

export interface WrapperJobScopeDependencies {
  resolveOrigin(originSessionId: string | undefined): WrapperOrigin | undefined
  findSession(sessionId: string): PhiSessionManifest | null
  getProject(projectId: string): Project | undefined
  ownsRemoteRuntimeSession(originSessionId: string): boolean
  resolveBinding(input: {
    sessionId: string
    projectId: string
  }): Pick<RemoteWorkspaceHostBinding, 'cacheKey'>
  resolveTarget(project: Project): WrapperRemoteTarget
  readRun(runId: string): WrapperRun | null | undefined
}

interface WrapperScopeOrigin {
  originSessionId: string
  origin: WrapperOrigin
  manifest: PhiSessionManifest
}

function wrapperScopeOrigin(
  context: PhiHostRequestContext | undefined,
  dependencies: WrapperJobScopeDependencies
): WrapperScopeOrigin | undefined {
  const originSessionId = context?.originSessionId
  if (!originSessionId) {
    if (context?.signal) throw new Error('RPC Wrapper call has no trusted origin')
    return undefined
  }
  const origin = dependencies.resolveOrigin(originSessionId)
  const manifest = origin && dependencies.findSession(origin.phiSessionId)
  if (!origin || !manifest) throw new Error('Wrapper origin session is unavailable')
  return { originSessionId, origin, manifest }
}

function wrapperScopeProject(
  context: PhiHostRequestContext | undefined,
  manifest: PhiSessionManifest,
  dependencies: WrapperJobScopeDependencies
): RemoteWrapperProject | undefined {
  const project = manifest.projectId ? dependencies.getProject(manifest.projectId) : undefined
  if (project?.location.kind !== 'ssh') {
    if (context?.signal || manifest.projectLocation?.kind === 'ssh') {
      throw new Error('RPC Wrapper project is unavailable')
    }
    return undefined
  }
  return project as RemoteWrapperProject
}

function assertWrapperScopeCurrent(options: {
  originSessionId: string
  origin: WrapperOrigin
  project: Project
  bindingKey: string
  targetKey: string
  dependencies: WrapperJobScopeDependencies
}): void {
  const currentProject = options.dependencies.getProject(options.project.id)
  if (
    !currentProject ||
    options.dependencies.resolveOrigin(options.originSessionId)?.phiSessionId !==
      options.origin.phiSessionId ||
    options.dependencies.resolveBinding({
      sessionId: options.origin.phiSessionId,
      projectId: options.project.id
    }).cacheKey !== options.bindingKey ||
    JSON.stringify(options.dependencies.resolveTarget(currentProject)) !== options.targetKey
  ) {
    throw new Error('RPC Wrapper selected project/host binding changed')
  }
}

export function resolveWrapperJobHostScope(
  context: PhiHostRequestContext | undefined,
  dependencies: WrapperJobScopeDependencies
): WrapperJobHostScope | undefined {
  const resolvedOrigin = wrapperScopeOrigin(context, dependencies)
  if (!resolvedOrigin) return undefined
  const { originSessionId, origin, manifest } = resolvedOrigin
  const project = wrapperScopeProject(context, manifest, dependencies)
  if (!project) return undefined
  if (dependencies.ownsRemoteRuntimeSession(originSessionId) && !context?.signal) {
    throw new Error('RPC Wrapper call has no owned cancellation scope')
  }
  const binding = dependencies.resolveBinding({
    sessionId: origin.phiSessionId,
    projectId: project.id
  })
  const target = dependencies.resolveTarget(project)
  if ('reason' in target) throw new Error(target.reason)
  const targetKey = JSON.stringify(target)
  return createWrapperJobHostScope({
    originSessionId,
    phiSessionId: origin.phiSessionId,
    projectId: project.id,
    hostProfileId: project.location.hostProfileId,
    host: target.target.connection.host,
    workspaceRoot: target.target.workspaceRoot,
    signal: context?.signal,
    readRun: dependencies.readRun,
    resolveOrigin: dependencies.resolveOrigin,
    assertCurrent: () =>
      assertWrapperScopeCurrent({
        originSessionId,
        origin,
        project,
        bindingKey: binding.cacheKey,
        targetKey,
        dependencies
      })
  })
}
