import type { facadeBindingHash } from '../engine/rpc/facade-session-driver'
import type { RemoteEnvironmentService } from './environment-service'
import type { RemoteWorkspaceHostBinding } from '../remote-workspace-boundary'
import type { AppRemoteSessionRoutingOptions } from '../remote-session-routing'
import type { Project } from '../projects'
import { controlRemoteRuntimeWorkspace } from './controller'
import { openRemoteRuntimeWorkspace, type RemoteRuntimeTarget } from './workspace'

type AgentEnvironmentResolver = NonNullable<
  AppRemoteSessionRoutingOptions['resolveAgentEnvironment']
>
type AgentEnvironmentIdentity = Parameters<AgentEnvironmentResolver>[0]
type AgentEnvironmentProfile = Parameters<AgentEnvironmentResolver>[1]

export interface AppRemoteAgentEnvironmentDeps {
  sessions: {
    findById(sessionId: string): { cwd: string } | null | undefined
  }
  workspace: {
    resolveBinding(input: { sessionId: string; projectId: string }): RemoteWorkspaceHostBinding
    resolveTarget(params: unknown): RemoteRuntimeTarget | undefined
  }
  runtime: {
    describeReadyInWorkspace: RemoteEnvironmentService['describeReadyInWorkspace']
  }
  projects: {
    require(projectId: string): Project
  }
  facade: {
    bindingHash: typeof facadeBindingHash
  }
}

async function resolveAppRemoteAgentEnvironment(
  identity: AgentEnvironmentIdentity,
  agent: AgentEnvironmentProfile,
  signal: AbortSignal,
  deps: AppRemoteAgentEnvironmentDeps
): Promise<Awaited<ReturnType<AgentEnvironmentResolver>>> {
  if (!agent.environment) throw new Error('专家未声明环境')
  const boundary = { sessionId: identity.sessionId, projectId: identity.projectId }
  const binding = deps.workspace.resolveBinding(boundary)
  const assertCurrent = (): void => {
    signal.throwIfAborted()
    if (
      deps.sessions.findById(identity.sessionId)?.cwd !== identity.resourceCwd ||
      deps.workspace.resolveBinding(boundary).cacheKey !== binding.cacheKey
    )
      throw new Error('专家环境的项目或主机绑定已改变')
  }
  assertCurrent()
  const target = deps.workspace.resolveTarget({
    runtimeSessionId: identity.runtimeSessionId,
    remoteSessionId: identity.sessionId,
    projectId: identity.projectId
  })
  if (!target) throw new Error('专家环境缺少已验证的远程项目')
  const workspace = await openRemoteRuntimeWorkspace(target, signal)
  try {
    assertCurrent()
    const environment = await deps.runtime.describeReadyInWorkspace(
      agent.environment,
      controlRemoteRuntimeWorkspace(workspace, assertCurrent),
      signal
    )
    assertCurrent()
    if (!environment) throw new Error(`专家环境尚未就绪：${agent.environment}`)
    const project = deps.projects.require(identity.projectId)
    if (project.location.kind !== 'ssh') throw new Error('专家环境项目不再是 SSH 项目')
    return {
      ...environment,
      ...(agent.pluginId ? { pluginId: agent.pluginId } : {}),
      binding: {
        serverId: project.location.hostProfileId,
        serverIdentitySha256: deps.facade.bindingHash(binding),
        projectId: project.id,
        projectRoot: binding.canonicalRoot
      }
    }
  } finally {
    await workspace.close?.()
  }
}

export function createAppRemoteAgentEnvironment(
  deps: AppRemoteAgentEnvironmentDeps
): AgentEnvironmentResolver {
  return (identity, agent, signal) =>
    resolveAppRemoteAgentEnvironment(identity, agent, signal, deps)
}
