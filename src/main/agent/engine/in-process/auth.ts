import type { AuthStorage, CredentialOrigin } from '@oh-my-pi/pi-ai'
import { mcpOAuthCredentialId } from '@oh-my-pi/pi-coding-agent/mcp/oauth-flow'

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
  if (origin.kind === 'fallback') return 'fallback'
  return undefined
}

function storedCredentialLabel(
  entry: ReturnType<AuthStorage['listStoredCredentials']>[number]
): string {
  return entry.credential.type === 'oauth'
    ? (entry.credential.email ?? entry.credential.accountId ?? entry.provider)
    : entry.provider
}

export function createPhiAuth(authStorage: AuthStorage): PhiAuth {
  return {
    listCredentials(authId?: string): PhiStoredCredential[] {
      return authStorage.listStoredCredentials(authId).map((entry) => ({
        id: String(entry.id),
        providerId: entry.provider,
        type: entry.credential.type,
        label: storedCredentialLabel(entry)
      }))
    },

    credentialStatus(providerId) {
      return {
        available: authStorage.hasAuth(providerId) || authStorage.hasConcreteAuth(providerId),
        origin: normalizeCredentialOrigin(authStorage.getCredentialOrigin(providerId)),
        label: authStorage.describeCredentialSource(providerId)
      }
    },

    hasOAuth(providerId) {
      return authStorage.hasOAuth(providerId)
    },

    isFromEnvironment(authId) {
      return authStorage.getCredentialOrigin(authId)?.kind === 'env'
    },

    async setApiKey(providerId, key) {
      await authStorage.set(providerId, { type: 'api_key', key, source: 'login' })
    },

    async replaceApiKey(authId, key) {
      const existing = authStorage
        .listStoredCredentials(authId)
        .filter((entry) => entry.credential.type !== 'api_key')
        .map((entry) => entry.credential)
      await authStorage.set(authId, [...existing, { type: 'api_key', key: key.trim() }])
    },

    async clearApiKeys(authId) {
      for (const entry of authStorage.listStoredCredentials(authId)) {
        if (entry.credential.type === 'api_key') {
          await authStorage.removeCredential(authId, entry.id)
        }
      }
    },

    async login(providerId, callbacks) {
      await authStorage.login(providerId, {
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
      await authStorage.logout(providerId)
    },

    hasMcpOAuth(url) {
      return authStorage.get(mcpOAuthCredentialId(url)) !== undefined
    },

    hasMcpOAuthToken(url) {
      return authStorage.get(mcpOAuthCredentialId(url))?.type === 'oauth'
    },

    async setMcpOAuth(url, credential: PhiMcpOAuthCredential) {
      await authStorage.set(mcpOAuthCredentialId(url), credential)
    }
  }
}
