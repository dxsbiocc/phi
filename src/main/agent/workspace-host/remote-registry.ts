import {
  resolveRemoteWorkspaceHostBinding,
  type RemoteWorkspaceHostBinding
} from '../remote-workspace-boundary'
import { remoteMicromambaManifestVersion } from '../remote-micromamba-artifact'
import type { RemoteSshSession } from '../wrappers/remote-ssh-session'
import { readCapabilityProfile } from './capability-profile-store'
import { reconcileRemoteHelperProfile } from './helper-installer'
import { resolveRemoteHelperPreparation } from './helper-development'
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
  helperDevelopmentRoot?: string
  expectedMicromambaVersion?: string
}

function expectedMicromambaVersion(
  dependencies: RemoteWorkspaceHostRegistryDependencies
): string | undefined {
  if (dependencies.expectedMicromambaVersion) return dependencies.expectedMicromambaVersion
  try {
    return remoteMicromambaManifestVersion()
  } catch {
    return undefined
  }
}

interface HostEntry {
  projectId: string
  cacheKey: string
  canonicalRoot: string
  host: WorkspaceHost
}

function helperBootstrapConfig(
  profileKey: { hostAlias: string; projectRoot: string },
  dependencies: RemoteWorkspaceHostRegistryDependencies
): NonNullable<SshHostConfig['helperBootstrap']> {
  return {
    profileKey,
    agentDir: dependencies.agentDir,
    resourceRoot: dependencies.helperResourceRoot,
    developmentRoot: dependencies.helperDevelopmentRoot
  }
}

function sshHostConfig(
  binding: RemoteWorkspaceHostBinding,
  dependencies: RemoteWorkspaceHostRegistryDependencies
): SshHostConfig {
  const profileKey = { hostAlias: binding.hostAlias, projectRoot: binding.remoteRoot }
  const cached = readCapabilityProfile(profileKey, {
    agentDir: dependencies.agentDir,
    expectedMicromambaVersion: expectedMicromambaVersion(dependencies)
  })
  const profile = cached
    ? reconcileRemoteHelperProfile(cached, {
        profileKey,
        agentDir: dependencies.agentDir,
        resourceRoot: dependencies.helperResourceRoot
      })
    : undefined
  if (!profile || profile.probe?.state === 'degraded') {
    return {
      ...binding.config,
      capabilityProfile: profile,
      helperBootstrap: helperBootstrapConfig(profileKey, dependencies)
    }
  }
  const preparation = resolveRemoteHelperPreparation(profile, {
    resourceRoot: dependencies.helperResourceRoot,
    developmentRoot: dependencies.helperDevelopmentRoot
  })
  const artifact = preparation?.artifact
  const helperDegraded =
    profile.helperVersion === artifact?.version &&
    profile.helperStatus?.state === 'degraded' &&
    !preparation?.prepareArtifact
  return {
    ...binding.config,
    ...(artifact && !helperDegraded
      ? {
          helper: {
            profile,
            profileKey,
            artifact,
            prepareArtifact: preparation?.prepareArtifact,
            agentDir: dependencies.agentDir
          }
        }
      : { platform: profile.platform, capabilityProfile: profile })
  }
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
    const createHost = this.dependencies.createHost ?? ((input) => new SshHost(input))
    return {
      projectId: binding.projectId,
      cacheKey: binding.cacheKey,
      canonicalRoot: binding.canonicalRoot,
      host: createHost(sshHostConfig(binding, this.dependencies))
    }
  }
}

export const remoteWorkspaceHosts = new RemoteWorkspaceHostRegistry()
