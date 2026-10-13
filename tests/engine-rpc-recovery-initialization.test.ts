import assert from 'node:assert/strict'
import test from 'node:test'
import { RpcSessionBackend } from '../src/main/agent/engine/rpc/rpc-session-backend'
import { eventually } from './engine-contract/basic-suite'
import { createInitializationWire, deferred } from './helpers/rpc-initialization-wire'

const params = {
  sessionId: 'recovery-initialization',
  cwd: '/synthetic/project',
  agentDir: '/synthetic/agent',
  model: {
    provider: 'bootstrap',
    id: 'bootstrap-model',
    name: 'Bootstrap',
    reasoning: true,
    supportsImages: false
  },
  thinkingLevel: 'high' as const
}

test('verified recovery selection survives bootstrap defaults before readiness', async (t) => {
  let selected = 'bootstrap-model'
  let thinking = 'high'
  const wire = createInitializationWire((command, respond) => {
    if (command.type === 'set_model') {
      selected = String(command.modelId)
      respond({})
      return true
    }
    if (command.type === 'set_thinking_level') {
      thinking = String(command.level)
      respond({})
      return true
    }
    if (command.type === 'get_state') {
      respond({
        sessionFile: '/synthetic/saved.jsonl',
        model: { provider: 'saved', id: selected, name: 'Saved', reasoning: true },
        thinkingLevel: thinking
      })
      return true
    }
    return false
  })
  let defaultSelections = 0
  const backend = new RpcSessionBackend(() => wire.transport, {
    async initialize({ connection }) {
      await connection.request({ type: 'set_model', provider: 'saved', modelId: 'saved-model' })
      await connection.request({ type: 'set_thinking_level', level: 'low' })
      return { selectionHandled: true }
    },
    async selectModel({ connection }, model) {
      defaultSelections++
      await connection.request({ type: 'set_model', provider: model.provider, modelId: model.id })
    }
  })
  t.after(() => backend.dispose(params))
  const { state } = await backend.create(params)
  assert.equal(defaultSelections, 0, 'a verified restored model must not be overwritten')
  assert.equal(state.model?.id, 'saved-model')
  assert.equal(state.thinkingLevel, 'low')
  assert.deepEqual(
    wire.commands.filter((command) => command.type === 'set_thinking_level').map((c) => c.level),
    ['low']
  )
})

test('a void initializer retains explicit launch model and thinking selection', async (t) => {
  const wire = createInitializationWire()
  const selected: string[] = []
  const backend = new RpcSessionBackend(() => wire.transport, {
    initialize() {
      return undefined
    },
    selectModel(_context, model) {
      selected.push(model.id)
    }
  })
  t.after(() => backend.dispose(params))
  await backend.create(params)
  assert.deepEqual(selected, ['bootstrap-model'])
  assert.deepEqual(
    wire.commands.filter((command) => command.type === 'set_thinking_level').map((c) => c.level),
    ['high']
  )
})

test('late recovery completion cannot suppress a replacement generation model selection', async (t) => {
  const gate = deferred<{ selectionHandled: true }>()
  const selected: string[] = []
  let initializing = 0
  const backend = new RpcSessionBackend(() => createInitializationWire().transport, {
    initialize() {
      initializing++
      return initializing === 1 ? gate.promise : undefined
    },
    selectModel(_context, model) {
      selected.push(model.id)
    }
  })
  t.after(() => backend.dispose(params))
  const first = backend.create(params)
  void first.catch(() => undefined)
  await eventually(() => initializing === 1, 'first recovery initialization')
  await backend.dispose(params)
  await assert.rejects(first, /disposed/)
  await backend.create(params)
  gate.resolve({ selectionHandled: true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(selected, ['bootstrap-model'])
  assert.equal(backend.has(params.sessionId), true)
})
