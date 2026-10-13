import assert from 'node:assert/strict'
import test from 'node:test'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import { MAX_RPC_FRAME_BYTES } from '../src/main/agent/engine/rpc/frame-codec'
import type { RpcControlFrame } from '../src/main/agent/engine/rpc/types'
import { hostToolWire, hostToolPeer, hostTurns, hostUntil } from './helpers/rpc-host-tool-wire'

const result = (id = 'supplied'): RpcControlFrame => ({
  type: 'host_tool_result',
  id,
  result: { content: [{ type: 'text', text: 'ok' }] }
})

test('control preserves invocation/UI IDs without awaiting an acknowledgement or creating pending requests', async () => {
  const wire = await hostToolWire({ requestTimeoutMs: 10 })
  try {
    const channel = wire.connection.bindControl()
    await channel.sendControl(result())
    await channel.sendControl({ type: 'extension_ui_response', id: 'dialog', confirmed: false })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.deepEqual(wire.commands.slice(1), [
      result(),
      { type: 'extension_ui_response', id: 'dialog', confirmed: false }
    ])
    assert.equal(wire.connection.isReady, true)
    assert.equal(channel.signal.aborted, false)
  } finally {
    await wire.connection.close()
  }
})

test('control and requests share ordered writes; caller mutation cannot change encoded bytes', async () => {
  const wire = await hostToolWire()
  try {
    let release: (() => void) | undefined
    wire.intercept((command, done) => {
      if (command.type === 'host_tool_result' && command.id === 'first') {
        release = done
        return true
      }
      if (command.type === 'get_state') wire.respond(command, { ready: true })
      return false
    })
    const channel = wire.connection.bindControl()
    const first = channel.sendControl(result('first'))
    const frame = result('second')
    const second = channel.sendControl(frame)
    frame.id = 'mutated'
    const request = wire.connection.request({ type: 'get_state' })
    await hostUntil(() => !!release)
    assert.equal(wire.commands.length, 2)
    release?.()
    await Promise.all([first, second, request])
    assert.deepEqual(
      wire.commands.slice(1).map(({ type, id }) => ({ type, id })),
      [
        { type: 'host_tool_result', id: 'first' },
        { type: 'host_tool_result', id: 'second' },
        { type: 'get_state', id: wire.commands[3].id }
      ]
    )
  } finally {
    await wire.connection.close()
  }
})

test('retirement immediately rejects a blocked control write and detaches generation observers', async () => {
  const wire = await hostToolWire()
  const channel = wire.connection.bindControl()
  let release: (() => void) | undefined
  wire.intercept((_command, done) => {
    release = done
    return true
  })
  const pending = assert.rejects(channel.sendControl(result()), /closed/)
  await hostUntil(() => !!release)
  await wire.connection.close()
  await pending
  assert.equal(channel.signal.aborted, true)
  await assert.rejects(channel.sendControl(result('late')), /generation is closed/)
  assert.throws(() => channel.onFrame(() => undefined), /generation is closed/)
  release?.()
  await hostTurns()
})

test('control observer exceptions, async rejection and reentrant close cannot cross retirement', async () => {
  const wire = await hostToolWire()
  const channel = wire.connection.bindControl()
  let later = 0
  channel.onFrame(() => {
    throw new Error('observer')
  })
  channel.onFrame(async () => {
    throw new Error('async observer')
  })
  channel.onFrame(() => {
    void wire.connection.close()
  })
  channel.onFrame(() => {
    later++
  })
  wire.emit({ type: 'event' })
  await hostTurns()
  assert.equal(later, 0)
  assert.equal(channel.signal.aborted, true)
})

test('control validates all supported UI shapes and rejects arbitrary/malformed commands', async () => {
  const wire = await hostToolWire()
  try {
    const channel = wire.connection.bindControl()
    for (const frame of [
      { type: 'extension_ui_response', id: 'ui', value: 'x' },
      { type: 'extension_ui_response', id: 'ui', cancelled: true, timedOut: true },
      {
        type: 'extension_ui_response',
        id: 'ui',
        answers: [{ id: 'q', selectedOptions: ['x'], customInput: 'custom' }]
      },
      { type: 'host_tool_update', id: 'call', partialResult: { content: [], details: { step: 1 } } }
    ] as RpcControlFrame[])
      await channel.sendControl(frame)
    for (const frame of [
      { type: 'abort', id: 'x' },
      { type: 'host_tool_result', id: '', result: { content: [] } },
      { type: 'host_tool_result', id: 'x', result: { content: [{ type: 'text', text: 3 }] } },
      { type: 'host_tool_result', id: 'x', result: { content: [] }, isError: 'true' },
      { type: 'extension_ui_response', id: 'x', value: 'x', confirmed: true },
      { type: 'extension_ui_response', id: 'x', cancelled: false },
      { type: 'extension_ui_response', id: 'x', answers: [{ id: 'q', selectedOptions: [3] }] },
      { type: 'host_tool_update', id: 'x', partialResult: { content: [] }, sessionId: 'spoof' }
    ])
      await assert.rejects(
        channel.sendControl(frame as RpcControlFrame),
        /Invalid RPC control frame/
      )
  } finally {
    await wire.connection.close()
  }
})

test('control retains exact physical 1 MiB line bound with Unicode byte accounting', async () => {
  const wire = await hostToolWire()
  try {
    const channel = wire.connection.bindControl()
    const base = {
      type: 'host_tool_result' as const,
      id: 'bound',
      result: { content: [{ type: 'text' as const, text: '' }] }
    }
    const budget = MAX_RPC_FRAME_BYTES - Buffer.byteLength(JSON.stringify(base)) - 1
    base.result.content[0].text = 'é'.repeat(Math.floor(budget / 2)) + 'x'.repeat(budget % 2)
    await channel.sendControl(base)
    base.result.content[0].text += 'x'
    await assert.rejects(channel.sendControl(base), /exceeds the frame limit/)
    assert.equal(wire.connection.isReady, true)
  } finally {
    await wire.connection.close()
  }
})

test('failed control writes fail the channel and reject all queued controls', async () => {
  const wire = await hostToolWire()
  const channel = wire.connection.bindControl()
  wire.intercept((_command, done) => {
    done(new Error('synthetic write failure'))
    return true
  })
  const first = channel.sendControl(result('one'))
  const second = channel.sendControl(result('two'))
  await assert.rejects(first, /synthetic write failure/)
  await assert.rejects(second, /synthetic write failure|closed/)
  assert.equal(channel.signal.aborted, true)
  await wire.connection.close()
})

test('old generation writer and observer cannot reach a replacement transport on the same connection', async () => {
  const peers = [hostToolPeer(), hostToolPeer()]
  let index = 0
  const connection = new RpcConnection(() => peers[index++].transport, {
    startupTimeoutMs: 1000,
    requestTimeoutMs: 1000
  })
  const first = connection.start()
  peers[0].ready()
  await first
  const old = connection.bindControl()
  let oldEvents = 0
  old.onFrame(() => {
    oldEvents++
  })
  await connection.close()
  const second = connection.start()
  peers[1].ready()
  await second
  const current = connection.bindControl()
  let newEvents = 0
  current.onFrame(() => {
    newEvents++
  })
  peers[1].emit({ type: 'event' })
  await assert.rejects(old.sendControl(result('retired')), /generation is closed/)
  await current.sendControl(result('fresh'))
  assert.equal(oldEvents, 0)
  assert.equal(newEvents, 1)
  assert.deepEqual(
    peers[1].commands.slice(1).map(({ id }) => id),
    ['fresh']
  )
  assert.notEqual(old.generation, current.generation)
  await connection.close()
})

test('queued client memory is bounded independently of frame and reassembly limits', async () => {
  const wire = await hostToolWire()
  const channel = wire.connection.bindControl()
  let release: (() => void) | undefined
  wire.intercept((_command, done) => {
    release = done
    return true
  })
  const large: RpcControlFrame = {
    type: 'host_tool_result',
    id: 'large',
    result: { content: [{ type: 'text', text: 'x'.repeat(1024 * 1024 - 200) }] }
  }
  const promises = Array.from({ length: 10 }, () => channel.sendControl(large))
  const outcomes = await Promise.allSettled(promises)
  assert.equal(
    outcomes.every(({ status }) => status === 'rejected'),
    true
  )
  assert.equal(
    outcomes.some(
      (value) => value.status === 'rejected' && /queue exceeds/.test(String(value.reason))
    ),
    true
  )
  assert.equal(channel.signal.aborted, true)
  release?.()
  await wire.connection.close()
})
