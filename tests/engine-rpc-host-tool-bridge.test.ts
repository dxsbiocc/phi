import assert from 'node:assert/strict'
import test from 'node:test'
import { setImmediate as turn } from 'node:timers/promises'
import type { PhiTool, PhiToolResult, PhiToolUpdate } from '../src/main/agent/engine/types'
import {
  RpcHostToolBridge,
  type RpcHostToolRun,
  type RpcHostToolScope
} from '../src/main/agent/engine/rpc/host-tool-bridge'
import { MAX_RPC_FRAME_BYTES } from '../src/main/agent/engine/rpc/frame-codec'
import { hostToolWire, hostTurns, hostUntil, type HostCommand } from './helpers/rpc-host-tool-wire'

const ok = (text = 'ok'): PhiToolResult => ({ content: [{ type: 'text', text }] })
function tool(
  execute: PhiTool['execute'] = async () => ok(),
  extra: Partial<PhiTool> = {}
): PhiTool {
  return {
    name: 'desktop_echo',
    label: 'Echo',
    description: 'Echo test input',
    site: 'host',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false
    },
    execute,
    ...extra
  }
}
function fixtureScope(): {
  scope: RpcHostToolScope
  run: RpcHostToolRun
  controller: AbortController
  setRun(run: RpcHostToolRun | undefined): void
  calls: Map<string, 'main' | 'child'>
} {
  const controller = new AbortController()
  const calls = new Map<string, 'main' | 'child'>([
    ['tool-1', 'main'],
    ['tool-2', 'main'],
    ['child', 'child']
  ])
  const run: RpcHostToolRun = {
    id: 'run-1',
    signal: controller.signal,
    authorizeCall: (id, name) => (name === 'desktop_echo' ? calls.get(id) : undefined)
  }
  let current: RpcHostToolRun | undefined = run
  return {
    run,
    controller,
    calls,
    setRun(value) {
      current = value
    },
    scope: {
      sessionId: 'session',
      projectId: 'project',
      cwd: '/remote/project',
      recentUserImages: () => [{ type: 'image', data: 'session-image', mimeType: 'image/png' }],
      currentRun: () => current
    }
  }
}
function call(
  wire: Awaited<ReturnType<typeof hostToolWire>>,
  extra: Record<string, unknown> = {}
): void {
  wire.emit({
    type: 'host_tool_call',
    id: 'invocation-1',
    toolCallId: 'tool-1',
    toolName: 'desktop_echo',
    arguments: { text: 'hello' },
    ...extra
  })
}
function controls(wire: Awaited<ReturnType<typeof hostToolWire>>): HostCommand[] {
  return wire.commands.filter(
    ({ type }) => type === 'host_tool_result' || type === 'host_tool_update'
  )
}
async function final(wire: Awaited<ReturnType<typeof hostToolWire>>): Promise<HostCommand> {
  await hostUntil(() => controls(wire).some(({ type }) => type === 'host_tool_result'))
  return controls(wire).find(({ type }) => type === 'host_tool_result')!
}

test('complete roster is registered once; filtered union inputs, remote cwd, session images and typed results survive', async () => {
  const wire = await hostToolWire()
  const f = fixtureScope()
  try {
    let observed: unknown
    const echo = tool(
      async (id, params, onUpdate, ctx) => {
        observed = { id, params, cwd: ctx.cwd, images: ctx.recentUserImages() }
        onUpdate?.({ content: [{ type: 'text', text: 'step' }], details: { order: 1 } })
        return {
          content: [{ type: 'image', data: 'png-bytes', mimeType: 'image/png' }],
          details: { nested: { exact: true } }
        }
      },
      {
        parameters: {
          oneOf: [
            {
              type: 'object',
              properties: { text: { type: 'string' }, nested: { type: 'object' } },
              required: ['text'],
              additionalProperties: false
            },
            {
              type: 'object',
              properties: { count: { type: 'number' } },
              required: ['count'],
              additionalProperties: false
            }
          ]
        }
      }
    )
    const bridge = await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [echo],
      scope: f.scope
    })
    assert.equal(bridge.isReady, true)
    assert.equal(wire.commands.filter(({ type }) => type === 'set_host_tools').length, 1)
    call(wire, {
      arguments: {
        text: 'hello',
        nested: { i: 'preserved' },
        i: 'stripped',
        sessionId: 'spoof',
        cwd: '/desktop'
      }
    })
    const output = await final(wire)
    assert.deepEqual(observed, {
      id: 'tool-1',
      params: { text: 'hello', nested: { i: 'preserved' } },
      cwd: '/remote/project',
      images: [{ type: 'image', data: 'session-image', mimeType: 'image/png' }]
    })
    assert.deepEqual(
      controls(wire).map(({ type }) => type),
      ['host_tool_update', 'host_tool_result']
    )
    assert.deepEqual(output.result, {
      content: [{ type: 'image', data: 'png-bytes', mimeType: 'image/png' }],
      details: { nested: { exact: true } }
    })
    assert.equal(output.isError, false)
    bridge.dispose()
  } finally {
    await wire.connection.close()
  }
})

test('registration requires exact names and does not admit calls while awaiting acknowledgement', async () => {
  const wire = await hostToolWire()
  const f = fixtureScope()
  let executions = 0
  try {
    let registration: HostCommand | undefined
    wire.intercept((command, done) => {
      if (command.type === 'set_host_tools') {
        registration = command
        done()
        return true
      }
      return false
    })
    const pending = RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [
        tool(async () => {
          executions++
          return ok()
        })
      ],
      scope: f.scope
    })
    await hostUntil(() => !!registration)
    call(wire)
    await final(wire)
    assert.equal(executions, 0)
    wire.respond(registration!, { toolNames: ['wrong'] })
    await assert.rejects(pending, /exact roster/)
    call(wire, { id: 'new' })
    await hostTurns()
    assert.equal(executions, 0)
  } finally {
    await wire.connection.close()
  }
})

test('registration cancellation settles immediately and ignores a late valid acknowledgement', async () => {
  const wire = await hostToolWire()
  const f = fixtureScope()
  const abort = new AbortController()
  let executions = 0
  try {
    let registration: HostCommand | undefined
    wire.intercept((command, done) => {
      if (command.type === 'set_host_tools') {
        registration = command
        done()
        return true
      }
      return false
    })
    const pending = RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [
        tool(async () => {
          executions++
          return ok()
        })
      ],
      scope: f.scope,
      signal: abort.signal
    })
    await hostUntil(() => !!registration)
    abort.abort()
    await assert.rejects(pending, /registration aborted/)
    wire.respond(registration!, { toolNames: ['desktop_echo'] })
    call(wire)
    await hostTurns()
    assert.equal(executions, 0)
  } finally {
    await wire.connection.close()
  }
})

test('malformed, unknown, child, unbound and duplicate invocations have no tool effects', async () => {
  const wire = await hostToolWire()
  const f = fixtureScope()
  let executions = 0
  try {
    await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [
        tool(async () => {
          executions++
          return ok()
        })
      ],
      scope: f.scope
    })
    for (const extra of [
      { id: 'unknown', toolName: 'not_registered' },
      { id: 'child-id', toolCallId: 'child' },
      { id: 'unbound', toolCallId: 'not_known' },
      { id: 'badargs', arguments: [] },
      { id: 'missing-id', toolCallId: '' },
      {
        id: 'bookkeeping',
        toolCallId: 'spoof',
        runId: 'run-1',
        agentKind: 'main',
        sessionId: 'session'
      }
    ])
      call(wire, extra)
    await hostUntil(() => controls(wire).length === 6)
    assert.equal(executions, 0)
    call(wire)
    await hostUntil(() => executions === 1)
    await hostTurns()
    call(wire)
    call(wire, { id: 'second-invocation-same-toolcall' })
    await hostTurns()
    assert.equal(executions, 1)
    assert.equal(controls(wire).filter(({ id }) => id === 'invocation-1').length, 1)
  } finally {
    await wire.connection.close()
  }
})

test('actual schema validation rejects wrong types without coercion/defaulting and keeps nested union fields', async () => {
  const wire = await hostToolWire()
  const f = fixtureScope()
  let executions = 0
  try {
    await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [
        tool(async () => {
          executions++
          return ok()
        })
      ],
      scope: f.scope
    })
    call(wire, { arguments: { text: 42 } })
    assert.match(JSON.stringify((await final(wire)).result), /declared schema/)
    assert.equal(executions, 0)
  } finally {
    await wire.connection.close()
  }
})

test('direct tool error maps to top-level isError and synchronous/async throws settle exactly once', async () => {
  for (const execute of [
    async () => ({ ...ok('direct failure'), isError: true }),
    () => {
      throw new Error('sync failure')
    },
    async () => {
      throw new Error('async failure')
    }
  ] satisfies PhiTool['execute'][]) {
    const wire = await hostToolWire()
    const f = fixtureScope()
    try {
      await RpcHostToolBridge.create({
        connection: wire.connection,
        tools: [tool(execute)],
        scope: f.scope
      })
      call(wire)
      const output = await final(wire)
      assert.equal(output.isError, true)
      assert.match(JSON.stringify(output.result), /failure/)
      await hostTurns()
      assert.equal(controls(wire).length, 1)
    } finally {
      await wire.connection.close()
    }
  }
})

test('cancel targetId aborts the exact invocation; late progress/results are ignored', async () => {
  const wire = await hostToolWire()
  const f = fixtureScope()
  let update: PhiToolUpdate | undefined
  let resolve!: (result: PhiToolResult) => void
  let signal: AbortSignal | undefined
  try {
    await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [
        tool((_id, _params, partial, _ctx, abort) => {
          update = partial
          signal = abort
          return new Promise((done) => {
            resolve = done
          })
        })
      ],
      scope: f.scope
    })
    call(wire)
    await hostUntil(() => !!resolve)
    wire.emit({ type: 'host_tool_cancel', id: 'cancel-frame-id', targetId: 'unrelated' })
    assert.equal(signal?.aborted, false)
    update?.(ok('before cancel'))
    await hostUntil(() => controls(wire).length === 1)
    wire.emit({ type: 'host_tool_cancel', id: 'cancel-frame-id', targetId: 'invocation-1' })
    assert.equal(signal?.aborted, true)
    update?.(ok('late'))
    resolve(ok('late final'))
    await final(wire)
    await hostTurns()
    assert.deepEqual(
      controls(wire).map(({ type }) => type),
      ['host_tool_update', 'host_tool_result']
    )
    assert.equal(controls(wire)[1].isError, true)
  } finally {
    await wire.connection.close()
  }
})

test('run abort produces one cancellation; changed run cannot consume stale success/images', async () => {
  for (const replacement of [false, true]) {
    const wire = await hostToolWire()
    const f = fixtureScope()
    let resolve!: (result: PhiToolResult) => void
    try {
      await RpcHostToolBridge.create({
        connection: wire.connection,
        tools: [
          tool(
            () =>
              new Promise((done) => {
                resolve = done
              })
          )
        ],
        scope: f.scope
      })
      call(wire)
      await hostUntil(() => !!resolve)
      if (replacement) f.setRun({ ...f.run, id: 'new-run', signal: new AbortController().signal })
      else f.controller.abort()
      resolve(ok('stale success'))
      const output = await final(wire)
      assert.equal(output.isError, true)
      assert.match(JSON.stringify(output.result), /cancelled/)
      await hostTurns()
      assert.equal(controls(wire).length, 1)
    } finally {
      await wire.connection.close()
    }
  }
})

test('dispose cancels pending server calls; disconnect drops writes and both ignore late callbacks', async () => {
  for (const disconnect of [false, true]) {
    const wire = await hostToolWire()
    const f = fixtureScope()
    let resolve!: (result: PhiToolResult) => void
    let update: PhiToolUpdate | undefined
    let signal: AbortSignal | undefined
    try {
      const bridge = await RpcHostToolBridge.create({
        connection: wire.connection,
        tools: [
          tool((_id, _params, partial, _ctx, abort) => {
            update = partial
            signal = abort
            return new Promise((done) => {
              resolve = done
            })
          })
        ],
        scope: f.scope
      })
      call(wire)
      await hostUntil(() => !!resolve)
      if (disconnect) await wire.connection.close()
      else bridge.dispose()
      assert.equal(signal?.aborted, true)
      update?.(ok('late'))
      resolve(ok('late'))
      await hostTurns()
      assert.equal(controls(wire).length, disconnect ? 0 : 1)
      if (!disconnect) assert.equal(controls(wire)[0].isError, true)
      assert.equal(bridge.isReady, false)
    } finally {
      await wire.connection.close()
    }
  }
})

test('oversized/invalid progress and results produce explicit tool failure without truncation', async () => {
  for (const mode of ['progress', 'result', 'invalid'] as const) {
    const wire = await hostToolWire()
    const f = fixtureScope()
    let signal: AbortSignal | undefined
    try {
      await RpcHostToolBridge.create({
        connection: wire.connection,
        tools: [
          tool(async (_id, _params, update, _ctx, abort) => {
            signal = abort
            const large = ok('x'.repeat(MAX_RPC_FRAME_BYTES))
            if (mode === 'progress') update?.(large)
            if (mode === 'invalid')
              return { content: [{ type: 'text', text: 42 }] } as unknown as PhiToolResult
            return large
          })
        ],
        scope: f.scope
      })
      call(wire)
      const output = await final(wire)
      assert.equal(output.isError, true)
      assert.match(JSON.stringify(output.result), /supported frame limit|invalid content/)
      assert.equal(controls(wire).length, 1)
      if (mode === 'progress') assert.equal(signal?.aborted, true)
    } finally {
      await wire.connection.close()
    }
  }
})

test('mutation after update does not change payload; updates retain execution order', async () => {
  const wire = await hostToolWire()
  const f = fixtureScope()
  try {
    await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [
        tool(async (_id, _params, update) => {
          const payload = ok('first')
          update?.(payload)
          payload.content[0] = { type: 'text', text: 'mutated' }
          update?.(ok('second'))
          return ok('final')
        })
      ],
      scope: f.scope
    })
    call(wire)
    await final(wire)
    assert.deepEqual(
      controls(wire).map((frame) => JSON.stringify(frame.partialResult ?? frame.result)),
      [JSON.stringify(ok('first')), JSON.stringify(ok('second')), JSON.stringify(ok('final'))]
    )
  } finally {
    await wire.connection.close()
  }
})

test('reentrant authority/image disposal cannot execute a tool; throwing observers never reject unhandled', async () => {
  for (const reentrant of ['authority', 'images']) {
    const wire = await hostToolWire()
    const f = fixtureScope()
    let bridge: RpcHostToolBridge | undefined
    let executions = 0
    if (reentrant === 'authority')
      f.run.authorizeCall = () => {
        bridge?.dispose()
        return 'main'
      }
    else
      f.scope.recentUserImages = () => {
        bridge?.dispose()
        return []
      }
    try {
      bridge = await RpcHostToolBridge.create({
        connection: wire.connection,
        tools: [
          tool(async () => {
            executions++
            return ok()
          })
        ],
        scope: f.scope,
        onError: async () => {
          throw new Error('diagnostic rejection')
        }
      })
      call(wire)
      await turn()
      assert.equal(executions, 0)
      assert.equal(bridge.isReady, false)
    } finally {
      await wire.connection.close()
    }
  }
})

test('invalid, duplicate, runtime and oversized definitions fail before registration; same generation cannot rebind', async () => {
  for (const tools of [
    [tool(), tool()],
    [tool(undefined, { name: 'bad name' })],
    [tool(undefined, { site: 'runtime' })],
    [tool(undefined, { description: 'x'.repeat(MAX_RPC_FRAME_BYTES) })]
  ]) {
    const wire = await hostToolWire()
    const f = fixtureScope()
    try {
      await assert.rejects(
        RpcHostToolBridge.create({ connection: wire.connection, tools, scope: f.scope })
      )
      assert.equal(
        wire.commands.some(({ type }) => type === 'set_host_tools'),
        false
      )
    } finally {
      await wire.connection.close()
    }
  }
  const wire = await hostToolWire()
  const f = fixtureScope()
  try {
    const bridge = await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [tool()],
      scope: f.scope
    })
    bridge.dispose()
    await assert.rejects(
      RpcHostToolBridge.create({ connection: wire.connection, tools: [tool()], scope: f.scope }),
      /already bound/
    )
  } finally {
    await wire.connection.close()
  }
})
