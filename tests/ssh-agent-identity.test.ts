import assert from 'node:assert/strict'
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { homedir } from 'node:os'
import test from 'node:test'

import {
  assertEncryptedIdentityLoaded,
  type IdentityAgentCommandRunner
} from '../src/main/agent/wrappers/ssh-agent-identity'
import { RemoteSshConnectionError } from '../src/main/agent/wrappers/remote-ssh-diagnostics'
import { sshConnectionDiagnosis } from '../src/main/agent/wrappers/remote-ssh-diagnostics'
import { connectRemoteSshSession } from '../src/main/agent/wrappers/remote-ssh-session'

test('an encrypted identity missing from ssh-agent fails with a sanitized non-auth error', async () => {
  const calls: Array<{ command: string; args: string[] }> = []
  const runCommand: IdentityAgentCommandRunner = async (command, args) => {
    calls.push({ command, args })
    if (command === 'ssh-keygen' && args.includes('-y')) {
      return { exitCode: 1, stdout: '', stderr: 'incorrect passphrase' }
    }
    if (command === 'ssh-keygen') {
      return { exitCode: 0, stdout: '256 SHA256:phi-key comment (ED25519)\n', stderr: '' }
    }
    return { exitCode: 0, stdout: '256 SHA256:other-key other (ED25519)\n', stderr: '' }
  }

  await assert.rejects(
    assertEncryptedIdentityLoaded('/private/home/.ssh/phi_lab_ed25519', {
      environment: { SSH_AUTH_SOCK: '/tmp/agent.sock' },
      publicKeyExists: async () => true,
      runCommand
    }),
    (error: unknown) =>
      error instanceof RemoteSshConnectionError &&
      error.code === 'identity_not_loaded' &&
      !error.message.includes('/private/home')
  )
  assert.deepEqual(calls, [
    {
      command: 'ssh-keygen',
      args: ['-y', '-P', '', '-f', '/private/home/.ssh/phi_lab_ed25519']
    },
    {
      command: 'ssh-keygen',
      args: ['-lf', '/private/home/.ssh/phi_lab_ed25519.pub', '-E', 'sha256']
    },
    { command: 'ssh-add', args: ['-l', '-E', 'sha256'] }
  ])
})

test('remote connection checks an encrypted identity before SSH spawn or cooldown accounting', async () => {
  let spawned = 0
  let blockedChecks = 0
  let recordedFailures = 0
  await assert.rejects(
    connectRemoteSshSession(
      { host: 'lab-hpc', identityFile: '/tmp/phi_lab_ed25519' },
      {
        assertIdentityReady: async () => {
          throw new RemoteSshConnectionError(sshConnectionDiagnosis('identity_not_loaded'))
        },
        spawnImpl: () => {
          spawned += 1
          throw new Error('SSH must not spawn')
        },
        authGate: {
          assertSshNotBlocked: () => {
            blockedChecks += 1
          },
          recordSshFailure: () => {
            recordedFailures += 1
          },
          clearSshBlock: () => undefined
        }
      }
    ),
    (error: unknown) =>
      error instanceof RemoteSshConnectionError && error.code === 'identity_not_loaded'
  )

  assert.equal(spawned, 0)
  assert.equal(blockedChecks, 1)
  assert.equal(recordedFailures, 0)
})

test('alias-only connections resolve a Phi IdentityFile before starting BatchMode SSH', async () => {
  const spawnArgs: string[][] = []
  const checked: string[] = []
  await assert.rejects(
    connectRemoteSshSession(
      { host: 'lab-hpc' },
      {
        spawnImpl: (_binary, args, options): ChildProcessWithoutNullStreams => {
          spawnArgs.push(args)
          if (args[0] === '-G') {
            return spawn(
              process.execPath,
              [
                '-e',
                "process.stdout.write('identityfile ~/.ssh/id_ed25519\\nidentityfile ~/.ssh/phi_other_ed25519\\nidentityfile ~/.ssh/phi_lab-hpc_ed25519\\n')"
              ],
              options
            )
          }
          throw new Error('BatchMode SSH must not start before the identity check')
        },
        assertIdentityReady: async (identityFile) => {
          checked.push(identityFile)
          throw new RemoteSshConnectionError(sshConnectionDiagnosis('identity_not_loaded'))
        }
      }
    ),
    (error: unknown) =>
      error instanceof RemoteSshConnectionError && error.code === 'identity_not_loaded'
  )

  assert.deepEqual(checked, [`${homedir()}/.ssh/phi_lab-hpc_ed25519`])
  assert.equal(spawnArgs.length, 1)
  assert.equal(spawnArgs[0][0], '-G')
})
