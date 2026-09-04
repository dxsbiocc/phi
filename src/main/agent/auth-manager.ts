import { BrowserWindow, shell } from 'electron'
import { randomUUID } from 'node:crypto'

import { ModelRuntime } from '@earendil-works/pi-coding-agent'
type AuthInteraction = {
  signal?: AbortSignal
  prompt(prompt: AuthPrompt): Promise<string>
  notify(event: AuthEvent): void
}

type AuthPrompt =
  | {
      type: 'text'
      message: string
      placeholder?: string
      signal?: AbortSignal
    }
  | {
      type: 'secret'
      message: string
      placeholder?: string
      signal?: AbortSignal
    }
  | {
      type: 'select'
      message: string
      options: ReadonlyArray<{ id: string; label: string; description?: string }>
      signal?: AbortSignal
    }
  | {
      type: 'manual_code'
      message: string
      placeholder?: string
      signal?: AbortSignal
    }

type AuthEvent =
  | {
      type: 'info'
      message: string
      links?: ReadonlyArray<{ url: string; label?: string }>
    }
  | {
      type: 'auth_url'
      url: string
      instructions?: string
    }
  | {
      type: 'device_code'
      userCode: string
      verificationUri: string
      intervalSeconds?: number
      expiresInSeconds?: number
    }
  | {
      type: 'progress'
      message: string
    }

export interface AuthProviderStatusItem {
  providerId: string
  name: string
  configured: boolean
  source?:
    'stored' | 'runtime' | 'environment' | 'fallback' | 'models_json_key' | 'models_json_command'
  label?: string
  hasApiKey: boolean
  hasOAuth: boolean
  hasConfigError: boolean
  statusText: string
}

export interface AuthInteractionPromptEvent {
  type: 'prompt'
  requestId: string
  providerId: string
  prompt: AuthPrompt
}

export interface AuthInteractionNotifyEvent {
  type: 'notify'
  providerId: string
  event: AuthEvent
}

export type AuthInteractionEvent = AuthInteractionPromptEvent | AuthInteractionNotifyEvent

interface PendingInteraction {
  resolve: (value: string) => void
  reject: (error: Error) => void
  cleanup: () => void
}

export class AuthManager {
  private readonly runtime: Promise<ModelRuntime>
  private readonly pendingInteractions = new Map<string, PendingInteraction>()

  constructor() {
    // No explicit authPath: PI_CODING_AGENT_DIR (set in main/index.ts) already
    // redirects the SDK's default agent dir to pi-desktop's own ~/.phi, isolated
    // from the pi CLI's ~/.pi/agent — no shared credential file, no lock contention.
    this.runtime = ModelRuntime.create()
  }

  async getRuntime(): Promise<ModelRuntime> {
    return this.runtime
  }

  async getProviderStatuses(): Promise<AuthProviderStatusItem[]> {
    const runtime = await this.getRuntime()
    const providers = runtime.getProviders()
    const credentials = await runtime.listCredentials()
    const credentialProviderIds = new Set(credentials.map((entry) => entry.providerId))

    return providers.map((provider) => {
      const baseStatus = runtime.getProviderAuthStatus(provider.id)
      const hasStoredCredential = credentialProviderIds.has(provider.id)
      const configured = baseStatus.configured || hasStoredCredential
      const hasConfigError = false
      const statusText = configured ? (baseStatus.source ?? '已配置') : '未配置'

      return {
        providerId: provider.id,
        name: provider.name || provider.id,
        configured,
        source: baseStatus.source,
        label: baseStatus.label,
        hasApiKey: Boolean(provider.auth?.apiKey),
        hasOAuth: Boolean(provider.auth?.oauth),
        hasConfigError,
        statusText
      }
    })
  }

  async loginApiKey(providerId: string, key: string): Promise<AuthProviderStatusItem[]> {
    const runtime = await this.getRuntime()
    await runtime.setRuntimeApiKey(providerId, key)
    return this.getProviderStatuses()
  }

  async loginOAuth(providerId: string): Promise<AuthProviderStatusItem[]> {
    const runtime = await this.getRuntime()
    const interaction = this.createInteraction(providerId)
    await runtime.login(providerId, 'oauth', interaction)
    return this.getProviderStatuses()
  }

  async logout(providerId: string): Promise<void> {
    const runtime = await this.getRuntime()
    await runtime.logout(providerId)
  }

  async resolveInteraction(requestId: string, value: string): Promise<void> {
    const pending = this.pendingInteractions.get(requestId)
    if (!pending) {
      throw new Error('No pending auth interaction')
    }

    this.pendingInteractions.delete(requestId)
    pending.cleanup()
    pending.resolve(value)
  }

  private createInteraction(providerId: string): AuthInteraction {
    return {
      prompt: async (prompt: AuthPrompt): Promise<string> => {
        const window = this.getActiveWindow()
        if (!window) {
          throw new Error('No active window for auth interaction')
        }

        return new Promise<string>((resolve, reject) => {
          const requestId = randomUUID()
          const cleanup = (): void => {
            this.pendingInteractions.delete(requestId)
          }

          const pending: PendingInteraction = {
            resolve: (value: string) => {
              cleanup()
              resolve(value)
            },
            reject: (error: Error) => {
              cleanup()
              reject(error)
            },
            cleanup: () => {
              this.pendingInteractions.delete(requestId)
            }
          }

          this.pendingInteractions.set(requestId, pending)

          window.webContents.send('auth:interaction', {
            type: 'prompt',
            requestId,
            providerId,
            prompt
          })

          if (prompt.type === 'manual_code') {
            const url = `输入授权码完成 ${providerId} 登录`
            window.webContents.send('auth:interaction', {
              type: 'notify',
              providerId,
              event: {
                type: 'info',
                message: url
              }
            })
          }
        })
      },
      notify: (event: AuthEvent): void => {
        if (event.type === 'auth_url') {
          void shell.openExternal(event.url)
        }

        const targetWindow = this.getActiveWindow()
        if (!targetWindow) {
          return
        }

        targetWindow.webContents.send('auth:interaction', {
          type: 'notify',
          providerId,
          event
        })
      }
    }
  }

  private getActiveWindow(): BrowserWindow | null {
    return (
      BrowserWindow.getFocusedWindow() ??
      BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ??
      null
    )
  }
}

const authManager = new AuthManager()

export function getAuthManager(): AuthManager {
  return authManager
}
