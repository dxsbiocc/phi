import assert from 'node:assert/strict'
import test from 'node:test'
import { promptWithAutomaticModelFallback } from '../src/main/agent/session/automatic-model-fallback'
import type {
  RuntimeAgentSession,
  RuntimeModel,
  RuntimePromptOptions
} from '../src/main/agent/runtime/runtime-adapter'

function model(id: string): RuntimeModel {
  return { provider: 'fixture', id, name: id, reasoning: true }
}

type TestSession = Pick<RuntimeAgentSession, 'messages' | 'prompt' | 'setModel'> & {
  model: RuntimeModel
}
type PromptCall = { model: string; text: string; options?: RuntimePromptOptions }

function fixture(): {
  input: Parameters<typeof promptWithAutomaticModelFallback>[0]
  calls: PromptCall[]
  switches: string[]
  session: TestSession
  stop(): void
} {
  const first = model('first')
  const second = model('second')
  const third = model('third')
  let failure: string | undefined
  let current = true
  const calls: Array<{ model: string; text: string; options?: RuntimePromptOptions }> = []
  const switches: string[] = []
  const session = {
    model: first,
    messages: [] as unknown[],
    prompt: async (text: string, options?: RuntimePromptOptions): Promise<void> => {
      calls.push({ model: session.model.id, text, options })
      session.messages.push({ role: options?.synthetic ? 'developer' : 'user', content: text })
      failure = session.model.id === 'third' ? undefined : '429 rate limit'
    },
    setModel: async (next: RuntimeModel): Promise<void> => {
      session.model = next
    }
  }
  const input = {
    session,
    text: 'Finish the analysis',
    options: {
      hostRunId: 'run-1',
      images: [{ type: 'image' as const, data: 'image', mimeType: 'image/png' }]
    },
    automatic: true,
    isCurrent: () => current,
    recordedFailure: () => failure,
    clearFailure: () => {
      failure = undefined
    },
    candidates: async () => [first, second, second, third],
    onSwitch: (_from: RuntimeModel, to: RuntimeModel) => {
      switches.push(to.id)
    }
  }
  return {
    input,
    calls,
    switches,
    session,
    stop: () => {
      current = false
    }
  }
}

test('automatic mode tries distinct models until success within the same run and history', async () => {
  const f = fixture()
  await promptWithAutomaticModelFallback(f.input)
  assert.deepEqual(
    f.calls.map((call) => call.model),
    ['first', 'second', 'third']
  )
  assert.deepEqual(f.switches, ['second', 'third'])
  assert.equal(
    f.session.messages.filter((item) => (item as { role: string }).role === 'user').length,
    1
  )
  assert.ok(f.calls.slice(1).every((call) => call.options?.synthetic && !call.options.images))
  assert.ok(f.calls.every((call) => call.options?.hostRunId === 'run-1'))
  assert.equal(f.input.recordedFailure(), undefined)
})

test('an exhausted candidate list preserves the final model failure', async () => {
  const f = fixture()
  f.input.candidates = async () => [model('first'), model('second')]
  await promptWithAutomaticModelFallback(f.input)
  assert.equal(f.calls.length, 2)
  assert.equal(f.input.recordedFailure(), '429 rate limit')
})

test('fixed model selection does not silently change models', async () => {
  const f = fixture()
  f.input.automatic = false
  await promptWithAutomaticModelFallback(f.input)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.switches, [])
})

test('thrown provider failures before admission retry the original prompt with attachments', async () => {
  const f = fixture()
  f.session.prompt = async (text, options) => {
    f.calls.push({ model: f.session.model.id, text, options })
    if (f.session.model.id === 'first') throw new Error('401 Invalid Authentication')
  }
  await promptWithAutomaticModelFallback(f.input)
  assert.deepEqual(
    f.calls.map((call) => call.model),
    ['first', 'second']
  )
  assert.equal(f.calls[1].text, f.input.text)
  assert.equal(f.calls[1].options?.images?.length, 1)
})

test('tool approval failures are not retried with another model', async () => {
  const f = fixture()
  f.session.prompt = async () => {
    throw new Error('Permission denied for tool write')
  }
  await assert.rejects(promptWithAutomaticModelFallback(f.input), /Permission denied/)
  assert.deepEqual(f.switches, [])
})

test('cancel during candidate discovery does not select or start another model', async () => {
  const f = fixture()
  f.input.candidates = async () => {
    f.stop()
    return [model('second')]
  }
  await promptWithAutomaticModelFallback(f.input)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.switches, [])
})

test('cancel during model selection does not start its prompt', async () => {
  const f = fixture()
  f.session.setModel = async (next) => {
    f.session.model = next
    f.stop()
  }
  await promptWithAutomaticModelFallback(f.input)
  assert.equal(f.calls.length, 1)
  assert.deepEqual(f.switches, [])
})

test('a rejected fallback model is skipped without repeating previously tried models', async () => {
  const f = fixture()
  f.session.setModel = async (next) => {
    if (next.id === 'second') throw new Error('404 model not found')
    f.session.model = next
  }
  await promptWithAutomaticModelFallback(f.input)
  assert.deepEqual(
    f.calls.map((call) => call.model),
    ['first', 'third']
  )
})
