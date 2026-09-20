import { readFileSync } from 'node:fs'

import type { Project, ProjectRemoteConnection } from '../projects'
import { getPhiAgentDir } from '../runtime-paths'
import type { RemoteTarget } from './composition/remote-job'
import type { ConnectImpl } from './executor-remote'
import { readRemoteConnectionPassphrase } from './remote-credential-store'
import type { RemoteConnectionConfig } from './remote-ssh-session'

/** Everything `runs.ts` needs to dispatch a `slurm-controller` submit — resolved either explicitly by the caller, or (via `resolveProjectRemoteSubmitOptions`) from a project's saved remote config. */
export interface RemoteSubmitOptions {
  connection: RemoteConnectionConfig
  /** Remote root Phi run directories are created under, e.g. `/data/lab/.phi`. */
  remoteWorkspaceRoot: string
  connectImpl?: ConnectImpl
  pollIntervalMs?: number
}

/**
 * Turns a saved `ProjectRemoteConnection` into an actual `RemoteConnectionConfig`
 * — reads the key file off disk and, if the key needs one, the passphrase out
 * of the OS keychain. Throws with a specific, user-facing reason rather than
 * returning undefined: unlike "this project has no remote config at all"
 * (see `resolveProjectRemoteSubmitOptions`), a connection that exists but is
 * broken (deleted key file, keychain entry gone) is worth surfacing
 * distinctly rather than folding into a generic "not configured" message.
 */
export function resolveRemoteConnectionConfig(
  connection: ProjectRemoteConnection,
  agentDir = getPhiAgentDir()
): RemoteConnectionConfig {
  let privateKey: string
  try {
    privateKey = readFileSync(connection.privateKeyPath, 'utf-8')
  } catch {
    throw new Error(
      `无法读取连接 "${connection.label}" 的 SSH 私钥文件: ${connection.privateKeyPath}`
    )
  }

  let passphrase: string | undefined
  if (connection.hasPassphrase) {
    passphrase = readRemoteConnectionPassphrase(connection.id, agentDir)
    if (passphrase === undefined) {
      throw new Error(`未找到连接 "${connection.label}" 保存的密钥口令，请重新配置该连接`)
    }
  }

  return {
    host: connection.host,
    port: connection.port,
    username: connection.username,
    privateKey,
    passphrase
  }
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
    remoteWorkspaceRoot: project.remoteWorkspaceRoot
  }
}

/** A resolved remote for a composition run, plus the ids needed to reconnect to it after a restart. */
export interface ResolvedRemoteTarget {
  target: RemoteTarget
  connectionId: string
  projectId: string
}

/**
 * Resolves what a `wrapper_run` on a remote host connects to: the project's saved
 * connection (`connectionId`, else its default) with the connection's HPC settings.
 * Never throws: every way it can fail is a `reason` the agent can relay to the user,
 * including a saved connection that is broken (deleted key, keychain entry gone).
 */
export function resolveProjectRemoteTarget(
  project: Project | undefined,
  connectionId: string | undefined,
  agentDir = getPhiAgentDir()
): ResolvedRemoteTarget | { reason: string } {
  if (!project) {
    return { reason: '找不到这次运行所属的项目，无法确定要连接的远程主机。' }
  }
  if (!project.remoteWorkspaceRoot) {
    return {
      reason: `项目 "${project.name}" 还没有设置远程工作目录（remoteWorkspaceRoot）。请先在 Wrappers 页的远程设置里配置。`
    }
  }
  const wanted = connectionId ?? project.defaultRemoteConnectionId
  const connection = project.remoteConnections?.find((candidate) => candidate.id === wanted)
  if (!connection) {
    return {
      reason: `项目 "${project.name}" 没有可用的远程连接${wanted ? `（找不到 ${wanted}）` : '，也没有设置默认连接'}。请先在 Wrappers 页的远程设置里添加。`
    }
  }
  if (!connection.hpc) {
    // Without this, Nextflow would run every step on the login node itself: never the intent.
    return {
      reason: `连接 "${connection.label}" 还没有设置运行方式（用 Slurm 调度，还是直接在该主机上运行）。请先在 Wrappers 页的远程设置里编辑该连接并保存。`
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
      projectId: project.id
    }
  } catch (error) {
    return { reason: error instanceof Error ? error.message : String(error) }
  }
}
