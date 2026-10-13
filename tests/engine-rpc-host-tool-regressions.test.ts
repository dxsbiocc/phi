import assert from 'node:assert/strict'
import test from 'node:test'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import type { PhiTool } from '../src/main/agent/engine/types'
import {
  RpcHostToolBridge,
  type RpcHostToolRun,
  type RpcHostToolScope
} from '../src/main/agent/engine/rpc/host-tool-bridge'
import { hostToolPeer, hostToolWire, hostTurns, hostUntil } from './helpers/rpc-host-tool-wire'

function scope(run: RpcHostToolRun): RpcHostToolScope {
  return {
    sessionId: 'session',
    projectId: 'project',
    cwd: '/remote/project',
    recentUserImages: () => [],
    currentRun: () => run
  }
}
function schemaTool(
  id: string,
  execute: PhiTool['execute'] = async () => ({ content: [] })
): PhiTool {
  return {
    name: 'echo',
    label: 'Echo',
    description: 'Typed echo',
    site: 'host',
    parameters: {
      $id: id,
      type: 'object',
      properties: { nested: { $ref: '#/$defs/nested' } },
      required: ['nested'],
      $defs: {
        nested: {
          type: 'object',
          properties: { value: { type: 'number' } },
          required: ['value'],
          additionalProperties: false
        }
      }
    },
    execute
  }
}
const request = {
  type: 'host_tool_call',
  id: 'invocation',
  toolCallId: 'known',
  toolName: 'echo',
  arguments: { nested: { value: 1 } }
}

test('another frame observer cannot change schema-validated authorized nested input before execute', async () => {
  const wire = await hostToolWire()
  let decide!: (result: 'main') => void
  let authorized: unknown
  let executed: unknown
  let callerValue: unknown
  const run: RpcHostToolRun = {
    id: 'run',
    signal: new AbortController().signal,
    authorizeCall: (_id, _name, input) => {
      authorized = input
      return new Promise((resolve) => {
        decide = resolve
      })
    }
  }
  try {
    await RpcHostToolBridge.create({
      connection: wire.connection,
      tools: [
        schemaTool('urn:phi:t12:toctou', async (_id, params) => {
          executed = structuredClone(params)
          ;(params.nested as { value: number }).value = 77
          return { content: [] }
        })
      ],
      scope: scope(run)
    })
    wire.connection.onEvent((frame) => {
      if (frame.type === 'host_tool_call') {
        const args = frame.arguments as { nested: { value: number } }
        args.nested.value = 99
        callerValue = args.nested
      }
    })
    wire.emit(request)
    await hostUntil(() => !!decide)
    assert.deepEqual(authorized, { nested: { value: 1 } })
    decide('main')
    await hostUntil(() => !!executed)
    assert.deepEqual(executed, { nested: { value: 1 } })
    assert.deepEqual(callerValue, { value: 99 })
  } finally {
    await wire.connection.close()
  }
})

test('same legal schema $id with internal refs registers in two independent sessions', async () => {
  const wires = [await hostToolWire(), await hostToolWire()]
  const run: RpcHostToolRun = {
    id: 'run',
    signal: new AbortController().signal,
    authorizeCall: () => 'main'
  }
  const tool = schemaTool('urn:phi:t12:independent-sessions')
  try {
    const one = await RpcHostToolBridge.create({
      connection: wires[0].connection,
      tools: [tool],
      scope: scope(run)
    })
    const two = await RpcHostToolBridge.create({
      connection: wires[1].connection,
      tools: [tool],
      scope: scope(run)
    })
    assert.equal(one.isReady, true)
    assert.equal(two.isReady, true)
    wires[1].emit({ ...request, arguments: { nested: { value: 'wrong type' } } })
    await hostUntil(() => wires[1].commands.some(({ type }) => type === 'host_tool_result'))
    assert.equal(wires[1].commands.find(({ type }) => type === 'host_tool_result')?.isError, true)
  } finally {
    await Promise.all(wires.map(({ connection }) => connection.close()))
  }
})

test('same legal schema $id registers after reconnect without prior-generation validator pollution', async () => {
  const peers = [hostToolPeer(), hostToolPeer()]
  let index = 0
  const connection = new RpcConnection(() => peers[index++].transport, {
    startupTimeoutMs: 1000,
    requestTimeoutMs: 1000
  })
  const run: RpcHostToolRun = {
    id: 'run',
    signal: new AbortController().signal,
    authorizeCall: () => 'main'
  }
  const tool = schemaTool('urn:phi:t12:reconnect')
  try {
    const first = connection.start()
    peers[0].ready()
    await first
    await RpcHostToolBridge.create({ connection, tools: [tool], scope: scope(run) })
    await connection.close()
    const second = connection.start()
    peers[1].ready()
    await second
    const bridge = await RpcHostToolBridge.create({ connection, tools: [tool], scope: scope(run) })
    assert.equal(bridge.isReady, true)
    peers[1].emit(request)
    await hostTurns()
    assert.equal(peers[1].commands.find(({ type }) => type === 'host_tool_result')?.isError, false)
  } finally {
    await connection.close()
  }
})
