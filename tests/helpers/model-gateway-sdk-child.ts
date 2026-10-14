import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { createInterface } from 'node:readline'
import { AuthStorage, SqliteAuthCredentialStore } from '@oh-my-pi/pi-ai'
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent'
import { createPhiAuth } from '../../src/main/agent/engine/in-process/auth'
import { ModelGatewayManager } from '../../src/main/agent/engine/in-process/model-gateway'
import type { RuntimeContext } from '../../src/main/agent/engine/in-process/common'
import {
  MODEL_GATEWAY_FIXTURE_REFS as refs,
  MODEL_GATEWAY_FIXTURE_SECRETS as secrets,
  type GatewayFixtureSnapshot
} from './model-gateway-sdk-fixture'

const root = process.env.PHI_GATEWAY_FIXTURE_ROOT
const agentDir = process.env.PI_CODING_AGENT_DIR
if (!root || !agentDir) throw new Error('SDK fixture requires disposable paths')
const stats: GatewayFixtureSnapshot = {
  gateway: { leases: 0, activeRequests: 0 },
  authCalls: 0,
  commandCalls: 0,
  registryCalls: 0,
  authSignalAborts: 0,
  refreshCalls: 0,
  invalidationCalls: 0,
  authScopes: [],
  providerRequests: [],
  activeProviderStreams: 0,
  debugEnabled: false,
  rawLogFiles: [],
  logSentinels: { credential: false, gatewayBearer: false, context: false }
}
const bearers = new Set<string>()
let tokenSequence = 0
const base = process.env.PHI_GATEWAY_FIXTURE_PROVIDER_URL
if (!base || !/^https?:\/\/127\.0\.0\.1:[0-9]+$/.test(base))
  throw new Error('SDK fixture provider must be a private loopback URL')
const model = (id: string): Record<string, unknown> => ({
  id,
  name: id,
  reasoning: true,
  input: ['text'],
  contextWindow: 32768,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  compat: { thinkingFormat: 'openai' }
})
const commandMarker = join(root, 'synthetic-command-resolutions')
const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
await writeFile(
  join(agentDir, 'models.yml'),
  JSON.stringify({
    providers: {
      [refs.key.provider]: {
        api: 'openai-completions',
        auth: 'oauth',
        baseUrl: `${base}/key/v1`,
        models: [model(refs.key.id)]
      },
      [refs.none.provider]: {
        api: 'openai-completions',
        baseUrl: `${base}/none/v1`,
        auth: 'none',
        models: [model(refs.none.id)]
      },
      [refs.oauth.provider]: {
        api: 'openai-completions',
        auth: 'oauth',
        baseUrl: `${base}/oauth/v1`,
        models: [model(refs.oauth.id)]
      },
      [refs.rotate.provider]: {
        api: 'openai-completions',
        auth: 'oauth',
        baseUrl: `${base}/rotate/v1`,
        models: [model(refs.rotate.id)]
      },
      [refs.command.provider]: {
        api: 'openai-completions',
        apiKey: `!printf 'called\\n' >> ${quote(commandMarker)}; printf %s ${quote(secrets.command)}`,
        baseUrl: `${base}/command/v1`,
        models: [model(refs.command.id)]
      },
      [refs.scopeA.provider]: {
        api: 'openai-completions',
        auth: 'oauth',
        baseUrl: `${base}/scope/v1`,
        models: [
          { ...model(refs.scopeA.id), baseUrl: `${base}/scope-a/v1` },
          { ...model(refs.scopeB.id), baseUrl: `${base}/scope-b/v1` }
        ]
      }
    }
  }),
  { mode: 0o600 }
)
const authStorage = await AuthStorage.create(join(agentDir, 'auth.db'))
const registry = new ModelRegistry(authStorage, join(agentDir, 'models.yml'))
if (registry.getError()) throw new Error(inspect(registry.getError(), { depth: 8 }))
registry.registerProvider(
  refs.oauth.provider,
  {
    api: 'openai-completions',
    baseUrl: `${base}/oauth/v1`,
    oauth: {
      name: 'Private fixture OAuth',
      async login() {
        throw new Error('Interactive fixture login is disabled')
      },
      async refreshToken(credentials) {
        stats.refreshCalls++
        return {
          ...credentials,
          access: `fixture-oauth-access-${++tokenSequence}`,
          refresh: secrets.refresh,
          expires: Date.now() + 3_600_000
        }
      },
      getApiKey: (credential) => credential.access
    }
  },
  'private-sdk-fixture'
)
async function seedCredentials(key: string): Promise<void> {
  await authStorage.credentials.set(refs.key.provider, { type: 'api_key', key })
  await authStorage.credentials.set(refs.scopeA.provider, { type: 'api_key', key: secrets.scope })
  await authStorage.credentials.set(refs.rotate.provider, [
    { type: 'api_key', key: secrets.firstRotation },
    { type: 'api_key', key: secrets.nextRotation }
  ])
  await authStorage.credentials.set(refs.oauth.provider, {
    type: 'oauth',
    access: process.env.PHI_GATEWAY_FIXTURE_OAUTH_VALID
      ? 'fixture-initial-access'
      : 'fixture-expired-access',
    refresh: secrets.refresh,
    expires: Date.now() + (process.env.PHI_GATEWAY_FIXTURE_OAUTH_VALID ? 3_600_000 : -60_000),
    accountId: 'fixture-account'
  })
}
await seedCredentials(secrets.key)
function instrumentStorage(): void {
  const keys = authStorage.keys
  const resolve = keys.getWithCredential.bind(keys)
  keys.getWithCredential = (...args) => {
    stats.authCalls++
    return resolve(...args)
  }
  const limits = authStorage.limits
  const invalidate = limits.invalidateMatching.bind(limits)
  limits.invalidateMatching = (...args) => {
    stats.invalidationCalls++
    return invalidate(...args)
  }
}
instrumentStorage()
const observedSignals = new WeakSet<AbortSignal>()
const resolve = registry.getApiKeyWithCredentialForProvider.bind(registry)
registry.getApiKeyWithCredentialForProvider = (provider, sessionId, options) => {
  stats.registryCalls++
  if (options?.signal && !observedSignals.has(options.signal)) {
    observedSignals.add(options.signal)
    options.signal.addEventListener('abort', () => stats.authSignalAborts++, { once: true })
  }
  stats.authScopes.push({
    provider,
    sessionId,
    modelId: options?.modelId,
    baseUrl: options?.baseUrl,
    forceRefresh: options?.forceRefresh,
    refreshReason: options?.refreshReason,
    signalAborted: options?.signal?.aborted ?? false
  })
  return resolve(provider, sessionId, options)
}
const context: RuntimeContext = {
  agentDir,
  auth: createPhiAuth(authStorage),
  authStorage,
  modelRegistry: registry
}
const manager = new ModelGatewayManager({
  ...(process.env.PHI_GATEWAY_FIXTURE_STREAM_LIMITS
    ? { streamLimits: JSON.parse(process.env.PHI_GATEWAY_FIXTURE_STREAM_LIMITS) }
    : {}),
  context: async () => context,
  model: async (ctx, ref) => ctx.modelRegistry.find(ref.provider, ref.id)
})
let storeSequence = 0
let closing = false
async function close(): Promise<void> {
  if (closing) return
  closing = true
  await manager.closeAll()
  registry.unregisterProvider(refs.oauth.provider)
  authStorage.close()
}
async function logs(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true })
  const result: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) result.push(...(await logs(join(path, entry.name))))
    else if (/\.log$/.test(entry.name)) result.push(join(path, entry.name).slice(root!.length + 1))
  }
  return result
}
const input = createInterface({ input: process.stdin })
for await (const line of input) {
  let id: string | undefined
  try {
    const request = JSON.parse(line) as { id: string; method: string; params?: unknown }
    id = request.id
    let result: unknown
    switch (request.method) {
      case 'create': {
        const lease = await manager.create(request.params)
        bearers.add(lease.bearerToken)
        result = lease
        break
      }
      case 'revoke':
        await manager.revoke(request.params as { leaseId: string })
        break
      case 'snapshot': {
        const files = await logs(root)
        const contents = (
          await Promise.all(files.map((file) => readFile(join(root, file), 'utf8')))
        ).join('\n')
        const credentialSentinels = [
          ...Object.values(secrets).filter((value) => value !== secrets.context),
          'fixture-oauth-access-',
          'fixture-expired-access'
        ]
        result = {
          ...stats,
          commandCalls: (await readFile(commandMarker, 'utf8').catch(() => ''))
            .split('\n')
            .filter(Boolean).length,
          gateway: manager.diagnostics(),
          activeProviderStreams: 0,
          debugEnabled: Boolean(process.env.PI_REQ_DEBUG),
          rawLogFiles: files,
          logSentinels: {
            credential: credentialSentinels.some((value) => contents.includes(value)),
            gatewayBearer: [...bearers].some((value) => contents.includes(value)),
            context: contents.includes(secrets.context)
          }
        }
        break
      }
      case 'resetStats':
        stats.authCalls =
          stats.registryCalls =
          stats.refreshCalls =
          stats.invalidationCalls =
          stats.authSignalAborts =
            0
        stats.authScopes = []
        stats.providerRequests = []
        break
      case 'replaceStore':
        await authStorage.replaceStore(
          await SqliteAuthCredentialStore.open(join(agentDir, `replacement-${++storeSequence}.db`))
        )
        await seedCredentials(secrets.replacement)
        instrumentStorage()
        break
      case 'close':
        await close()
        break
      default:
        throw new Error('Unknown SDK fixture command')
    }
    process.stdout.write(JSON.stringify({ id, ok: true, result }) + '\n')
    if (request.method === 'close') break
  } catch (error) {
    process.stdout.write(
      JSON.stringify({
        id,
        ok: false,
        error: error instanceof Error ? error.message : 'Private fixture command failed'
      }) + '\n'
    )
  }
}
input.close()
await close()
