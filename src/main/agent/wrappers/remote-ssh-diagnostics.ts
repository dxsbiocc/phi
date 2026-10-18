export type SshConnectionIssueCode =
  | 'host_key_changed'
  | 'host_key_unknown'
  | 'host_key_unverified'
  | 'authentication_failed'
  | 'identity_not_loaded'
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
    message: 'The SSH host key does not match the trusted record',
    suggestion:
      'Verify the new fingerprint with the server administrator, then update known_hosts using your existing SSH trust process.'
  },
  host_key_unknown: {
    message: 'The SSH host key is not trusted yet',
    suggestion:
      'Verify the server fingerprint in a terminal and establish trust first. Phi does not automatically accept new keys.'
  },
  host_key_unverified: {
    message: 'SSH host identity verification failed',
    suggestion:
      'Check known_hosts and the server fingerprint in a terminal. Confirm the identity before retrying.'
  },
  authentication_failed: {
    message: 'Non-interactive SSH authentication failed',
    suggestion:
      'Check the user and key in ~/.ssh/config, the SSH agent, and whether the server requires interactive MFA.'
  },
  identity_not_loaded: {
    message: 'The SSH private key is not loaded in ssh-agent',
    suggestion:
      'Reload this key in Settings. Phi stopped before connecting, so no authentication failure cooldown was triggered.'
  },
  proxy_unreachable: {
    message: 'The SSH jump host or proxy connection failed',
    suggestion:
      'Check ProxyJump or ProxyCommand in ~/.ssh/config and ensure the jump host is reachable.'
  },
  ssh_missing: {
    message: 'System OpenSSH is unavailable',
    suggestion: 'Ensure the system can run ssh and sftp, and check the application PATH.'
  },
  configuration_invalid: {
    message: 'The SSH configuration is unusable',
    suggestion: 'Check the syntax, host alias, and referenced files in your ~/.ssh/config.'
  },
  network_unreachable: {
    message: 'The SSH server is unreachable',
    suggestion: 'Check the network, server address, port, and firewall settings.'
  },
  timeout: {
    message: 'SSH connection timed out',
    suggestion: 'Check the network and server status. If using a jump host, ensure it is reachable.'
  },
  unknown: {
    message: 'SSH connection failed',
    suggestion:
      'Use the same host alias in a terminal to check ~/.ssh/config and the connection status.'
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
  readonly diagnosis: Readonly<SshConnectionDiagnosis>

  constructor(diagnosis: SshConnectionDiagnosis) {
    super(`${diagnosis.message}. ${diagnosis.suggestion}`)
    this.name = 'RemoteSshConnectionError'
    this.code = diagnosis.code
    this.diagnosis = Object.freeze({ ...diagnosis })
  }
}
