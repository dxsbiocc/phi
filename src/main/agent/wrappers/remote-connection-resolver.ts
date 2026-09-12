import { readFileSync } from 'node:fs'

import type { Project, ProjectRemoteConnection } from '../projects'
import { getPhiAgentDir } from '../runtime-paths'
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
