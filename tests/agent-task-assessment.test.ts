import assert from 'node:assert/strict'
import test from 'node:test'

import type { DecisionRequest, DecisionResult } from '../src/shared/decisionTypes'
import type { PhiAgentDefinition } from '../src/main/agent/agents/definition'
import { AgentRunRegistry } from '../src/main/agent/agents/registry'
import { buildAgentTool } from '../src/main/agent/agents/tool'
import type { PhiToolContext, PhiToolResult } from '../src/main/agent/engine/types'

const WRAPPER: PhiAgentDefinition = {
  name: 'Wrapper',
  description: 'Runs and creates Nextflow wrappers.',
  delegation: 'Delegate workflow execution with exact paths and user constraints.',
  tools: ['read'],
  skills: [],
  systemPrompt: 'You are Wrapper.',
  source: 'phi',
  filePath: '/agents/Wrapper.md',
  visibility: 'entry',
  warnings: []
}
const context: PhiToolContext = { cwd: '/project', recentUserImages: () => [] }
const decision = (choice: string): DecisionResult => ({
  choice,
  source: 'model',
  model: { providerId: 'provider', modelId: 'main-model' },
  fallbackReason: 'not_configured'
})
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

test('unsuitable routing is recoverable and does not consume a run or unlock controlled fallback', async () => {
  const registry = new AgentRunRegistry()
  const updates: PhiToolResult[] = []
  const tool = buildAgentTool(WRAPPER, async () => assert.fail('must not launch'), registry, {
    assessTask: async () => decision('unsuitable')
  })
  const result = await tool.execute(
    'call',
    { task: 'Make a logo', background: true },
    (update) => updates.push(update),
    context
  )
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.content), /unsuitable.*No specialist run was started/)
  assert.deepEqual(registry.list(), [])
  assert.equal(registry.fallbackReadiness('Wrapper', 1).allowed, false)
  assert.equal(registry.fallbackReadiness('Wrapper', 1).failures, 0)
  assert.deepEqual(result.details, {
    kind: 'agent_decision',
    agent: 'Wrapper',
    purpose: 'task_routing',
    decision: decision('unsuitable')
  })
  assert.deepEqual(updates[0].details, result.details)
})

test('suitable and uncertain assessments preserve the original task and expose the decision source', async () => {
  for (const choice of ['suitable', 'uncertain']) {
    let receivedRequest: DecisionRequest | undefined
    let receivedTask: string | undefined
    const tool = buildAgentTool(
      WRAPPER,
      async ({ task }) => {
        receivedTask = task
        return { text: 'Complete', toolCalls: 1 }
      },
      undefined,
      {
        assessTask: async (request) => {
          receivedRequest = request
          return decision(choice)
        }
      }
    )
    const result = await tool.execute(
      'call',
      { task: 'Run only the selected wrapper.' },
      undefined,
      context
    )
    assert.equal(result.isError, undefined)
    assert.equal(receivedTask, 'Run only the selected wrapper.')
    assert.equal(JSON.parse(receivedRequest!.context).task, receivedTask)
    assert.deepEqual(result.details, {
      kind: 'agent_result',
      agent: 'Wrapper',
      decision: decision(choice),
      status: 'completed',
      missingInputs: [],
      toolCalls: 1
    })
  }
})

test('argument validation precedes assessment and assessment errors do not leak provider details', async () => {
  let calls = 0
  const registry = new AgentRunRegistry()
  const tool = buildAgentTool(WRAPPER, async () => assert.fail('must not launch'), registry, {
    assessTask: async () => {
      calls += 1
      throw new Error('Authorization: Bearer secret-token; private endpoint response')
    }
  })
  assert.equal((await tool.execute('missing', {}, undefined, context)).isError, true)
  assert.equal(calls, 0)
  const result = await tool.execute('failure', { task: 'Run workflow' }, undefined, context)
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result), /assessment failed/)
  assert.doesNotMatch(JSON.stringify(result), /secret-token|Authorization|endpoint/)
  assert.deepEqual(registry.list(), [])
})

test('invalid routing labels never start a run', async () => {
  const registry = new AgentRunRegistry()
  const tool = buildAgentTool(WRAPPER, async () => assert.fail('must not launch'), registry, {
    assessTask: async () => decision('override_approval')
  })
  const result = await tool.execute('invalid', { task: 'Run workflow' }, undefined, context)
  assert.equal(result.isError, true)
  assert.deepEqual(registry.list(), [])
})

test('native assessments expose only the decision contract and do not use concentration as a routing threshold', async () => {
  const nativeDecision: DecisionResult = {
    choice: 'unsuitable',
    source: 'native',
    model: { providerId: 'judge-provider', modelId: 'judge-model' },
    confidence: 0.2
  }
  const registry = new AgentRunRegistry()
  const tool = buildAgentTool(WRAPPER, async () => assert.fail('must not launch'), registry, {
    assessTask: async () => ({ ...nativeDecision, rawProviderResponse: 'private-token' })
  })
  const result = await tool.execute('native', { task: 'Make a logo' }, undefined, context)
  assert.equal(result.isError, true)
  assert.deepEqual(result.details, {
    kind: 'agent_decision',
    agent: 'Wrapper',
    purpose: 'task_routing',
    decision: nativeDecision
  })
  assert.doesNotMatch(JSON.stringify(result), /private-token|rawProviderResponse/)
  assert.deepEqual(registry.list(), [])
})

test('an already cancelled parent does not call assessment or start a background run', async () => {
  const controller = new AbortController()
  controller.abort()
  const registry = new AgentRunRegistry()
  const tool = buildAgentTool(WRAPPER, async () => assert.fail('must not launch'), registry, {
    assessTask: async () => assert.fail('must not assess')
  })
  const result = await tool.execute(
    'cancelled',
    { task: 'Run workflow', background: true },
    undefined,
    context,
    controller.signal
  )
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.content), /cancelled/)
  assert.deepEqual(registry.list(), [])
})

test(
  'cancellation settles an ignored signal and a late assessment cannot launch background work',
  { timeout: 1_000 },
  async () => {
    const controller = new AbortController()
    const gate = deferred<DecisionResult>()
    const registry = new AgentRunRegistry()
    let receivedSignal: AbortSignal | undefined
    const tool = buildAgentTool(WRAPPER, async () => assert.fail('must not launch'), registry, {
      assessTask: async (_, signal) => {
        receivedSignal = signal
        return gate.promise
      }
    })
    const pending = tool.execute(
      'cancelled',
      { task: 'Run workflow', background: true },
      undefined,
      context,
      controller.signal
    )
    await tick()
    assert.equal(receivedSignal, controller.signal)
    assert.deepEqual(registry.list(), [])
    controller.abort()
    const result = await pending
    assert.equal(result.isError, true)
    gate.resolve(decision('suitable'))
    await tick()
    assert.deepEqual(registry.list(), [])
  }
)

test('cancellation from the assessment update still prevents background launch', async () => {
  const controller = new AbortController()
  const registry = new AgentRunRegistry()
  const tool = buildAgentTool(WRAPPER, async () => assert.fail('must not launch'), registry, {
    assessTask: async () => decision('suitable')
  })
  const result = await tool.execute(
    'cancelled',
    { task: 'Run workflow', background: true },
    () => controller.abort(),
    context,
    controller.signal
  )
  assert.equal(result.isError, true)
  assert.deepEqual(registry.list(), [])
})

test('successful assessments still respect registry concurrency, stop control and total-run limits', async () => {
  const registry = new AgentRunRegistry({ limits: { maxConcurrent: 1, maxRuns: 2 } })
  const gate = deferred<{ text: string; toolCalls: number }>()
  let started = 0
  const tool = buildAgentTool(
    WRAPPER,
    async () => {
      started += 1
      return gate.promise
    },
    registry,
    { assessTask: async () => decision('suitable') }
  )
  const first = await tool.execute('first', { task: 'One', background: true }, undefined, context)
  const second = await tool.execute('second', { task: 'Two', background: true }, undefined, context)
  await tick()
  assert.equal(first.isError, undefined)
  assert.equal(second.isError, undefined)
  assert.equal(started, 1)
  assert.deepEqual(
    registry.list().map((run) => run.state),
    ['running', 'queued']
  )
  const overLimit = await tool.execute(
    'third',
    { task: 'Three', background: true },
    undefined,
    context
  )
  assert.equal(overLimit.isError, true)
  assert.match(JSON.stringify(overLimit.content), /limit/)
  const queued = registry.list()[1]
  assert.equal(registry.stop(queued.id), true)
  gate.resolve({ text: 'done', toolCalls: 0 })
  await tick()
  assert.equal(started, 1)
  assert.deepEqual(
    registry.list().map((run) => run.state),
    ['done', 'cancelled']
  )
})

test('a suitable assessment cannot override runner permission denial', async () => {
  const registry = new AgentRunRegistry()
  const tool = buildAgentTool(
    WRAPPER,
    async () => {
      throw new Error('Permission denied')
    },
    registry,
    {
      assessTask: async () => decision('suitable')
    }
  )
  const result = await tool.execute('denied', { task: 'Run workflow' }, undefined, context)
  assert.equal(tool.approval, 'read')
  assert.equal(result.isError, true)
  assert.match(JSON.stringify(result.content), /Permission denied/)
  assert.equal(registry.list()[0].state, 'error')
})
