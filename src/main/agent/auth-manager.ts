import { IPC } from '../../shared/ipcChannels'
import { BrowserWindow, shell, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'

import {
  createModelRuntime,
  type AuthEvent,
  type AuthInteraction,
  type AuthPrompt,
  type ModelRuntime
} from './runtime/runtime-adapter'

export interface AuthProviderStatusItem {
  modelKinds?: Array<'chat' | 'decision'>
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
  attemptId: string
  requestId: string
  providerId: string
  prompt: AuthPrompt
}

export interface AuthInteractionNotifyEvent {
  type: 'notify'
  attemptId: string
  providerId: string
  event: AuthEvent
}

export type AuthInteractionEvent = AuthInteractionPromptEvent | AuthInteractionNotifyEvent

interface PendingInteraction {
  resolve: (value: string) => void
  reject: (error: Error) => void
}

type AuthWindow = BrowserWindow

function isUsableWindow(window: AuthWindow | null): window is AuthWindow {
  return Boolean(window && !window.isDestroyed() && !window.webContents.isDestroyed?.())
}

function toRendererPrompt(prompt: AuthPrompt): AuthPrompt {
  if (prompt.type === 'select') {
    return {
      type: prompt.type,
      message: prompt.message,
      options: prompt.options
    }
  }

  return {
    type: prompt.type,
    message: prompt.message,
    ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder })
  }
}

function addWindowUnavailableListener(window: AuthWindow, callback: () => void): () => void {
  const webContents = window.webContents
  const onUnavailable = (): void => callback()
  const onNavigation = (...args: unknown[]): void => {
    const isInPlace = args[2]
    const isMainFrame = args[3]
    if (isInPlace === true || isMainFrame === false) return
    callback()
  }

  window.once('closed', onUnavailable)
  webContents.once('destroyed', onUnavailable)
  webContents.once('render-process-gone', onUnavailable)
  webContents.on('did-start-navigation', onNavigation)

  return () => {
    window.removeListener('closed', onUnavailable)
    webContents.removeListener('destroyed', onUnavailable)
    webContents.removeListener('render-process-gone', onUnavailable)
    webContents.removeListener('did-start-navigation', onNavigation)
  }
}

export class AuthManager {
  private runtime: Promise<ModelRuntime> | null
  private readonly pendingInteractions = new Map<string, PendingInteraction>()
  private readonly oauthAttempts = new Map<
    string,
    { controller: AbortController; owner: WebContents }
  >()

  constructor(runtime?: Promise<ModelRuntime>) {
    // No explicit authPath: PI_CODING_AGENT_DIR (set in main/index.ts) already
    // redirects the runtime's default agent dir to Phi's own ~/.phi.
    this.runtime = runtime ?? null
  }

  async getRuntime(): Promise<ModelRuntime> {
    this.runtime ??= createModelRuntime()
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
        ...(provider.modelKinds ? { modelKinds: [...provider.modelKinds] } : {}),
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
    // runtime.setRuntimeApiKey() only holds the key in an in-memory Map — it never
    // reaches AuthStorage, so it silently doesn't survive a restart. Go through
    // runtime.login('api_key', ...) instead: same persistent path OAuth uses
    // (credentials.modify() -> auth.json). The interaction's prompt() just returns
    // the key we already collected from our own dialog, no extra round-trip.
    const interaction: AuthInteraction = {
      prompt: async () => key,
      notify: () => {}
    }
    await runtime.login(providerId, 'api_key', interaction)
    return this.getProviderStatuses()
  }

  async loginOAuth(
    providerId: string,
    attemptId: string = randomUUID(),
    sender?: WebContents
  ): Promise<AuthProviderStatusItem[]> {
    const window = sender ? BrowserWindow.fromWebContents(sender) : this.getActiveWindow()
    if (!isUsableWindow(window)) throw new Error('No active window for auth interaction')
    if (typeof attemptId !== 'string' || !attemptId || this.oauthAttempts.has(attemptId)) {
      throw new Error('Invalid auth attempt')
    }

    const controller = new AbortController()
    this.oauthAttempts.set(attemptId, { controller, owner: window.webContents })
    const detach = addWindowUnavailableListener(window, () => {
      controller.abort(new Error('Auth window was closed'))
    })
    try {
      const runtime = await this.getRuntime()
      controller.signal.throwIfAborted()
      await runtime.login(
        providerId,
        'oauth',
        this.createInteraction(providerId, attemptId, window, controller)
      )
      controller.signal.throwIfAborted()
      return await this.getProviderStatuses()
    } finally {
      this.oauthAttempts.delete(attemptId)
      detach()
      controller.abort(new Error('Auth interaction has ended'))
    }
  }

  cancelOAuth(attemptId: string, sender?: WebContents): void {
    const attempt = this.oauthAttempts.get(attemptId)
    if (attempt && (!sender || attempt.owner === sender)) {
      attempt.controller.abort(new Error('Auth interaction was cancelled'))
    }
  }

  async logout(providerId: string): Promise<void> {
    const runtime = await this.getRuntime()
    await runtime.logout(providerId)
  }

  async resolveInteraction(requestId: string, value: string): Promise<void> {
    const pending = this.pendingInteractions.get(requestId)
    if (!pending) return
    pending.resolve(value)
  }

  private createInteraction(
    providerId: string,
    attemptId: string,
    window: AuthWindow,
    interactionController: AbortController
  ): AuthInteraction {
    return {
      attemptId,
      signal: interactionController.signal,
      prompt: async (prompt: AuthPrompt): Promise<string> => {
        interactionController.signal.throwIfAborted()
        if (!isUsableWindow(window)) {
          interactionController.abort()
          throw new Error('No active window for auth interaction')
        }
        if (prompt.signal?.aborted) {
          throw new Error('Auth interaction was cancelled')
        }

        return new Promise<string>((resolve, reject) => {
          const requestId = randomUUID()
          let settled = false
          const cleanupFns: Array<() => void> = []

          const cleanup = (): void => {
            this.pendingInteractions.delete(requestId)
            for (const cleanupFn of cleanupFns.splice(0)) {
              cleanupFn()
            }
          }

          const settle = (callback: () => void): void => {
            if (settled) return
            settled = true
            cleanup()
            callback()
          }

          const pending: PendingInteraction = {
            resolve: (value: string) => {
              settle(() => resolve(value))
            },
            reject: (error: Error) => {
              settle(() => reject(error))
            }
          }

          this.pendingInteractions.set(requestId, pending)

          const onAbort = (): void =>
            pending.reject(
              interactionController.signal.reason ?? new Error('Auth interaction was cancelled')
            )
          const signals = [interactionController.signal, prompt.signal]
          for (const signal of signals) {
            if (!signal) continue
            if (signal.aborted) {
              onAbort()
              return
            }
            signal.addEventListener('abort', onAbort, { once: true })
            cleanupFns.push(() => signal.removeEventListener('abort', onAbort))
          }

          try {
            window.webContents.send(IPC.auth.interactionRequested, {
              type: 'prompt',
              attemptId,
              requestId,
              providerId,
              prompt: toRendererPrompt(prompt)
            })

            if (prompt.type === 'manual_code') {
              const url = `输入授权码完成 ${providerId} 登录`
              window.webContents.send(IPC.auth.interactionRequested, {
                type: 'notify',
                attemptId,
                providerId,
                event: {
                  type: 'info',
                  message: url
                }
              })
            }
          } catch (error) {
            pending.reject(error instanceof Error ? error : new Error(String(error)))
          }
        })
      },
      notify: (event: AuthEvent): void => {
        if (interactionController.signal.aborted || !isUsableWindow(window)) return
        try {
          window.webContents.send(IPC.auth.interactionRequested, {
            type: 'notify',
            attemptId,
            providerId,
            event
          })
          if (event.type === 'auth_url') {
            void shell.openExternal(event.url).catch((error) => interactionController.abort(error))
          }
        } catch (error) {
          interactionController.abort(error)
        }
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
