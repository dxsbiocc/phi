export type SshConnectionIssueCode =
  | 'host_key_changed'
  | 'host_key_unknown'
  | 'host_key_unverified'
  | 'authentication_failed'
  | 'proxy_unreachable'
  | 'ssh_missing'
  | 'configuration_invalid'
  | 'network_unreachable'
  | 'timeout'
  | 'unknown'

export interface SshConnectionDiagnosis {
  code: SshConnectionIssueCode
  message: string
  suggestion: string
}

const DIAGNOSES: Record<SshConnectionIssueCode, Omit<SshConnectionDiagnosis, 'code'>> = {
  host_key_changed: {
    message: 'SSH 主机密钥与已信任的记录不一致',
    suggestion: '先向服务器管理员核对新指纹，再按你现有的 SSH 信任流程更新 known_hosts。'
  },
  host_key_unknown: {
    message: 'SSH 主机密钥尚未被信任',
    suggestion: '先在终端核对服务器指纹并完成首次信任；Phi 不会自动接受新密钥。'
  },
  host_key_unverified: {
    message: 'SSH 主机身份校验失败',
    suggestion: '在终端检查 known_hosts 和服务器指纹，确认身份后再重试。'
  },
  authentication_failed: {
    message: 'SSH 非交互认证失败',
    suggestion: '检查 ~/.ssh/config 的用户和密钥、SSH agent，以及服务器是否要求交互式 MFA。'
  },
  proxy_unreachable: {
    message: 'SSH 跳板机或代理连接失败',
    suggestion: '检查 ~/.ssh/config 中的 ProxyJump 或 ProxyCommand，并确认跳板机可达。'
  },
  ssh_missing: {
    message: '系统 OpenSSH 程序不可用',
    suggestion: '确认系统可运行 ssh 和 sftp，并检查应用的 PATH。'
  },
  configuration_invalid: {
    message: 'SSH 配置无法使用',
    suggestion: '检查你自己的 ~/.ssh/config 语法、主机别名和引用的文件。'
  },
  network_unreachable: {
    message: 'SSH 服务器无法连接',
    suggestion: '检查网络、服务器地址、端口及防火墙设置。'
  },
  timeout: {
    message: 'SSH 连接超时',
    suggestion: '检查网络和服务器状态；若使用跳板机，也请确认跳板机可达。'
  },
  unknown: {
    message: 'SSH 连接失败',
    suggestion: '在终端使用同一主机别名检查 ~/.ssh/config 与连接状态。'
  }
}

export function sshConnectionDiagnosis(code: SshConnectionIssueCode): SshConnectionDiagnosis {
  return { code, ...DIAGNOSES[code] }
}

/** Classify OpenSSH diagnostics without returning stderr, file paths, or credentials to the UI. */
export function diagnoseSshConnectionFailure(input: unknown): SshConnectionDiagnosis {
  const error = input instanceof Error ? input : null
  const code = error && 'code' in error ? error.code : undefined
  const output = (error?.message ?? String(input ?? '')).toLowerCase()
  let issue: SshConnectionIssueCode

  if (code === 'ENOENT' || /spawn (ssh|sftp) enoent/.test(output)) {
    issue = 'ssh_missing'
  } else if (
    /remote host identification has changed|offending .* key in|possible dns spoofing/.test(output)
  ) {
    issue = 'host_key_changed'
  } else if (
    /no .* host key is known|authenticity of host .*can't be established|host key is not cached/.test(
      output
    )
  ) {
    issue = 'host_key_unknown'
  } else if (/host key verification failed|host key .*verification failed/.test(output)) {
    issue = 'host_key_unverified'
  } else if (
    /bad configuration option|terminating, .* bad configuration options|cannot open user config file|unable to open config file/.test(
      output
    )
  ) {
    issue = 'configuration_invalid'
  } else if (
    /stdio forwarding failed|proxycommand|proxyjump|connection closed by unknown port 65535/.test(
      output
    )
  ) {
    issue = 'proxy_unreachable'
  } else if (
    /permission denied \(|too many authentication failures|no supported authentication methods|authentication failed|agent refused operation/.test(
      output
    )
  ) {
    issue = 'authentication_failed'
  } else if (/timed out|timeout/.test(output)) {
    issue = 'timeout'
  } else if (
    /could not resolve hostname|connection refused|network is unreachable|no route to host|connection reset/.test(
      output
    )
  ) {
    issue = 'network_unreachable'
  } else {
    issue = 'unknown'
  }

  return sshConnectionDiagnosis(issue)
}

export class RemoteSshConnectionError extends Error {
  readonly code: SshConnectionIssueCode

  constructor(diagnosis: SshConnectionDiagnosis) {
    super(`${diagnosis.message}。${diagnosis.suggestion}`)
    this.name = 'RemoteSshConnectionError'
    this.code = diagnosis.code
  }
}
