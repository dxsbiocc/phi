import assert from 'node:assert/strict'
import test from 'node:test'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import {
  RpcByteLimitError,
  RpcRequestError,
  MAX_RPC_ERROR_CODE_BYTES
} from '../src/main/agent/engine/rpc/errors'
import {
  MAX_RPC_FRAME_BYTES,
  MAX_RPC_REASSEMBLED_BYTES,
  RPC_CHUNK_PAYLOAD_BYTES,
  RpcFrameCodec,
  encodeRpcCommand
} from '../src/main/agent/engine/rpc/frame-codec'
import { hostToolPeer, hostToolWire, hostUntil } from './helpers/rpc-host-tool-wire'

const line = (frame: unknown): Buffer => Buffer.from(JSON.stringify(frame) + '\n')
const chunk = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: 'rpc_chunk',
  chunkId: 'history',
  index: 0,
  count: 256,
  byteLength: MAX_RPC_REASSEMBLED_BYTES,
  data: 'eA==',
  ...overrides
})
function codec(): RpcFrameCodec {
  const result = new RpcFrameCodec()
  result.enableProtocolV2()
  return result
}
function failure(error: unknown): RpcRequestError {
  assert.ok(error instanceof RpcRequestError)
  return error
}

test('official pagination error codes are correlated with their own command and request ID', async () => {
  const wire = await hostToolWire()
  try {
    wire.intercept((_command, done) => {
      done()
      return true
    })
    const one = wire.connection.request({ type: 'get_messages_page', cursor: 'stale' })
    const two = wire.connection.request({ type: 'fork', entryId: 'busy' })
    const first = one.catch(failure)
    const second = two.catch(failure)
    await hostUntil(() => wire.commands.length === 3)
    wire.emit({
      type: 'response',
      id: wire.commands[2].id,
      command: 'fork',
      success: false,
      error: 'Session cannot fork while running',
      code: 'session_busy'
    })
    wire.emit({
      type: 'response',
      id: wire.commands[1].id,
      command: 'get_messages_page',
      success: false,
      error: 'RPC message cursor is stale',
      code: 'stale_cursor'
    })
    const [stale, busy] = await Promise.all([first, second])
    assert.ok(stale instanceof RpcRequestError)
    assert.ok(busy instanceof RpcRequestError)
    assert.equal(stale.code, 'stale_cursor')
    assert.equal(stale.command, 'get_messages_page')
    assert.equal(stale.requestId, wire.commands[1].id)
    assert.equal(stale.message, 'RPC message cursor is stale')
    assert.equal(busy.code, 'session_busy')
    assert.equal(busy.command, 'fork')
    assert.equal(busy.requestId, wire.commands[2].id)
    assert.equal(wire.connection.isReady, true)
  } finally {
    await wire.connection.close()
  }
})

test('legacy no-code failures keep message and absence; unknown bounded UTF-8 codes are preserved without inference', async () => {
  for (const code of [undefined, 'future_vendor_reason', '界'.repeat(85) + 'x']) {
    const wire = await hostToolWire()
    try {
      wire.intercept((command, done) => {
        wire.emit({
          type: 'response',
          id: command.id,
          command: command.type,
          success: false,
          error: 'original server message',
          ...(code === undefined ? {} : { code })
        })
        done()
        return true
      })
      const error = await wire.connection.request({ type: 'get_messages_page' }).catch(failure)
      assert.ok(error instanceof RpcRequestError)
      assert.equal(error.message, 'original server message')
      assert.equal(error.code, code)
      assert.equal(Object.hasOwn(error, 'code'), code !== undefined)
      assert.equal(wire.connection.isReady, true)
    } finally {
      await wire.connection.close()
    }
  }
  const cause = new Error('original cause')
  const typed = new RpcRequestError(
    { id: 'id', command: 'command', error: 'same message', code: 'future_code' },
    { cause }
  )
  assert.equal(typed.cause, cause)
  assert.equal(typed.message, 'same message')
})

test('invalid or over-byte-budget codes retire the channel as malformed protocol, never trusted request errors', async () => {
  for (const code of [
    null,
    [],
    {},
    42,
    true,
    '',
    '界'.repeat(86),
    'x'.repeat(MAX_RPC_ERROR_CODE_BYTES + 1)
  ]) {
    const wire = await hostToolWire()
    try {
      wire.intercept((command, done) => {
        wire.emit({
          type: 'response',
          id: command.id,
          command: command.type,
          success: false,
          error: 'untrusted code',
          code
        })
        done()
        return true
      })
      await assert.rejects(
        wire.connection.request({ type: 'get_messages_page' }),
        (error: unknown) => {
          assert.ok(error instanceof Error)
          assert.equal(error instanceof RpcRequestError, false)
          assert.equal(error instanceof RpcByteLimitError, false)
          assert.match(error.message, /Invalid RPC response/)
          return true
        }
      )
      assert.equal(wire.connection.isReady, false)
    } finally {
      await wire.connection.close()
    }
  }
})

test('response code does not bypass command correlation or grant authority to an unsolicited response', async () => {
  const wire = await hostToolWire()
  try {
    wire.emit({
      type: 'response',
      id: 'unsolicited',
      command: 'get_messages_page',
      success: false,
      error: 'not requested',
      code: 'stale_cursor'
    })
    assert.equal(wire.connection.isReady, true)
    wire.intercept((command, done) => {
      wire.emit({
        type: 'response',
        id: command.id,
        command: 'wrong-command',
        success: false,
        error: 'wrong command',
        code: 'session_busy'
      })
      done()
      return true
    })
    await assert.rejects(
      wire.connection.request({ type: 'get_messages_page' }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error instanceof RpcRequestError, false)
        assert.match(error.message, /command does not match/)
        return true
      }
    )
  } finally {
    await wire.connection.close()
  }
})

test('well-formed chunk byte-limit failure is typed without accumulating the oversized logical payload', () => {
  const parser = codec()
  assert.throws(
    () => parser.push(line(chunk({ byteLength: MAX_RPC_REASSEMBLED_BYTES + 1 }))),
    (error: unknown) => {
      assert.ok(error instanceof RpcByteLimitError)
      assert.equal(error.scope, 'reassembled-frame')
      assert.equal(error.limitBytes, MAX_RPC_REASSEMBLED_BYTES)
      assert.equal(error.actualBytes, MAX_RPC_REASSEMBLED_BYTES + 1)
      return true
    }
  )
  // An oversized declaration never installs partial chunk state.
  assert.deepEqual(parser.push(line({ type: 'notice', text: 'next valid frame' })), [
    { type: 'notice', text: 'next valid frame' }
  ])
  parser.finish()
})

test('oversized bytes do not disguise malformed metadata, base64, payload or ordering as a history limit', () => {
  for (const overrides of [
    { chunkId: '' },
    { index: -1 },
    { index: 0.5 },
    { count: '256' },
    { count: 257 },
    { byteLength: '67108865' },
    { byteLength: Number.MAX_SAFE_INTEGER + 1 },
    { byteLength: NaN },
    { data: '%%%%' },
    { data: 'AB==' },
    { data: Buffer.alloc(RPC_CHUNK_PAYLOAD_BYTES + 1).toString('base64') },
    { index: 1 }
  ]) {
    assert.throws(
      () => codec().push(line(chunk({ byteLength: MAX_RPC_REASSEMBLED_BYTES + 1, ...overrides }))),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.equal(error instanceof RpcByteLimitError, false)
        return true
      }
    )
  }
  const pending = codec()
  pending.push(line(chunk()))
  assert.throws(
    () => pending.push(line(chunk({ index: 1, byteLength: MAX_RPC_REASSEMBLED_BYTES + 1 }))),
    (error: unknown) => {
      assert.ok(error instanceof Error)
      assert.equal(error instanceof RpcByteLimitError, false)
      assert.match(error.message, /sequence mismatch/)
      return true
    }
  )
})

test('physical and outgoing command byte limits retain distinct scopes and original messages', () => {
  const overhead = Buffer.byteLength(JSON.stringify({ type: 'notice', text: '' })) + 1
  const exact = line({ type: 'notice', text: 'x'.repeat(MAX_RPC_FRAME_BYTES - overhead) })
  assert.equal(new RpcFrameCodec().push(exact).length, 1)
  const oversized = line({ type: 'notice', text: 'x'.repeat(MAX_RPC_FRAME_BYTES - overhead + 1) })
  assert.throws(
    () => new RpcFrameCodec().push(oversized),
    (error: unknown) => {
      assert.ok(error instanceof RpcByteLimitError)
      assert.equal(error.scope, 'physical-frame')
      assert.equal(error.actualBytes, MAX_RPC_FRAME_BYTES + 1)
      assert.match(error.message, /RPC physical frame exceeds the frame limit/)
      return true
    }
  )
  assert.throws(
    () =>
      encodeRpcCommand({ type: 'notice', text: 'x'.repeat(MAX_RPC_FRAME_BYTES - overhead + 1) }),
    (error: unknown) => {
      assert.ok(error instanceof RpcByteLimitError)
      assert.equal(error.scope, 'command-frame')
      assert.equal(error.actualBytes, MAX_RPC_FRAME_BYTES + 1)
      assert.match(error.message, /RPC command exceeds the frame limit/)
      return true
    }
  )
  const parser = new RpcFrameCodec()
  parser.push(Buffer.alloc(20, 32))
  assert.throws(
    () => parser.push(Buffer.alloc(MAX_RPC_FRAME_BYTES - 20, 32)),
    (error: unknown) => {
      assert.ok(error instanceof RpcByteLimitError)
      assert.equal(error.actualBytes, MAX_RPC_FRAME_BYTES + 1)
      return true
    }
  )
})

test('exact 64 MiB complete reassembly is accepted and its payload/count budgets remain unchanged', () => {
  const empty = JSON.stringify({ type: 'notice', text: '' })
  const json = Buffer.from(
    JSON.stringify({
      type: 'notice',
      text: 'x'.repeat(MAX_RPC_REASSEMBLED_BYTES - Buffer.byteLength(empty))
    })
  )
  assert.equal(json.length, MAX_RPC_REASSEMBLED_BYTES)
  const parser = codec()
  let decoded: unknown
  for (let index = 0; index < 256; index++) {
    const frames = parser.push(
      line(
        chunk({
          index,
          data: json
            .subarray(index * RPC_CHUNK_PAYLOAD_BYTES, (index + 1) * RPC_CHUNK_PAYLOAD_BYTES)
            .toString('base64')
        })
      )
    )
    if (frames.length) decoded = frames[0]
  }
  assert.deepEqual(decoded, {
    type: 'notice',
    text: 'x'.repeat(MAX_RPC_REASSEMBLED_BYTES - Buffer.byteLength(empty))
  })
  parser.finish()
})

test('malformed UTF-8/JSON/EOF remain protocol errors and error cause options retain identity', () => {
  for (const value of [Buffer.from('{broken}\n'), Buffer.from([0xc3, 0x28, 0x0a])]) {
    assert.throws(
      () => new RpcFrameCodec().push(value),
      (error: unknown) => {
        assert.equal(error instanceof RpcByteLimitError, false)
        return true
      }
    )
  }
  const parser = new RpcFrameCodec()
  parser.push(Buffer.from('{"type":'))
  assert.throws(
    () => parser.finish(),
    (error: unknown) => {
      assert.equal(error instanceof RpcByteLimitError, false)
      return true
    }
  )
  const cause = new Error('budget source')
  assert.equal(new RpcByteLimitError('budget', 'reassembled-frame', 1, 2, { cause }).cause, cause)
})

test('retired generations cannot deliver trusted response codes to a new pending request', async () => {
  const peers = [hostToolPeer(), hostToolPeer()]
  let index = 0
  const connection = new RpcConnection(() => peers[index++].transport, {
    startupTimeoutMs: 1000,
    requestTimeoutMs: 1000
  })
  try {
    let start = connection.start()
    peers[0].ready()
    await start
    peers[0].intercept((_command, done) => {
      done()
      return true
    })
    const old = connection.request({ type: 'get_messages_page' }).catch((error: unknown) => error)
    await hostUntil(() => peers[0].commands.length === 2)
    const oldId = peers[0].commands[1].id
    await connection.close()
    assert.ok((await old) instanceof Error)
    start = connection.start()
    peers[1].ready()
    await start
    peers[1].intercept((_command, done) => {
      done()
      return true
    })
    const current = connection.request({ type: 'get_messages_page' })
    const outcome = current.catch(failure)
    await hostUntil(() => peers[1].commands.length === 2)
    peers[1].emit({
      type: 'response',
      id: oldId,
      command: 'get_messages_page',
      success: false,
      error: 'late old code',
      code: 'stale_cursor'
    })
    peers[1].emit({
      type: 'response',
      id: peers[1].commands[1].id,
      command: 'get_messages_page',
      success: false,
      error: 'current busy',
      code: 'session_busy'
    })
    const error = await outcome
    assert.ok(error instanceof RpcRequestError)
    assert.equal(error.code, 'session_busy')
    assert.equal(error.message, 'current busy')
  } finally {
    await connection.close()
  }
})

test('connection propagates a logical byte-limit error intact to its waiting request', async () => {
  const wire = await hostToolWire()
  try {
    wire.intercept((_command, done) => {
      wire.emit(chunk({ byteLength: MAX_RPC_REASSEMBLED_BYTES + 1 }))
      done()
      return true
    })
    await assert.rejects(
      wire.connection.request({ type: 'get_messages_page' }),
      (error: unknown) => {
        assert.ok(error instanceof RpcByteLimitError)
        assert.equal(error.scope, 'reassembled-frame')
        assert.equal(error.actualBytes, MAX_RPC_REASSEMBLED_BYTES + 1)
        assert.equal(error instanceof RpcRequestError, false)
        return true
      }
    )
    assert.equal(wire.connection.isReady, false)
  } finally {
    await wire.connection.close()
  }
})
