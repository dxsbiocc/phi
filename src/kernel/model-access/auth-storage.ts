import {
  AuthStorage,
  getOAuthApiKey,
  type AuthApiKeyOptions,
  type OAuthProvider,
  type ResolvedApiKey
} from '../omp/model-access'

import { ModelAccessReadOnlyError } from './errors'
import type { MemoryAuthCredentialStore } from './memory-credential-store'

type ReadOnlyAuthOptions = {
  sourceLabel: string
  reloadBeforeCredentialRead?: (provider?: string) => Promise<void>
  brokerBackedProviders?: ReadonlySet<string>
}

type StoredRow = ReturnType<AuthStorage['credentials']['list']>[number]
type ConcreteStoredAuthSource =
  | { kind: 'oauth'; concrete: true }
  | {
      kind: 'api_key'
      concrete: true
    }
type StoredAuthSource = ConcreteStoredAuthSource | undefined

function brokerCredentialSource(storage: AuthStorage, provider: string): StoredAuthSource {
  const rows = storage.credentials.list(provider)
  if (rows.some((row) => row.credential.type === 'oauth')) {
    return { kind: 'oauth', concrete: true }
  }
  return rows.some((row) => row.credential.type === 'api_key')
    ? { kind: 'api_key', concrete: true }
    : undefined
}

function apiKeyResolution(rows: StoredRow[]): ResolvedApiKey | undefined {
  const row =
    rows.find(
      (candidate) =>
        candidate.credential.type === 'api_key' && candidate.credential.source === 'login'
    ) ?? rows.find((candidate) => candidate.credential.type === 'api_key')
  return row?.credential.type === 'api_key'
    ? { apiKey: row.credential.key, credentialId: row.id }
    : undefined
}

async function oauthResolution(
  storage: AuthStorage,
  provider: string,
  sessionId?: string,
  options?: AuthApiKeyOptions
): Promise<ResolvedApiKey | undefined> {
  const access = await storage.oauth.access(provider, sessionId, options)
  if (!access) return undefined
  const row = storage.credentials
    .list(provider)
    .find(
      (candidate) => candidate.id === access.credentialId && candidate.credential.type === 'oauth'
    )
  if (row?.credential.type !== 'oauth') return undefined
  const resolved = await getOAuthApiKey(provider as OAuthProvider, {
    [provider]: row.credential
  })
  if (!resolved) return undefined
  return {
    apiKey: resolved.apiKey,
    credentialId: row.id,
    oauthIdentity: {
      ...(access.accountId ? { accountId: access.accountId } : {}),
      ...(access.projectId ? { projectId: access.projectId } : {}),
      ...(access.enterpriseUrl ? { enterpriseUrl: access.enterpriseUrl } : {}),
      ...(access.apiEndpoint ? { apiEndpoint: access.apiEndpoint } : {}),
      ...(access.orgId ? { orgId: access.orgId } : {}),
      ...(access.region ? { region: access.region } : {}),
      ...(access.inferenceRegion ? { inferenceRegion: access.inferenceRegion } : {})
    }
  }
}

function bindValue(target: object, property: PropertyKey): unknown {
  const value = Reflect.get(target, property, target)
  return typeof value === 'function' ? value.bind(target) : value
}

function namespaceProxy<T extends object>(
  target: T,
  overrides: Readonly<Record<PropertyKey, unknown>>
): T {
  return new Proxy(target, {
    get(inner, property) {
      if (Object.hasOwn(overrides, property)) return overrides[property]
      return bindValue(inner, property)
    }
  })
}

function storedKeyOverrides(
  storage: AuthStorage,
  options: ReadOnlyAuthOptions
): Readonly<Record<PropertyKey, unknown>> {
  const brokerBacked = (provider: string): boolean =>
    options.brokerBackedProviders?.has(provider) === true
  const configuredSource = (provider: string): boolean => {
    if (brokerBacked(provider)) return false
    const kind = storage.keys.source(provider, { env: 'none' })?.kind
    return kind === 'config' || kind === 'runtime'
  }
  const refresh = async (provider: string): Promise<void> => {
    await options.reloadBeforeCredentialRead?.(provider)
  }
  const resolve = async (
    provider: string,
    sessionId?: string,
    keyOptions?: AuthApiKeyOptions
  ): Promise<ResolvedApiKey | undefined> => {
    if (configuredSource(provider)) {
      return storage.keys.getWithCredential(provider, sessionId, keyOptions)
    }
    await refresh(provider)
    const rows = storage.credentials.list(provider)
    return rows.some((row) => row.credential.type === 'oauth')
      ? ((await oauthResolution(storage, provider, sessionId, keyOptions)) ??
          apiKeyResolution(rows))
      : apiKeyResolution(rows)
  }
  const peek = async (provider: string): Promise<string | undefined> => {
    if (configuredSource(provider)) return storage.keys.peek(provider)
    // Discovery probes are advisory and must never turn an absent desktop broker into a
    // session-creation failure. Request paths use resolve(), which still refreshes/fails closed.
    const rows = storage.credentials.list(provider)
    const oauth = rows.find(
      (row) => row.credential.type === 'oauth' && row.credential.expires > Date.now()
    )
    if (oauth?.credential.type === 'oauth') {
      return (await getOAuthApiKey(provider as OAuthProvider, { [provider]: oauth.credential }))
        ?.apiKey
    }
    return apiKeyResolution(rows)?.apiKey
  }
  return {
    get: async (provider: string, sessionId?: string, keyOptions?: AuthApiKeyOptions) =>
      (await resolve(provider, sessionId, keyOptions))?.apiKey,
    getWithCredential: resolve,
    peek,
    source: (provider: string) =>
      brokerBacked(provider)
        ? brokerCredentialSource(storage, provider)
        : storage.keys.source(provider, { env: 'none' }),
    describe: (provider: string) =>
      configuredSource(provider)
        ? storage.keys.describe(provider)
        : brokerCredentialSource(storage, provider)
          ? options.sourceLabel
          : undefined,
    resolver:
      (
        provider: string,
        resolverOptions?: { sessionId?: string; baseUrl?: string; modelId?: string }
      ) =>
      async (context: { error: unknown; lastChance: boolean; signal?: AbortSignal }) =>
        resolve(provider, resolverOptions?.sessionId, {
          baseUrl: resolverOptions?.baseUrl,
          modelId: resolverOptions?.modelId,
          signal: context.signal,
          forceRefresh: context.error !== undefined && !context.lastChance,
          ...(context.error !== undefined ? { refreshReason: 'auth-recovery' as const } : {})
        })
  }
}

export function createReadOnlyAuthStorage(
  store: MemoryAuthCredentialStore,
  options: ReadOnlyAuthOptions
): { authStorage: AuthStorage; storage: AuthStorage } {
  const storage = new AuthStorage(store, { sourceLabel: options.sourceLabel })
  const credentials = namespaceProxy(storage.credentials, {
    set: () => Promise.reject(new ModelAccessReadOnlyError('set')),
    remove: () => Promise.reject(new ModelAccessReadOnlyError('remove')),
    removeById: () => Promise.reject(new ModelAccessReadOnlyError('removeById')),
    upsert: () => Promise.reject(new ModelAccessReadOnlyError('upsert')),
    upsertOAuth: () => Promise.reject(new ModelAccessReadOnlyError('upsert'))
  })
  const oauth = namespaceProxy(storage.oauth, {
    login: () => Promise.reject(new ModelAccessReadOnlyError('login'))
  })

  const keys = namespaceProxy(storage.keys, storedKeyOverrides(storage, options))
  const authStorage = new Proxy(storage, {
    get(target, property) {
      if (property === 'credentials') return credentials
      if (property === 'oauth') return oauth
      if (property === 'keys') return keys
      return bindValue(target, property)
    }
  })
  return { authStorage, storage }
}
