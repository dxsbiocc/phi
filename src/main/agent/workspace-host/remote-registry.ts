import {
  resolveRemoteWorkspaceHostBinding,
  type RemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import { createWorkspaceHostRemoteSession } from './remote-session'
import { SshHost } from './ssh-host'
import type { WorkspaceHost } from './types'

export interface RemoteWorkspaceHostIdentity {
  sessionId: string
  projectId: string
  execTimeoutMs?: number
}

interface RemoteWorkspaceHostRegistryDependencies {
  resolveBinding?: (request: RemoteWorkspaceHostIdentity) => RemoteWorkspaceHostBinding
  createHost?: (config: RemoteWorkspaceHostBinding['config']) => WorkspaceHost
}

interface HostEntry {
  projectId: string
  cacheKey: string
  canonicalRoot: string
  host: WorkspaceHost
}

export class RemoteWorkspaceHostRegistry {
  private readonly entries = new Map<string, HostEntry>()

  constructor(private readonly dependencies: RemoteWorkspaceHostRegistryDependencies = {}) {}

  async connect(request: RemoteWorkspaceHostIdentity): Promise<RemoteSshSession> {
    const binding = (this.dependencies.resolveBinding ?? resolveRemoteWorkspaceHostBinding)({
      sessionId: request.sessionId,
      projectId: request.projectId
    })
    const current = this.entries.get(binding.sessionId)
    const entry =
      current?.projectId === binding.projectId && current.cacheKey === binding.cacheKey
        ? current
        : this.create(binding)
    this.entries.set(binding.sessionId, entry)
    return createWorkspaceHostRemoteSession(entry.host, entry.canonicalRoot, {
      onFailure: () => this.releaseSession(binding.sessionId),
      defaultTimeoutMs: request.execTimeoutMs
    })
  }

  releaseSession(sessionId: string): void {
    this.entries.delete(sessionId)
  }

  releaseProject(projectId: string): void {
    for (const [sessionId, entry] of this.entries) {
      if (entry.projectId === projectId) this.entries.delete(sessionId)
    }
  }

  releaseAll(): void {
    this.entries.clear()
  }

  private create(binding: RemoteWorkspaceHostBinding): HostEntry {
    const createHost = this.dependencies.createHost ?? ((config) => new SshHost(config))
    return {
      projectId: binding.projectId,
      cacheKey: binding.cacheKey,
      canonicalRoot: binding.canonicalRoot,
      host: createHost(binding.config)
    }
  }
}

export const remoteWorkspaceHosts = new RemoteWorkspaceHostRegistry()
