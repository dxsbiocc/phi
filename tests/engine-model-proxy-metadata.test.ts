import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import test from 'node:test'

import type { SafeModelDescriptor } from '../src/main/agent/engine/model-gateway-types'
import { validateRpcModelMetadata } from '../src/main/agent/engine/phi-extension/lib/rpc-model-metadata'
import { writeRemoteModelProxyConfig } from '../src/main/agent/engine/rpc/model-proxy-config'
import type {
  RpcStartupFile,
  RpcStartupTransactionWriter
} from '../src/main/agent/engine/rpc/startup-transaction'

const model: SafeModelDescriptor = {
  provider: 'synthetic-provider',
  id: 'nullable-model',
  name: 'Unknown Limits',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: null,
  maxTokens: null
}

function fixture(): {
  files: RpcStartupFile[]
  options: Parameters<typeof writeRemoteModelProxyConfig>[0]
} {
  const files: RpcStartupFile[] = []
  const startup: RpcStartupTransactionWriter = {
    addDirectory: () => undefined,
    addFile: (file) => files.push(file)
  }
  const nonce = randomUUID()
  const agentDir = posix.join('/runtime/rpc-sessions', nonce, 'home/.omp/agent')
  return {
    files,
    options: {
      session: {} as never,
      startup,
      agentDir,
      sessionId: 'nullable-session',
      projectRoot: '/project',
      gatewayGeneration: 3,
      models: [model],
      remotePort: 41000,
      gatewayBearer: 'A'.repeat(43)
    }
  }
}

test('nullable metadata remains exact and credential-free beside bootstrap placeholders', async () => {
  const f = fixture()
  const identity = await writeRemoteModelProxyConfig({
    ...f.options,
    models: [
      Object.assign({}, model, {
        baseUrl: 'https://vendor-secret.invalid',
        apiKey: 'vendor-secret',
        rawMetadata: { secret: 'vendor-secret' }
      })
    ]
  })
  const raw = f.files.find((file) => file.item === 'model-proxy-metadata')!.bytes.toString()
  const metadata = validateRpcModelMetadata(JSON.parse(raw))
  assert.deepEqual(metadata, { schema: 1, ...identity, models: [model] })
  assert.equal(raw.includes('vendor-secret'), false)
  const configured = JSON.parse(
    f.files.find((file) => file.item === 'model-proxy-config')!.bytes.toString()
  ).providers[model.provider].models[0]
  assert.equal(Object.hasOwn(configured, 'contextWindow'), false)
  assert.equal(Object.hasOwn(configured, 'maxTokens'), false)
})

test('independent generations queue isolated metadata identities', async () => {
  const first = fixture()
  const second = fixture()
  const [left, right] = await Promise.all([
    writeRemoteModelProxyConfig(first.options),
    writeRemoteModelProxyConfig({ ...second.options, gatewayGeneration: 4 })
  ])
  assert.notEqual(left.nonce, right.nonce)
  assert.equal(left.gatewayGeneration, 3)
  assert.equal(right.gatewayGeneration, 4)
  assert.notEqual(first.files[0]!.path, second.files[0]!.path)
})

test('metadata projection rejects unsupported nested values before queueing', async () => {
  for (const invalid of [
    { ...model, provider: '' },
    { ...model, id: '' },
    { ...model, contextWindow: -1 },
    { ...model, maxTokens: Number.POSITIVE_INFINITY },
    { ...model, cost: { input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } }
  ]) {
    const f = fixture()
    await assert.rejects(
      writeRemoteModelProxyConfig({ ...f.options, models: [invalid as SafeModelDescriptor] })
    )
    assert.deepEqual(f.files, [])
  }
})
