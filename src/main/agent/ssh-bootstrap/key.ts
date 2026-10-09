import { access, chmod as chmodFile, mkdir, open, readFile, rm } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { validateHostAlias } from '../wrappers/remote-ssh-session'
import type { SshBootstrapTarget } from '../../../shared/sshBootstrapTypes'
import type { RemoteSshAuthGate } from '../wrappers/remote-ssh-auth-gate'
import { validateRemoteConnectionOverrides } from '../wrappers/remote-ssh-session'
import { withSshAskpass, type SshAskpassFileSystem } from './askpass'
import { sshBootstrapAuthGateKey, type SshBootstrapSecretCommandRunner } from './credentials'
import { validateSshBootstrapTarget } from './preflight'

export interface SshBootstrapKeyFileSystem {
  ensureDirectory(path: string, mode: number): Promise<void>
  exists(path: string): Promise<boolean>
  readText(path: string): Promise<string | null>
  chmod(path: string, mode: number): Promise<void>
  remove(path: string): Promise<void>
  acquireLock(path: string): Promise<(() => Promise<void>) | null>
}

export function createNodeSshBootstrapKeyFileSystem(): SshBootstrapKeyFileSystem {
  return {
    async ensureDirectory(path, mode) {
      await mkdir(path, { recursive: true, mode })
      await chmodFile(path, mode)
    },
    async exists(path) {
      try {
        await access(path)
        return true
      } catch {
        return false
      }
    },
    async readText(path) {
      try {
        return await readFile(path, 'utf8')
      } catch {
        return null
      }
    },
    async chmod(path, mode) {
      await chmodFile(path, mode)
    },
    async remove(path) {
      await rm(path, { force: true })
    },
    async acquireLock(path) {
      let handle
      try {
        handle = await open(path, 'wx', 0o600)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null
        throw error
      }
      return async () => {
        await handle.close().catch(() => undefined)
        await rm(path, { force: true })
      }
    }
  }
}

export type SshBootstrapKeyProtection =
  { kind: 'passphrase'; passphrase: string } | { kind: 'passwordless-explicit' }

export interface SshBootstrapKeyInput {
  alias: string
  protection: SshBootstrapKeyProtection
}

export interface SshBootstrapKeyDependencies {
  sshDirectory: string
  machineName: string
  date: string
  files: SshBootstrapKeyFileSystem
  askpassFiles: SshAskpassFileSystem
  runCommand: SshBootstrapSecretCommandRunner
}

export type SshBootstrapKeyResult =
  | {
      status: 'ready'
      privateKeyPath: string
      publicKey: string
      fingerprint: string
    }
  | { status: 'rejected'; errorCode: 'unexpected' }

export interface SshBootstrapKeyLoadInput {
  platform: 'darwin' | 'linux'
  privateKeyPath: string
  passphrase: string
}

export interface SshBootstrapKeyLoadDependencies {
  environment: Readonly<Record<string, string | undefined>>
  askpassFiles: SshAskpassFileSystem
  runCommand: SshBootstrapSecretCommandRunner
}

export type SshBootstrapKeyLoadResult =
  { status: 'ready' } | { status: 'rejected'; errorCode: 'linux_agent_missing' | 'unexpected' }

export interface SshBootstrapKeyVerificationInput {
  target: SshBootstrapTarget
  privateKeyPath: string
  fingerprint: string
  requireAgent: boolean
}

export interface SshBootstrapKeyVerificationDependencies {
  environment: Readonly<Record<string, string | undefined>>
  runCommand: SshBootstrapSecretCommandRunner
  authGate: RemoteSshAuthGate
}

export type SshBootstrapKeyVerificationResult =
  | { status: 'ready' }
  | {
      status: 'rejected'
      errorCode: 'key_not_loaded' | 'authentication_failed' | 'unexpected'
    }

function safeCommentPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown'
}

async function removeGeneratedKey(
  privateKeyPath: string,
  files: SshBootstrapKeyFileSystem
): Promise<void> {
  await Promise.allSettled([files.remove(privateKeyPath), files.remove(`${privateKeyPath}.pub`)])
}

export async function generateSshBootstrapKey(
  input: SshBootstrapKeyInput,
  dependencies: SshBootstrapKeyDependencies
): Promise<SshBootstrapKeyResult> {
  const alias = validateHostAlias(input.alias)
  if (input.protection.kind === 'passphrase' && input.protection.passphrase.length === 0) {
    return { status: 'rejected', errorCode: 'unexpected' }
  }

  const privateKeyPath = join(dependencies.sshDirectory, `phi_${alias}_ed25519`)
  const publicKeyPath = `${privateKeyPath}.pub`
  await dependencies.files.ensureDirectory(dependencies.sshDirectory, 0o700)
  const releaseLock = await dependencies.files.acquireLock(`${privateKeyPath}.phi-bootstrap.lock`)
  if (!releaseLock) {
    return { status: 'rejected', errorCode: 'unexpected' }
  }
  try {
    if (
      (await dependencies.files.exists(privateKeyPath)) ||
      (await dependencies.files.exists(publicKeyPath))
    ) {
      return { status: 'rejected', errorCode: 'unexpected' }
    }

    const passphrase = input.protection.kind === 'passphrase' ? input.protection.passphrase : ''
    const comment = `phi@${safeCommentPart(dependencies.machineName)}-${safeCommentPart(dependencies.date)}`
    const generated = await withSshAskpass(
      passphrase,
      dependencies.askpassFiles,
      ({ env }) =>
        dependencies.runCommand({
          command: 'ssh-keygen',
          args: ['-q', '-t', 'ed25519', '-f', privateKeyPath, '-C', comment],
          env
        }),
      { promptCount: 2 }
    )
    if (generated.exitCode !== 0) {
      await removeGeneratedKey(privateKeyPath, dependencies.files)
      return { status: 'rejected', errorCode: 'unexpected' }
    }

    await dependencies.files.chmod(privateKeyPath, 0o600)
    const publicKey = (await dependencies.files.readText(publicKeyPath))?.trim()
    if (!publicKey) {
      await removeGeneratedKey(privateKeyPath, dependencies.files)
      return { status: 'rejected', errorCode: 'unexpected' }
    }
    const fingerprintResult = await dependencies.runCommand({
      command: 'ssh-keygen',
      args: ['-lf', publicKeyPath, '-E', 'sha256']
    })
    const fingerprint = /^\d+\s+(SHA256:[^\s]+)/m.exec(fingerprintResult.stdout)?.[1]
    if (fingerprintResult.exitCode !== 0 || !fingerprint) {
      await removeGeneratedKey(privateKeyPath, dependencies.files)
      return { status: 'rejected', errorCode: 'unexpected' }
    }

    return { status: 'ready', privateKeyPath, publicKey, fingerprint }
  } finally {
    await releaseLock()
  }
}

export async function loadSshBootstrapKey(
  input: SshBootstrapKeyLoadInput,
  dependencies: SshBootstrapKeyLoadDependencies
): Promise<SshBootstrapKeyLoadResult> {
  if (!isAbsolute(input.privateKeyPath) || /[\r\n\0]/.test(input.privateKeyPath)) {
    return { status: 'rejected', errorCode: 'unexpected' }
  }
  const agentSocket = dependencies.environment.SSH_AUTH_SOCK
  if (input.platform === 'linux' && !agentSocket) {
    return { status: 'rejected', errorCode: 'linux_agent_missing' }
  }

  const result = await withSshAskpass(input.passphrase, dependencies.askpassFiles, ({ env }) =>
    dependencies.runCommand({
      command: 'ssh-add',
      args:
        input.platform === 'darwin'
          ? ['--apple-use-keychain', input.privateKeyPath]
          : [input.privateKeyPath],
      env: {
        ...env,
        ...(agentSocket ? { SSH_AUTH_SOCK: agentSocket } : {})
      }
    })
  )
  return result.exitCode === 0
    ? { status: 'ready' }
    : { status: 'rejected', errorCode: 'unexpected' }
}

function keyVerificationArgs(input: SshBootstrapKeyVerificationInput): string[] {
  const target = validateSshBootstrapTarget(input.target)
  const overrides = validateRemoteConnectionOverrides({
    user: target.user,
    port: target.port,
    identityFile: input.privateKeyPath
  })
  return [
    '-F',
    '/dev/null',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'IdentitiesOnly=yes',
    '-i',
    overrides.identityFile ?? '',
    '-p',
    String(overrides.port),
    '-l',
    overrides.user ?? '',
    target.hostname,
    'true'
  ]
}

export async function verifySshBootstrapKey(
  input: SshBootstrapKeyVerificationInput,
  dependencies: SshBootstrapKeyVerificationDependencies
): Promise<SshBootstrapKeyVerificationResult> {
  const target = validateSshBootstrapTarget(input.target)
  if (!/^SHA256:[^\s]+$/.test(input.fingerprint)) {
    return { status: 'rejected', errorCode: 'unexpected' }
  }
  if (input.requireAgent) {
    const agentSocket = dependencies.environment.SSH_AUTH_SOCK
    const listed = await dependencies.runCommand({
      command: 'ssh-add',
      args: ['-l', '-E', 'sha256'],
      ...(agentSocket ? { env: { SSH_AUTH_SOCK: agentSocket } } : {})
    })
    const loaded = listed.stdout
      .split(/\r?\n/)
      .some((line) => line.split(/\s+/).includes(input.fingerprint))
    if (listed.exitCode !== 0 || !loaded) {
      return { status: 'rejected', errorCode: 'key_not_loaded' }
    }
  }

  const verified = await dependencies.runCommand({
    command: 'ssh',
    args: keyVerificationArgs(input)
  })
  const hostKey = sshBootstrapAuthGateKey(target)
  if (verified.exitCode === 0) {
    dependencies.authGate.clearSshBlock(hostKey)
    return { status: 'ready' }
  }
  if (/permission denied|authentication failed|agent refused operation/i.test(verified.stderr)) {
    dependencies.authGate.recordSshFailure(hostKey, 'authentication_failed')
    return { status: 'rejected', errorCode: 'authentication_failed' }
  }
  return { status: 'rejected', errorCode: 'unexpected' }
}
