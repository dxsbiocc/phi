import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { prepareModelProxyRpcSessionTransport } from '../src/main/agent/engine/rpc/model-proxy-lease'
import { createPhiExtensionBundle } from '../src/main/agent/engine/rpc/extension-deployment'
import { RpcSessionBackend } from '../src/main/agent/engine/rpc/rpc-session-backend'
import type { OwnedModelGatewayLease } from '../src/main/agent/engine/omp-bridge'
import type {
  RemoteExecResult,
  RemoteReverseTunnel
} from '../src/main/agent/wrappers/remote-ssh-session'
import { shellQuote } from '../src/main/agent/wrappers/remote-ssh-session'
import { createPhiExtensionDeploymentFixture } from './helpers/phiExtensionDeploymentFixture'
import { createLocalShellSession } from './helpers/localShellSession'
import { deferred } from './helpers/rpc-initialization-wire'

const unknown = {
  provider: 'phi-proxy-fixture',
  id: 'unknown-model',
  name: 'Unknown model limits',
  reasoning: false,
  supportsImages: false
}
const selected = {
  provider: 'phi-proxy-fixture',
  id: 'proxy-model',
  name: 'Private proxy model',
  reasoning: false,
  supportsImages: false
}

test('actual OMP restores nullable limits on initial and later choices and isolates private generations', async (t) => {
  const bun = join(process.env.HOME!, '.bun/bin/bun')
  const cli = join(process.cwd(), 'node_modules/@oh-my-pi/pi-coding-agent/dist/cli.js')
  const guard = join(process.cwd(), 'tests/engine-contract/network-guard.ts')
  const debugGuard = join(process.cwd(), 'tests/engine-contract/rpc-debug-guard.ts')
  const payload = `#!/bin/sh\nif [ "$1" = --version ]; then printf 'omp/18.10.3\\n'; exit 0; fi\nexec ${shellQuote(bun)} --no-env-file --preload ${shellQuote(debugGuard)} --preload ${shellQuote(guard)} ${shellQuote(cli)} "$@"\n`
  const fixture = await createPhiExtensionDeploymentFixture(payload)
  const session = createLocalShellSession(fixture.runtimeRoot)
  const cwd = join(fixture.root, 'project')
  await mkdir(cwd)
  // Only synthetic data: Bun dotenv must not re-enable raw request logging.
  await writeFile(join(cwd, '.env'), 'PI_REQ_DEBUG=1\n')
  t.after(async () => {
    await session.close()
    await fixture.cleanup()
  })
  session.execWithInput = async (command, input, options): Promise<RemoteExecResult> => {
    options?.signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const child = spawn('bash', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] })
      let stdout = ''
      let stderr = ''
      const cancel = (): void => {
        child.kill('SIGTERM')
      }
      options?.signal?.addEventListener('abort', cancel, { once: true })
      child.stdout.on('data', (bytes: Buffer) => {
        stdout += bytes.toString('utf8')
      })
      child.stderr.on('data', (bytes: Buffer) => {
        stderr += bytes.toString('utf8')
      })
      child.once('error', reject)
      child.once('close', (code, signal) => {
        options?.signal?.removeEventListener('abort', cancel)
        if (options?.signal?.aborted) reject(options.signal.reason)
        else resolve({ stdout, stderr, code, signal })
      })
      child.stdin.end(input)
    })
  }
  const gateways: Array<OwnedModelGatewayLease & { closes: number }> = []
  const tunnels: Array<RemoteReverseTunnel & { closes: number }> = []
  session.openReverseTunnel = async ({ localPort }) => {
    const done = deferred<void>()
    const tunnel = {
      remotePort: localPort + 100,
      closed: done.promise,
      closes: 0,
      async close() {
        if (this.closes) return
        this.closes++
        done.resolve()
      }
    }
    tunnels.push(tunnel)
    return tunnel
  }
  const transport = await prepareModelProxyRpcSessionTransport({
    session,
    runtime: fixture.options,
    bundle: await createPhiExtensionBundle(
      join(process.cwd(), 'src/main/agent/engine/phi-extension')
    ),
    projectId: 'project',
    models: [selected, unknown],
    gateway: {
      async createModelGatewayLease(params) {
        const done = deferred<void>()
        const lease = {
          leaseId: `lease-${params.generation}`,
          sessionId: params.sessionId,
          generation: params.generation,
          localPort: 34000 + gateways.length,
          bearerToken: `${params.generation}`.padEnd(43, 'x'),
          models: [
            {
              provider: unknown.provider,
              id: unknown.id,
              name: unknown.name,
              reasoning: false,
              input: ['text' as const],
              contextWindow: null,
              maxTokens: null
            },
            {
              provider: selected.provider,
              id: selected.id,
              name: selected.name,
              reasoning: false,
              input: ['text' as const],
              contextWindow: 32768,
              maxTokens: 256
            }
          ],
          closed: done.promise,
          closes: 0,
          async close() {
            if (this.closes) return
            this.closes++
            done.resolve()
          }
        }
        gateways.push(lease)
        return lease
      }
    }
  })
  let rpc!: Parameters<typeof transport.initialize>[0]['connection']
  const engine = new RpcSessionBackend(transport.open, {
    prepare: transport.prepare,
    initialize: async (context) => {
      rpc = context.connection
      await transport.initialize(context)
    },
    selectModel: transport.selectModel,
    startupTimeoutMs: 5000
  })
  const params = {
    sessionId: 'proxy-session',
    cwd,
    agentDir: '/never-copy-desktop-agent',
    model: selected
  }
  t.after(() => engine.dispose(params))
  const first = await engine.create(params)
  assert.equal(first.state.model?.provider, selected.provider)
  assert.equal(first.state.model?.id, selected.id)
  await engine.setModel({ sessionId: params.sessionId, model: unknown })
  const unknownState = (await rpc.request({ type: 'get_state' })) as {
    model: { contextWindow: unknown; maxTokens: unknown }
  }
  assert.equal(unknownState.model.contextWindow, null)
  assert.equal(unknownState.model.maxTokens, null)
  await engine.setModel({ sessionId: params.sessionId, model: selected })
  const restoredState = (await rpc.request({ type: 'get_state' })) as {
    model: { contextWindow: unknown; maxTokens: unknown }
  }
  assert.equal(restoredState.model.contextWindow, 32768)
  assert.equal(restoredState.model.maxTokens, 256)
  const base = join(fixture.runtimeRoot, 'rpc-sessions')
  const [directory] = await readdir(base)
  const modelsPath = join(base, directory, 'home/agent/models.yml')
  assert.equal((await stat(modelsPath)).mode & 0o777, 0o600)
  const config = JSON.parse(await readFile(modelsPath, 'utf8'))
  assert.deepEqual(Object.keys(config.providers), [selected.provider])
  assert.equal(config.providers[selected.provider].transport, 'pi-native')
  assert.equal(config.providers[selected.provider].apiKey, gateways[0].bearerToken)
  assert.equal(
    config.providers[selected.provider].baseUrl,
    `http://127.0.0.1:${tunnels[0].remotePort}`
  )
  assert.ok(!session.commands.some((command) => command.includes(gateways[0].bearerToken)))
  assert.ok(
    session.commands.some(
      (command) => command.includes(' env -i PATH=') && command.includes('PI_REQ_DEBUG=0')
    )
  )
  await engine.dispose(params)
  assert.deepEqual(await readdir(base), [])
  assert.equal(gateways[0].closes, 1)
  assert.equal(tunnels[0].closes, 1)
  await engine.create({ ...params, model: unknown })
  const initialUnknown = (await rpc.request({ type: 'get_state' })) as {
    model: { contextWindow: unknown; maxTokens: unknown }
  }
  assert.equal(initialUnknown.model.contextWindow, null)
  assert.equal(initialUnknown.model.maxTokens, null)
  assert.notEqual(gateways[1].bearerToken, gateways[0].bearerToken)
  assert.notEqual(tunnels[1].remotePort, tunnels[0].remotePort)
  await engine.dispose(params)
  assert.equal(session.closed, false)
  assert.equal((await session.exec('printf master-kept')).stdout, 'master-kept')
})
