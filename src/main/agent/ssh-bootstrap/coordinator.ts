import type { OpenSshHostInput } from '../../../shared/remoteHostProfile'
import type {
  SshBootstrapCredentialRequest,
  SshBootstrapFinalResult,
  SshBootstrapHostKeyConfirmation,
  SshBootstrapInspection,
  SshBootstrapPreparation,
  SshBootstrapPublicErrorCode,
  SshBootstrapRendererBridge,
  SshBootstrapTarget
} from '../../../shared/sshBootstrapTypes'
import { updatedOpenSshConfig } from '../ssh-config-editor'
import type { SshHostKeyTrustService } from './host-key'
import type { SshBootstrapPreflightResult } from './preflight'

type StageResult<Code extends string = SshBootstrapPublicErrorCode> =
  { status: 'ready' } | { status: 'rejected'; errorCode: Code }

interface AuthenticatedPasswordSession {
  installPublicKey(publicKey: string): Promise<StageResult>
  close(): Promise<void>
}

type PasswordAuthenticationResult =
  | { status: 'ready'; session?: AuthenticatedPasswordSession }
  | { status: 'rejected'; errorCode: string }

interface GeneratedKey {
  status: 'ready'
  privateKeyPath: string
  publicKey: string
  fingerprint: string
}

export interface SshBootstrapCoordinatorDependencies {
  createId(): string
  preflight(target: SshBootstrapTarget): Promise<SshBootstrapPreflightResult>
  hostKeys: SshHostKeyTrustService
  authenticate(
    target: SshBootstrapTarget,
    password: string,
    attemptId?: string
  ): Promise<PasswordAuthenticationResult>
  generateKey(
    alias: string,
    credentials: SshBootstrapCredentialRequest
  ): Promise<GeneratedKey | { status: 'rejected'; errorCode: string }>
  installKey(target: SshBootstrapTarget, password: string, publicKey: string): Promise<StageResult>
  loadKey(
    platform: 'darwin' | 'linux',
    privateKeyPath: string,
    passphrase: string
  ): Promise<StageResult>
  verifyKey(
    target: SshBootstrapTarget,
    privateKeyPath: string,
    fingerprint: string,
    requireAgent: boolean
  ): Promise<StageResult>
  saveHost(input: OpenSshHostInput): Promise<string>
  hostAliasExists?: (alias: string) => boolean | Promise<boolean>
}

interface AttemptState {
  target: SshBootstrapTarget
  preflight: Extract<SshBootstrapPreflightResult, { status: 'ready' }>
  trusted: boolean
  editingExisting: boolean
  hostConfirmationId?: string
  key?: GeneratedKey
  installed?: boolean
  busy?: boolean
}

interface ConfigOperation {
  input: OpenSshHostInput
  preview: string
  keyFingerprint: string
  keyDisplayPath: string
}

export interface SshBootstrapCoordinator extends SshBootstrapRendererBridge {}

const failed = (
  errorCode: SshBootstrapPublicErrorCode,
  retryable = false
): SshBootstrapPreparation => ({ status: 'failed', errorCode, retryable })

function publicErrorCode(value: string): SshBootstrapPublicErrorCode {
  const known: ReadonlySet<string> = new Set([
    'proxy_unsupported',
    'keyboard_interactive_unsupported',
    'pubkey_auth_disabled',
    'openssh_too_old',
    'host_key_changed',
    'authentication_failed',
    'password_attempts_exhausted',
    'linux_agent_missing',
    'key_not_loaded',
    'unsupported_platform',
    'unexpected'
  ])
  return known.has(value) ? (value as SshBootstrapPublicErrorCode) : 'unexpected'
}

function keyDisplayPath(privateKeyPath: string): string {
  const name = privateKeyPath.split(/[\\/]/).at(-1)
  return name ? `~/.ssh/${name}` : '~/.ssh/phi_ed25519'
}

export function createSshBootstrapCoordinator(
  dependencies: SshBootstrapCoordinatorDependencies
): SshBootstrapCoordinator {
  const attempts = new Map<string, AttemptState>()
  const operations = new Map<string, ConfigOperation>()

  return {
    async inspectTarget(target): Promise<SshBootstrapInspection> {
      try {
        const preflight = await dependencies.preflight(target)
        if (preflight.status === 'rejected') return preflight
        const trust = await dependencies.hostKeys.inspectTarget(target)
        if (trust.status === 'rejected') return trust
        const attemptId = dependencies.createId()
        attempts.set(attemptId, {
          target,
          preflight,
          trusted: trust.status === 'ready',
          editingExisting: Boolean(await dependencies.hostAliasExists?.(target.alias)),
          ...(trust.status === 'confirmation-required'
            ? { hostConfirmationId: trust.confirmationId }
            : {})
        })
        return trust.status === 'confirmation-required'
          ? { status: 'confirmation-required', attemptId, fingerprints: trust.fingerprints }
          : { status: 'ready', attemptId, agentState: preflight.agentState }
      } catch {
        return { status: 'rejected', errorCode: 'unexpected' }
      }
    },

    async confirmHostKey(attemptId): Promise<SshBootstrapHostKeyConfirmation> {
      const attempt = attempts.get(attemptId)
      if (!attempt?.hostConfirmationId || attempt.trusted) {
        return { status: 'rejected', errorCode: 'unexpected' }
      }
      const result = await dependencies.hostKeys.confirmHostKey(attempt.hostConfirmationId)
      if (result.status === 'rejected') return result
      attempts.set(attemptId, { ...attempt, trusted: true, hostConfirmationId: undefined })
      return { status: 'ready', attemptId, agentState: attempt.preflight.agentState }
    },

    async completeWithCredentials(attemptId, credentials): Promise<SshBootstrapPreparation> {
      let ownsLock = false
      try {
        const found = attempts.get(attemptId)
        if (!found?.trusted || found.busy) return failed('unexpected')
        const attempt = { ...found, busy: true }
        attempts.set(attemptId, attempt)
        ownsLock = true
        if (
          attempt.preflight.platform === 'linux' &&
          attempt.preflight.agentState === 'missing-linux' &&
          credentials.keyProtection === 'passphrase'
        ) {
          return failed('linux_agent_missing', true)
        }
        if (
          credentials.keyProtection === 'passwordless-explicit' &&
          !(
            attempt.preflight.platform === 'linux' &&
            attempt.preflight.agentState === 'missing-linux'
          )
        ) {
          return failed('unexpected')
        }

        let current = attempt
        let passwordSession: AuthenticatedPasswordSession | undefined
        if (!current.installed) {
          const authenticated = await dependencies.authenticate(
            current.target,
            credentials.password,
            attemptId
          )
          if (authenticated.status === 'rejected') {
            const code = publicErrorCode(authenticated.errorCode)
            return failed(code, code === 'authentication_failed')
          }
          passwordSession = authenticated.session
        }
        let generated = current.key
        try {
          if (!generated) {
            const result = await dependencies.generateKey(current.target.alias, credentials)
            if (result.status === 'rejected') return failed(publicErrorCode(result.errorCode))
            generated = result
            current = { ...current, key: generated }
            attempts.set(attemptId, current)
          }
          if (!current.installed) {
            const installed = passwordSession
              ? await passwordSession.installPublicKey(generated.publicKey)
              : await dependencies.installKey(
                  current.target,
                  credentials.password,
                  generated.publicKey
                )
            if (installed.status === 'rejected') {
              return failed(publicErrorCode(installed.errorCode))
            }
            current = { ...current, installed: true }
            attempts.set(attemptId, current)
          }
        } finally {
          await passwordSession?.close().catch(() => undefined)
        }

        const requireAgent = credentials.keyProtection === 'passphrase'
        if (requireAgent) {
          const loaded = await dependencies.loadKey(
            current.preflight.platform,
            generated.privateKeyPath,
            credentials.passphrase
          )
          if (loaded.status === 'rejected') return failed(publicErrorCode(loaded.errorCode), true)
        }
        const verified = await dependencies.verifyKey(
          current.target,
          generated.privateKeyPath,
          generated.fingerprint,
          requireAgent
        )
        if (verified.status === 'rejected') {
          return failed(
            publicErrorCode(verified.errorCode),
            verified.errorCode === 'key_not_loaded'
          )
        }

        const displayPath = keyDisplayPath(generated.privateKeyPath)
        const input: OpenSshHostInput = {
          ...(current.editingExisting ? { originalAlias: current.target.alias } : {}),
          alias: current.target.alias,
          hostname: current.target.hostname,
          user: current.target.user,
          port: current.target.port,
          identityFile: displayPath,
          identitiesOnly: true,
          ...(current.preflight.platform === 'darwin'
            ? { addKeysToAgent: true, useKeychain: true }
            : {})
        }
        const preview = updatedOpenSshConfig('', { ...input, originalAlias: undefined }, [])
        const operationId = dependencies.createId()
        attempts.delete(attemptId)
        operations.set(operationId, {
          input,
          preview,
          keyFingerprint: generated.fingerprint,
          keyDisplayPath: displayPath
        })
        return {
          status: 'config-preview',
          operationId,
          preview,
          keyFingerprint: generated.fingerprint,
          keyDisplayPath: displayPath
        }
      } catch {
        return failed('unexpected')
      } finally {
        if (ownsLock) {
          const current = attempts.get(attemptId)
          if (current?.busy) attempts.set(attemptId, { ...current, busy: false })
        }
        credentials.password = ''
        if (credentials.keyProtection === 'passphrase') credentials.passphrase = ''
      }
    },

    async saveConfig(operationId): Promise<SshBootstrapFinalResult> {
      const operation = operations.get(operationId)
      if (!operation) throw new Error('SSH 引导操作不存在或已结束')
      await dependencies.saveHost(operation.input)
      operations.delete(operationId)
      return {
        configured: true,
        keyFingerprint: operation.keyFingerprint,
        keyDisplayPath: operation.keyDisplayPath
      }
    },

    async declineConfig(operationId): Promise<SshBootstrapFinalResult> {
      const operation = operations.get(operationId)
      if (!operation) throw new Error('SSH 引导操作不存在或已结束')
      operations.delete(operationId)
      return {
        configured: false,
        keyFingerprint: operation.keyFingerprint,
        keyDisplayPath: operation.keyDisplayPath,
        manualConfig: operation.preview
      }
    },

    async cancel(id): Promise<void> {
      attempts.delete(id)
      operations.delete(id)
    }
  }
}
