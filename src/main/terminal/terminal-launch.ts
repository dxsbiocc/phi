import type { RemoteConnectionConfig } from '../agent/wrappers/remote-ssh-session'
import { shellQuote, validateHostAlias } from '../agent/wrappers/remote-ssh-session'
import { buildSshConnectionArgs } from '../agent/workspace-host/ssh-port-forward'

export interface LocalTerminalWorkspaceLaunch {
  kind: 'local'
  localCwd: string
}

export interface SshTerminalWorkspaceLaunch {
  kind: 'ssh'
  application: string
  args: string[]
  localCwd: string
  hostLabel: string
}

export type TerminalWorkspaceLaunch = LocalTerminalWorkspaceLaunch | SshTerminalWorkspaceLaunch

const SSH_TERMINAL_OPTIONS = [
  '-o',
  'BatchMode=yes',
  '-o',
  'StrictHostKeyChecking=yes',
  '-o',
  'ForwardAgent=no',
  '-o',
  'ClearAllForwardings=yes',
  '-o',
  'ServerAliveInterval=15',
  '-o',
  'ServerAliveCountMax=3'
] as const

const REMOTE_DIRECTORY_ERROR = '远程项目目录不存在或无法进入，已停止启动终端。'

export function buildRemoteTerminalCommand(remoteRoot: string): string {
  if (!remoteRoot.startsWith('/') || remoteRoot.includes('\0')) {
    throw new Error('远程项目根目录无效')
  }
  return [
    `cd -- ${shellQuote(remoteRoot)} || { printf '%s\\n' ${shellQuote(REMOTE_DIRECTORY_ERROR)} >&2; exit 72; }`,
    'exec "${SHELL:-/bin/sh}" -il'
  ].join('\n')
}

export function buildSshTerminalLaunch(input: {
  connection: RemoteConnectionConfig
  remoteRoot: string
  localCwd: string
  hostLabel: string
  sshExecutable?: string
}): SshTerminalWorkspaceLaunch {
  const application = input.sshExecutable || 'ssh'
  if (application !== 'ssh' && !application.startsWith('/')) {
    throw new Error('SSH 可执行文件必须是 ssh 或绝对路径')
  }
  return {
    kind: 'ssh',
    application,
    args: [
      '-tt',
      ...buildSshConnectionArgs(input.connection),
      ...SSH_TERMINAL_OPTIONS,
      validateHostAlias(input.connection.host),
      buildRemoteTerminalCommand(input.remoteRoot)
    ],
    localCwd: input.localCwd,
    hostLabel: input.hostLabel
  }
}
