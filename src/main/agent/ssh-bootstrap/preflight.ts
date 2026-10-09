import type {
  SshBootstrapAgentState,
  SshBootstrapPublicErrorCode,
  SshBootstrapTarget
} from '../../../shared/sshBootstrapTypes'
import {
  validateHostAlias,
  validateRemoteConnectionOverrides
} from '../wrappers/remote-ssh-session'

export interface SshBootstrapCommandRequest {
  command: string
  args: string[]
  stdin?: string
}

export interface SshBootstrapCommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type SshBootstrapCommandRunner = (
  request: SshBootstrapCommandRequest
) => Promise<SshBootstrapCommandResult>

export interface SshBootstrapPreflightDependencies {
  platform: string
  environment: Readonly<Record<string, string | undefined>>
  runCommand: SshBootstrapCommandRunner
}

export type SshBootstrapPreflightResult =
  | {
      status: 'ready'
      platform: 'darwin' | 'linux'
      openSshVersion: string
      agentState: SshBootstrapAgentState
    }
  | {
      status: 'rejected'
      errorCode: Extract<
        SshBootstrapPublicErrorCode,
        'openssh_too_old' | 'proxy_unsupported' | 'unsupported_platform' | 'unexpected'
      >
    }

const MINIMUM_OPENSSH_VERSION = { major: 8, minor: 4 } as const

function parseOpenSshVersion(
  output: string
): { major: number; minor: number; display: string } | null {
  const match = /OpenSSH_(\d+)\.(\d+)(?:p\d+)?/i.exec(output)
  if (!match) return null
  return {
    major: Number.parseInt(match[1], 10),
    minor: Number.parseInt(match[2], 10),
    display: `${match[1]}.${match[2]}`
  }
}

function supportsPasswordAskpass(version: { major: number; minor: number }): boolean {
  return (
    version.major > MINIMUM_OPENSSH_VERSION.major ||
    (version.major === MINIMUM_OPENSSH_VERSION.major &&
      version.minor >= MINIMUM_OPENSSH_VERSION.minor)
  )
}

function usesUnsupportedProxy(config: string): boolean {
  return config.split(/\r?\n/).some((line) => {
    const match = /^\s*(proxyjump|proxycommand)\s+(.+?)\s*$/i.exec(line)
    return Boolean(match && match[2].toLowerCase() !== 'none')
  })
}

export function validateSshBootstrapTarget(target: SshBootstrapTarget): SshBootstrapTarget {
  const alias = validateHostAlias(target.alias.trim())
  const hostname = target.hostname.trim()
  if (!hostname || hostname.length > 255 || /[\s#\0]/.test(hostname) || hostname.startsWith('-')) {
    throw new Error('服务器地址必须是单个主机名或 IP 地址')
  }
  const overrides = validateRemoteConnectionOverrides({ user: target.user, port: target.port })
  if (!overrides.user || overrides.port === undefined) {
    throw new Error('SSH 用户名和端口不能为空')
  }
  return { alias, hostname, user: overrides.user, port: overrides.port }
}

export async function runSshBootstrapPreflight(
  input: SshBootstrapTarget,
  dependencies: SshBootstrapPreflightDependencies
): Promise<SshBootstrapPreflightResult> {
  const target = validateSshBootstrapTarget(input)

  if (dependencies.platform !== 'darwin' && dependencies.platform !== 'linux') {
    return { status: 'rejected', errorCode: 'unsupported_platform' }
  }

  const versionResult = await dependencies.runCommand({ command: 'ssh', args: ['-V'] })
  const version = parseOpenSshVersion(`${versionResult.stdout}\n${versionResult.stderr}`)
  if (!version || versionResult.exitCode !== 0) {
    return { status: 'rejected', errorCode: 'unexpected' }
  }
  if (!supportsPasswordAskpass(version)) {
    return { status: 'rejected', errorCode: 'openssh_too_old' }
  }

  const configResult = await dependencies.runCommand({
    command: 'ssh',
    args: ['-G', '-p', String(target.port), '-l', target.user, target.alias]
  })
  if (configResult.exitCode !== 0) {
    return { status: 'rejected', errorCode: 'unexpected' }
  }
  if (usesUnsupportedProxy(configResult.stdout)) {
    return { status: 'rejected', errorCode: 'proxy_unsupported' }
  }

  return {
    status: 'ready',
    platform: dependencies.platform,
    openSshVersion: version.display,
    agentState:
      dependencies.platform === 'linux' && !dependencies.environment.SSH_AUTH_SOCK
        ? 'missing-linux'
        : 'ready'
  }
}
