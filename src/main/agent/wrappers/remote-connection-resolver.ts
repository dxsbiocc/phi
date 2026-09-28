import type { Project, ProjectRemoteConnection } from '../projects'
import type { RemoteHpcSettings } from '../../../shared/wrapperRemoteTypes'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from '../remote-hosts'
import { getPhiAgentDir } from '../runtime-paths'
import type { RemoteTarget } from './composition/remote-job'
import type { ConnectImpl } from './executor-remote'
import type { RemoteConnectionConfig } from './remote-ssh-session'

/** Everything `runs.ts` needs to dispatch a `slurm-controller` submit — resolved either explicitly by the caller, or (via `resolveProjectRemoteSubmitOptions`) from a project's saved remote config. */
export interface RemoteSubmitOptions {
  connection: RemoteConnectionConfig
  /** Remote root Phi run directories are created under, e.g. `/data/lab/.phi`. */
  remoteWorkspaceRoot: string
  hpc?: RemoteHpcSettings
  connectImpl?: ConnectImpl
  pollIntervalMs?: number
}

/** Resolve a project binding to the OpenSSH host alias owned by Phi. */
export function resolveRemoteConnectionConfig(
  connection: ProjectRemoteConnection,
  agentDir = getPhiAgentDir()
): RemoteConnectionConfig {
  const profile = getRemoteHostProfile(connection.hostProfileId, agentDir)
  if (!profile) throw new Error(`连接 "${connection.label}" 的 SSH 服务器档案不可用，请重新配置`)
  return remoteConnectionConfigForProfile(profile)
}

/**
 * Resolves a project's default remote target into `RemoteSubmitOptions`, or
 * `undefined` when the project simply has no remote config (no
 * `remoteWorkspaceRoot`, or no `remoteConnections` entry matching
 * `defaultRemoteConnectionId`) — that's the "not configured" case `runs.ts`
 * falls back to its generic message for. A config that DOES exist but is
 * broken still throws, via `resolveRemoteConnectionConfig`.
 */
export function resolveProjectRemoteSubmitOptions(
  project: Project,
  agentDir = getPhiAgentDir()
): RemoteSubmitOptions | undefined {
  if (!project.remoteWorkspaceRoot) return undefined
  const connection = project.remoteConnections?.find(
    (candidate) => candidate.id === project.defaultRemoteConnectionId
  )
  if (!connection) return undefined

  return {
    connection: resolveRemoteConnectionConfig(connection, agentDir),
    remoteWorkspaceRoot: project.remoteWorkspaceRoot,
    hpc: connection.hpc
  }
}

/** A resolved remote for a composition run, plus the ids needed to reconnect to it after a restart. */
export interface ResolvedRemoteTarget {
  target: RemoteTarget
  connectionId: string
  projectId: string
  hostProfileId: string
}

/**
 * Resolves what a `wrapper_run` on a remote host connects to: the project's saved
 * connection (`connectionId`, else its default) with the connection's HPC settings.
 * Never throws: every way it can fail is a `reason` the agent can relay to the user,
 * including a saved connection whose host profile has been removed.
 */
export function resolveProjectRemoteTarget(
  project: Project | undefined,
  connectionId: string | undefined,
  agentDir = getPhiAgentDir()
): ResolvedRemoteTarget | { reason: string } {
  if (!project) {
    return { reason: '找不到这次运行所属的项目，无法确定要连接的远程主机。' }
  }
  if (project.location.kind === 'ssh') {
    const hostProfile = getRemoteHostProfile(project.location.hostProfileId, agentDir)
    if (!hostProfile) {
      return { reason: '远程项目绑定的 SSH 服务器档案不可用，请先恢复服务器配置。' }
    }
    const wanted = connectionId ?? project.defaultRemoteConnectionId
    const configured = project.remoteConnections?.find((candidate) => candidate.id === wanted)
    if (wanted && wanted !== project.location.hostProfileId && !configured) {
      return { reason: `远程项目的运行配置 ${wanted} 不存在，请重新选择。` }
    }
    if (configured && configured.hostProfileId !== project.location.hostProfileId) {
      return { reason: '远程项目的 Wrapper 运行配置指向另一台服务器，请改用本项目绑定的服务器。' }
    }
    if (configured && !configured.hpc) {
      return { reason: `连接 "${configured.label}" 尚未设置 Wrapper 运行方式。` }
    }
    return {
      target: {
        connection: remoteConnectionConfigForProfile(hostProfile),
        workspaceRoot: project.location.canonicalRoot,
        hpc: configured?.hpc ?? { scheduler: 'local' }
      },
      connectionId: configured?.id ?? project.location.hostProfileId,
      projectId: project.id,
      hostProfileId: project.location.hostProfileId
    }
  }
  if (!project.remoteWorkspaceRoot) {
    return {
      reason: `项目 "${project.name}" 还没有设置服务器工作目录。请在该项目的 Wrapper 页面选择“设置远程计算”。`
    }
  }
  const wanted = connectionId ?? project.defaultRemoteConnectionId
  const connection = project.remoteConnections?.find((candidate) => candidate.id === wanted)
  if (!connection) {
    return {
      reason: `项目 "${project.name}" 没有可用的远程计算目标${wanted ? `（找不到 ${wanted}）` : ''}。请在该项目的 Wrapper 页面选择“设置远程计算”。`
    }
  }
  if (!connection.hpc) {
    // Without this, Nextflow would run every step on the login node itself: never the intent.
    return {
      reason: `计算目标 "${connection.label}" 还没有设置运行方式。请在该项目的 Wrapper 页面选择“设置远程计算”。`
    }
  }
  try {
    return {
      target: {
        connection: resolveRemoteConnectionConfig(connection, agentDir),
        workspaceRoot: project.remoteWorkspaceRoot,
        hpc: connection.hpc
      },
      connectionId: connection.id,
      projectId: project.id,
      hostProfileId: connection.hostProfileId
    }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) }
  }
}
