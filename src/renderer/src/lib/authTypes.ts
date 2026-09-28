export type AuthPromptType = 'text' | 'secret' | 'select' | 'manual_code'

export interface AuthPrompt {
  type: AuthPromptType
  message: string
  placeholder?: string
  options?: ReadonlyArray<{ id: string; label: string; description?: string }>
}

export interface AuthPromptInteraction {
  requestId: string
  providerId: string
  prompt: AuthPrompt
  value: string
}

export type ActiveAuthPrompt = AuthPromptInteraction

export type AuthEvent =
  | {
      type: 'info'
      message: string
      links?: ReadonlyArray<{ url: string; label?: string }>
    }
  | { type: 'auth_url'; url: string; instructions?: string }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | { type: 'progress'; message: string }

export type AuthInteractionEvent =
  | {
      type: 'prompt'
      requestId: string
      providerId: string
      prompt: AuthPrompt
    }
  | {
      type: 'notify'
      providerId: string
      event: AuthEvent
    }
