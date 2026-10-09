import { execFile } from 'node:child_process'
import { access } from 'node:fs/promises'
import { promisify } from 'node:util'

import { RemoteSshConnectionError, sshConnectionDiagnosis } from './remote-ssh-diagnostics'

const execFileAsync = promisify(execFile)

export type IdentityAgentCommandRunner = (
  command: string,
  args: string[]
) => Promise<{ exitCode: number | null; stdout: string; stderr: string }>

interface IdentityAgentDependencies {
  environment: Readonly<Record<string, string | undefined>>
  publicKeyExists(path: string): Promise<boolean>
  runCommand: IdentityAgentCommandRunner
}

async function defaultRunCommand(
  command: string,
  args: string[]
): Promise<{ exitCode: number | null; stdout: string; stderr: string }> {
  try {
    const result = await execFileAsync(command, args, {
      encoding: 'utf8',
      timeout: 3_000,
      maxBuffer: 64 * 1024
    })
    return { exitCode: 0, stdout: result.stdout, stderr: result.stderr }
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string }
    return {
      exitCode: typeof failure.code === 'number' ? failure.code : 1,
      stdout: failure.stdout ?? '',
      stderr: failure.stderr ?? ''
    }
  }
}

const defaultDependencies: IdentityAgentDependencies = {
  environment: process.env,
  publicKeyExists: async (path) =>
    access(path).then(
      () => true,
      () => false
    ),
  runCommand: defaultRunCommand
}

function fingerprint(output: string): string | null {
  return /^\d+\s+(SHA256:[^\s]+)/m.exec(output)?.[1] ?? null
}

/**
 * Encrypted identities cannot prompt under BatchMode. Generated Phi keys always retain their
 * public sidecar, which lets this check compare fingerprints without asking for the passphrase.
 */
export async function assertEncryptedIdentityLoaded(
  identityFile: string,
  dependencies: IdentityAgentDependencies = defaultDependencies
): Promise<void> {
  if (!(await dependencies.publicKeyExists(`${identityFile}.pub`))) return

  const unlocked = await dependencies.runCommand('ssh-keygen', ['-y', '-P', '', '-f', identityFile])
  if (unlocked.exitCode === 0) return

  const fail = (): never => {
    throw new RemoteSshConnectionError(sshConnectionDiagnosis('identity_not_loaded'))
  }
  if (!dependencies.environment.SSH_AUTH_SOCK) fail()

  const key = await dependencies.runCommand('ssh-keygen', [
    '-lf',
    `${identityFile}.pub`,
    '-E',
    'sha256'
  ])
  const expected = key.exitCode === 0 ? fingerprint(key.stdout) : null
  if (!expected) return fail()

  const agent = await dependencies.runCommand('ssh-add', ['-l', '-E', 'sha256'])
  if (
    agent.exitCode !== 0 ||
    !agent.stdout.split(/\r?\n/).some((line) => line.includes(expected))
  ) {
    fail()
  }
}
