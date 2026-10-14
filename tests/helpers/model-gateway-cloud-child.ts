import { writeFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inspect } from 'node:util'
import { createInterface } from 'node:readline'
import type { AssistantMessage, Context, Model, Api, SimpleStreamOptions } from '@oh-my-pi/pi-ai'
import {
  CLOUD_REFS as refs,
  CLOUD_SECRETS as secrets,
  type CloudCategory
} from './model-gateway-cloud-provider'

const root = process.env.PHI_CLOUD_ROOT,
  agentDir = process.env.PI_CODING_AGENT_DIR,
  base = process.env.PHI_CLOUD_BASE
if (!root || !agentDir || !base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base))
  throw new Error('Disposable cloud fixture paths required')
const originalFetch = globalThis.fetch
const mappedRequests: Array<{ url: string; headers: Record<string, string>; body: string }> = []
const allowedOrigins = new Set([
  'https://oauth2.googleapis.com',
  'https://us-central1-aiplatform.googleapis.com',
  'https://bedrock-runtime.us-west-2.amazonaws.com',
  'https://antigravity-hub-auto-updater-974169037036.us-central1.run.app'
])
// This mapping exists solely inside this disposable child. Unknown destinations
// throw before DNS; all signing, ADC and vendor dispatch remains actual SDK code.
globalThis.fetch = Object.assign(async (input: string | URL | Request, init?: RequestInit) => {
  const request = new Request(input, init),
    url = new URL(request.url)
  if (url.origin === base || url.hostname === '127.0.0.1') return originalFetch(input, init)
  if (!allowedOrigins.has(url.origin))
    throw new Error(`Unapproved private-fixture cloud destination: ${url.origin}`)
  const body =
    request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.text()
  mappedRequests.push({
    url: request.url,
    headers: Object.fromEntries(request.headers),
    body: body ?? ''
  })
  return originalFetch(`${base}/mapped/${url.hostname}${url.pathname}${url.search}`, {
    method: request.method,
    headers: request.headers,
    body,
    signal: request.signal,
    redirect: 'manual'
  })
}, {})
const { AuthStorage, streamSimple } = await import('@oh-my-pi/pi-ai')
const { createNativeStreamIntegrityAdapter } =
  await import('../../src/main/agent/engine/phi-extension/lib/rpc-native-stream-adapter')
const { AssistantMessageEventStream } = await import('@oh-my-pi/pi-ai/utils/event-stream')
const { ModelRegistry } = await import('@oh-my-pi/pi-coding-agent')
const { createPhiAuth } = await import('../../src/main/agent/engine/in-process/auth')
const { ModelGatewayManager } = await import('../../src/main/agent/engine/in-process/model-gateway')
const { modelBySelector } = await import('../../src/main/agent/engine/in-process/runtime-context')
const { isHostResponse, handleHostResponse } =
  await import('../../src/main/agent/engine/in-process/ipc')
const model = (
  id: string
): Pick<Model<Api>, 'id' | 'name' | 'reasoning' | 'input' | 'cost'> & {
  contextWindow: number
  maxTokens: number
} => ({
  id,
  name: id,
  reasoning: true,
  input: ['text'] as Array<'text'>,
  contextWindow: 32768,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
})
await writeFile(
  join(agentDir, 'models.yml'),
  JSON.stringify({
    providers: {
      google: {
        auth: 'oauth',
        api: 'google-generative-ai',
        baseUrl: `${base}/google/v1beta`,
        models: [model(refs.google.id)]
      },
      'google-gemini-cli': {
        auth: 'oauth',
        api: 'google-gemini-cli',
        baseUrl: `${base}/gemini`,
        models: [model(refs.gemini.id)]
      },
      'google-antigravity': {
        auth: 'oauth',
        api: 'google-gemini-cli',
        baseUrl: `${base}/antigravity`,
        models: [model(refs.antigravity.id)]
      },
      'amazon-bedrock': {
        auth: 'oauth',
        api: 'bedrock-converse-stream',
        baseUrl: 'https://bedrock-runtime.us-west-2.amazonaws.com',
        models: [model(refs.bedrock.id)]
      },
      'google-vertex': {
        auth: 'oauth',
        baseUrl: 'https://us-central1-aiplatform.googleapis.com',
        api: 'google-vertex',
        models: [model(refs.vertex.id)]
      }
    }
  }),
  { mode: 0o600 }
)
const storage = await AuthStorage.create(join(agentDir, 'auth.db'))
await storage.credentials.set('google', { type: 'api_key', key: secrets.google })
for (const category of ['gemini', 'antigravity'] as const)
  await storage.credentials.set(refs[category].provider, {
    type: 'oauth',
    access: secrets[category],
    refresh: `private-${category}-refresh`,
    expires: Date.now() + 3600000,
    projectId: `private-${category}-project`
  })
await storage.credentials.set('cursor', { type: 'api_key', key: secrets.cursor })
await storage.credentials.set('phi-extension', { type: 'api_key', key: secrets.registered })
const registry = new ModelRegistry(storage, join(agentDir, 'models.yml'))
if (registry.getError()) throw new Error(inspect(registry.getError(), { depth: 8 }))
registry.registerProvider(
  'cursor',
  {
    api: 'cursor-agent',
    baseUrl: 'https://api2.cursor.sh',
    apiKey: secrets.cursor,
    models: [model(refs.cursor.id)]
  },
  'private-cloud-cursor'
)
let customCalls = 0,
  customAborts = 0
registry.registerProvider(
  'phi-extension',
  {
    api: 'phi-private-extension-api',
    apiKey: secrets.registered,
    baseUrl: `${base}/registered`,
    models: [model(refs.registered.id)],
    streamSimple: (selected, context, options) => {
      const stream = new AssistantMessageEventStream()
      void (async () => {
        const message: AssistantMessage = {
          role: 'assistant',
          api: selected.api,
          provider: selected.provider,
          model: selected.id,
          content: [],
          stopReason: 'stop',
          timestamp: 1,
          usage: {
            input: 9,
            output: 4,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 13,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
          }
        }
        try {
          customCalls++
          options?.signal?.addEventListener('abort', () => customAborts++, { once: true })
          const response = await (options?.fetch ?? fetch)(selected.baseUrl!, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${String(options?.apiKey)}`
            },
            body: JSON.stringify({ context }),
            signal: options?.signal
          })
          const raw = await response.text()
          if (options?.signal?.aborted) throw new Error('Private extension aborted')
          const payload = JSON.parse(raw) as { text: string; tool?: boolean }
          message.content = payload.tool
            ? [
                {
                  type: 'toolCall',
                  name: 'inspect',
                  id: 'cloud-call',
                  arguments: { path: 'ordinary.txt' }
                }
              ]
            : [
                {
                  type: 'thinking',
                  thinking: 'private reasoning',
                  thinkingSignature: 'opaque-cloud-signature'
                },
                { type: 'text', text: payload.text }
              ]
          message.stopReason = payload.tool ? 'toolUse' : 'stop'
          stream.push({ type: 'start', partial: message })
          if (payload.tool) {
            stream.push({ type: 'toolcall_start', contentIndex: 0, partial: message })
            stream.push({
              type: 'toolcall_delta',
              contentIndex: 0,
              delta: JSON.stringify({ path: 'ordinary.txt' }),
              partial: message
            })
            stream.push({
              type: 'toolcall_end',
              contentIndex: 0,
              toolCall: message.content[0] as import('@oh-my-pi/pi-ai').ToolCall,
              partial: message
            })
          }
          // Terminal-only provider: the first SDK projector must synthesize
          // start/end without deltas; the native hop must preserve that text.
          stream.push({ type: 'done', reason: message.stopReason, message })
        } catch (error) {
          message.stopReason = options?.signal?.aborted ? 'aborted' : 'error'
          message.errorMessage = String(error)
          stream.push({ type: 'error', reason: message.stopReason, error: message })
        } finally {
          stream.end()
        }
      })()
      return stream
    }
  },
  'private-cloud-extension'
)
const context = {
  agentDir,
  auth: createPhiAuth(storage),
  authStorage: storage,
  modelRegistry: registry
}
const manager = new ModelGatewayManager({ context: async () => context, model: modelBySelector })
const active = new Map<string, AbortController>(),
  leases = new Map<CloudCategory, Awaited<ReturnType<typeof manager.create>>>()
const safeModel = (
  selected: Model<Api>,
  lease: Awaited<ReturnType<typeof manager.create>>
): Model<Api> => ({
  ...selected,
  baseUrl: `http://127.0.0.1:${lease.localPort}`,
  headers: undefined,
  transport: 'pi-native'
})
async function turn(params: {
  category: CloudCategory
  native: boolean
  context: Context
  id: string
}): Promise<{
  message: AssistantMessage
  events: unknown[]
  lease?: { models: readonly unknown[] }
}> {
  const selected = params.native
    ? registry.find(refs[params.category].provider, refs[params.category].id)
    : await modelBySelector(context, refs[params.category])
  if (!selected) throw new Error('Fixture model unavailable')
  const controller = new AbortController()
  active.set(params.id, controller)
  let lease = leases.get(params.category)
  if (params.native && !lease) {
    lease = await manager.create({
      sessionId: `cloud-${params.category}`,
      generation: 1,
      models: [refs[params.category]]
    })
    leases.set(params.category, lease)
  }
  const resolution = params.native
    ? undefined
    : await registry.getApiKeyWithCredentialForProvider(
        selected.provider,
        `direct-${params.category}`,
        { modelId: selected.id, baseUrl: selected.baseUrl }
      )
  const options: SimpleStreamOptions = {
    apiKey: params.native ? lease!.bearerToken : resolution?.apiKey,
    signal: controller.signal,
    sessionId: `${params.native ? 'native' : 'direct'}-${params.category}`,
    maxTokens: 1024,
    ...(params.native ? {} : { cursorExternalToolExecutor: true })
  }
  try {
    const execute = params.native
      ? createNativeStreamIntegrityAdapter(streamSimple, {
          generation: lease!.generation,
          endpoint: `http://127.0.0.1:${lease!.localPort}/v1/pi/stream`,
          models: lease!.models,
          signal: controller.signal,
          isActive: () => !controller.signal.aborted
        })
      : streamSimple
    const stream = await execute(
      params.native ? safeModel(selected, lease!) : selected,
      params.context,
      options
    )
    const events: unknown[] = []
    for await (const event of stream) events.push(event)
    return {
      message: await stream.result(),
      events,
      lease: params.native ? { models: lease!.models } : undefined
    }
  } finally {
    active.delete(params.id)
  }
}
async function logFiles(path: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const full = join(path, entry.name)
    if (entry.isDirectory()) result.push(...(await logFiles(full)))
    else if (/\.log$/.test(entry.name)) result.push(await readFile(full, 'utf8'))
  }
  return result
}
const lines = createInterface({ input: process.stdin })
const tasks = new Set<Promise<void>>()
lines.on('line', (line) => {
  const task = (async () => {
    const request = JSON.parse(line) as { id: string; method: string; params: unknown }
    if (isHostResponse(request)) {
      handleHostResponse(request)
      return
    }
    try {
      let result: unknown
      switch (request.method) {
        case 'turn':
          result = await turn(request.params as Parameters<typeof turn>[0])
          break
        case 'abort':
          active.get(String(request.params))?.abort()
          result = true
          break
        case 'snapshot':
          result = {
            available: registry
              .getAvailable()
              .filter((item) =>
                Object.values(refs).some(
                  (ref) => ref.provider === item.provider && ref.id === item.id
                )
              )
              .map((item) => ({ provider: item.provider, id: item.id })),
            mappedRequests,
            customCalls,
            customAborts,
            gateway: manager.diagnostics(),
            logs: await logFiles(root)
          }
          break
        case 'close':
          for (const controller of active.values()) controller.abort()
          await manager.closeAll()
          registry.unregisterProvider('phi-extension')
          registry.unregisterProvider('cursor')
          storage.close()
          result = true
          break
        default:
          throw new Error('Unknown private fixture method')
      }
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n')
    } catch (error) {
      process.stdout.write(
        JSON.stringify({ id: request.id, ok: false, error: String(error) }) + '\n'
      )
    }
  })()
  tasks.add(task)
  void task.finally(() => tasks.delete(task))
})
await new Promise<void>((resolve) => lines.once('close', resolve))
await Promise.all(tasks)
