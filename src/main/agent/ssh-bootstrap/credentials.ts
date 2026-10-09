import type { SshBootstrapTarget } from '../../../shared/sshBootstrapTypes'
import type { RemoteSshAuthGate } from '../wrappers/remote-ssh-auth-gate'
import { withSshAskpass, type SshAskpassFileSystem } from './askpass'
import { validateSshBootstrapTarget } from './preflight'

export interface SshBootstrapSecretCommandRequest {
  command: string
  args: string[]
  stdin?: string
  env?: Readonly<Record<string, string>>
}

export interface SshBootstrapSecretCommandResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

export type SshBootstrapSecretCommandRunner = (
  request: SshBootstrapSecretCommandRequest
) => Promise<SshBootstrapSecretCommandResult>

export interface SshPasswordAuthenticatorDependencies {
  runCommand: SshBootstrapSecretCommandRunner
  askpassFiles: SshAskpassFileSystem
  authGate: RemoteSshAuthGate
}

export type SshPasswordAuthenticationResult =
  | { status: 'ready' }
  | {
      status: 'rejected'
      errorCode:
        | 'authentication_failed'
        | 'password_attempts_exhausted'
        | 'keyboard_interactive_unsupported'
        | 'pubkey_auth_disabled'
        | 'unexpected'
    }

export interface SshPasswordAuthenticator {
  authenticate(
    target: SshBootstrapTarget,
    password: string
  ): Promise<SshPasswordAuthenticationResult>
}

function passwordAuthenticationArgs(input: SshBootstrapTarget): string[] {
  const target = validateSshBootstrapTarget(input)
  return [
    '-F',
    '/dev/null',
    '-v',
    '-o',
    'BatchMode=no',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'PreferredAuthentications=password',
    '-o',
    'KbdInteractiveAuthentication=no',
    '-o',
    'PubkeyAuthentication=no',
    '-o',
    'NumberOfPasswordPrompts=1',
    '-p',
    String(target.port),
    '-l',
    target.user,
    target.hostname,
    'true'
  ]
}

export function sshBootstrapAuthGateKey(target: SshBootstrapTarget): string {
  return JSON.stringify([target.alias, null, null, null])
}

export function isSshPasswordAuthenticationFailure(stderr: string): boolean {
  return /permission denied|authentication failed|no supported authentication methods/i.test(stderr)
}

function offeredAuthenticationMethods(stderr: string): string[] | null {
  const match = /authentications that can continue:\s*([^\r\n]+)/i.exec(stderr)
  return match
    ? match[1]
        .split(',')
        .map((method) => method.trim().toLowerCase())
        .filter(Boolean)
    : null
}

export function publicKeyAuthenticationIsDisabled(stderr: string): boolean {
  if (/pubkeyauthentication\s+no|public-?key authentication (?:is )?disabled/i.test(stderr)) {
    return true
  }
  const methods = offeredAuthenticationMethods(stderr)
  return Boolean(methods && methods.length > 0 && !methods.includes('publickey'))
}

export function requiresUnsupportedInteractiveAuthentication(stderr: string): boolean {
  if (
    /verification code|one[- ]time password|\botp\b|multi[- ]factor|two[- ]factor/i.test(stderr)
  ) {
    return true
  }
  const methods = offeredAuthenticationMethods(stderr)
  return Boolean(
    methods &&
    methods.length > 0 &&
    methods.every((method) => method === 'keyboard-interactive' || method === 'challenge-response')
  )
}

export function createSshPasswordAuthenticator(
  dependencies: SshPasswordAuthenticatorDependencies
): SshPasswordAuthenticator {
  const failuresByTarget = new Map<string, number>()
  return {
    async authenticate(target, password) {
      const checkedTarget = validateSshBootstrapTarget(target)
      const hostKey = sshBootstrapAuthGateKey(checkedTarget)
      const priorFailures = failuresByTarget.get(hostKey) ?? 0
      if (priorFailures >= 3) {
        return { status: 'rejected', errorCode: 'password_attempts_exhausted' }
      }
      const result = await withSshAskpass(password, dependencies.askpassFiles, ({ env }) =>
        dependencies.runCommand({
          command: 'ssh',
          args: passwordAuthenticationArgs(checkedTarget),
          env
        })
      )
      if (result.exitCode === 0) {
        if (publicKeyAuthenticationIsDisabled(result.stderr)) {
          return { status: 'rejected', errorCode: 'pubkey_auth_disabled' }
        }
        failuresByTarget.delete(hostKey)
        dependencies.authGate.clearSshBlock(hostKey)
        return { status: 'ready' }
      }
      if (!isSshPasswordAuthenticationFailure(result.stderr)) {
        return { status: 'rejected', errorCode: 'unexpected' }
      }
      dependencies.authGate.recordSshFailure(hostKey, 'authentication_failed')
      const failures = priorFailures + 1
      failuresByTarget.set(hostKey, failures)
      if (requiresUnsupportedInteractiveAuthentication(result.stderr)) {
        return { status: 'rejected', errorCode: 'keyboard_interactive_unsupported' }
      }
      if (publicKeyAuthenticationIsDisabled(result.stderr)) {
        return { status: 'rejected', errorCode: 'pubkey_auth_disabled' }
      }
      return {
        status: 'rejected',
        errorCode: failures >= 3 ? 'password_attempts_exhausted' : 'authentication_failed'
      }
    }
  }
}
