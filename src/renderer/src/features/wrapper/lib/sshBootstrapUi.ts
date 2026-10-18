import { remoteSetupCopy } from './remoteSetupCopy'
import type {
  SshBootstrapAgentState,
  SshBootstrapCredentialRequest,
  SshBootstrapKeyProtectionRequest,
  SshBootstrapPasswordRequest,
  SshBootstrapPublicErrorCode,
  SshBootstrapRendererBridge,
  SshBootstrapTarget,
  SshHostKeyFingerprint
} from '../../../../../shared/sshBootstrapTypes'

export type {
  SshBootstrapAgentState,
  SshBootstrapCredentialRequest,
  SshBootstrapFinalResult,
  SshBootstrapHostKeyConfirmation,
  SshBootstrapInspection,
  SshBootstrapPreparation,
  SshBootstrapPublicErrorCode,
  SshBootstrapTarget,
  SshHostKeyFingerprint
} from '../../../../../shared/sshBootstrapTypes'

export interface SshBootstrapCredentialDraft {
  password: string
  passphrase: string
  passphraseConfirmation: string
}

export interface SshBootstrapKeyProtectionDraft {
  passphrase: string
  passphraseConfirmation: string
}

export interface SshBootstrapTargetModel {
  phase: 'target'
  target: SshBootstrapTarget
  busy: boolean
  error: string | null
}

export interface SshBootstrapHostKeyModel {
  phase: 'host-key-confirmation'
  target: SshBootstrapTarget
  busy: boolean
  error: string | null
  fingerprints: SshHostKeyFingerprint[]
}

export interface SshBootstrapPasswordModel {
  phase: 'password'
  target: SshBootstrapTarget
  busy: boolean
  error: string | null
  agentState: SshBootstrapAgentState
  password: string
  validationMessage: string | null
}

export interface SshBootstrapPasswordChoiceModel {
  phase: 'password-choice'
  target: SshBootstrapTarget
  busy: boolean
  error: string | null
  agentState: SshBootstrapAgentState
}

export interface SshBootstrapSkippedModel {
  phase: 'skipped'
  target: SshBootstrapTarget
  busy: false
  error: null
}

export interface SshBootstrapCredentialsModel {
  phase: 'credentials'
  target: SshBootstrapTarget
  busy: boolean
  error: string | null
  credentials: SshBootstrapCredentialDraft
  validationMessage: string | null
  passwordlessAvailable: boolean
  passwordlessAcknowledged: boolean
}

export interface SshBootstrapProgressModel {
  phase: 'progress'
  target: SshBootstrapTarget
  busy: true
  error: null
  completedSteps: string[]
  currentStep: string
}

export interface SshBootstrapConfigPreviewModel {
  phase: 'config-preview'
  target: SshBootstrapTarget
  busy: boolean
  error: string | null
  preview: string
  keyFingerprint: string
  keyDisplayPath: string
}

export interface SshBootstrapResultModel {
  phase: 'result'
  target: SshBootstrapTarget
  busy: false
  error: null
  configured: boolean
  keyFingerprint: string
  keyDisplayPath: string
  manualConfig?: string
}

export type SshBootstrapUiModel =
  | SshBootstrapTargetModel
  | SshBootstrapHostKeyModel
  | SshBootstrapPasswordModel
  | SshBootstrapPasswordChoiceModel
  | SshBootstrapSkippedModel
  | SshBootstrapCredentialsModel
  | SshBootstrapProgressModel
  | SshBootstrapConfigPreviewModel
  | SshBootstrapResultModel

export interface SshBootstrapUiActions {
  startInspection: () => void
  confirmHostKey: () => void
  setPassword: (value: string) => void
  verifyPassword: () => void
  configurePasswordless: () => void
  skipPasswordless: () => void
  setPassphrase: (value: string) => void
  setPassphraseConfirmation: (value: string) => void
  setPasswordlessAcknowledged: (value: boolean) => void
  submitCredentials: () => void
  saveConfig: () => void
  declineConfig: () => void
  close: () => void
}

export type RemoteHostPasswordBootstrapClient = Pick<
  SshBootstrapRendererBridge,
  | 'inspectTarget'
  | 'confirmHostKey'
  | 'verifyPassword'
  | 'completeWithKeyProtection'
  | 'saveConfig'
  | 'declineConfig'
  | 'cancel'
>

const PUBLIC_ERROR_MESSAGES: Record<SshBootstrapPublicErrorCode, string> = {
  get proxy_unsupported() {
    return remoteSetupCopy.bootstrapProxyUnsupported
  },
  get keyboard_interactive_unsupported() {
    return remoteSetupCopy.bootstrapInteractiveUnsupported
  },
  get pubkey_auth_disabled() {
    return remoteSetupCopy.bootstrapPublicKeyDisabled
  },
  get openssh_too_old() {
    return remoteSetupCopy.bootstrapOpenSshTooOld
  },
  get host_key_changed() {
    return remoteSetupCopy.bootstrapHostKeyChanged
  },
  get authentication_failed() {
    return remoteSetupCopy.bootstrapAuthenticationFailed
  },
  get password_attempts_exhausted() {
    return remoteSetupCopy.bootstrapPasswordAttemptsExhausted
  },
  get linux_agent_missing() {
    return remoteSetupCopy.bootstrapAgentMissing
  },
  get key_not_loaded() {
    return remoteSetupCopy.bootstrapKeyNotLoaded
  },
  get unsupported_platform() {
    return remoteSetupCopy.bootstrapPlatformUnsupported
  },
  get unexpected() {
    return remoteSetupCopy.bootstrapUnexpected
  }
}

export function sshBootstrapErrorMessage(code: SshBootstrapPublicErrorCode): string {
  return PUBLIC_ERROR_MESSAGES[code]
}

export function initialSshBootstrapUiModel(target: SshBootstrapTarget): SshBootstrapTargetModel {
  return { phase: 'target', target, busy: false, error: null }
}

export function passwordSshBootstrapUiModel(
  target: SshBootstrapTarget,
  agentState: SshBootstrapAgentState,
  error: string | null = null
): SshBootstrapPasswordModel {
  return {
    phase: 'password',
    target,
    busy: false,
    error,
    agentState,
    password: '',
    validationMessage: remoteSetupCopy.serverPasswordRequired
  }
}

export function credentialValidationMessage(
  draft: SshBootstrapCredentialDraft,
  options: { passwordlessAvailable?: boolean; passwordlessAcknowledged?: boolean } = {}
): string | null {
  if (!draft.password) return remoteSetupCopy.serverPasswordRequired
  if (options.passwordlessAvailable) {
    return options.passwordlessAcknowledged ? null : remoteSetupCopy.agentRequired
  }
  if (!draft.passphrase) return remoteSetupCopy.keyPassphraseRequired
  if (draft.passphrase !== draft.passphraseConfirmation)
    return remoteSetupCopy.keyPassphrasesMismatch
  return null
}

export function keyProtectionValidationMessage(
  draft: Pick<SshBootstrapCredentialDraft, 'passphrase' | 'passphraseConfirmation'>,
  options: { passwordlessAvailable?: boolean; passwordlessAcknowledged?: boolean } = {}
): string | null {
  if (options.passwordlessAvailable) {
    return options.passwordlessAcknowledged ? null : remoteSetupCopy.agentRequired
  }
  if (!draft.passphrase) return remoteSetupCopy.keyPassphraseRequired
  if (draft.passphrase !== draft.passphraseConfirmation)
    return remoteSetupCopy.keyPassphrasesMismatch
  return null
}

export function credentialsSshBootstrapUiModel(
  target: SshBootstrapTarget,
  agentState: SshBootstrapAgentState,
  error: string | null = null
): SshBootstrapCredentialsModel {
  const passwordlessAvailable = agentState === 'missing-linux'
  const credentials = { password: '', passphrase: '', passphraseConfirmation: '' }
  return {
    phase: 'credentials',
    target,
    busy: false,
    error,
    credentials,
    passwordlessAvailable,
    passwordlessAcknowledged: false,
    validationMessage: keyProtectionValidationMessage(credentials, { passwordlessAvailable })
  }
}

export async function withEphemeralSshBootstrapCredentials<T>(
  draft: SshBootstrapCredentialDraft,
  passwordlessAcknowledged: boolean,
  consume: (credentials: SshBootstrapCredentialRequest) => Promise<T>
): Promise<T> {
  const credentials: SshBootstrapCredentialRequest = passwordlessAcknowledged
    ? { password: draft.password, keyProtection: 'passwordless-explicit' }
    : {
        password: draft.password,
        keyProtection: 'passphrase',
        passphrase: draft.passphrase
      }
  try {
    return await consume(credentials)
  } finally {
    credentials.password = ''
    if (credentials.keyProtection === 'passphrase') credentials.passphrase = ''
  }
}

export async function withEphemeralSshBootstrapPassword<T>(
  password: string,
  consume: (input: SshBootstrapPasswordRequest) => Promise<T>
): Promise<T> {
  const input = { password }
  try {
    return await consume(input)
  } finally {
    input.password = ''
  }
}

export async function withEphemeralSshBootstrapKeyProtection<T>(
  draft: SshBootstrapKeyProtectionDraft,
  passwordlessAcknowledged: boolean,
  consume: (input: SshBootstrapKeyProtectionRequest) => Promise<T>
): Promise<T> {
  const input: SshBootstrapKeyProtectionRequest = passwordlessAcknowledged
    ? { keyProtection: 'passwordless-explicit' }
    : { keyProtection: 'passphrase', passphrase: draft.passphrase }
  try {
    return await consume(input)
  } finally {
    if (input.keyProtection === 'passphrase') input.passphrase = ''
  }
}
