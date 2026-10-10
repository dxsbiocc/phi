import type { Project, ProjectRemoteConnection } from './projects'
import { getProject, updateProjectRemoteConnection } from './projects'
import {
  normalizeRemoteEnvironmentToolPaths,
  type RemoteEnvironmentSettingInput,
  type RemoteEnvironmentToolPaths
} from '../../shared/remoteEnvironmentTypes'
import {
  getRemoteHostProfile,
  listAvailableRemoteHostProfiles,
  type RemoteHostProfile
} from './remote-hosts'
import {
  readHostRemoteMicromambaMirrorPrefix,
  saveHostRemoteMicromambaMirrorPrefix
} from './remote-micromamba-mirror-store'
import { readHostRuntimeRoot, saveHostRuntimeRoot } from './remote-runtime-root-store'
import { normalizeRemoteRuntimeRoot } from './remote-runtime-root'
import {
  readHostRemoteEnvironmentPaths,
  saveHostRemoteEnvironmentPaths
} from './remote-environment-store'
import { getPhiAgentDir } from './runtime-paths'
import {
  invalidateCapabilityProfile,
  invalidateCapabilityProfilesForHost
} from './workspace-host/capability-profile-store'

export interface RemoteHostProfileWithRuntimeRoot extends RemoteHostProfile {
  runtimeRoot?: string
  downloadMirrorPrefix?: string
  toolPaths?: RemoteEnvironmentToolPaths
}

export function remoteHostProfileWithRuntimeRoot(
  profile: RemoteHostProfile,
  agentDir = getPhiAgentDir()
): RemoteHostProfileWithRuntimeRoot {
  const runtimeRoot = readHostRuntimeRoot(profile.id, agentDir)
  const downloadMirrorPrefix = readHostRemoteMicromambaMirrorPrefix(profile.id, agentDir)
  const toolPaths = readHostRemoteEnvironmentPaths(profile.id, agentDir)
  return {
    ...profile,
    ...(runtimeRoot ? { runtimeRoot } : {}),
    ...(downloadMirrorPrefix ? { downloadMirrorPrefix } : {}),
    ...(Object.keys(toolPaths).length ? { toolPaths } : {})
  }
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

export function saveRemoteEnvironmentSetting(
  hostProfileId: string,
  input: RemoteEnvironmentSettingInput,
  agentDir = getPhiAgentDir(),
  sshConfigPath?: string
): RemoteHostProfileWithRuntimeRoot {
  const profile = getRemoteHostProfile(hostProfileId, agentDir, sshConfigPath)
  if (!profile) throw new Error('SSH 服务器档案不存在')
  const previousRoot = readHostRuntimeRoot(hostProfileId, agentDir)
  const previousPaths = readHostRemoteEnvironmentPaths(hostProfileId, agentDir)
  const runtimeRoot = input.runtimeRoot?.trim()
  const normalizedRoot = runtimeRoot ? normalizeRemoteRuntimeRoot(runtimeRoot) : undefined
  const normalizedPaths = normalizeRemoteEnvironmentToolPaths(input.toolPaths)
  saveHostRuntimeRoot(hostProfileId, normalizedRoot, agentDir)
  saveHostRemoteEnvironmentPaths(hostProfileId, normalizedPaths, agentDir)
  const currentRoot = readHostRuntimeRoot(hostProfileId, agentDir)
  const currentPaths = readHostRemoteEnvironmentPaths(hostProfileId, agentDir)
  if (
    previousRoot !== currentRoot ||
    JSON.stringify(previousPaths) !== JSON.stringify(currentPaths)
  ) {
    invalidateCapabilityProfilesForHost(profile.hostAlias, agentDir)
  }
  return remoteHostProfileWithRuntimeRoot(profile, agentDir)
}

export function saveRemoteMicromambaMirrorSetting(
  hostProfileId: string,
  downloadMirrorPrefix: string | null | undefined,
  agentDir = getPhiAgentDir(),
  sshConfigPath?: string
): RemoteHostProfileWithRuntimeRoot {
  const profile = getRemoteHostProfile(hostProfileId, agentDir, sshConfigPath)
  if (!profile) throw new Error('SSH 服务器档案不存在')
  const previous = readHostRemoteMicromambaMirrorPrefix(hostProfileId, agentDir)
  saveHostRemoteMicromambaMirrorPrefix(hostProfileId, downloadMirrorPrefix, agentDir)
  const current = readHostRemoteMicromambaMirrorPrefix(hostProfileId, agentDir)
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

export function clearRemoteEnvironmentSetting(
  hostProfileId: string,
  agentDir = getPhiAgentDir()
): void {
  saveHostRemoteEnvironmentPaths(hostProfileId, undefined, agentDir)
}

export function clearRemoteMicromambaMirrorSetting(
  hostProfileId: string,
  agentDir = getPhiAgentDir()
): void {
  const profile = getRemoteHostProfile(hostProfileId, agentDir)
  const previous = readHostRemoteMicromambaMirrorPrefix(hostProfileId, agentDir)
  if (!profile || previous === undefined) return
  saveHostRemoteMicromambaMirrorPrefix(hostProfileId, undefined, agentDir)
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
