import { randomUUID } from 'node:crypto'
import { ModelRegistry, discoverAuthStorage } from '@oh-my-pi/pi-coding-agent'
import {
  authPolicyFor,
  getCatalogProviderEntry,
  parseConfiguredThinkingLevel,
  type ConfiguredThinkingLevel,
  type PhiModel
} from '../omp-internals'
import { cursorModelWithBridge } from '../cursor-model-routing'
import { createPhiAuth } from './auth'
import { PhiAuth } from '../types'
import { WEB_SEARCH_PROVIDER_DETAILS } from '../../web-search-settings'
import {
  RuntimeContext,
  RuntimeModel,
  RuntimeModelSummary,
  ThinkingLevel,
  UnknownRecord,
  isRecord,
  stringArrayValue,
  stringValue
} from './common'
import { requestHost, sendEvent } from './ipc'
import { RuntimeThinkingLevel, contexts, pendingAuthPrompts } from './state'

export const THINKING_LEVELS: ThinkingLevel[] = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max']

export async function getContext(agentDirParam?: unknown): Promise<RuntimeContext> {
  const agentDir = stringValue(agentDirParam, process.env.PI_CODING_AGENT_DIR)
  const key = agentDir || '__default__'
  const existing = contexts.get(key)
  if (existing) return existing

  const promise = (async (): Promise<RuntimeContext> => {
    if (agentDir) process.env.PI_CODING_AGENT_DIR = agentDir
    const authStorage = await discoverAuthStorage(agentDir || undefined)
    const auth = createPhiAuth(authStorage)
    const modelRegistry = new ModelRegistry(authStorage)
    await modelRegistry.hydrateCredentialScopedModelCaches().catch(() => undefined)
    return { agentDir, auth, authStorage, modelRegistry }
  })()
  contexts.set(key, promise)
  return promise
}

export function webSearchAuthStatus(auth: PhiAuth): Record<
  string,
  {
    apiKeyConfigured: boolean
    apiKeyStored: boolean
    oauthConfigured: boolean
  }
> {
  return Object.fromEntries(
    Object.entries(WEB_SEARCH_PROVIDER_DETAILS).map(([id, detail]) => {
      const keyId = 'apiKeyAuthId' in detail ? detail.apiKeyAuthId : undefined
      const oauthIds = 'oauthAuthIds' in detail ? detail.oauthAuthIds : []
      const storedKey = keyId
        ? auth.listCredentials(keyId).some((entry) => entry.type === 'api_key')
        : false
      const envNames =
        'apiKeyEnv' in detail
          ? [
              detail.apiKeyEnv,
              ...(id === 'kimi' ? ['MOONSHOT_SEARCH_API_KEY'] : []),
              ...(id === 'anthropic' ? ['ANTHROPIC_SEARCH_API_KEY'] : [])
            ]
          : []
      const envKey = Boolean(
        (keyId && auth.isFromEnvironment(keyId)) ||
        envNames.some((name) => Boolean(process.env[name]?.trim()))
      )
      return [
        id,
        {
          apiKeyConfigured: storedKey || envKey,
          apiKeyStored: storedKey,
          oauthConfigured: oauthIds.some((provider) => auth.hasOAuth(provider))
        }
      ]
    })
  )
}

export function serializeThinkingMap(
  model: PhiModel
): Partial<Record<ThinkingLevel, string | null>> | undefined {
  const thinking = model.thinking as { efforts?: unknown } | undefined
  const efforts = stringArrayValue(thinking?.efforts)
  if (!efforts) return undefined

  return Object.fromEntries(
    THINKING_LEVELS.map((level) => [level, efforts.includes(level) ? level : null])
  ) as Partial<Record<ThinkingLevel, string | null>>
}

export function serializeModel(model: PhiModel): RuntimeModelSummary {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name || model.id,
    reasoning: Boolean(model.reasoning),
    supportsImages: model.input.includes('image'),
    ...(serializeThinkingMap(model) ? { thinkingLevelMap: serializeThinkingMap(model) } : {})
  }
}

export function configuredThinkingLevel(value: unknown): ConfiguredThinkingLevel | undefined {
  return typeof value === 'string' ? parseConfiguredThinkingLevel(value) : undefined
}

export function runtimeThinkingLevel(value: unknown): RuntimeThinkingLevel {
  return configuredThinkingLevel(value) as RuntimeThinkingLevel
}

export function hasOAuth(policy: ReturnType<typeof authPolicyFor>): boolean {
  const kind = policy?.login?.kind
  return kind === 'oauth-code' || kind === 'device-code' || kind === 'custom'
}

export function hasApiKey(policy: ReturnType<typeof authPolicyFor>, providerId: string): boolean {
  const entry = getCatalogProviderEntry(providerId) as UnknownRecord | undefined
  const envVars = Array.isArray(entry?.envVars) ? entry.envVars : []
  return policy?.login?.kind === 'api-key' || policy?.result === 'api-key' || envVars.length > 0
}

export function providerName(providerId: string): string {
  const policy = authPolicyFor(providerId)
  const catalog = getCatalogProviderEntry(providerId) as UnknownRecord | undefined
  const catalogDiscovery = catalog?.catalogDiscovery
  if (policy?.name) return policy.name
  if (isRecord(catalogDiscovery) && typeof catalogDiscovery.label === 'string') {
    return catalogDiscovery.label
  }
  return providerId
}

export async function modelRuntimeSnapshot(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const ctx = await getContext(record.agentDir)
  const models = ctx.modelRegistry.getAll().map(serializeModel)
  const providerIds = [...new Set(models.map((model) => model.provider))].sort()
  const credentials = ctx.auth.listCredentials()

  return {
    providers: providerIds.map((id) => {
      const policy = authPolicyFor(id)
      const status = ctx.auth.credentialStatus(id)
      const configured =
        status.available || credentials.some((credential) => credential.providerId === id)

      return {
        id,
        name: providerName(id),
        auth: {
          apiKey: hasApiKey(policy, id),
          oauth: hasOAuth(policy)
        },
        status: {
          configured,
          source: status.origin,
          label: status.label
        }
      }
    }),
    models,
    credentials
  }
}

export async function loginModelRuntime(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const providerId = stringValue(record.providerId)
  const type = stringValue(record.type)
  const ctx = await getContext(record.agentDir)
  if (!providerId) throw new Error('Missing providerId')

  if (type === 'api_key') {
    const key = stringValue(record.key)
    if (!key) throw new Error('Missing API key')
    await ctx.auth.setApiKey(providerId, key)
    await ctx.modelRegistry.refresh('offline').catch(() => undefined)
    return modelRuntimeSnapshot(record)
  }

  if (type !== 'oauth') {
    throw new Error(`Unsupported auth type: ${type}`)
  }

  await ctx.auth.login(providerId, {
    signal: undefined,
    onAuth: (info) => {
      sendEvent('authNotify', {
        providerId,
        event: {
          type: 'auth_url',
          url: info.url,
          instructions: info.instructions
        }
      })
    },
    onProgress: (message) => {
      sendEvent('authNotify', {
        providerId,
        event: {
          type: 'progress',
          message
        }
      })
    },
    onManualCodeInput: () =>
      requestAuthPrompt(providerId, {
        type: 'manual_code',
        message: `输入授权码完成 ${providerId} 登录`
      }),
    onPrompt: (prompt) =>
      requestAuthPrompt(providerId, {
        type: 'text',
        message: prompt.message,
        ...(prompt.placeholder ? { placeholder: prompt.placeholder } : {})
      })
  })
  await ctx.modelRegistry.refresh('offline').catch(() => undefined)
  return modelRuntimeSnapshot(record)
}

export async function logoutModelRuntime(params: unknown): Promise<unknown> {
  const record = isRecord(params) ? params : {}
  const providerId = stringValue(record.providerId)
  const ctx = await getContext(record.agentDir)
  if (!providerId) throw new Error('Missing providerId')
  await ctx.auth.logout(providerId)
  await ctx.modelRegistry.refresh('offline').catch(() => undefined)
  return modelRuntimeSnapshot(record)
}

export function requestAuthPrompt(providerId: string, prompt: UnknownRecord): Promise<string> {
  const requestId = randomUUID()
  sendEvent(
    'authPrompt',
    {
      providerId,
      prompt
    },
    { requestId }
  )
  return new Promise<string>((resolve, reject) => {
    pendingAuthPrompts.set(requestId, {
      resolve,
      reject
    })
  })
}

export async function modelBySelector(
  ctx: RuntimeContext,
  modelLike: unknown
): Promise<RuntimeModel | undefined> {
  if (!isRecord(modelLike)) return undefined
  const provider = stringValue(modelLike.provider)
  const modelId = stringValue(modelLike.id)
  if (!provider || !modelId) return undefined
  const model = ctx.modelRegistry.find(provider, modelId)
  return cursorModelWithBridge(model, async () => {
    const response = await requestHost('cursorBridge.ensure', {})
    if (!isRecord(response) || typeof response.baseUrl !== 'string') {
      throw new Error('Cursor HTTP/2 桥接不可用')
    }
    return response.baseUrl
  })
}
