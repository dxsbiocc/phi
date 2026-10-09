import type { SshBootstrapTarget } from '../../../shared/sshBootstrapTypes'
import { withSshAskpass, type SshAskpassFileSystem } from './askpass'
import type { SshBootstrapSecretCommandRunner } from './credentials'
import { validateSshBootstrapTarget } from './preflight'

export interface SshPublicKeyInstallInput {
  target: SshBootstrapTarget
  password: string
  publicKey: string
}

export interface SshPublicKeyInstallDependencies {
  runCommand: SshBootstrapSecretCommandRunner
  askpassFiles: SshAskpassFileSystem
}

export type SshPublicKeyInstallResult =
  { status: 'ready' } | { status: 'rejected'; errorCode: 'authentication_failed' | 'unexpected' }

export const INSTALL_AUTHORIZED_KEY_COMMAND = [
  'umask 077',
  'mkdir -p "$HOME/.ssh" || exit 70',
  'chmod 700 "$HOME/.ssh" || exit 71',
  'touch "$HOME/.ssh/authorized_keys" || exit 72',
  'chmod 600 "$HOME/.ssh/authorized_keys" || exit 73',
  'IFS= read -r phi_key || exit 74',
  'grep -qxF -- "$phi_key" "$HOME/.ssh/authorized_keys" || printf \'%s\\n\' "$phi_key" >> "$HOME/.ssh/authorized_keys"'
].join('; ')

export function validateSshPublicKey(input: string): string | null {
  const publicKey = input.trim()
  return /^ssh-ed25519\s+\S+(?:\s+.*)?$/.test(publicKey) && !/[\r\n\0]/.test(publicKey)
    ? publicKey
    : null
}

function installArgs(input: SshBootstrapTarget): string[] {
  const target = validateSshBootstrapTarget(input)
  return [
    '-F',
    '/dev/null',
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
    INSTALL_AUTHORIZED_KEY_COMMAND
  ]
}

export async function installSshPublicKeyWithPassword(
  input: SshPublicKeyInstallInput,
  dependencies: SshPublicKeyInstallDependencies
): Promise<SshPublicKeyInstallResult> {
  const target = validateSshBootstrapTarget(input.target)
  const publicKey = validateSshPublicKey(input.publicKey)
  if (!publicKey) {
    return { status: 'rejected', errorCode: 'unexpected' }
  }
  const result = await withSshAskpass(input.password, dependencies.askpassFiles, ({ env }) =>
    dependencies.runCommand({
      command: 'ssh',
      args: installArgs(target),
      stdin: `${publicKey}\n`,
      env
    })
  )
  if (result.exitCode === 0) return { status: 'ready' }
  return {
    status: 'rejected',
    errorCode: /permission denied|authentication failed/i.test(result.stderr)
      ? 'authentication_failed'
      : 'unexpected'
  }
}
