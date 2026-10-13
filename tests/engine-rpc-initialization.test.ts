import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RPC_BOOTSTRAP_COMMAND,
  RPC_BOOTSTRAP_DESCRIPTION,
  type RpcBootstrapConfig
} from '../src/main/agent/engine/phi-extension/lib/rpc-config'
import {
  attestBootstrap,
  createBootstrapAttester
} from '../src/main/agent/engine/rpc/bootstrap-attestation'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import {
  RpcSessionBackend,
  type RpcSessionInitializationContext
} from '../src/main/agent/engine/rpc/rpc-session-backend'
import { eventually } from './engine-contract/basic-suite'
import { createInitializationWire, deferred } from './helpers/rpc-initialization-wire'

const params = {
  sessionId: 'initialization',
  cwd: '/synthetic/project',
  agentDir: '/synthetic/agent'
}
const expected: RpcBootstrapConfig = {
  schema: 1,
  nonce: 'synthetic-nonce-0123456789',
  sessionId: params.sessionId,
  projectId: 'synthetic-project',
  projectRoot: params.cwd,
  ompVersion: '18.10.3',
  contentHash: 'a'.repeat(64)
}
const command = {
  name: RPC_BOOTSTRAP_COMMAND,
  source: 'extension',
  description: RPC_BOOTSTRAP_DESCRIPTION
}
function notice(patch: Record<string, unknown> = {}): unknown {
  const identity: Record<string, unknown> = { ...expected }
  delete identity.schema
  return {
    type: 'phi_rpc_bootstrap_attestation',
    protocolVersion: 1,
    ...identity,
    guards: { projectBoundary: true, remoteUrl: true, writes: 'deny' },
    ...patch
  }
}
function wire(
  options: {
    commands?: unknown
    notification?: unknown
    omitNotification?: boolean
    result?: Record<string, unknown>
    modelEvent?: boolean
  } = {}
): ReturnType<typeof createInitializationWire> {
  return createInitializationWire((request, respond, emit) => {
    if (request.type === 'get_available_commands') {
      respond({ commands: options.commands ?? [command] })
      return true
    }
    if (request.type === 'prompt') {
      assert.equal(request.message, `/${RPC_BOOTSTRAP_COMMAND} ${expected.nonce}`)
      if (options.modelEvent) emit({ type: 'agent_start' })
      if (!options.omitNotification)
        emit({
          type: 'extension_ui_request',
          id: 'notice',
          method: 'notify',
          notifyType: 'info',
          message: JSON.stringify(options.notification ?? notice())
        })
      if (options.result) {
        respond({})
        emit({
          type: 'prompt_result',
          id: request.id,
          agentInvoked: false,
          status: 'completed',
          sessionSettled: true,
          ...options.result
        })
      } else respond({ agentInvoked: false })
      return true
    }
    return false
  })
}

test('initialization gates session methods and events before publishing ready', async (t) => {
  const gate = deferred<void>()
  const transport = createInitializationWire()
  let context: RpcSessionInitializationContext | undefined
  const backend = new RpcSessionBackend(() => transport.transport, {
    initialize(value) {
      context = value
      return gate.promise
    }
  })
  t.after(() => backend.dispose(params))
  const statuses: string[] = []
  const events: string[] = []
  backend.onSessionStatus(params.sessionId, (status) => statuses.push(status.phase))
  backend.onSessionEvent(params.sessionId, (event) => events.push(event.type))
  const creating = backend.create(params)
  await eventually(() => context !== undefined, 'initialization hook')
  assert.equal(backend.has(params.sessionId), true)
  await assert.rejects(
    backend.prompt({ sessionId: params.sessionId, text: 'Too early.' }),
    /unavailable/
  )
  await assert.rejects(backend.abort(params), /unavailable/)
  transport.emit({ type: 'agent_start' })
  assert.deepEqual(events, [])
  assert.deepEqual(statuses, [])
  assert.deepEqual(
    transport.commands.map((request) => request.type),
    ['negotiate_protocol']
  )
  gate.resolve()
  await creating
  assert.deepEqual(statuses, ['ready'])
  assert.deepEqual(
    transport.commands.map((request) => request.type),
    ['negotiate_protocol', 'get_state', 'get_messages']
  )
})

test('initialization failure closes its owned channel and releases the session', async () => {
  const transport = createInitializationWire()
  const backend = new RpcSessionBackend(() => transport.transport, {
    initialize() {
      throw new Error('Guard setup failed')
    }
  })
  await assert.rejects(backend.create(params), /Guard setup failed/)
  assert.equal(transport.closeCalls(), 1)
  assert.equal(backend.has(params.sessionId), false)
  assert.ok(!transport.commands.some((request) => request.type === 'get_state'))
})

test('initialization timeout cancels a hook that ignores cancellation and closes the channel', async () => {
  const gate = deferred<void>()
  const transport = createInitializationWire()
  let signal: AbortSignal | undefined
  const backend = new RpcSessionBackend(() => transport.transport, {
    initializationTimeoutMs: 20,
    initialize(context) {
      signal = context.signal
      return gate.promise
    }
  })
  await assert.rejects(backend.create(params), /initialization timed out/)
  assert.equal(signal?.aborted, true)
  assert.equal(transport.closeCalls(), 1)
  assert.equal(backend.has(params.sessionId), false)
  gate.resolve()
})

test('disconnect cancels pending initialization and cannot produce ready', async () => {
  const gate = deferred<void>()
  const transport = createInitializationWire()
  let signal: AbortSignal | undefined
  const backend = new RpcSessionBackend(() => transport.transport, {
    initialize(context) {
      signal = context.signal
      return gate.promise
    }
  })
  const statuses: string[] = []
  backend.onSessionStatus(params.sessionId, (status) => statuses.push(status.phase))
  const creating = backend.create(params)
  await eventually(() => signal !== undefined, 'hook before disconnect')
  transport.disconnect()
  await assert.rejects(creating, /ended|exited/)
  assert.equal(signal?.aborted, true)
  assert.deepEqual(statuses, ['interrupted'])
  assert.equal(backend.has(params.sessionId), false)
  gate.resolve()
})

test('disposed initialization and a late hook cannot affect a same-id replacement', async (t) => {
  const gate = deferred<void>()
  const transports: ReturnType<typeof createInitializationWire>[] = []
  const contexts: RpcSessionInitializationContext[] = []
  const openedParams: unknown[] = []
  const backend = new RpcSessionBackend(
    (input) => {
      openedParams.push(input)
      const transport = createInitializationWire()
      transports.push(transport)
      return transport.transport
    },
    {
      initialize(context) {
        contexts.push(context)
        if (contexts.length === 1) return gate.promise
        return undefined
      }
    }
  )
  t.after(() => backend.dispose(params))
  const first = backend.create(params)
  void first.catch(() => undefined)
  await eventually(() => contexts.length === 1, 'first initialization')
  const disposing = backend.dispose(params)
  const statuses: string[] = []
  backend.onSessionStatus(params.sessionId, (status) => statuses.push(status.phase))
  await backend.create(params)
  await disposing
  await assert.rejects(first, /disposed/)
  gate.resolve()
  await new Promise((resolve) => setImmediate(resolve))
  assert.notEqual(openedParams[0], openedParams[1])
  assert.equal(openedParams[0], contexts[0].params)
  assert.equal(openedParams[1], contexts[1].params)
  assert.equal(Object.isFrozen(openedParams[0]), true)
  assert.equal(contexts[0].signal.aborted, true)
  assert.equal(contexts[1].signal.aborted, false)
  assert.deepEqual(statuses, ['ready'])
  assert.equal(transports[0].closeCalls(), 1)
  assert.equal(transports[1].closeCalls(), 0)
  assert.equal(backend.has(params.sessionId), true)
})

test('bootstrap attestation verifies known extension command and exact identity without model work', async (t) => {
  const transport = wire()
  const backend = new RpcSessionBackend(() => transport.transport, {
    initialize: createBootstrapAttester(expected)
  })
  t.after(() => backend.dispose(params))
  await backend.create(params)
  assert.deepEqual(
    transport.commands.map((request) => request.type),
    ['negotiate_protocol', 'get_available_commands', 'prompt', 'get_state', 'get_messages']
  )
})

for (const commands of [
  [],
  [{ ...command, source: 'custom' }],
  [{ ...command, description: 'Wrong protocol' }],
  [command, command],
  'invalid'
]) {
  test(`bootstrap rejects missing or invalid command metadata: ${JSON.stringify(commands)}`, async () => {
    const transport = wire({ commands })
    const backend = new RpcSessionBackend(() => transport.transport, {
      initialize: createBootstrapAttester(expected)
    })
    await assert.rejects(backend.create(params), /command list|command is not loaded/)
    assert.equal(transport.closeCalls(), 1)
    assert.equal(backend.has(params.sessionId), false)
    assert.ok(
      !transport.commands.some((request) => request.type === 'prompt'),
      'Unknown slash command must never reach model dispatch'
    )
  })
}

for (const [key, value] of Object.entries({
  nonce: 'wrong-nonce-0123456789',
  sessionId: 'other-session',
  projectId: 'other-project',
  projectRoot: '/other/project',
  ompVersion: '18.1.10',
  contentHash: 'b'.repeat(64),
  protocolVersion: 2,
  guards: { projectBoundary: true, remoteUrl: false, writes: 'deny' }
})) {
  test(`bootstrap rejects mismatched attestation ${key}`, async () => {
    const transport = wire({ notification: notice({ [key]: value }) })
    const backend = new RpcSessionBackend(() => transport.transport, {
      initialize: createBootstrapAttester(expected)
    })
    await assert.rejects(backend.create(params), /does not match|guards are not active/)
    assert.equal(transport.closeCalls(), 1)
    assert.equal(backend.has(params.sessionId), false)
    assert.ok(!transport.commands.some((request) => request.type === 'get_state'))
  })
}

test('bootstrap missing notification times out and cleans the owned channel', async () => {
  const transport = wire({ omitNotification: true })
  const backend = new RpcSessionBackend(() => transport.transport, {
    initialize: createBootstrapAttester(expected, { timeoutMs: 20 })
  })
  await assert.rejects(backend.create(params), /attestation timed out/)
  assert.equal(transport.closeCalls(), 1)
  assert.equal(backend.has(params.sessionId), false)
})

for (const options of [
  { modelEvent: true },
  { result: { agentInvoked: true } },
  { result: { status: 'aborted' } },
  { result: { sessionSettled: false } }
]) {
  test(`bootstrap requires local settled completion: ${JSON.stringify(options)}`, async () => {
    const transport = wire(options)
    const backend = new RpcSessionBackend(() => transport.transport, {
      initialize: createBootstrapAttester(expected)
    })
    await assert.rejects(backend.create(params), /model execution|did not complete locally/)
    assert.equal(transport.closeCalls(), 1)
    assert.equal(backend.has(params.sessionId), false)
  })
}

test('cancelled attestation cannot dispatch a late slash probe after command discovery resolves', async (t) => {
  let replyList: ((data: unknown) => void) | undefined
  const transport = createInitializationWire((request, respond) => {
    if (request.type !== 'get_available_commands') return false
    replyList = respond
    return true
  })
  const connection = new RpcConnection(() => transport.transport)
  t.after(() => connection.close())
  await connection.start()
  const controller = new AbortController()
  const pending = attestBootstrap(connection, expected, controller.signal)
  await eventually(() => replyList !== undefined, 'command discovery')
  controller.abort(new Error('Cancelled bootstrap'))
  await assert.rejects(pending, /Cancelled bootstrap/)
  replyList!({ commands: [command] })
  await new Promise((resolve) => setImmediate(resolve))
  assert.ok(!transport.commands.some((request) => request.type === 'prompt'))
})

test('a conflicting attestation after a valid notification still rejects initialization', async () => {
  const transport = createInitializationWire((request, respond, emit) => {
    if (request.type === 'get_available_commands') {
      respond({ commands: [command] })
      return true
    }
    if (request.type !== 'prompt') return false
    for (const data of [notice(), notice({ contentHash: 'b'.repeat(64) })]) {
      emit({
        type: 'extension_ui_request',
        id: 'notice',
        method: 'notify',
        notifyType: 'info',
        message: JSON.stringify(data)
      })
    }
    respond({ agentInvoked: false })
    return true
  })
  const backend = new RpcSessionBackend(() => transport.transport, {
    initialize: createBootstrapAttester(expected)
  })
  await assert.rejects(backend.create(params), /contentHash does not match/)
  assert.equal(transport.closeCalls(), 1)
})
