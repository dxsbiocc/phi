import type { AuthStorage, CredentialOrigin } from '@oh-my-pi/pi-ai'

import { mcpOAuthCredentialId } from '../mcp/oauth'
import type {
  PhiAuth,
  PhiCredentialOrigin,
  PhiMcpOAuthCredential,
  PhiStoredCredential
} from '../types'

function normalizeCredentialOrigin(origin: CredentialOrigin | undefined): PhiCredentialOrigin {
  if (!origin) return undefined
  if (origin.kind === 'config') return 'models_json_key'
  if (origin.kind === 'runtime') return 'runtime'
  if (origin.kind === 'env') return 'environment'
  if (origin.kind === 'oauth' || origin.kind === 'api_key') return 'stored'
  return undefined
}

function storedCredentialLabel(
  entry: ReturnType<AuthStorage['credentials']['list']>[number]
): string {
  return entry.credential.type === 'oauth'
    ? (entry.credential.email ?? entry.credential.accountId ?? entry.provider)
    : entry.provider
}

export function createPhiAuth(authStorage: AuthStorage): PhiAuth {
  return {
    listCredentials(authId?: string): PhiStoredCredential[] {
      return authStorage.credentials.list(authId).map((entry) => ({
        id: String(entry.id),
        providerId: entry.provider,
        type: entry.credential.type,
        label: storedCredentialLabel(entry)
      }))
    },

    credentialStatus(providerId) {
      const source = authStorage.keys.source(providerId)
      return {
        available: source !== undefined,
        origin: normalizeCredentialOrigin(source),
        label: authStorage.keys.describe(providerId)
      }
    },

    hasOAuth(providerId) {
      return authStorage.credentials.hasOAuth(providerId)
    },

    isFromEnvironment(authId) {
      return authStorage.keys.source(authId)?.kind === 'env'
    },

    async setApiKey(providerId, key) {
      await authStorage.credentials.set(providerId, { type: 'api_key', key, source: 'login' })
    },

    async replaceApiKey(authId, key) {
      const existing = authStorage.credentials
        .list(authId)
        .filter((entry) => entry.credential.type !== 'api_key')
        .map((entry) => entry.credential)
      await authStorage.credentials.set(authId, [...existing, { type: 'api_key', key: key.trim() }])
    },

    async clearApiKeys(authId) {
      for (const entry of authStorage.credentials.list(authId)) {
        if (entry.credential.type === 'api_key') {
          await authStorage.credentials.removeById(authId, entry.id)
        }
      }
    },

    async login(providerId, callbacks) {
      await authStorage.oauth.login(providerId, {
        signal: callbacks.signal,
        onAuth: (info) => {
          callbacks.onAuth({
            url: info.launchUrl ?? info.url,
            ...(info.instructions === undefined ? {} : { instructions: info.instructions })
          })
        },
        onProgress: callbacks.onProgress,
        onManualCodeInput: callbacks.onManualCodeInput,
        onPrompt: (prompt) =>
          callbacks.onPrompt({
            message: prompt.message,
            ...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder })
          })
      })
    },

    async logout(providerId) {
      await authStorage.credentials.remove(providerId)
    },

    hasMcpOAuth(url) {
      return authStorage.credentials.get(mcpOAuthCredentialId(url)) !== undefined
    },

    hasMcpOAuthToken(url) {
      return authStorage.credentials.get(mcpOAuthCredentialId(url))?.type === 'oauth'
    },

    async setMcpOAuth(url, credential: PhiMcpOAuthCredential) {
      await authStorage.credentials.set(mcpOAuthCredentialId(url), credential)
    }
  }
}
