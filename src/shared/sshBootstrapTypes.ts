export type SshBootstrapPublicErrorCode =
  | 'proxy_unsupported'
  | 'keyboard_interactive_unsupported'
  | 'pubkey_auth_disabled'
  | 'openssh_too_old'
  | 'host_key_changed'
  | 'authentication_failed'
  | 'password_attempts_exhausted'
  | 'linux_agent_missing'
  | 'key_not_loaded'
  | 'unsupported_platform'
  | 'unexpected'

export interface SshBootstrapTarget {
  alias: string
  hostname: string
  user: string
  port: number
}

export interface SshHostKeyFingerprint {
  algorithm: string
  sha256: string
}

export type SshBootstrapAgentState = 'ready' | 'missing-linux'

export type SshBootstrapInspection =
  | {
      status: 'ready'
      attemptId: string
      agentState: SshBootstrapAgentState
    }
  | {
      status: 'confirmation-required'
      attemptId: string
      fingerprints: SshHostKeyFingerprint[]
    }
  | {
      status: 'rejected'
      errorCode: SshBootstrapPublicErrorCode
    }

export type SshBootstrapHostKeyConfirmation =
  | {
      status: 'ready'
      attemptId: string
      agentState: SshBootstrapAgentState
    }
  | {
      status: 'rejected'
      errorCode: SshBootstrapPublicErrorCode
    }

export interface SshBootstrapPasswordRequest {
  password: string
}

export type SshBootstrapKeyProtectionRequest =
  { keyProtection: 'passphrase'; passphrase: string } | { keyProtection: 'passwordless-explicit' }

export type SshBootstrapCredentialRequest = SshBootstrapPasswordRequest &
  SshBootstrapKeyProtectionRequest

export type SshBootstrapPasswordVerification =
  | {
      status: 'ready'
      attemptId: string
      agentState: SshBootstrapAgentState
    }
  | {
      status: 'failed'
      errorCode: SshBootstrapPublicErrorCode
      retryable: boolean
    }

export type SshBootstrapPreparation =
  | {
      status: 'config-preview'
      operationId: string
      preview: string
      keyFingerprint: string
      keyDisplayPath: string
    }
  | {
      status: 'failed'
      errorCode: SshBootstrapPublicErrorCode
      retryable: boolean
    }

export interface SshBootstrapFinalResult {
  configured: boolean
  keyFingerprint: string
  keyDisplayPath: string
  manualConfig?: string
}

export interface SshBootstrapRendererBridge {
  inspectTarget(input: SshBootstrapTarget): Promise<SshBootstrapInspection>
  confirmHostKey(attemptId: string): Promise<SshBootstrapHostKeyConfirmation>
  verifyPassword(
    attemptId: string,
    input: SshBootstrapPasswordRequest
  ): Promise<SshBootstrapPasswordVerification>
  completeWithKeyProtection(
    attemptId: string,
    input: SshBootstrapKeyProtectionRequest
  ): Promise<SshBootstrapPreparation>
  saveConfig(operationId: string): Promise<SshBootstrapFinalResult>
  declineConfig(operationId: string): Promise<SshBootstrapFinalResult>
  cancel(id: string): Promise<void>
}
