import { randomUUID } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { join } from 'node:path'

import { discoverOpenSshAliases } from '../ssh-config-discovery'
import { saveOpenSshHost } from '../ssh-config-editor'
import {
  assertSshNotBlocked,
  clearSshBlock,
  recordSshFailure,
  type RemoteSshAuthGate
} from '../wrappers/remote-ssh-auth-gate'
import { createNodeSshAskpassFileSystem } from './askpass'
import { createSshBootstrapCoordinator, type SshBootstrapCoordinator } from './coordinator'
import { sshBootstrapAuthGateKey } from './credentials'
import { createNodeSshHostKeyFileSystem } from './filesystem'
import { createSshHostKeyTrustService } from './host-key'
import { installSshPublicKeyWithPassword } from './install-key'
import {
  createNodeSshBootstrapKeyFileSystem,
  generateSshBootstrapKey,
  loadSshBootstrapKey,
  verifySshBootstrapKey
} from './key'
import { runSshBootstrapPreflight } from './preflight'
import {
  createNodeSshPasswordSessionFileSystem,
  createSshPasswordSessionAuthenticator
} from './password-session'
import { runSshBootstrapCommand } from './runtime'

interface DefaultSshBootstrapCoordinatorOptions {
  homeDirectory?: string
  platform?: string
  environment?: Readonly<Record<string, string | undefined>>
  machineName?: string
  now?: () => Date
  createId?: () => string
  tempRoot?: string
  runCommand?: typeof runSshBootstrapCommand
}

export function createDefaultSshBootstrapCoordinator(
  options: DefaultSshBootstrapCoordinatorOptions = {}
): SshBootstrapCoordinator {
  const sshDirectory = join(options.homeDirectory ?? homedir(), '.ssh')
  const knownHostsPath = join(sshDirectory, 'known_hosts')
  const configPath = join(sshDirectory, 'config')
  const environment = options.environment ?? process.env
  const runCommand = options.runCommand ?? runSshBootstrapCommand
  const createId = options.createId ?? randomUUID
  const askpassFiles = createNodeSshAskpassFileSystem(options.tempRoot)
  const keyFiles = createNodeSshBootstrapKeyFileSystem()
  const authGate: RemoteSshAuthGate = {
    recordSshFailure,
    assertSshNotBlocked,
    clearSshBlock
  }
  const authenticator = createSshPasswordSessionAuthenticator({
    runCommand,
    askpassFiles,
    sessionFiles: createNodeSshPasswordSessionFileSystem(options.tempRoot),
    authGate
  })
  const hostKeys = createSshHostKeyTrustService({
    runCommand,
    files: createNodeSshHostKeyFileSystem(),
    knownHostsPath,
    createId
  })

  return createSshBootstrapCoordinator({
    createId,
    preflight: (target) =>
      runSshBootstrapPreflight(target, {
        platform: options.platform ?? process.platform,
        environment,
        runCommand
      }),
    hostKeys,
    authenticate: (target, password, attemptId) =>
      authenticator.authenticate(target, password, attemptId),
    generateKey: (alias, credentials) =>
      generateSshBootstrapKey(
        {
          alias,
          protection:
            credentials.keyProtection === 'passphrase'
              ? { kind: 'passphrase', passphrase: credentials.passphrase }
              : { kind: 'passwordless-explicit' }
        },
        {
          sshDirectory,
          machineName: options.machineName ?? hostname(),
          date: (options.now?.() ?? new Date()).toISOString().slice(0, 10),
          files: keyFiles,
          askpassFiles,
          runCommand
        }
      ),
    installKey: async (target, password, publicKey) => {
      const result = await installSshPublicKeyWithPassword(
        { target, password, publicKey },
        { askpassFiles, runCommand }
      )
      if (result.status === 'rejected' && result.errorCode === 'authentication_failed') {
        authGate.recordSshFailure(sshBootstrapAuthGateKey(target), 'authentication_failed')
      }
      return result
    },
    loadKey: (platform, privateKeyPath, passphrase) =>
      loadSshBootstrapKey(
        { platform, privateKeyPath, passphrase },
        { environment, askpassFiles, runCommand }
      ),
    verifyKey: (target, privateKeyPath, fingerprint, requireAgent) =>
      verifySshBootstrapKey(
        { target, privateKeyPath, fingerprint, requireAgent },
        { environment, runCommand, authGate }
      ),
    saveHost: (input) => saveOpenSshHost(input, configPath),
    hostAliasExists: (alias) => discoverOpenSshAliases(configPath).includes(alias)
  })
}
