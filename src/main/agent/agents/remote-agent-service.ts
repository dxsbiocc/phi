import {
  resolveRemoteWorkspaceHostBinding,
  type RemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import { SshHost } from '../workspace-host/ssh-host'
import type { WorkspaceHost } from '../workspace-host/types'
import { discoverRemoteAgentCatalog, type RemoteAgentCatalogResult } from './remote-agent-catalog'
import { revokeRemoteProjectAgentTrust, trustRemoteProjectAgent } from './remote-agent-trust-store'
import { discoverRemoteProjectAgents } from './remote-project-agent-discovery'

export interface RemoteAgentProjectContext {
  sessionId: string
  projectId: string
  cwd: string
  agentDir: string
  bundledDir: string
}

export interface RemoteAgentTrustMutation {
  relativePath: string
  contentHash: string
}

interface RemoteAgentServiceDependencies {
  resolveBinding?: (input: { sessionId: string; projectId: string }) => RemoteWorkspaceHostBinding
  createHost?: (binding: RemoteWorkspaceHostBinding) => WorkspaceHost
}

function bindingFor(
  context: RemoteAgentProjectContext,
  dependencies: RemoteAgentServiceDependencies
): RemoteWorkspaceHostBinding {
  // The boundary rejects any key besides sessionId/projectId, so never forward the whole context.
  const identity = { sessionId: context.sessionId, projectId: context.projectId }
  return (
    dependencies.resolveBinding ??
    ((input) =>
      resolveRemoteWorkspaceHostBinding(input, {
        agentDir: context.agentDir
      }))
  )(identity)
}

function hostFor(
  binding: RemoteWorkspaceHostBinding,
  dependencies: RemoteAgentServiceDependencies
): WorkspaceHost {
  return dependencies.createHost?.(binding) ?? new SshHost(binding.config)
}

export async function loadRemoteAgentCatalog(
  context: RemoteAgentProjectContext,
  dependencies: RemoteAgentServiceDependencies = {}
): Promise<RemoteAgentCatalogResult> {
  const binding = bindingFor(context, dependencies)
  const host = hostFor(binding, dependencies)
  try {
    return await discoverRemoteAgentCatalog({
      host,
      projectRoot: binding.canonicalRoot,
      hostAlias: binding.hostAlias,
      agentDir: context.agentDir,
      cwd: context.cwd,
      bundledDir: context.bundledDir
    })
  } finally {
    await host.close?.().catch(() => undefined)
  }
}

async function mutateTrust(
  context: RemoteAgentProjectContext,
  mutation: RemoteAgentTrustMutation,
  trusted: boolean,
  dependencies: RemoteAgentServiceDependencies
): Promise<void> {
  const binding = bindingFor(context, dependencies)
  const host = hostFor(binding, dependencies)
  try {
    const scan = await discoverRemoteProjectAgents({
      host,
      projectRoot: binding.canonicalRoot,
      hostAlias: binding.hostAlias,
      agentDir: context.agentDir
    })
    const entry = scan.entries.find((item) => item.relativePath === mutation.relativePath)
    if (!entry || entry.contentHash !== mutation.contentHash || entry.trustState === 'invalid') {
      throw new Error('服务器项目 agent 已变化或不可用，请刷新列表后重试')
    }
    const identity = {
      hostAlias: binding.hostAlias,
      projectRoot: binding.canonicalRoot,
      relativePath: entry.relativePath,
      contentHash: entry.contentHash
    }
    if (trusted) trustRemoteProjectAgent(identity, context.agentDir)
    else revokeRemoteProjectAgentTrust(identity, context.agentDir)
  } finally {
    await host.close?.().catch(() => undefined)
  }
}

export function trustRemoteAgent(
  context: RemoteAgentProjectContext,
  mutation: RemoteAgentTrustMutation,
  dependencies: RemoteAgentServiceDependencies = {}
): Promise<void> {
  return mutateTrust(context, mutation, true, dependencies)
}

export function revokeRemoteAgent(
  context: RemoteAgentProjectContext,
  mutation: RemoteAgentTrustMutation,
  dependencies: RemoteAgentServiceDependencies = {}
): Promise<void> {
  return mutateTrust(context, mutation, false, dependencies)
}
