import { chmod, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { SshBootstrapTarget } from '../../../shared/sshBootstrapTypes'
import type { RemoteSshAuthGate } from '../wrappers/remote-ssh-auth-gate'
import { withSshAskpass, type SshAskpassFileSystem } from './askpass'
import {
  isSshPasswordAuthenticationFailure,
  publicKeyAuthenticationIsDisabled,
  requiresUnsupportedInteractiveAuthentication,
  sshBootstrapAuthGateKey,
  type SshBootstrapSecretCommandRunner
} from './credentials'
import { INSTALL_AUTHORIZED_KEY_COMMAND, validateSshPublicKey } from './install-key'
import { validateSshBootstrapTarget } from './preflight'

export interface SshPasswordSessionFileSystem {
  createDirectory(prefix: string): Promise<string>
  remove(path: string): Promise<void>
}

export function createNodeSshPasswordSessionFileSystem(
  tempRoot = tmpdir()
): SshPasswordSessionFileSystem {
  return {
    async createDirectory(prefix) {
      const directory = await mkdtemp(join(tempRoot, prefix))
      await chmod(directory, 0o700)
      return directory
    },
    async remove(path) {
      await rm(path, { recursive: true, force: true })
    }
  }
}

type SessionStageResult =
  { status: 'ready' } | { status: 'rejected'; errorCode: 'authentication_failed' | 'unexpected' }

export interface SshPasswordSession {
  installPublicKey(publicKey: string): Promise<SessionStageResult>
  close(): Promise<void>
}

export type SshPasswordSessionAuthenticationResult =
  | { status: 'ready'; session: SshPasswordSession }
  | {
      status: 'rejected'
      errorCode:
        | 'authentication_failed'
        | 'password_attempts_exhausted'
        | 'keyboard_interactive_unsupported'
        | 'pubkey_auth_disabled'
        | 'unexpected'
    }

interface SshPasswordSessionDependencies {
  runCommand: SshBootstrapSecretCommandRunner
  askpassFiles: SshAskpassFileSystem
  sessionFiles: SshPasswordSessionFileSystem
  authGate: RemoteSshAuthGate
}

function connectionArgs(target: SshBootstrapTarget): string[] {
  return ['-p', String(target.port), '-l', target.user, target.hostname]
}

function openArgs(target: SshBootstrapTarget, controlPath: string): string[] {
  return [
    '-F',
    '/dev/null',
    '-v',
    '-M',
    '-N',
    '-f',
    '-S',
    controlPath,
    '-o',
    'ControlMaster=yes',
    '-o',
    'ControlPersist=no',
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
    ...connectionArgs(target)
  ]
}

function sessionArgs(target: SshBootstrapTarget, controlPath: string, tail: string[]): string[] {
  return [
    '-F',
    '/dev/null',
    '-S',
    controlPath,
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    ...connectionArgs(target),
    ...tail
  ]
}

function closeArgs(target: SshBootstrapTarget, controlPath: string): string[] {
  return ['-F', '/dev/null', '-S', controlPath, '-O', 'exit', ...connectionArgs(target)]
}

export function createSshPasswordSessionAuthenticator(
  dependencies: SshPasswordSessionDependencies
): {
  authenticate(
    target: SshBootstrapTarget,
    password: string,
    attemptId?: string
  ): Promise<SshPasswordSessionAuthenticationResult>
} {
  const attempts = new Map<string, { failures: number; inFlight: number }>()
  return {
    async authenticate(input, password, attemptId) {
      const target = validateSshBootstrapTarget(input)
      const hostKey = sshBootstrapAuthGateKey(target)
      const attemptKey = attemptId ?? hostKey
      const prior = attempts.get(attemptKey) ?? { failures: 0, inFlight: 0 }
      if (prior.failures + prior.inFlight >= 3) {
        return { status: 'rejected', errorCode: 'password_attempts_exhausted' }
      }
      attempts.set(attemptKey, { ...prior, inFlight: prior.inFlight + 1 })

      const finishAttempt = (result: 'success' | 'failure' | 'neutral'): void => {
        const current = attempts.get(attemptKey) ?? { failures: 0, inFlight: 1 }
        const next = {
          failures: result === 'success' ? 0 : current.failures + (result === 'failure' ? 1 : 0),
          inFlight: Math.max(0, current.inFlight - 1)
        }
        if (next.failures === 0 && next.inFlight === 0) attempts.delete(attemptKey)
        else attempts.set(attemptKey, next)
      }

      let directory: string
      try {
        directory = await dependencies.sessionFiles.createDirectory('phi-ssh-session-')
      } catch {
        finishAttempt('neutral')
        return { status: 'rejected', errorCode: 'unexpected' }
      }
      const controlPath = join(directory, 'master')
      let opened
      try {
        opened = await withSshAskpass(password, dependencies.askpassFiles, ({ env }) =>
          dependencies.runCommand({ command: 'ssh', args: openArgs(target, controlPath), env })
        )
      } catch {
        await dependencies.sessionFiles.remove(directory).catch(() => undefined)
        finishAttempt('neutral')
        return { status: 'rejected', errorCode: 'unexpected' }
      }
      if (opened.exitCode !== 0) {
        await dependencies.sessionFiles.remove(directory)
        if (!isSshPasswordAuthenticationFailure(opened.stderr)) {
          finishAttempt('neutral')
          return { status: 'rejected', errorCode: 'unexpected' }
        }
        dependencies.authGate.recordSshFailure(hostKey, 'authentication_failed')
        finishAttempt('failure')
        const failures = attempts.get(attemptKey)?.failures ?? 0
        if (requiresUnsupportedInteractiveAuthentication(opened.stderr)) {
          return { status: 'rejected', errorCode: 'keyboard_interactive_unsupported' }
        }
        if (publicKeyAuthenticationIsDisabled(opened.stderr)) {
          return { status: 'rejected', errorCode: 'pubkey_auth_disabled' }
        }
        return {
          status: 'rejected',
          errorCode: failures >= 3 ? 'password_attempts_exhausted' : 'authentication_failed'
        }
      }
      if (publicKeyAuthenticationIsDisabled(opened.stderr)) {
        await dependencies.runCommand({
          command: 'ssh',
          args: closeArgs(target, controlPath)
        })
        await dependencies.sessionFiles.remove(directory)
        finishAttempt('success')
        return { status: 'rejected', errorCode: 'pubkey_auth_disabled' }
      }
      finishAttempt('success')
      dependencies.authGate.clearSshBlock(hostKey)

      let closed = false
      return {
        status: 'ready',
        session: {
          async installPublicKey(value) {
            if (closed) return { status: 'rejected', errorCode: 'unexpected' }
            const publicKey = validateSshPublicKey(value)
            if (!publicKey) return { status: 'rejected', errorCode: 'unexpected' }
            const result = await dependencies.runCommand({
              command: 'ssh',
              args: sessionArgs(target, controlPath, [INSTALL_AUTHORIZED_KEY_COMMAND]),
              stdin: `${publicKey}\n`
            })
            return result.exitCode === 0
              ? { status: 'ready' }
              : { status: 'rejected', errorCode: 'unexpected' }
          },
          async close() {
            if (closed) return
            closed = true
            await dependencies
              .runCommand({
                command: 'ssh',
                args: closeArgs(target, controlPath)
              })
              .catch(() => undefined)
            await dependencies.sessionFiles.remove(directory)
          }
        }
      }
    }
  }
}
