import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { chmodSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import {
  loadRpcModelMetadata,
  parseRpcModelSelectionRequest,
  RPC_MODEL_METADATA_MAX_BYTES,
  RPC_MODEL_SELECTION_COMMAND,
  RPC_MODEL_SELECTION_DESCRIPTION,
  validateRpcModelMetadata,
  type RpcModelMetadata,
  type RpcModelSelectionNotification,
  type RpcModelSelectionRequest
} from '../src/main/agent/engine/phi-extension/lib/rpc-model-metadata'
import { attestBootstrap } from '../src/main/agent/engine/rpc/bootstrap-attestation'
import { createRpcModelSelectionFixture } from './helpers/rpcModelSelectionFixture'

function request(metadata: RpcModelMetadata, model = metadata.models[0]): RpcModelSelectionRequest {
  return {
    nonce: metadata.nonce,
    sessionId: metadata.sessionId,
    projectRoot: metadata.projectRoot,
    gatewayGeneration: metadata.gatewayGeneration,
    selectionId: randomUUID(),
    provider: model.provider,
    modelId: model.id
  }
}

test('private metadata preserves nulls and accepts only explicit safe descriptors and selection identities', async (t) => {
  const f = await createRpcModelSelectionFixture()
  t.after(() => f.close())
  assert.deepEqual(loadRpcModelMetadata(f.agentDir, f.config), f.metadata)
  assert.ok(Object.isFrozen(validateRpcModelMetadata(f.metadata).models[0]))
  for (const invalid of [
    null,
    [],
    { ...f.metadata, bearer: 'must-not-pass' },
    { ...f.metadata, schema: 2 },
    { ...f.metadata, gatewayGeneration: 0 },
    { ...f.metadata, gatewayGeneration: 1.5 },
    { ...f.metadata, models: [] },
    { ...f.metadata, models: [f.metadata.models[0], f.metadata.models[0]] },
    ...[
      { baseUrl: 'http://untrusted' },
      { headers: {} },
      { contextWindow: 0 },
      { maxTokens: -1 },
      { input: ['text', 'text'] },
      { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, token: 'hidden' } }
    ].map((patch) => ({ ...f.metadata, models: [{ ...f.metadata.models[0], ...patch }] }))
  ])
    assert.throws(() => validateRpcModelMetadata(invalid))
  const valid = request(f.metadata)
  assert.deepEqual(parseRpcModelSelectionRequest(JSON.stringify(valid), f.metadata), valid)
  for (const patch of [
    { nonce: randomUUID() },
    { sessionId: 'wrong' },
    { projectRoot: f.root },
    { gatewayGeneration: 2 },
    { selectionId: 'wrong' },
    { model: { baseUrl: 'http://untrusted' } }
  ])
    assert.throws(() =>
      parseRpcModelSelectionRequest(JSON.stringify({ ...valid, ...patch }), f.metadata)
    )
  assert.throws(() => parseRpcModelSelectionRequest(' '.repeat(4097), f.metadata))
  assert.throws(() => parseRpcModelSelectionRequest('invalid-json', f.metadata))
})

test('private reader enforces owned mode600 bounded regular no-follow and bootstrap binding', async (t) => {
  const f = await createRpcModelSelectionFixture()
  t.after(() => f.close())
  const valid = readFileSync(f.metadataPath)
  chmodSync(f.metadataPath, 0o644)
  assert.throws(() => loadRpcModelMetadata(f.agentDir, f.config), /private owned/)
  chmodSync(f.metadataPath, 0o600)
  if (process.getuid) {
    const original = process.getuid
    const uid = process.getuid()
    process.getuid = () => uid + 1
    try {
      assert.throws(() => loadRpcModelMetadata(f.agentDir, f.config), /private owned/)
    } finally {
      process.getuid = original
    }
  }
  for (const patch of [{ nonce: randomUUID() }, { sessionId: 'wrong' }, { projectRoot: f.root }]) {
    writeFileSync(f.metadataPath, JSON.stringify({ ...f.metadata, ...patch }))
    assert.throws(() => loadRpcModelMetadata(f.agentDir, f.config), /bootstrap identity/)
  }
  writeFileSync(f.metadataPath, Buffer.alloc(RPC_MODEL_METADATA_MAX_BYTES + 1))
  assert.throws(() => loadRpcModelMetadata(f.agentDir, f.config), /private owned/)
  writeFileSync(f.metadataPath, Buffer.from([0xff]))
  assert.throws(() => loadRpcModelMetadata(f.agentDir, f.config))
  rmSync(f.metadataPath)
  const target = join(f.root, 'ordinary.json')
  writeFileSync(target, valid, { mode: 0o600 })
  symlinkSync(target, f.metadataPath)
  assert.throws(() => loadRpcModelMetadata(f.agentDir, f.config), /opened safely/)
  rmSync(f.metadataPath)
  assert.equal(loadRpcModelMetadata(f.agentDir, f.config), undefined)
})

for (const provider of ['phi-selection', 'llama.cpp', 'lm-studio']) {
  test(
    `real CLI ${provider} restores exact null and mixed limits initially and on later model changes`,
    { timeout: 30000 },
    async (t) => {
      const f = await createRpcModelSelectionFixture({ provider })
      t.after(() => f.close())
      await f.connection.start()
      await attestBootstrap(f.connection, f.config, new AbortController().signal)
      const { commands } = await f.connection.request<{
        commands: Array<{ name: string; source: string; description: string }>
      }>({ type: 'get_available_commands' })
      assert.deepEqual(
        commands
          .filter(({ name }) => name === RPC_MODEL_SELECTION_COMMAND)
          .map(({ name, source, description }) => ({ name, source, description })),
        [
          {
            name: RPC_MODEL_SELECTION_COMMAND,
            source: 'extension',
            description: RPC_MODEL_SELECTION_DESCRIPTION
          }
        ]
      )
      const before = await f.connection.request<{
        model: { contextWindow: number; maxTokens: number }
      }>({ type: 'get_state' })
      assert.equal(
        before.model.contextWindow,
        128000,
        'YAML applies numeric bootstrap defaults until trusted public runtime selection'
      )
      assert.equal(before.model.maxTokens, 16384)
      for (const model of [...f.metadata.models, f.metadata.models[0]]) {
        const selection = request(f.metadata, model)
        const offset = f.frames.length
        const result = await f.connection.prompt(
          `/${RPC_MODEL_SELECTION_COMMAND} ${JSON.stringify(selection)}`
        )
        assert.equal(result.agentInvoked, false)
        assert.equal(result.sessionSettled, true)
        assert.equal(result.status, 'completed')
        const notifications = f.frames
          .slice(offset)
          .filter((frame) => frame.type === 'extension_ui_request' && frame.method === 'notify')
          .map((frame) => JSON.parse(String(frame.message)) as RpcModelSelectionNotification)
          .filter((message) => message.type === 'phi_rpc_model_selection')
        assert.deepEqual(notifications, [
          {
            ...selection,
            type: 'phi_rpc_model_selection',
            protocolVersion: 1,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens
          }
        ])
        const state = await f.connection.request<{ model: Record<string, unknown> }>({
          type: 'get_state'
        })
        for (const [key, value] of Object.entries({
          provider: model.provider,
          id: model.id,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          transport: 'pi-native',
          baseUrl: f.provider.url
        }))
          assert.equal(state.model[key], value, key)
      }
      assert.equal(
        f.provider.requests.length,
        0,
        'Explicit static providers must not run native lazy metadata discovery'
      )
      assert.equal(
        f.frames.some((frame) => frame.type === 'agent_start'),
        false
      )
      assert.doesNotMatch(f.stderr(), /synthetic-private-gateway-bearer/)
      assert.doesNotMatch(JSON.stringify(f.frames), /synthetic-private-gateway-bearer/)
    }
  )
}

test(
  'real CLI refuses wrong identities and arbitrary model overrides locally without provider execution',
  { timeout: 30000 },
  async (t) => {
    const f = await createRpcModelSelectionFixture()
    t.after(() => f.close())
    await f.connection.start()
    await attestBootstrap(f.connection, f.config, new AbortController().signal)
    for (const patch of [
      { nonce: randomUUID() },
      { projectRoot: f.root },
      { sessionId: 'other-session' },
      { gatewayGeneration: 2 },
      { modelId: 'unk' },
      { provider: 'missing' },
      { baseUrl: 'http://arbitrary', apiKey: 'synthetic-private-gateway-bearer' }
    ]) {
      const offset = f.frames.length
      const result = await f.connection.prompt(
        `/${RPC_MODEL_SELECTION_COMMAND} ${JSON.stringify({ ...request(f.metadata), ...patch })}`
      )
      assert.equal(result.agentInvoked, false)
      assert.equal(result.sessionSettled, true)
      // SDK emits extension_error yet completes the local slash-command prompt.
      assert.equal(result.status, 'completed')
      assert.equal(
        f.frames
          .slice(offset)
          .some(
            (frame) =>
              frame.type === 'extension_error' &&
              frame.extensionPath === `command:${RPC_MODEL_SELECTION_COMMAND}`
          ),
        true
      )
      assert.equal(
        f.frames
          .slice(offset)
          .some(
            (frame) =>
              frame.type === 'extension_ui_request' &&
              typeof frame.message === 'string' &&
              frame.message.includes('phi_rpc_model_selection')
          ),
        false
      )
    }
    const state = await f.connection.request<{
      model: { contextWindow: number; maxTokens: number }
    }>({ type: 'get_state' })
    assert.equal(state.model.contextWindow, 128000)
    assert.equal(state.model.maxTokens, 16384)
    assert.equal(f.provider.requests.length, 0)
    assert.doesNotMatch(f.stderr(), /synthetic-private-gateway-bearer/)
    assert.doesNotMatch(JSON.stringify(f.frames), /synthetic-private-gateway-bearer/)
  }
)

for (const scenario of [
  'wrong nonce',
  'wrong project',
  'invalid generation',
  'malformed',
  'public',
  'symlink',
  'oversized'
] as const) {
  test(
    `real CLI ${scenario} metadata prevents bootstrap before provider execution`,
    { timeout: 30000 },
    async (t) => {
      const f = await createRpcModelSelectionFixture()
      t.after(() => f.close())
      if (scenario === 'public') chmodSync(f.metadataPath, 0o644)
      else if (scenario === 'symlink') {
        const target = join(f.root, 'ordinary-metadata.json')
        writeFileSync(target, readFileSync(f.metadataPath), { mode: 0o600 })
        rmSync(f.metadataPath)
        symlinkSync(target, f.metadataPath)
      } else if (scenario === 'oversized')
        writeFileSync(f.metadataPath, ' '.repeat(RPC_MODEL_METADATA_MAX_BYTES + 1))
      else
        writeFileSync(
          f.metadataPath,
          JSON.stringify(
            scenario === 'malformed'
              ? { schema: 1 }
              : {
                  ...f.metadata,
                  ...(scenario === 'wrong nonce'
                    ? { nonce: randomUUID() }
                    : scenario === 'wrong project'
                      ? { projectRoot: f.root }
                      : { gatewayGeneration: 0 })
                }
          )
        )
      await assert.rejects(
        (async () => {
          await f.connection.start()
          await attestBootstrap(f.connection, f.config, new AbortController().signal)
        })(),
        /guard command is not loaded|RPC output stream ended/
      )
      assert.match(f.stderr(), /Phi RPC model metadata/)
      assert.equal(f.provider.requests.length, 0)
      await f.connection.close()
      assert.equal(f.running(), false)
    }
  )
}
