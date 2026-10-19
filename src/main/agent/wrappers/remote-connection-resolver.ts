import type { Project, ProjectRemoteConnection } from '../projects'
import type { RemoteHpcSettings } from '../../../shared/wrapperRemoteTypes'
import { getRemoteHostProfile, remoteConnectionConfigForProfile } from '../remote-hosts'
import { readHostRemoteEnvironmentPaths } from '../remote-environment-store'
import { getPhiAgentDir } from '../runtime-paths'
import type { RemoteTarget } from './composition/remote-job'
import type { ConnectImpl } from './executor-remote'
import type { RemoteConnectionConfig } from './remote-ssh-session'

import { errorMessage } from '../../../shared/errorCodes'
/** Everything `runs.ts` needs to dispatch a `slurm-controller` submit — resolved either explicitly by the caller, or (via `resolveProjectRemoteSubmitOptions`) from a project's saved remote config. */
export interface RemoteSubmitOptions {
  connection: RemoteConnectionConfig
  /** Remote root Phi run directories are created under, e.g. `/data/lab/.phi`. */
  remoteWorkspaceRoot: string
  hpc?: RemoteHpcSettings
  connectImpl?: ConnectImpl
  pollIntervalMs?: number
}

function withHostEnvironmentPaths(
  hpc: RemoteHpcSettings | undefined,
  hostProfileId: string,
  agentDir: string
): RemoteHpcSettings | undefined {
  if (!hpc) return undefined
  const paths = readHostRemoteEnvironmentPaths(hostProfileId, agentDir)
  return {
    ...hpc,
    ...(!hpc.nextflowBin && paths.nextflow ? { nextflowBin: paths.nextflow } : {}),
    ...(hpc.runtime === 'docker' && paths.docker ? { containerRuntimeBin: paths.docker } : {})
  }
}

/** Resolve a project binding to the OpenSSH host alias owned by Phi. */
export function resolveRemoteConnectionConfig(
  connection: ProjectRemoteConnection,
  agentDir = getPhiAgentDir()
): RemoteConnectionConfig {
  const profile = getRemoteHostProfile(connection.hostProfileId, agentDir)
  if (!profile)
    throw new Error(
      `The SSH server profile for connection "${connection.label}" is unavailable. Configure it again`
    )
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
    hpc: withHostEnvironmentPaths(connection.hpc, connection.hostProfileId, agentDir)
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
    return {
      reason:
        'The project for this run could not be found, so the remote host cannot be determined.'
    }
  }
  if (project.location.kind === 'ssh') {
    const hostProfile = getRemoteHostProfile(project.location.hostProfileId, agentDir)
    if (!hostProfile) {
      return {
        reason:
          'The SSH server profile bound to this remote project is unavailable. Restore its configuration first.'
      }
    }
    const wanted = connectionId ?? project.defaultRemoteConnectionId
    const configured = project.remoteConnections?.find((candidate) => candidate.id === wanted)
    if (wanted && wanted !== project.location.hostProfileId && !configured) {
      return {
        reason: `Execution configuration ${wanted} for this remote project does not exist. Select it again.`
      }
    }
    if (configured && configured.hostProfileId !== project.location.hostProfileId) {
      return {
        reason:
          'The Wrapper execution configuration points to another server. Use the server bound to this project.'
      }
    }
    if (configured && !configured.hpc) {
      return {
        reason: `Connection "${configured.label}" has no Wrapper execution mode configured.`
      }
    }
    return {
      target: {
        connection: remoteConnectionConfigForProfile(hostProfile),
        workspaceRoot: project.location.canonicalRoot,
        agentDir,
        hpc: withHostEnvironmentPaths(
          configured?.hpc ?? { scheduler: 'local' },
          project.location.hostProfileId,
          agentDir
        )
      },
      connectionId: configured?.id ?? project.location.hostProfileId,
      projectId: project.id,
      hostProfileId: project.location.hostProfileId
    }
  }
  if (!project.remoteWorkspaceRoot) {
    return {
      reason: `Project "${project.name}" has no server working directory. Select "Configure remote execution" on its Wrapper page.`
    }
  }
  const wanted = connectionId ?? project.defaultRemoteConnectionId
  const connection = project.remoteConnections?.find((candidate) => candidate.id === wanted)
  if (!connection) {
    return {
      reason: `Project "${project.name}" has no available remote execution target${wanted ? ` (${wanted} not found)` : ''}. Select "Configure remote execution" on its Wrapper page.`
    }
  }
  if (!connection.hpc) {
    // Without this, Nextflow would run every step on the login node itself: never the intent.
    return {
      reason: `Execution target "${connection.label}" has no execution mode configured. Select "Configure remote execution" on this project's Wrapper page.`
    }
  }
  try {
    return {
      target: {
        connection: resolveRemoteConnectionConfig(connection, agentDir),
        workspaceRoot: project.remoteWorkspaceRoot,
        agentDir,
        hpc: withHostEnvironmentPaths(connection.hpc, connection.hostProfileId, agentDir)
      },
      connectionId: connection.id,
      projectId: project.id,
      hostProfileId: connection.hostProfileId
    }
  } catch (error) {
    return { reason: errorMessage(error) }
  }
}
