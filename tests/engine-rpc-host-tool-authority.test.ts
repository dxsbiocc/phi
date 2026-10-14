import assert from 'node:assert/strict'
import test from 'node:test'
import type { PhiTool } from '../src/main/agent/engine/types'
import {
  RpcHostToolBridge,
  type RpcHostToolRun
} from '../src/main/agent/engine/rpc/host-tool-bridge'
import { hostToolWire, hostTurns, hostUntil } from './helpers/rpc-host-tool-wire'

for (const change of [
  'stop',
  'same-id-policy',
  'same-id-input',
  'dispose',
  'disconnect'
] as const) {
  test(`pending asynchronous authorization cannot survive ${change}`, async () => {
    const wire = await hostToolWire()
    const controller = new AbortController()
    let decide!: (value: 'main') => void
    let sawInput: unknown
    let executions = 0
    let current: RpcHostToolRun = {
      id: 'run',
      signal: controller.signal,
      authorizeCall: (_id, _name, input) => {
        sawInput = input
        return new Promise((resolve) => {
          decide = resolve
        })
      }
    }
    const tool: PhiTool = {
      name: 'echo',
      label: 'Echo',
      description: 'Synthetic echo',
      site: 'host',
      parameters: {
        type: 'object',
        properties: {
          data: { type: 'object', properties: { value: { type: 'number' } }, required: ['value'] }
        },
        required: ['data']
      },
      async execute() {
        executions++
        return { content: [] }
      }
    }
    const bridge = await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [tool],
      scope: {
        sessionId: 's',
        projectId: 'p',
        cwd: '/remote/project',
        recentUserImages: () => [],
        currentRun: () => current
      }
    })
    wire.emit({
      type: 'host_tool_call',
      id: 'invocation',
      toolCallId: 'known',
      toolName: 'echo',
      arguments: { data: { value: 1 }, i: 'drop' }
    })
    await hostUntil(() => !!decide)
    assert.deepEqual(sawInput, { data: { value: 1 } })
    if (change === 'stop') controller.abort()
    else if (change === 'dispose') bridge.dispose()
    else if (change === 'disconnect') await wire.connection.close()
    else
      current = {
        ...current,
        authorizeCall: () => (change === 'same-id-input' ? undefined : 'main')
      }
    decide('main')
    await hostTurns()
    assert.equal(executions, 0)
    const results = wire.commands.filter(({ type }) => type === 'host_tool_result')
    assert.equal(results.length, change === 'disconnect' ? 0 : 1)
    if (results.length) assert.equal(results[0].isError, true)
    await wire.connection.close()
  })
}

test('authorization cannot approve a mutated normalized input snapshot', async () => {
  const wire = await hostToolWire()
  let received: unknown
  const run: RpcHostToolRun = {
    id: 'run',
    signal: new AbortController().signal,
    authorizeCall: (_id, _name, input) => {
      ;(input.nested as { value: number }).value = 99
      return 'main'
    }
  }
  const tool: PhiTool = {
    name: 'echo',
    label: 'Echo',
    description: 'Synthetic echo',
    site: 'host',
    parameters: { type: 'object', properties: { nested: { type: 'object' } } },
    async execute(_id, input) {
      received = input
      return { content: [] }
    }
  }
  try {
    await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [tool],
      scope: {
        sessionId: 's',
        projectId: 'p',
        cwd: '/remote/project',
        recentUserImages: () => [],
        currentRun: () => run
      }
    })
    wire.emit({
      type: 'host_tool_call',
      id: 'invocation',
      toolCallId: 'known',
      toolName: 'echo',
      arguments: { nested: { value: 1 }, i: 'drop' }
    })
    await hostUntil(() => wire.commands.some(({ type }) => type === 'host_tool_result'))
    assert.equal(received, undefined)
    assert.equal(wire.commands.find(({ type }) => type === 'host_tool_result')?.isError, true)
  } finally {
    await wire.connection.close()
  }
})

test('bounded progress queue produces an explicit terminal failure and ignores all later callbacks', async () => {
  const wire = await hostToolWire()
  let aborted = false
  const run: RpcHostToolRun = {
    id: 'run',
    signal: new AbortController().signal,
    authorizeCall: () => 'main'
  }
  const tool: PhiTool = {
    name: 'echo',
    label: 'Echo',
    description: 'Synthetic echo',
    site: 'host',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _input, update, _ctx, signal) {
      for (let i = 0; i < 20; i++)
        update?.({ content: [{ type: 'text', text: 'x'.repeat(900_000) }] })
      aborted = signal?.aborted === true
      update?.({ content: [{ type: 'text', text: 'late' }] })
      return { content: [{ type: 'text', text: 'late final' }] }
    }
  }
  try {
    await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [tool],
      scope: {
        sessionId: 's',
        projectId: 'p',
        cwd: '/remote/project',
        recentUserImages: () => [],
        currentRun: () => run
      }
    })
    wire.emit({
      type: 'host_tool_call',
      id: 'invocation',
      toolCallId: 'known',
      toolName: 'echo',
      arguments: {}
    })
    await hostUntil(() => wire.commands.some(({ type }) => type === 'host_tool_result'))
    const results = wire.commands.filter(({ type }) => type === 'host_tool_result')
    assert.equal(aborted, true)
    assert.equal(results.length, 1)
    assert.equal(results[0].isError, true)
    assert.match(JSON.stringify(results[0].result), /supported frame limit/)
    assert.equal(
      wire.commands.some((frame) => JSON.stringify(frame).includes('late final')),
      false
    )
  } finally {
    await wire.connection.close()
  }
})

test('main-run cancellation reaches an awaited authorizer signal and late authorization rejection is handled', async () => {
  const wire = await hostToolWire()
  const abort = new AbortController()
  let authSignal: AbortSignal | undefined
  let reject!: (error: Error) => void
  let executions = 0
  const run: RpcHostToolRun = {
    id: 'run',
    signal: abort.signal,
    authorizeCall: (_id, _name, _input, signal) => {
      authSignal = signal
      return new Promise((_yes, no) => {
        reject = no
      })
    }
  }
  const tool: PhiTool = {
    name: 'echo',
    label: 'Echo',
    description: 'Synthetic echo',
    site: 'host',
    parameters: { type: 'object', properties: {} },
    async execute() {
      executions++
      return { content: [] }
    }
  }
  try {
    await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [tool],
      scope: {
        sessionId: 's',
        projectId: 'p',
        cwd: '/remote/project',
        recentUserImages: () => [],
        currentRun: () => run
      }
    })
    wire.emit({
      type: 'host_tool_call',
      id: 'invocation',
      toolCallId: 'known',
      toolName: 'echo',
      arguments: {}
    })
    await hostUntil(() => !!authSignal)
    abort.abort()
    assert.equal(authSignal?.aborted, true)
    reject(new Error('late authorization error'))
    await hostTurns()
    assert.equal(executions, 0)
    assert.equal(wire.commands.filter(({ type }) => type === 'host_tool_result').length, 1)
  } finally {
    await wire.connection.close()
  }
})

test('partial write failure retires execution and diagnostic thenable rejection remains isolated', async () => {
  const wire = await hostToolWire()
  let errors = 0
  let signal: AbortSignal | undefined
  const run: RpcHostToolRun = {
    id: 'run',
    signal: new AbortController().signal,
    authorizeCall: () => 'main'
  }
  const tool: PhiTool = {
    name: 'echo',
    label: 'Echo',
    description: 'Synthetic echo',
    site: 'host',
    parameters: { type: 'object', properties: {} },
    async execute(_id, _input, update, _ctx, abort) {
      signal = abort
      update?.({ content: [] })
      await new Promise(() => undefined)
      return { content: [] }
    }
  }
  try {
    const bridge = await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [tool],
      scope: {
        sessionId: 's',
        projectId: 'p',
        cwd: '/remote/project',
        recentUserImages: () => [],
        currentRun: () => run
      },
      onError: async () => {
        errors++
        throw new Error('diagnostic failure')
      }
    })
    wire.intercept((command, done) => {
      if (command.type === 'host_tool_update') {
        done(new Error('partial write failure'))
        return true
      }
      return false
    })
    wire.emit({
      type: 'host_tool_call',
      id: 'invocation',
      toolCallId: 'known',
      toolName: 'echo',
      arguments: {}
    })
    await hostUntil(() => errors > 0)
    await hostTurns()
    assert.equal(bridge.isReady, false)
    assert.equal(signal?.aborted, true)
  } finally {
    await wire.connection.close()
  }
})

test('server-native names cannot be overridden by the desktop host roster', async () => {
  const wire = await hostToolWire()
  const run: RpcHostToolRun = {
    id: 'run',
    signal: new AbortController().signal,
    authorizeCall: () => 'main'
  }
  try {
    await assert.rejects(
      RpcHostToolBridge.create({
        connection: wire.connection,
        tools: [
          {
            name: 'read',
            label: 'Read',
            description: 'Colliding host tool',
            site: 'host',
            parameters: { type: 'object' },
            async execute() {
              return { content: [] }
            }
          }
        ],
        scope: {
          sessionId: 's',
          projectId: 'p',
          cwd: '/remote/project',
          recentUserImages: () => [],
          currentRun: () => run
        }
      }),
      /Invalid or duplicate/
    )
    assert.equal(
      wire.commands.some(({ type }) => type === 'set_host_tools'),
      false
    )
  } finally {
    await wire.connection.close()
  }
})
