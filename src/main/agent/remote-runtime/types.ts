import type { CommandResult, WorkspaceHost } from '../workspace-host/types'

export interface RemoteRuntimeInputOptions {
  signal?: AbortSignal
  timeoutMs: number
  maxOutputBytes: number
}

export type RemoteRuntimeInputExec = (
  script: string,
  options: RemoteRuntimeInputOptions
) => Promise<CommandResult>

export interface RemoteRuntimeWorkspace {
  projectHost: WorkspaceHost
  runtimeHost: WorkspaceHost
  /** Canonical absolute POSIX project directory on the server. */
  projectRoot: string
  /** Canonical absolute POSIX Phi runtime root on the server. */
  runtimeRoot: string
  /** Optional server-level micromamba executable override. */
  micromambaPath?: string
  /** One direct SSH command whose script body is streamed over stdin. */
  execWithInput: RemoteRuntimeInputExec
  close?(): Promise<void>
}

export type OpenRemoteRuntimeWorkspace = (
  runtimeSessionId: string,
  signal?: AbortSignal
) => Promise<RemoteRuntimeWorkspace>

export interface RemoteEnvironmentHandle {
  ref: string
  envId: string
  name: string
  prefix: string
  packages: string[]
  channels: string[]
}

export interface RemoteSkillSource {
  name: string
  filePath: string
  dir: string
  insidePlugin: boolean
  pluginId?: string
  toolPrefix?: string
  remoteUnsupportedReason?: string
}
