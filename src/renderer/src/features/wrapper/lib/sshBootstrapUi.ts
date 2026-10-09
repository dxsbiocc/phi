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
  proxy_unsupported: '此服务器通过 ProxyJump 或 ProxyCommand 连接，当前版本不支持引导。',
  keyboard_interactive_unsupported: '服务器要求键盘交互、MFA 或一次性密码，当前版本不支持引导。',
  pubkey_auth_disabled: '服务器已禁用公钥认证，无法设置免密登录。',
  openssh_too_old: '系统 OpenSSH 版本低于 8.4，无法安全使用一次性密码引导。',
  host_key_changed: '服务器主机密钥与 known_hosts 中的记录不一致，已停止且不会覆盖。',
  authentication_failed: '服务器拒绝了密码认证。请检查密码后重试。',
  password_attempts_exhausted: '本次引导已达到 3 次密码尝试上限，请稍后再试。',
  linux_agent_missing: '请先启动 ssh-agent 后重新检查，或明确选择无口令密钥。',
  key_not_loaded: '专用密钥尚未加载到 ssh-agent，请重新加载后再连接。',
  unsupported_platform: '此功能仅支持 macOS 和 Linux。',
  unexpected: '引导失败。为保护凭据，不显示底层命令输出；请重试。'
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
    validationMessage: '请输入服务器密码'
  }
}

export function credentialValidationMessage(
  draft: SshBootstrapCredentialDraft,
  options: { passwordlessAvailable?: boolean; passwordlessAcknowledged?: boolean } = {}
): string | null {
  if (!draft.password) return '请输入服务器密码'
  if (options.passwordlessAvailable) {
    return options.passwordlessAcknowledged
      ? null
      : '请先启动 ssh-agent 后重新检查，或明确选择无口令密钥'
  }
  if (!draft.passphrase) return '请输入私钥口令'
  if (draft.passphrase !== draft.passphraseConfirmation) return '两次输入的私钥口令不一致'
  return null
}

export function keyProtectionValidationMessage(
  draft: Pick<SshBootstrapCredentialDraft, 'passphrase' | 'passphraseConfirmation'>,
  options: { passwordlessAvailable?: boolean; passwordlessAcknowledged?: boolean } = {}
): string | null {
  if (options.passwordlessAvailable) {
    return options.passwordlessAcknowledged
      ? null
      : '请先启动 ssh-agent 后重新检查，或明确选择无口令密钥'
  }
  if (!draft.passphrase) return '请输入私钥口令'
  if (draft.passphrase !== draft.passphraseConfirmation) return '两次输入的私钥口令不一致'
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
