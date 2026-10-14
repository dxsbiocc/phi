import { createInterface } from 'node:readline'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { AuthStorage } from '@oh-my-pi/pi-ai'
import { ModelRegistry } from '@oh-my-pi/pi-coding-agent'
import { createPhiAuth } from '../../src/main/agent/engine/in-process/auth'
import { ModelGatewayManager } from '../../src/main/agent/engine/in-process/model-gateway'
import type { RuntimeContext } from '../../src/main/agent/engine/in-process/common'
import { RPC_COMPOSITION_REF } from './rpcRuntimeCompositionGateway'

const agentDir = process.env.PI_CODING_AGENT_DIR!,
  baseUrl = process.env.PHI_COMPOSITION_PROVIDER!
const anthropic = process.env.PHI_COMPOSITION_ANTHROPIC === '1'
const contextWindow = Number(process.env.PHI_COMPOSITION_CONTEXT_WINDOW ?? 32768)
if (!Number.isSafeInteger(contextWindow) || contextWindow < 32768 || contextWindow > 2_000_000)
  throw new Error('Invalid private composition model window')
const ref = anthropic ? { provider: 'anthropic', id: 'claude-sonnet-4-6' } : RPC_COMPOSITION_REF
if (!agentDir || !/^http:\/\/127\.0\.0\.1:\d+(?:\/v1)?$/u.test(baseUrl))
  throw new Error('Private composition gateway requires an isolated provider')
if (anthropic) {
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    if (
      url.origin === 'https://api.anthropic.com' &&
      url.pathname === '/phi-parity/v1/messages' &&
      (!url.search || url.search === '?beta=true')
    ) {
      const safe = { ...init } as RequestInit & { proxy?: string }
      delete safe.proxy
      return original(baseUrl + '/anthropic/v1/messages', safe)
    }
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
      throw new Error('External composition request refused')
    return original(input, init)
  }, {})
}
await writeFile(
  join(agentDir, 'models.yml'),
  JSON.stringify({
    providers: {
      [ref.provider]: anthropic
        ? {
            api: 'anthropic-messages',
            auth: 'apiKey',
            baseUrl: 'https://api.anthropic.com/phi-parity'
          }
        : {
            api: 'openai-completions',
            auth: 'oauth',
            baseUrl,
            models: [
              {
                id: RPC_COMPOSITION_REF.id,
                name: 'Composition image model',
                reasoning: true,
                input: ['text', 'image'],
                contextWindow,
                maxTokens: 1024,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
              }
            ]
          }
    }
  }),
  { mode: 0o600 }
)
const auth = await AuthStorage.create(join(agentDir, 'auth.db'))
await auth.credentials.set(ref.provider, {
  type: 'api_key',
  key: 'synthetic-composition-desktop-key'
})
const registry = new ModelRegistry(auth, join(agentDir, 'models.yml'))
if (registry.getError())
  throw new Error(`Composition registry failed: ${String(registry.getError()).slice(0, 4096)}`)
const context: RuntimeContext = {
  agentDir,
  auth: createPhiAuth(auth),
  authStorage: auth,
  modelRegistry: registry
}
const manager = new ModelGatewayManager({
  context: async () => context,
  model: async (_ctx, ref) => registry.find(ref.provider, ref.id)
})
const input = createInterface({ input: process.stdin })
try {
  for await (const line of input) {
    const request = JSON.parse(line)
    try {
      let result: unknown
      if (request.method === 'create') result = await manager.create(request.params)
      else if (request.method === 'revoke') result = await manager.revoke(request.params)
      else if (request.method === 'snapshot') result = manager.diagnostics()
      else if (request.method === 'close') {
        await manager.closeAll()
        result = null
      } else throw new Error('Unknown private composition command')
      process.stdout.write(JSON.stringify({ id: request.id, ok: true, result }) + '\n')
      if (request.method === 'close') break
    } catch {
      process.stdout.write(JSON.stringify({ id: request.id, ok: false }) + '\n')
    }
  }
} finally {
  input.close()
  await manager.closeAll()
  auth.close()
}
