import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { createScopedCursorH2Gateway } from '../src/main/agent/engine/in-process/scoped-cursor-h2-gateway'
import { prepareModelProxyRpcSessionTransport } from '../src/main/agent/engine/rpc/model-proxy-lease'
import { createPhiExtensionBundle } from '../src/main/agent/engine/rpc/extension-deployment'
import { RpcSessionBackend } from '../src/main/agent/engine/rpc/rpc-session-backend'
import { shellQuote } from '../src/main/agent/wrappers/remote-ssh-session'
import { startCloudProvider } from './helpers/model-gateway-cloud-provider'
import { createPhiExtensionDeploymentFixture } from './helpers/phiExtensionDeploymentFixture'
import { createLocalShellSession } from './helpers/localShellSession'
import { deferred } from './helpers/rpc-initialization-wire'

test('actual remote OMP Cursor transport executes read and returns its result to the model', { timeout: 60_000 }, async (t) => {
  const bun = join(process.env.HOME!, '.bun/bin/bun')
  const cli = join(process.cwd(), 'node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js')
  const guard = join(process.cwd(), 'tests/engine-contract/network-guard.ts')
  const payload = `#!/bin/sh\nif [ "$1" = --version ]; then printf 'omp/18.10.3\\n'; exit 0; fi\nexec ${shellQuote(bun)} --no-env-file --preload ${shellQuote(guard)} ${shellQuote(cli)} "$@"\n`
  const fixture = await createPhiExtensionDeploymentFixture(payload)
  const session = createLocalShellSession(fixture.runtimeRoot)
  const provider = await startCloudProvider()
  const token = randomBytes(32).toString('base64url')
  const scoped = await createScopedCursorH2Gateway({
    token,
    allowedModelIds: [
      'cursor-grok-4.6-fast',
      'cursor-grok-4.6-low-fast',
      'cursor-grok-4.6-medium-fast',
      'cursor-grok-4.6-high-fast',
      'cursor-grok-4.6-xhigh-fast'
    ],
    resolveBearer: async () => 'private-cursor-access-fixture',
    upstreamOrigin: await provider.bridge.ensure()
  })
  t.after(async () => {
    await scoped.close()
    await provider.close()
    await session.close()
    await fixture.cleanup()
  })
  session.openReverseTunnel = async ({ localPort }) => {
    const done = deferred<void>()
    return {
      remotePort: localPort,
      closed: done.promise,
      async close() { done.resolve() }
    }
  }
  const cwd = join(fixture.root, 'project')
  await mkdir(cwd)
  await writeFile(join(cwd, '.phi-validation.txt'), 'ok\n')
  const selected = {
    provider: 'cursor', id: 'cursor-grok-4.6-fast', name: 'Grok 4.6 Fast',
    reasoning: true, supportsImages: false
  }
  const transport = await prepareModelProxyRpcSessionTransport({
    session,
    runtime: fixture.options,
    bundle: await createPhiExtensionBundle(join(process.cwd(), 'src/main/agent/engine/phi-extension')),
    projectId: 'project',
    models: [selected],
    gateway: {
      async createModelGatewayLease(params) {
        const done = deferred<void>()
        return {
          leaseId: `lease-${params.generation}`,
          sessionId: params.sessionId,
          generation: params.generation,
          localPort: scoped.port,
          bearerToken: randomBytes(32).toString('base64url'),
          cursor: { localPort: scoped.port, bearerToken: token },
          models: [{
            provider: selected.provider, id: selected.id, name: selected.name,
            reasoning: true, input: ['text' as const], contextWindow: 256000, maxTokens: 16384
          }],
          closed: done.promise,
          async close() { done.resolve() }
        }
      }
    }
  })
  const engine = new RpcSessionBackend(transport.open, {
    prepare: transport.prepare,
    initialize: transport.initialize,
    selectModel: transport.selectModel,
    startupTimeoutMs: 15_000
  })
  const params = { sessionId: 'cursor-native-read', cwd, agentDir: '/never-copy-desktop-agent', model: selected, thinkingLevel: 'high' as const }
  t.after(() => engine.dispose(params))
  await engine.create(params)
  provider.enqueue({ tool: true, toolName: 'read', toolPath: '.phi-validation.txt', text: 'ok' })
  const state = await engine.prompt({ sessionId: params.sessionId, text: 'Read .phi-validation.txt and reply with its content.' })
  assert.match(JSON.stringify(state.messages), /ok/)
  assert.ok(provider.snapshot().requests.some((request) => request.body.mcpResultBase64))
})
