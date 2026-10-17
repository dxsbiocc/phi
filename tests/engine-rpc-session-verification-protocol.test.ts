import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { createRpcSessionVerifier } from '../src/main/agent/engine/rpc/session-verification'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import { collectSessionAssetReferences } from '../src/main/agent/engine/phi-extension/lib/rpc-session-assets'
import { verifySessionGraph } from '../src/main/agent/engine/phi-extension/lib/rpc-session-proof'
import {
  SessionVerificationError,
  SESSION_VERIFICATION_DEFAULT_BUDGETS,
  RPC_SAVED_STATE_COMMAND,
  RPC_SESSION_VERIFICATION_DESCRIPTION,
  RPC_SESSION_VERIFICATION_TYPE,
  type SessionVerificationCapability
} from '../src/main/agent/engine/phi-extension/lib/rpc-session-verification-protocol'
import { createInitializationWire, deferred } from './helpers/rpc-initialization-wire'
import type { RemoteSessionReference } from '../src/main/agent/engine/rpc/session-storage/types'

const identity = {
  nonce: 'n'.repeat(32),
  phiSessionId: 'phi',
  generation: 1,
  projectRoot: '/project',
  directory: '/private/durable',
  journals: '/private/durable/journals',
  blobs: '/private/durable/data/omp/blobs'
}
const reference: RemoteSessionReference = {
  kind: 'remote-omp',
  version: 1,
  ompVersion: '18.10.3',
  hostProfileId: 'host',
  bindingHash: 'a'.repeat(64),
  projectId: 'project',
  runtimeRoot: '/private',
  projectRoot: identity.projectRoot,
  phiSessionId: identity.phiSessionId,
  durableSessionKey: 'fixture',
  ompSessionId: 'omp',
  journalBasename: 'fixture.jsonl'
}
const code =
  (expected: string): ((error: unknown) => boolean) =>
  (error: unknown) =>
    error instanceof SessionVerificationError && error.code === expected
const signal = (): AbortSignal => new AbortController().signal
const capability: SessionVerificationCapability = {
  ...identity,
  signal: signal(),
  assertActive: () => undefined
}
const settled = {
  isStreaming: false,
  isCompacting: false,
  isSettled: true,
  queuedMessageCount: 0,
  hasPendingAsyncWork: false,
  sessionId: 'live',
  sessionFile: '/live.jsonl'
}
async function fixture(
  t: TestContext,
  options: {
    transform?: (raw: Record<string, unknown>) => Record<string, unknown>
    commands?: unknown[]
    state?: Record<string, unknown>
    hold?: boolean
    gate?: () => void
  } = {}
): Promise<{
  wire: ReturnType<typeof createInitializationWire>
  connection: RpcConnection
  verifier: ReturnType<typeof createRpcSessionVerifier>
  entered: ReturnType<typeof deferred<void>>
}> {
  const entered = deferred<void>()
  const wire = createInitializationWire((command, respond, emit) => {
    if (command.type === 'get_state') {
      respond({ ...settled, ...options.state })
      return true
    }
    if (command.type === 'get_available_commands') {
      entered.resolve()
      if (!options.hold)
        respond({
          commands: options.commands ?? [
            {
              name: RPC_SAVED_STATE_COMMAND,
              source: 'extension',
              description: RPC_SESSION_VERIFICATION_DESCRIPTION
            }
          ]
        })
      return true
    }
    if (command.type === 'prompt') {
      if (command.message === 'ordinary prompt') {
        respond({ agentInvoked: false })
        emit({
          type: 'prompt_result',
          id: command.id,
          status: 'completed',
          agentInvoked: false,
          sessionSettled: true
        })
        return true
      }
      const request = JSON.parse(
        String(command.message).slice(String(command.message).indexOf(' ') + 1)
      )
      let raw: Record<string, unknown> = {
        type: RPC_SESSION_VERIFICATION_TYPE,
        request,
        proof: {
          ompSessionId: 'omp',
          phiSessionId: 'phi',
          generation: 1,
          projectRoot: '/project',
          journalPath: '/private/durable/journals/fixture.jsonl',
          leafId: null,
          model: null,
          modelRole: null,
          journalDigest: 'a'.repeat(64),
          assetDigest: 'b'.repeat(64),
          entryCount: 0,
          blobCount: 0,
          artifactCount: 0
        }
      }
      raw = options.transform?.(raw) ?? raw
      emit({
        type: 'extension_ui_request',
        method: 'notify',
        notifyType: 'info',
        message: JSON.stringify(raw)
      })
      respond({ agentInvoked: false })
      emit({
        type: 'prompt_result',
        id: command.id,
        status: 'completed',
        agentInvoked: false,
        sessionSettled: true
      })
      return true
    }
    return false
  })
  const connection = new RpcConnection(() => wire.transport, { requestTimeoutMs: 1000 })
  t.after(() => connection.close())
  await connection.start()
  const verifier = createRpcSessionVerifier({
    connection,
    control: connection.bindControl(),
    identity,
    assertActive: options.gate ?? (() => undefined),
    timeoutMs: 1000
  })
  return { wire, connection, verifier, entered }
}
test('Node verifier only accepts known local source and exact proof identity', async (t) => {
  const f = await fixture(t)
  assert.equal(
    (await f.verifier.verifySavedState(reference, signal())).journalDigest,
    'a'.repeat(64)
  )
  assert.equal(f.wire.commands.filter((c) => c.type === 'prompt').length, 1)
})
for (const change of [
  'nonce',
  'generation',
  'requestId',
  'unexpected',
  'path',
  'digest',
  'model',
  'modelRole'
]) {
  test('Node verifier rejects changed ' + change, async (t) => {
    const f = await fixture(t, {
      transform: (raw) => {
        const request = { ...(raw.request as Record<string, unknown>) },
          proof = { ...(raw.proof as Record<string, unknown>) }
        if (change === 'nonce') request.nonce = 'wrong'
        if (change === 'generation') request.generation = 2
        if (change === 'requestId') request.unexpected = true
        if (change === 'unexpected') raw.unexpected = true
        if (change === 'path') proof.journalPath = '/outside'
        if (change === 'digest') proof.assetDigest = 'bad'
        if (change === 'model') proof.model = { provider: 'x', id: 'y', apiKey: 'secret' }
        if (change === 'modelRole') proof.modelRole = 'default'
        return { ...raw, request, proof }
      }
    })
    await assert.rejects(
      f.verifier.verifySavedState(reference, signal()),
      code('IDENTITY_MISMATCH')
    )
  })
}
test('unknown command description never becomes a provider prompt', async (t) => {
  const f = await fixture(t, {
    commands: [{ name: RPC_SAVED_STATE_COMMAND, source: 'extension', description: 'other' }]
  })
  await assert.rejects(f.verifier.verifySavedState(reference, signal()), code('IDENTITY_MISMATCH'))
  assert.equal(f.wire.commands.filter((c) => c.type === 'prompt').length, 0)
})
for (const state of [
  { isSettled: false },
  { isStreaming: true },
  { isCompacting: true },
  { queuedMessageCount: 1 },
  { hasPendingAsyncWork: true }
]) {
  test(
    'busy or scheduled continuation fails before local command ' + JSON.stringify(state),
    async (t) => {
      const f = await fixture(t, { state })
      await assert.rejects(f.verifier.verifySavedState(reference, signal()), code('SESSION_BUSY'))
      assert.equal(f.wire.commands.filter((c) => c.type === 'prompt').length, 0)
    }
  )
}
test('preaborted signal does not leave the verifier admission stuck', async (t) => {
  const f = await fixture(t),
    controller = new AbortController()
  controller.abort()
  await assert.rejects(
    f.verifier.verifySavedState(reference, controller.signal),
    code('GENERATION_REVOKED')
  )
  await f.verifier.verifySavedState(reference, signal())
})
test('ordinary prompt revokes the exclusive gate while discovery is awaiting and cannot publish a proof', async (t) => {
  let owned = true
  const f = await fixture(t, {
    hold: true,
    gate: () => {
      if (!owned) throw new Error('gate revoked')
    }
  })
  const pending = f.verifier.verifySavedState(reference, signal())
  await f.entered.promise
  owned = false
  await f.connection.prompt('ordinary prompt')
  const command = f.wire.commands.find((c) => c.type === 'get_available_commands')!
  f.wire.emit({
    type: 'response',
    id: command.id,
    command: command.type,
    success: true,
    data: {
      commands: [
        {
          name: RPC_SAVED_STATE_COMMAND,
          source: 'extension',
          description: RPC_SESSION_VERIFICATION_DESCRIPTION
        }
      ]
    }
  })
  await assert.rejects(pending, code('GENERATION_REVOKED'))
  assert.equal(
    f.wire.commands.filter((c) => c.type === 'prompt' && String(c.message).startsWith('/phi-rpc'))
      .length,
    0
  )
})
test('reference count, object work and graph ancestry have independent explicit limits', () => {
  const hash = 'blob:sha256:' + 'a'.repeat(64)
  const image = { type: 'image', data: hash }
  assert.throws(
    () =>
      collectSessionAssetReferences([{ content: [image, image] }], {
        ...capability,
        budgets: { ...SESSION_VERIFICATION_DEFAULT_BUDGETS, references: 1 }
      }),
    code('VERIFICATION_LIMIT')
  )
  assert.throws(
    () =>
      collectSessionAssetReferences([{ content: [image] }], {
        ...capability,
        budgets: { ...SESSION_VERIFICATION_DEFAULT_BUDGETS, nodes: 1 }
      }),
    code('VERIFICATION_LIMIT')
  )
  const graph = [
    { type: 'session' },
    { type: 'message', id: 'one', parentId: null },
    { type: 'message', id: 'two', parentId: 'one' },
    { type: 'compaction', id: 'three', parentId: 'two', firstKeptEntryId: 'one' }
  ]
  assert.throws(
    () =>
      verifySessionGraph(graph, {
        ...capability,
        budgets: { ...SESSION_VERIFICATION_DEFAULT_BUDGETS, nodes: 1 }
      }),
    code('VERIFICATION_LIMIT')
  )
  assert.throws(
    () =>
      verifySessionGraph(graph, {
        ...capability,
        budgets: { ...SESSION_VERIFICATION_DEFAULT_BUDGETS, entries: 3 }
      }),
    code('VERIFICATION_LIMIT')
  )
})
test('only actual image and structured metadata carriers grant asset dependency authority', () => {
  assert.deepEqual(
    collectSessionAssetReferences(
      [
        {
          type: 'message',
          message: { role: 'user', content: 'blob:sha256:bad artifact://999' },
          signature: 'blob:sha256:bad',
          data: 'blob:sha256:bad'
        }
      ],
      capability
    ),
    { blobs: [], artifacts: [], hydration: [] }
  )
  for (const payload of [
    { content: [{ type: 'image', data: 'blob:sha256:BAD' }] },
    { payload: { image_url: 'blob:sha256:bad' } },
    { details: { meta: { limits: { columnTruncated: { artifactId: '../outside' } } } } }
  ])
    assert.throws(() => collectSessionAssetReferences([payload], capability), code('FILE_INVALID'))
})
