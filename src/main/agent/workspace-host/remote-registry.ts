import {
  resolveRemoteWorkspaceHostBinding,
  type RemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import { readCapabilityProfile } from './capability-profile-store'
import { reconcileRemoteHelperProfile, resolveRemoteHelperArtifact } from './helper-installer'
import { createWorkspaceHostRemoteSession } from './remote-session'
import { SshHost } from './ssh-host'
import type { SshHostConfig } from './ssh-host-context'
import type { WorkspaceHost } from './types'

export interface RemoteWorkspaceHostIdentity {
  sessionId: string
  projectId: string
  execTimeoutMs?: number
}

interface RemoteWorkspaceHostRegistryDependencies {
  resolveBinding?: (request: RemoteWorkspaceHostIdentity) => RemoteWorkspaceHostBinding
  createHost?: (config: SshHostConfig) => WorkspaceHost
  agentDir?: string
  helperResourceRoot?: string
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
      onFailure: () => void this.releaseSession(binding.sessionId),
      defaultTimeoutMs: request.execTimeoutMs
    })
  }

  async releaseSession(sessionId: string): Promise<void> {
    const entry = this.entries.get(sessionId)
    this.entries.delete(sessionId)
    await entry?.host.close?.()
  }

  async releaseProject(projectId: string): Promise<void> {
    const closing: Promise<void>[] = []
    for (const [sessionId, entry] of this.entries) {
      if (entry.projectId !== projectId) continue
      this.entries.delete(sessionId)
      if (entry.host.close) closing.push(entry.host.close())
    }
    await Promise.all(closing)
  }

  async releaseAll(): Promise<void> {
    const closing = [...this.entries.values()].flatMap((entry) =>
      entry.host.close ? [entry.host.close()] : []
    )
    this.entries.clear()
    await Promise.all(closing)
  }

  private create(binding: RemoteWorkspaceHostBinding): HostEntry {
    const profileKey = { hostAlias: binding.hostAlias, projectRoot: binding.remoteRoot }
    const cached = readCapabilityProfile(profileKey, { agentDir: this.dependencies.agentDir })
    const profile = cached
      ? reconcileRemoteHelperProfile(cached, {
          profileKey,
          agentDir: this.dependencies.agentDir,
          resourceRoot: this.dependencies.helperResourceRoot
        })
      : undefined
    const artifact = profile
      ? resolveRemoteHelperArtifact(profile, this.dependencies.helperResourceRoot)
      : undefined
    const helperDegraded =
      profile?.helperVersion === artifact?.version && profile?.helperStatus?.state === 'degraded'
    const config: SshHostConfig = {
      ...binding.config,
      ...(profile && artifact && !helperDegraded
        ? {
            helper: {
              profile,
              profileKey,
              artifact,
              agentDir: this.dependencies.agentDir
            }
          }
        : { platform: profile?.platform, capabilityProfile: profile })
    }
    const createHost = this.dependencies.createHost ?? ((input) => new SshHost(input))
    return {
      projectId: binding.projectId,
      cacheKey: binding.cacheKey,
      canonicalRoot: binding.canonicalRoot,
      host: createHost(config)
    }
  }
}

export const remoteWorkspaceHosts = new RemoteWorkspaceHostRegistry()
