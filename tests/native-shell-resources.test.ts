import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import test from 'node:test'
import { installNativeShellResources } from '../src/main/agent/engine/in-process/native-shell-resources'

type Tool = {
  execute(
    id: string,
    args: unknown,
    signal?: AbortSignal,
    update?: (result: unknown) => void,
    context?: { toolCall: { index: number; toolCalls: { id: string; name: string }[] } }
  ): Promise<unknown>
}
function install(name: string, tool: Tool, asyncJobManager?: unknown, source = 'builtin'): Tool {
  const session = {
    asyncJobManager,
    getAllToolInfos: () => [{ name, sourceInfo: { source } }],
    getToolByName: () => tool
  } as unknown as Parameters<typeof installNativeShellResources>[0]
  installNativeShellResources(session)
  return tool
}

function run(
  tool: Tool,
  id: string,
  args = {},
  signal?: AbortSignal,
  update?: (result: unknown) => void
): Promise<unknown> {
  return tool.execute(id, args, signal, update, {
    toolCall: { index: 0, toolCalls: [{ id, name: 'bash' }] }
  })
}

test('an auto-backgrounded shell result does not release the resource before the exact job exits', async () => {
  const registered = Promise.withResolvers<void>()
  const otherJob = Promise.withResolvers<void>()
  const jobs = new Map([['unrelated', { promise: otherJob.promise }]])
  const manager = {
    getJob: (id: string) => jobs.get(id),
    register: (type: string) => {
      assert.equal(type, 'bash')
      jobs.set('owned', { promise: registered.promise })
      return 'owned'
    }
  }
  let secondRuns = 0
  const bash = install(
    'bash',
    {
      async execute() {
        manager.register('bash')
        return 'background job visible'
      }
    },
    manager
  )
  const second = install('bash', {
    async execute() {
      secondRuns++
      return 'second shell completed'
    }
  })
  const progress: unknown[] = []
  try {
    assert.equal(await run(bash, 'shell'), 'background job visible')
    const queued = run(second, 'second-shell', {}, undefined, (event) => progress.push(event))
    await setImmediate()
    assert.equal(secondRuns, 0)
    const direct = install('bash', {
      async execute() {
        return 'direct dispatch accepted'
      }
    })
    assert.equal(await direct.execute('direct', {}), 'direct dispatch accepted')
    assert.deepEqual(progress, [
      { content: [], details: { kind: 'phi_local_resource_wait', waiting: true } }
    ])
    registered.resolve()
    assert.equal(await queued, 'second shell completed')
    assert.equal(secondRuns, 1)
    assert.deepEqual(progress.at(-1), {
      content: [],
      details: { kind: 'phi_local_resource_wait', waiting: false }
    })
  } finally {
    registered.resolve()
    otherJob.resolve()
  }
})

test('a cancelled hidden shell job keeps the resource until the process cleanup settles', async () => {
  const body = Promise.withResolvers<void>()
  const manager = {
    getJob: () => ({ promise: body.promise }),
    register: (type: string) => {
      assert.equal(type, 'bash')
      return 'hidden'
    }
  }
  const bash = install(
    'bash',
    {
      async execute() {
        manager.register('bash')
        throw new Error('tool reported cancellation')
      }
    },
    manager
  )
  let secondRuns = 0
  const second = install('bash', {
    async execute() {
      secondRuns++
      return 'second shell completed'
    }
  })
  try {
    await assert.rejects(run(bash, 'shell'), /tool reported cancellation/)
    const queued = run(second, 'second-shell')
    await setImmediate()
    assert.equal(secondRuns, 0)
    body.resolve()
    assert.equal(await queued, 'second shell completed')
  } finally {
    body.resolve()
  }
})

test('an aborted queued shell never invokes the tool and direct or named calls keep their own policy', async () => {
  const body = Promise.withResolvers<void>()
  const controller = new AbortController()
  let runs = 0
  const first = install('bash', { execute: () => body.promise })
  const second = install('bash', {
    async execute() {
      return ++runs
    }
  })
  const custom = install(
    'bash',
    {
      async execute() {
        return 'custom'
      }
    },
    undefined,
    'extension'
  )
  try {
    const running = run(first, 'first')
    const waiting = run(second, 'second', {}, controller.signal)
    const cancelled = assert.rejects(waiting, /queued shell cancelled/)
    assert.equal(await run(custom, 'custom'), 'custom')
    assert.equal(await run(second, 'named', { name: 'server' }), 1)
    assert.equal(await run(second, 'terminal', { pty: true }), 2)
    controller.abort(new Error('queued shell cancelled'))
    await cancelled
    body.resolve()
    await running
    assert.equal(await run(second, 'third'), 3)
  } finally {
    body.resolve()
  }
})
