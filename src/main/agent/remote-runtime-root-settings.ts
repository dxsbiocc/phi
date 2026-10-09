import type { Project, ProjectRemoteConnection } from './projects'
import { getProject, updateProjectRemoteConnection } from './projects'
import {
  getRemoteHostProfile,
  listAvailableRemoteHostProfiles,
  type RemoteHostProfile
} from './remote-hosts'
import { readHostRuntimeRoot, saveHostRuntimeRoot } from './remote-runtime-root-store'
import { getPhiAgentDir } from './runtime-paths'
import {
  invalidateCapabilityProfile,
  invalidateCapabilityProfilesForHost
} from './workspace-host/capability-profile-store'

export interface RemoteHostProfileWithRuntimeRoot extends RemoteHostProfile {
  runtimeRoot?: string
}

export function remoteHostProfileWithRuntimeRoot(
  profile: RemoteHostProfile,
  agentDir = getPhiAgentDir()
): RemoteHostProfileWithRuntimeRoot {
  const runtimeRoot = readHostRuntimeRoot(profile.id, agentDir)
  return { ...profile, ...(runtimeRoot ? { runtimeRoot } : {}) }
}

export function listRemoteHostsWithRuntimeRoots(
  agentDir = getPhiAgentDir(),
  sshConfigPath?: string
): RemoteHostProfileWithRuntimeRoot[] {
  return listAvailableRemoteHostProfiles(agentDir, sshConfigPath).map((profile) =>
    remoteHostProfileWithRuntimeRoot(profile, agentDir)
  )
}

export function saveRemoteRuntimeRootSetting(
  hostProfileId: string,
  runtimeRoot: string | null | undefined,
  agentDir = getPhiAgentDir(),
  sshConfigPath?: string
): RemoteHostProfileWithRuntimeRoot {
  const profile = getRemoteHostProfile(hostProfileId, agentDir, sshConfigPath)
  if (!profile) throw new Error('SSH 服务器档案不存在')
  const previous = readHostRuntimeRoot(hostProfileId, agentDir)
  saveHostRuntimeRoot(hostProfileId, runtimeRoot, agentDir)
  const current = readHostRuntimeRoot(hostProfileId, agentDir)
  if (previous !== current) invalidateCapabilityProfilesForHost(profile.hostAlias, agentDir)
  return remoteHostProfileWithRuntimeRoot(profile, agentDir)
}

export function clearRemoteRuntimeRootSetting(
  hostProfileId: string,
  agentDir = getPhiAgentDir()
): void {
  const profile = getRemoteHostProfile(hostProfileId, agentDir)
  const previous = readHostRuntimeRoot(hostProfileId, agentDir)
  if (!profile || previous === undefined) return
  saveHostRuntimeRoot(hostProfileId, undefined, agentDir)
  invalidateCapabilityProfilesForHost(profile.hostAlias, agentDir)
}

function projectProfileRoot(project: Project | undefined): string | undefined {
  if (!project) return undefined
  return project.location.kind === 'ssh'
    ? project.location.canonicalRoot
    : project.remoteWorkspaceRoot
}

function invalidateConnectionProfile(
  project: Project | undefined,
  connection: ProjectRemoteConnection | undefined,
  agentDir: string
): void {
  const projectRoot = projectProfileRoot(project)
  if (!projectRoot || !connection) return
  const profile = getRemoteHostProfile(connection.hostProfileId, agentDir)
  if (!profile) return
  invalidateCapabilityProfile({ hostAlias: profile.hostAlias, projectRoot }, agentDir)
}

export function updateProjectRemoteConnectionRuntimeAware(
  id: string,
  connectionId: string,
  patch: ProjectRemoteConnection | null,
  agentDir = getPhiAgentDir()
): Project {
  const before = getProject(id)
  const oldConnection = before?.remoteConnections?.find((item) => item.id === connectionId)
  const updated = updateProjectRemoteConnection(id, connectionId, patch)
  const newConnection = updated.remoteConnections?.find((item) => item.id === connectionId)
  if (oldConnection?.runtimeRoot !== newConnection?.runtimeRoot) {
    invalidateConnectionProfile(before, oldConnection, agentDir)
    invalidateConnectionProfile(updated, newConnection, agentDir)
  }
  return updated
}
