import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { posix } from 'node:path'
import test from 'node:test'

import type { SafeModelDescriptor } from '../src/main/agent/engine/model-gateway-types'
import {
  serializeRemoteModelProxyConfig,
  writeRemoteModelProxyConfig
} from '../src/main/agent/engine/rpc/model-proxy-config'
import type {
  RpcStartupDirectory,
  RpcStartupFile,
  RpcStartupTransactionWriter
} from '../src/main/agent/engine/rpc/startup-transaction'

const model: SafeModelDescriptor = {
  provider: 'synthetic-provider',
  id: 'model/id',
  name: 'Reasoning Vision',
  reasoning: true,
  input: ['text', 'image'],
  contextWindow: 128000,
  maxTokens: 8192,
  cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.2 }
}
const bearer = 'A'.repeat(43)

function publication(): {
  files: RpcStartupFile[]
  directories: RpcStartupDirectory[]
  startup: RpcStartupTransactionWriter
  nonce: string
  agentDir: string
  options: Parameters<typeof writeRemoteModelProxyConfig>[0]
} {
  const files: RpcStartupFile[] = []
  const directories: RpcStartupDirectory[] = []
  const startup: RpcStartupTransactionWriter = {
    addDirectory: (directory) => directories.push(directory),
    addFile: (file) => files.push(file)
  }
  const nonce = randomUUID()
  const agentDir = posix.join('/runtime/rpc-sessions', nonce, 'home/agent')
  const options = {
    session: {} as never,
    startup,
    agentDir,
    sessionId: 'model-session',
    projectRoot: '/project',
    gatewayGeneration: 1,
    models: [model],
    remotePort: 41000,
    gatewayBearer: bearer
  }
  return { files, directories, startup, nonce, agentDir, options }
}

test('pi-native serialization preserves safe capabilities without model credentials or callbacks', () => {
  let resolved = false
  const unsafe = Object.assign({}, model, {
    apiKey: 'vendor-secret',
    baseUrl: 'https://user:password@private-provider/path?secret=value',
    headers: { Authorization: 'vendor-secret' },
    refreshToken: 'oauth-refresh-secret',
    resolveHeaders: () => {
      resolved = true
      return {}
    }
  })
  const content = serializeRemoteModelProxyConfig({
    models: [unsafe],
    remotePort: 41000,
    gatewayBearer: bearer
  })
  const provider = JSON.parse(content).providers[model.provider]
  assert.deepEqual(provider.models, [
    {
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: [...model.input],
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      cost: model.cost
    }
  ])
  assert.equal(provider.apiKey, bearer)
  for (const secret of ['vendor-secret', 'password', 'private-provider', 'oauth-refresh-secret'])
    assert.equal(content.includes(secret), false)
  assert.equal(resolved, false)
})

test('model publication queues two exact private files and performs no remote command', async () => {
  const fixture = publication()
  const identity = await writeRemoteModelProxyConfig(fixture.options)
  assert.deepEqual(identity, {
    nonce: fixture.nonce,
    sessionId: fixture.options.sessionId,
    projectRoot: fixture.options.projectRoot,
    gatewayGeneration: 1
  })
  assert.deepEqual(fixture.directories, [])
  assert.deepEqual(
    fixture.files.map(({ item, path, mode, ifAbsent }) => ({ item, path, mode, ifAbsent })),
    [
      {
        item: 'model-proxy-config',
        path: posix.join(fixture.agentDir, 'models.yml'),
        mode: 0o600,
        ifAbsent: true
      },
      {
        item: 'model-proxy-metadata',
        path: posix.join(fixture.agentDir, 'phi-model-metadata.json'),
        mode: 0o600,
        ifAbsent: true
      }
    ]
  )
  assert.equal(
    JSON.parse(fixture.files[0]!.bytes.toString()).providers[model.provider].apiKey,
    bearer
  )
  assert.equal(fixture.files[1]!.bytes.toString().includes(bearer), false)
})

test('invalid models, bearer, port and generation paths are refused before files are queued', async () => {
  for (const invalid of [
    { models: [] },
    { models: [model, model] },
    { models: [{ ...model, input: ['audio'] }] },
    { models: [{ ...model, maxTokens: Number.NaN }] },
    { gatewayBearer: 'short' },
    { remotePort: 0 },
    { agentDir: '/shared/agent' }
  ]) {
    const fixture = publication()
    await assert.rejects(writeRemoteModelProxyConfig({ ...fixture.options, ...invalid } as never))
    assert.deepEqual(fixture.files, [])
  }
})

test('an already-cancelled publication queues no capability files', async () => {
  const fixture = publication()
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(
    writeRemoteModelProxyConfig({ ...fixture.options, signal: controller.signal }),
    /cancelled/
  )
  assert.deepEqual(fixture.files, [])
})
