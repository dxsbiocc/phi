import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createPersistentLauncherFixture } from './helpers/persistentLauncherFixture'
import { createModelProxyConfigFixture } from './helpers/modelProxyConfigFixture'
import { writeRemoteModelProxyConfig } from '../src/main/agent/engine/rpc/model-proxy-config'
import { loadRpcModelMetadata } from '../src/main/agent/engine/phi-extension/lib/rpc-model-metadata'
import { selectRemoteModel } from '../src/main/agent/engine/rpc/model-selection'
import {
  canonicalRemoteSessionName,
  projectRemoteContextUsage
} from '../src/main/agent/engine/rpc/runtime-metadata-control'
import type { RpcBootstrapConfig } from '../src/main/agent/engine/phi-extension/lib/rpc-config'

const safeModel = {
  provider: 'phi-contract',
  id: 'contract-model',
  name: 'Private model',
  reasoning: false,
  input: ['text' as const],
  contextWindow: null,
  maxTokens: null
}

test('metadata DTO preserves actual unavailable usage and canonical pinned title semantics', () => {
  assert.equal(canonicalRemoteSessionName(' \u0000Title   中文\nname\u0085 '), 'Title 中文 name')
  assert.equal(canonicalRemoteSessionName('A\u00a0B'), 'A\u00a0B')
  for (const name of ['', '\u0000\u007f', 'x'.repeat(4097), '\ud800'])
    assert.throws(() => canonicalRemoteSessionName(name), /name|UTF8/)
  for (const usage of [
    undefined,
    null,
    {},
    { tokens: 1, contextWindow: null, percent: 1 },
    { tokens: 0, contextWindow: 0, percent: 0 },
    { tokens: NaN, contextWindow: 100, percent: 1 }
  ])
    assert.equal(projectRemoteContextUsage(usage), null)
  assert.deepEqual(
    projectRemoteContextUsage({
      tokens: 12,
      contextWindow: 100,
      percent: 12,
      privateCapability: 'must not be public'
    }),
    { tokens: 12, contextWindow: 100, percent: 12 }
  )
})

test(
  'actual CLI null catalog limits project to unavailable usage with no provider request',
  { timeout: 60000 },
  async (t) => {
    const f = await createPersistentLauncherFixture(true),
      writer = await createModelProxyConfigFixture()
    t.after(async () => {
      await f.cleanup()
      await writer.cleanup()
    })
    let providerRequests = 0
    const server = createServer((_request, response) => {
      providerRequests++
      response.writeHead(503).end()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    t.after(() => new Promise<void>((resolve) => server.close(() => resolve())))
    const factory = await f.factory({
      prepareSession: async ({ agentDir, startup }) => {
        await writeRemoteModelProxyConfig({
          session: writer.session,
          startup,
          agentDir,
          sessionId: f.params.sessionId,
          projectRoot: f.scope.projectRoot,
          gatewayGeneration: 1,
          remotePort: (server.address() as AddressInfo).port,
          gatewayBearer: 'N'.repeat(43),
          models: [safeModel]
        })
        startup.addFile({
          item: 'metadata-projection-config',
          path: join(agentDir, 'config.yml'),
          bytes: Buffer.from(
            JSON.stringify({
              defaultProvider: safeModel.provider,
              defaultModel: safeModel.id,
              extensions: [],
              skills: [],
              memory: { enabled: false }
            })
          ),
          mode: 0o600,
          ifAbsent: true
        })
      }
    })
    const actual = await f.connect(factory)
    const config: RpcBootstrapConfig = JSON.parse(
      await readFile(join(dirname(actual.home), 'config.json'), 'utf8')
    )
    const metadata = loadRpcModelMetadata(join(actual.home, '.omp/agent'), config)
    assert.ok(metadata)
    await selectRemoteModel(actual.connection, metadata, safeModel, new AbortController().signal)
    const state = await actual.connection.request<{
      model: { contextWindow: number | null; maxTokens: number | null }
      contextUsage?: unknown
    }>({ type: 'get_state' })
    assert.equal(state.model.contextWindow, null)
    assert.equal(state.model.maxTokens, null)
    assert.equal(projectRemoteContextUsage(state.contextUsage), null)
    assert.equal(providerRequests, 0)
    assert.equal(actual.frames.includes('agent_start'), false)
  }
)
