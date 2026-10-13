import { readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { AuthStorage, streamSimple, type Context, type SimpleStreamOptions } from '@oh-my-pi/pi-ai'
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent'
import { createNativeStreamIntegrityAdapter } from '../../src/main/agent/engine/phi-extension/lib/rpc-native-stream-adapter'
import { createPhiAuth } from '../../src/main/agent/engine/in-process/auth'
import { ModelGatewayManager } from '../../src/main/agent/engine/in-process/model-gateway'
import type { RuntimeContext } from '../../src/main/agent/engine/in-process/common'
import type { ModelGatewayLease } from '../../src/main/agent/engine/model-gateway-types'
import {
  VENDOR_REFS as refs,
  VENDOR_SECRETS as secrets,
  type VendorKind
} from './model-gateway-vendor-provider'

const root = process.env.PHI_VENDOR_ROOT
const agentDir = process.env.PI_CODING_AGENT_DIR
const base = process.env.PHI_VENDOR_URL
if (!root || !agentDir || !base || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(base))
  throw new Error('Private vendor fixture paths required')
// The official endpoint predicate controls redacted-thinking normalization.
// Only this synthetic path is redirected after the real SDK built auth/body.
// A configured private proxy selects Cowork's public fetch fallback; this test
// does not claim Cowork TLS fingerprint or external-network compatibility.
const nativeFetch = globalThis.fetch
const redirectedOrigins: string[] = []
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (
    url.origin === 'https://api.anthropic.com' &&
    url.pathname === '/phi-parity/v1/messages' &&
    (url.search === '' || url.search === '?beta=true')
  ) {
    redirectedOrigins.push(url.href)
    const safeInit = { ...init } as RequestInit & { proxy?: string }
    delete safeInit.proxy
    return nativeFetch(base + '/anthropic/v1/messages', safeInit)
  }
  if (url.hostname !== '127.0.0.1' || url.protocol !== 'http:')
    throw new Error('External fixture request refused')
  return nativeFetch(input, init)
}, {})
const codexToken = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'synthetic-codex-account' }, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.synthetic-signature`
const providers: Record<
  string,
  { api: string; baseUrl: string; auth: string; models: Array<Record<string, unknown>> }
> = Object.fromEntries(
  Object.entries(refs).map(([kind, ref]) => [
    ref.provider,
    {
      api: kind.startsWith('anthropic')
        ? 'anthropic-messages'
        : kind === 'codex'
          ? 'openai-codex-responses'
          : 'openai-responses',
      auth: kind.startsWith('anthropic') ? 'apiKey' : 'oauth',
      baseUrl: kind.startsWith('anthropic')
        ? 'https://api.anthropic.com/phi-parity'
        : `${base}/${kind}/v1`,

      models: [
        {
          id: ref.id,
          name: ref.id,
          ...(kind.startsWith('anthropic')
            ? { baseUrl: `https://api.anthropic.com/phi-parity/${kind}` }
            : {}),
          reasoning: true,
          input: ['text'],
          contextWindow: 32768,
          maxTokens: 1024,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          ...(kind === 'codex' ? { preferWebsockets: true } : {})
        }
      ]
    }
  ])
)
// Use the catalog's actual Anthropic model; custom model defaults force OAuth
// shaping even for a stored API key and would invalidate the key baseline.
delete (providers.anthropic as { models?: unknown }).models
await writeFile(join(agentDir, 'models.yml'), JSON.stringify({ providers }), { mode: 0o600 })
const storage = await AuthStorage.create(join(agentDir, 'auth.db'))
const registry = new ModelRegistry(storage, join(agentDir, 'models.yml'))
if (registry.getError()) throw new Error('Invalid vendor fixture models')
let refreshes = 0
for (const kind of ['anthropicOAuth', 'codex'] as const) {
  const ref = refs[kind]
  registry.registerProvider(
    ref.provider,
    {
      api: kind === 'codex' ? 'openai-codex-responses' : 'anthropic-messages',
      baseUrl: kind === 'codex' ? `${base}/${kind}/v1` : 'https://api.anthropic.com/phi-parity',
      oauth: {
        name: 'Private synthetic vendor OAuth',
        async login() {
          throw new Error('Interactive OAuth disabled')
        },
        async refreshToken(credentials) {
          refreshes++
          return {
            ...credentials,
            access: kind === 'codex' ? codexToken : `${secrets.oauth}-${refreshes}`,
            expires: Date.now() + 3600000
          }
        },
        getApiKey: (credential) => credential.access
      }
    },
    'private-vendor-parity'
  )
  await storage.credentials.set(ref.provider, {
    type: 'oauth',
    access: kind === 'codex' ? codexToken : secrets.oauth,
    refresh: secrets.refresh,
    expires: Date.now() + 3600000,
    accountId: kind === 'codex' ? 'synthetic-codex-account' : 'synthetic-anthropic-account',
    orgId: kind === 'anthropicOAuth' ? 'synthetic-anthropic-org' : undefined
  })
}
for (const kind of ['anthropicKey', 'responses'] as const)
  await storage.credentials.set(refs[kind].provider, { type: 'api_key', key: secrets.key })
const context: RuntimeContext = {
  agentDir,
  auth: createPhiAuth(storage),
  authStorage: storage,
  modelRegistry: registry
}
const manager = new ModelGatewayManager({
  context: async () => context,
  model: async (ctx, ref) => ctx.modelRegistry.find(ref.provider, ref.id)
})
const leases = new Map<VendorKind, ModelGatewayLease>()
const states = new Map<VendorKind, Map<string, unknown>>()
const wire: Array<{
  credentialInBody: boolean
  credentialInHeader: boolean
  responseHeaders: Record<string, string>
  redactedOnWire: boolean
  rawErrorLeak: boolean
}> = []
async function logs(path: string): Promise<string[]> {
  const found: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) found.push(...(await logs(child)))
    else if (entry.name.endsWith('.log')) found.push(await readFile(child, 'utf8'))
  }
  return found
}
async function close(): Promise<void> {
  await manager.closeAll()
  for (const kind of ['anthropicOAuth', 'codex'] as const)
    registry.unregisterProvider(refs[kind].provider)
  storage.close()
}
const input = createInterface({ input: process.stdin })
try {
  for await (const line of input) {
    let id: string | undefined
    try {
      if (Buffer.byteLength(line) > 4 * 1024 * 1024)
        throw new Error('Private command exceeds bound')
      const request = JSON.parse(line) as {
        id: string
        method: string
        params: { kind: VendorKind; hop?: boolean; context?: Context; cancel?: boolean }
      }
      id = request.id
      let result: unknown
      if (request.method === 'create') {
        const kind = request.params.kind
        if (kind === 'anthropicOAuth')
          await storage.credentials.set(refs[kind].provider, {
            type: 'oauth',
            access: secrets.oauth,
            refresh: secrets.refresh,
            expires: Date.now() + 3600000,
            accountId: 'synthetic-anthropic-account',
            orgId: 'synthetic-anthropic-org'
          })
        const lease = await manager.create({
          sessionId: `vendor-${kind}`,
          generation: 1,
          models: [refs[kind]]
        })
        leases.set(kind, lease)
        result = lease
      } else if (request.method === 'turn') {
        const { kind, hop, cancel } = request.params
        const ref = refs[kind]
        const original = registry.find(ref.provider, ref.id)
        const lease = leases.get(kind)
        if (!original || !lease || !request.params.context)
          throw new Error('Private turn not initialized')
        // Direct SSE is the baseline. The registry's original WS preference remains untouched.
        const model = {
          ...original,
          ...(kind === 'codex' ? { preferWebsockets: false } : {}),
          ...(hop
            ? {
                transport: 'pi-native' as const,
                baseUrl: `http://127.0.0.1:${lease.localPort}`,
                headers: undefined
              }
            : {})
        }
        const controller = new AbortController()
        const options: SimpleStreamOptions = {
          apiKey: hop ? lease.bearerToken : registry.resolver(original, lease.leaseId),
          sessionId: lease.leaseId,
          promptCacheKey: lease.leaseId,
          signal: controller.signal,
          maxTokens: 1024,
          maxRetryDelayMs: 0,
          preferWebsockets: false,
          providerSessionState: states.get(kind) ?? new Map()
        }
        states.set(kind, options.providerSessionState!)
        if (hop)
          options.fetch = async (url, init) => {
            const body = String(init?.body ?? '')
            const headers = new Headers(init?.headers)
            const response = await fetch(url, init)
            const privateValues = [
              secrets.key,
              secrets.oauth,
              secrets.refresh,
              codexToken,
              secrets.error,
              lease.bearerToken,
              base
            ]
            const responseHead = JSON.stringify([...response.headers])
            const audit = {
              credentialInBody: [
                secrets.key,
                secrets.oauth,
                secrets.refresh,
                codexToken,
                lease.bearerToken
              ].some((secret) => body.includes(secret)),
              credentialInHeader: [secrets.key, secrets.oauth, secrets.refresh, codexToken].some(
                (secret) => JSON.stringify([...headers]).includes(secret)
              ),
              responseHeaders: Object.fromEntries(response.headers),
              redactedOnWire: false,
              rawErrorLeak: privateValues.some((secret) => responseHead.includes(secret))
            }
            wire.push(audit)
            let observed = ''
            const decoder = new TextDecoder()
            const inspect = (chunk: Uint8Array): void => {
              observed += decoder.decode(chunk, { stream: true })
              if (observed.length > 4 * 1024 * 1024)
                throw new Error('Private native audit exceeds bound')
              audit.redactedOnWire =
                observed.includes('"redactedThinking"') && observed.includes(secrets.redacted)
              audit.rawErrorLeak ||= privateValues.some((secret) => observed.includes(secret))
            }
            const bodyStream = response.body?.pipeThrough(
              new TransformStream<Uint8Array, Uint8Array>({
                transform(chunk, controller) {
                  inspect(chunk)
                  controller.enqueue(chunk)
                }
              })
            )
            return new Response(bodyStream, { status: response.status, headers: response.headers })
          }
        const execute = hop
          ? createNativeStreamIntegrityAdapter(streamSimple, {
              generation: lease.generation,
              endpoint: `http://127.0.0.1:${lease.localPort}/v1/pi/stream`,
              models: lease.models,
              signal: controller.signal,
              isActive: () => !controller.signal.aborted
            })
          : streamSimple
        const stream = await execute(model, request.params.context, options)
        const events: unknown[] = []
        let cancellation = false
        try {
          for await (const event of stream) {
            events.push(JSON.parse(JSON.stringify(event)))
            if (cancel && !cancellation && event.type === 'text_delta') {
              cancellation = true
              controller.abort()
            }
          }
        } catch (error) {
          // The actual SDK can report a caller abort either as its aborted event
          // or an AbortError rejection. Serialize that real canceled stream only.
          if (
            !cancel ||
            !controller.signal.aborted ||
            !(error instanceof Error) ||
            error.name !== 'AbortError'
          )
            throw error
        }
        result = {
          events,
          message: await stream.result().catch((error: Error) => ({ failure: error.message })),
          cancellation
        }
      } else if (request.method === 'snapshot') {
        const content = (await logs(root)).join('\n')
        result = {
          refreshes,
          redirectedOrigins,
          wire,
          gateway: manager.diagnostics(),
          websocketEnv: process.env.PI_CODEX_WEBSOCKET,
          originalCodexPreference: registry.find(refs.codex.provider, refs.codex.id)
            ?.preferWebsockets,
          debugEnabled: Boolean(process.env.PI_REQ_DEBUG),
          logLeaks: [
            secrets.key,
            secrets.oauth,
            secrets.refresh,
            codexToken,
            ...[...leases.values()].map((lease) => lease.bearerToken)
          ].some((secret) => content.includes(secret)),
          logFiles: (await logs(root)).length
        }
      } else if (request.method === 'close') {
        await manager.closeAll()
        result = null
      } else throw new Error('Unknown private command')
      const frame = JSON.stringify({ id, ok: true, result })
      if (Buffer.byteLength(frame) > 4 * 1024 * 1024)
        throw new Error('Private response exceeds bound')
      process.stdout.write(frame + '\n')
      if (request.method === 'close') break
    } catch (error) {
      process.stdout.write(
        JSON.stringify({
          id,
          ok: false,
          error: error instanceof Error ? error.message : 'Private command failed'
        }) + '\n'
      )
    }
  }
} finally {
  input.close()
  await close()
}
