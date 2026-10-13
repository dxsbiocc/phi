import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { test, type TestContext } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import { selectRemoteModel } from '../src/main/agent/engine/rpc/model-selection'
import { RpcSessionBackend, RpcPromptError } from '../src/main/agent/engine/rpc/rpc-session-backend'
import {
  RPC_MODEL_SELECTION_COMMAND,
  RPC_MODEL_SELECTION_DESCRIPTION,
  type RpcModelMetadata
} from '../src/main/agent/engine/phi-extension/lib/rpc-model-metadata'
import { createInitializationWire, deferred } from './helpers/rpc-initialization-wire'

const ref = { provider: 'fixture', id: 'model' }
const model = { ...ref, name: 'Fixture', reasoning: false, supportsImages: false }
const metadata: RpcModelMetadata = {
  schema: 1,
  nonce: 'f'.repeat(32),
  sessionId: 'session',
  projectRoot: '/project',
  gatewayGeneration: 1,
  models: [
    {
      ...ref,
      name: 'Fixture',
      reasoning: false,
      input: ['text'],
      contextWindow: null,
      maxTokens: null
    }
  ]
}
const declaration = {
  name: RPC_MODEL_SELECTION_COMMAND,
  description: RPC_MODEL_SELECTION_DESCRIPTION,
  source: 'extension'
}

type SelectionOptions = {
  commands?: unknown[]
  notification?: (payload: Record<string, unknown>) => Record<string, unknown> | undefined
  result?: Record<string, unknown>
  agentStart?: boolean
  holdDiscovery?: boolean
  extensionError?: Record<string, unknown>
}
async function fixture(
  t: TestContext,
  options: SelectionOptions = {}
): Promise<{
  connection: RpcConnection
  wire: ReturnType<typeof createInitializationWire>
  selections: Record<string, unknown>[]
}> {
  const selections: Record<string, unknown>[] = []
  const wire = createInitializationWire((command, respond, emit) => {
    if (command.type === 'get_available_commands') {
      if (!options.holdDiscovery) respond({ commands: options.commands ?? [declaration] })
      return true
    }
    if (command.type === 'prompt') {
      const text = String(command.message)
      assert.ok(text.startsWith(`/${RPC_MODEL_SELECTION_COMMAND} `))
      const request = JSON.parse(text.slice(text.indexOf(' ') + 1)) as Record<string, unknown>
      selections.push(request)
      if (options.agentStart) emit({ type: 'agent_start' })
      if (options.extensionError) emit({ type: 'extension_error', ...options.extensionError })
      const payload = options.notification ? options.notification(request) : request
      if (payload)
        emit({
          type: 'extension_ui_request',
          method: 'notify',
          notifyType: 'info',
          message: JSON.stringify({
            type: 'phi_rpc_model_selection',
            protocolVersion: 1,
            contextWindow: null,
            maxTokens: null,
            ...payload
          })
        })
      respond({ agentInvoked: false })
      emit({
        type: 'prompt_result',
        id: command.id,
        status: 'completed',
        agentInvoked: false,
        sessionSettled: true,
        ...options.result
      })
      return true
    }
    return false
  })
  const connection = new RpcConnection(() => wire.transport, { requestTimeoutMs: 1000 })
  t.after(() => connection.close())
  await connection.start()
  return { connection, wire, selections }
}

test('trusted local selection restores null limits and repeated same-model choices use fresh challenges', async (t) => {
  const f = await fixture(t)
  await selectRemoteModel(f.connection, metadata, ref, new AbortController().signal)
  await selectRemoteModel(f.connection, metadata, ref, new AbortController().signal)
  assert.equal(f.selections.length, 2)
  assert.notEqual(f.selections[0].selectionId, f.selections[1].selectionId)
  assert.equal(
    f.wire.commands.some((command) => command.type === 'set_model'),
    false
  )
})

test('missing, duplicate, wrong-source or wrong-description commands are never probed', async (t) => {
  for (const commands of [
    [],
    [declaration, declaration],
    [{ ...declaration, source: 'builtin' }],
    [{ ...declaration, description: 'other' }]
  ]) {
    const f = await fixture(t, { commands })
    await assert.rejects(
      selectRemoteModel(f.connection, metadata, ref, new AbortController().signal),
      /command is not loaded/
    )
    assert.equal(f.selections.length, 0)
  }
})

test('selection accepts only exact generation, model, protocol and nullable limits', async (t) => {
  for (const changed of [
    { nonce: 'wrong' },
    { sessionId: 'wrong' },
    { projectRoot: '/wrong' },
    { gatewayGeneration: 2 },
    { provider: 'wrong' },
    { modelId: 'wrong' },
    { protocolVersion: 2 },
    { contextWindow: 128000 },
    { maxTokens: 16384 }
  ]) {
    const f = await fixture(t, { notification: (payload) => ({ ...payload, ...changed }) })
    await assert.rejects(
      selectRemoteModel(f.connection, metadata, ref, new AbortController().signal),
      /does not match|limits do not match/
    )
  }
})

test('a stale challenge cannot satisfy current selection and agent execution fails closed', async (t) => {
  const stale = await fixture(t, {
    notification: (payload) => ({ ...payload, selectionId: 'old' })
  })
  await assert.rejects(
    selectRemoteModel(stale.connection, metadata, ref, new AbortController().signal, {
      timeoutMs: 10
    }),
    /selection timed out/
  )
  const executing = await fixture(t, { agentStart: true })
  await assert.rejects(
    selectRemoteModel(executing.connection, metadata, ref, new AbortController().signal),
    /attempted model execution/
  )
})

test('local selection errors survive without waiting for an absent success notification', async (t) => {
  const f = await fixture(t, {
    notification: () => undefined,
    result: { status: 'error', error: { message: 'selection denied', retryable: false } }
  })
  await assert.rejects(
    selectRemoteModel(f.connection, metadata, ref, new AbortController().signal),
    (error) => error instanceof RpcPromptError && error.message === 'selection denied'
  )
})

test('cancelled discovery cannot later probe and independent deadlines are validated', async (t) => {
  const f = await fixture(t, { holdDiscovery: true })
  const controller = new AbortController()
  const selecting = selectRemoteModel(f.connection, metadata, ref, controller.signal)
  await delay(1)
  controller.abort(new Error('cancel selection'))
  await assert.rejects(selecting, /cancel selection/)
  const discovery = f.wire.commands.find((command) => command.type === 'get_available_commands')!
  f.wire.emit({
    type: 'response',
    id: discovery.id,
    command: discovery.type,
    success: true,
    data: { commands: [declaration] }
  })
  await delay(1)
  assert.equal(f.selections.length, 0)
  for (const timeoutMs of [0, -1, NaN, Infinity])
    await assert.rejects(
      selectRemoteModel(f.connection, metadata, ref, new AbortController().signal, { timeoutMs }),
      /positive and finite/
    )
})

test('backend uses one transport hook for initial and future selections and blocks concurrent prompt/model changes', async () => {
  const wire = createInitializationWire()
  const selections: Array<{ params: unknown; model: unknown }> = []
  const held = deferred<void>()
  const backend = new RpcSessionBackend(() => wire.transport, {
    async selectModel(context, model) {
      selections.push({ params: context.params, model })
      if (selections.length === 2) await held.promise
    }
  })
  const params = { sessionId: 'session', cwd: '/project', agentDir: '/unused', model }
  await backend.create(params)
  const changing = backend.setModel({
    sessionId: params.sessionId,
    model: { ...model, id: 'second' }
  })
  await assert.rejects(
    backend.prompt({ sessionId: params.sessionId, text: 'no concurrent prompt' }),
    /unavailable/
  )
  await assert.rejects(backend.setModel({ sessionId: params.sessionId, model }), /unavailable/)
  held.resolve()
  await changing
  assert.equal(selections.length, 2)
  assert.equal(selections[0].params, selections[1].params)
  assert.equal(
    wire.commands.some((command) => command.type === 'set_model'),
    false
  )
  await backend.dispose(params)
})

test('active prompts reject model changes and hook failure/timeout never marks the session ready', async () => {
  const wire = createInitializationWire((command, respond) => {
    if (command.type === 'prompt') {
      respond({ agentInvoked: true })
      return true
    }
    return false
  })
  let selections = 0
  const backend = new RpcSessionBackend(() => wire.transport, {
    selectModel: () => {
      selections++
    }
  })
  const params = { sessionId: 'session', cwd: '/project', agentDir: '/unused', model }
  await backend.create(params)
  const pending = backend.prompt({ sessionId: params.sessionId, text: 'held' })
  const rejected = assert.rejects(pending)
  await assert.rejects(
    backend.setModel({ sessionId: params.sessionId, model }),
    /Cannot change a running/
  )
  assert.equal(selections, 1)
  await backend.dispose(params)
  await rejected
  for (const timeout of [false, true]) {
    const expected = new Error('explicit selection failed')
    const engine = new RpcSessionBackend(() => createInitializationWire().transport, {
      modelSelectionTimeoutMs: 10,
      selectModel: () => {
        if (timeout) return new Promise<void>(() => undefined)
        throw expected
      }
    })
    await assert.rejects(
      engine.create(params),
      timeout ? /model selection timed out/ : (error) => error === expected
    )
    assert.equal(engine.has(params.sessionId), false)
  }
})

test('failed later selection preserves its error, interrupts once and never permits a prompt', async () => {
  const expected = new Error('approved model selection failed')
  let selections = 0
  const backend = new RpcSessionBackend(() => createInitializationWire().transport, {
    selectModel: () => {
      if (++selections === 2) throw expected
    }
  })
  const params = { sessionId: 'session', cwd: '/project', agentDir: '/unused', model }
  await backend.create(params)
  const errors: Error[] = []
  backend.onSessionStatus(params.sessionId, (status) => {
    if (status.phase === 'interrupted') errors.push(status.error)
  })
  await assert.rejects(
    backend.setModel({ sessionId: params.sessionId, model }),
    (error) => error === expected
  )
  assert.deepEqual(errors, [expected])
  await assert.rejects(
    backend.prompt({ sessionId: params.sessionId, text: 'not ready' }),
    /unavailable/
  )
  await backend.dispose(params)
})

test('cancelled model selection cannot mutate or notify a same-id replacement', async () => {
  const held = deferred<void>()
  let selections = 0
  const backend = new RpcSessionBackend(() => createInitializationWire().transport, {
    selectModel: () => {
      if (++selections === 2) return held.promise
      return undefined
    }
  })
  const params = { sessionId: 'session', cwd: '/project', agentDir: '/unused', model }
  await backend.create(params)
  const selecting = backend.setModel({ sessionId: params.sessionId, model })
  const rejected = assert.rejects(selecting, /disposed/)
  await delay(1)
  await backend.dispose(params)
  await backend.create(params)
  const phases: string[] = []
  backend.onSessionStatus(params.sessionId, (status) => phases.push(status.phase))
  held.resolve()
  await rejected
  await delay(1)
  assert.equal(backend.has(params.sessionId), true)
  assert.deepEqual(phases, [])
  await backend.dispose(params)
})

test('only the active exact selection command error fails the local challenge promptly', async (t) => {
  const failed = await fixture(t, {
    notification: () => undefined,
    extensionError: {
      extensionPath: `command:${RPC_MODEL_SELECTION_COMMAND}`,
      event: 'command',
      error: 'Phi RPC model selection was rejected'
    }
  })
  await assert.rejects(
    selectRemoteModel(failed.connection, metadata, ref, new AbortController().signal),
    /Phi RPC model selection was rejected/
  )
  const unrelated = await fixture(t, {
    extensionError: {
      extensionPath: 'command:unrelated',
      event: 'command',
      error: 'unrelated event'
    }
  })
  await selectRemoteModel(unrelated.connection, metadata, ref, new AbortController().signal)
})

test('selection primary survives rejected, timed-out and gated cleanup with strict unhandled rejection enforcement', () => {
  for (const scenario of ['reject', 'timeout', 'gated']) {
    const output = execFileSync(
      process.execPath,
      [
        '--unhandled-rejections=strict',
        '--import',
        './scripts/test-loader.mjs',
        'tests/helpers/rpcModelSelectionCleanup.ts',
        scenario
      ],
      { cwd: process.cwd(), encoding: 'utf8', timeout: 10_000 }
    )
    assert.match(
      output,
      new RegExp(`selection primary retained; ${scenario} cleanup completed within budget`)
    )
  }
})
