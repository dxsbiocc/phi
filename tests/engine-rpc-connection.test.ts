import assert from 'node:assert/strict'
import { PassThrough, Writable } from 'node:stream'
import { setImmediate as turn } from 'node:timers/promises'
import test from 'node:test'
import { RpcConnection } from '../src/main/agent/engine/rpc/connection'
import type {
  RpcConnectionOptions,
  RpcFrame,
  RpcTransport
} from '../src/main/agent/engine/rpc/types'

type Command = Record<string, unknown> & { id: string; type: string }
function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const ready = {
  type: 'ready',
  protocolVersion: 1,
  supportedProtocolVersions: [1, 2],
  maxFrameBytes: 1048576,
  maxReassembledFrameBytes: 67108864
}
function bytes(frame: unknown): Buffer {
  return Buffer.from(JSON.stringify(frame) + '\n')
}
function result(id: string, status: 'completed' | 'aborted' | 'error' = 'completed'): RpcFrame {
  return {
    type: 'prompt_result',
    id,
    agentInvoked: true,
    status,
    sessionSettled: true,
    ...(status === 'error'
      ? { error: { message: 'fixture provider error', retryable: false } }
      : {})
  }
}

/** Real Node streams; only the remote protocol peer is controlled by each case. */
class Peer implements RpcTransport {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly commands: Command[] = []
  readonly ended = deferred<{ code: number | null; signal: string | null }>()
  readonly closed = this.ended.promise
  readonly stdin: Writable
  onCommand?: (command: Command) => void
  failWrite?: Error
  closeGate?: Promise<void>
  closeCalls = 0
  negotiateVersion = 2
  private closing?: Promise<void>

  constructor() {
    this.stdin = new Writable({
      write: (data: Buffer, _encoding, callback) => {
        if (this.failWrite) {
          callback(this.failWrite)
          return
        }
        const command = JSON.parse(data.toString('utf8')) as Command
        this.commands.push(command)
        try {
          if (command.type === 'negotiate_protocol')
            this.respond(command, { protocolVersion: this.negotiateVersion })
          else this.onCommand?.(command)
          callback()
        } catch (error) {
          callback(error as Error)
        }
      }
    })
  }
  send(frame: unknown): void {
    this.stdout.write(bytes(frame))
  }
  respond(command: Command, data?: unknown): void {
    this.send({
      type: 'response',
      id: command.id,
      command: command.type,
      success: true,
      ...(data === undefined ? {} : { data })
    })
  }
  close(): Promise<void> {
    this.closing ??= (async () => {
      this.closeCalls++
      this.stdout.end()
      this.stderr.end()
      this.stdin.end()
      await this.closeGate
      await turn()
      this.ended.resolve({ code: 0, signal: null })
    })()
    return this.closing
  }
}

async function until(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error('fixture did not reach its expected state')
    await turn()
  }
}
async function connected(
  options: RpcConnectionOptions = {}
): Promise<{ peer: Peer; connection: RpcConnection }> {
  const peer = new Peer()
  const connection = new RpcConnection(() => peer, {
    startupTimeoutMs: 1000,
    requestTimeoutMs: 1000,
    ...options
  })
  const started = connection.start()
  peer.send(ready)
  await started
  return { peer, connection }
}

test('startup is idempotent and requires exact ready capabilities then v2 acknowledgement', async () => {
  const peer = new Peer()
  let opens = 0
  const connection = new RpcConnection(() => {
    opens++
    return peer
  })
  const first = connection.start()
  const second = connection.start()
  assert.equal(first, second)
  assert.equal(connection.isReady, false)
  peer.send(ready)
  await first
  assert.equal(opens, 1)
  assert.equal(connection.isReady, true)
  assert.deepEqual(
    peer.commands.map(({ type, protocolVersion }) => ({ type, protocolVersion })),
    [{ type: 'negotiate_protocol', protocolVersion: 2 }]
  )
  await connection.close()
  assert.equal(peer.closeCalls, 1)
  for (const altered of [
    { ...ready, supportedProtocolVersions: [1] },
    { ...ready, maxFrameBytes: 1 }
  ]) {
    const incompatible = new Peer()
    const invalid = new RpcConnection(() => incompatible)
    const starting = invalid.start()
    incompatible.send(altered)
    await assert.rejects(starting, /required protocol v2/)
    assert.equal(incompatible.closeCalls, 1)
  }
  const wrongAck = new Peer()
  wrongAck.negotiateVersion = 1
  const rejectedVersion = new RpcConnection(() => wrongAck)
  const negotiating = rejectedVersion.start()
  wrongAck.send(ready)
  await assert.rejects(negotiating, /negotiation failed/)
  assert.equal(wrongAck.closeCalls, 1)
})

test('request IDs correlate out-of-order responses and command errors do not poison the channel', async () => {
  const { peer, connection } = await connected()
  try {
    const one = connection.request({ type: 'get_state' })
    const two = connection.request({ type: 'get_messages' })
    await until(() => peer.commands.length === 3)
    assert.notEqual(peer.commands[1].id, peer.commands[2].id)
    peer.respond(peer.commands[2], { messages: ['two'] })
    peer.respond(peer.commands[1], { name: 'one' })
    assert.deepEqual(await one, { name: 'one' })
    assert.deepEqual(await two, { messages: ['two'] })
    peer.onCommand = (command) =>
      peer.send({
        type: 'response',
        id: command.id,
        command: command.type,
        success: false,
        error: 'rejected by server'
      })
    await assert.rejects(connection.request({ type: 'unknown' }), /rejected by server/)
    assert.equal(connection.isReady, true)
  } finally {
    await connection.close()
  }
})

test('agent_end is only an event; same-ID prompt_result owns completion, including early result', async () => {
  const { peer, connection } = await connected()
  try {
    let completed = false
    const events: string[] = []
    connection.onEvent((frame) => events.push(frame.type))
    peer.onCommand = (command) => {
      peer.respond(command, { agentInvoked: true })
      peer.send({ type: 'agent_end', messages: [] })
    }
    const pending = connection.prompt('one').then((value) => {
      completed = true
      return value
    })
    await until(() => peer.commands.length === 2)
    await turn()
    assert.equal(completed, false)
    peer.send(result('unrelated'))
    await turn()
    assert.equal(completed, false)
    peer.send(result(peer.commands[1].id))
    assert.equal((await pending).status, 'completed')
    assert.deepEqual(events, ['agent_end'])
    peer.onCommand = (command) => {
      peer.send(result(command.id))
      peer.respond(command, { agentInvoked: true })
    }
    const early = await connection.prompt('early')
    assert.equal(early.status, 'completed')
    assert.equal(early.id, peer.commands.at(-1)?.id)
  } finally {
    await connection.close()
  }
})

test('local commands complete at admission and rejected admission cannot consume an early result', async () => {
  const { peer, connection } = await connected()
  try {
    peer.onCommand = (command) => peer.respond(command, { agentInvoked: false })
    const local = await connection.prompt('/local')
    assert.equal(local.agentInvoked, false)
    assert.equal(local.status, 'completed')
    peer.onCommand = (command) => {
      peer.send(result(command.id))
      peer.send({
        type: 'response',
        id: command.id,
        command: 'prompt',
        success: false,
        error: 'not admitted'
      })
    }
    await assert.rejects(connection.prompt('rejected'), /not admitted/)
    assert.equal(connection.isReady, true)
  } finally {
    await connection.close()
  }
})

test('abort keeps one transport reusable and prompt error outcomes preserve metadata', async () => {
  const { peer, connection } = await connected()
  try {
    let promptId = ''
    peer.onCommand = (command) => {
      if (command.type === 'prompt') {
        promptId = command.id
        peer.respond(command, { agentInvoked: true })
      }
      if (command.type === 'abort') {
        peer.respond(command)
        peer.send(result(promptId, 'aborted'))
      }
    }
    const interrupted = connection.prompt('hold')
    await until(() => Boolean(promptId))
    await connection.abort()
    assert.equal((await interrupted).status, 'aborted')
    assert.equal(peer.closeCalls, 0)
    peer.onCommand = (command) => {
      peer.respond(command)
      peer.send(result(command.id, 'error'))
    }
    assert.deepEqual((await connection.prompt('error')).error, {
      message: 'fixture provider error',
      retryable: false
    })
    peer.onCommand = (command) => {
      peer.respond(command)
      peer.send(result(command.id))
    }
    assert.equal((await connection.prompt('next')).status, 'completed')
  } finally {
    await connection.close()
  }
})

test('abort skips only an already closed generation and preserves live request failures', async () => {
  const neverStarted = new RpcConnection(() => new Peer())
  await assert.rejects(neverStarted.abort(), /not ready/)

  const failed = await connected()
  const commandsBeforeFailure = failed.peer.commands.length
  failed.peer.stdout.end()
  await until(() => !failed.connection.isReady)
  await failed.connection.abort()
  assert.equal(failed.peer.commands.length, commandsBeforeFailure)
  await failed.connection.close()

  const refused = await connected()
  refused.peer.onCommand = (command) =>
    refused.peer.send({
      type: 'response',
      id: command.id,
      command: command.type,
      success: false,
      error: 'abort refused'
    })
  await assert.rejects(refused.connection.abort(), /abort refused/)
  assert.equal(refused.connection.isReady, true)
  await refused.connection.close()

  const timedOut = await connected({ requestTimeoutMs: 30 })
  timedOut.peer.onCommand = () => undefined
  await assert.rejects(timedOut.connection.abort(), /abort response timed out/)
  assert.equal(timedOut.connection.isReady, false)
  await timedOut.connection.close()
})

test('negotiate acknowledgement and official chunks coalesced in one read succeed', async () => {
  const peer = new Peer()
  const value = { type: 'notice', message: 'x'.repeat(1050000) }
  const payload = Buffer.from(JSON.stringify(value))
  const physical = Array.from({ length: Math.ceil(payload.length / 262144) }, (_, index) =>
    bytes({
      type: 'rpc_chunk',
      chunkId: 'coalesced',
      index,
      count: Math.ceil(payload.length / 262144),
      byteLength: payload.length,
      data: payload.subarray(index * 262144, (index + 1) * 262144).toString('base64')
    })
  )
  const originalWrite = peer.stdin._write.bind(peer.stdin)
  peer.stdin._write = (data, encoding, callback) => {
    const command = JSON.parse(data.toString()) as Command
    if (command.type !== 'negotiate_protocol') {
      originalWrite(data, encoding, callback)
      return
    }
    peer.stdout.write(
      Buffer.concat([
        bytes({
          type: 'response',
          id: command.id,
          command: command.type,
          success: true,
          data: { protocolVersion: 2 }
        }),
        ...physical
      ])
    )
    callback()
  }
  const connection = new RpcConnection(() => peer)
  const events: RpcFrame[] = []
  connection.onEvent(() => {
    throw new Error('consumer bug')
  })
  connection.onEvent((frame) => events.push(frame))
  connection.onDisconnect(() => {
    throw new Error('disconnect observer bug')
  })
  const starting = connection.start()
  peer.send(ready)
  await starting
  assert.deepEqual(events, [value])
  assert.equal(connection.isReady, true)
  await connection.close()
})

test('EOF rejects outstanding work, validates partial frames and removes owned listeners', async () => {
  for (const partial of ['', '{"type":']) {
    const { peer, connection } = await connected()
    peer.onCommand = () => undefined
    const interrupted = Promise.allSettled([
      connection.request({ type: 'get_state' }),
      connection.prompt('pending')
    ])
    await until(() => peer.commands.length === 3)
    peer.stdout.end(partial)
    const outcomes = await interrupted
    assert.ok(outcomes.every((item) => item.status === 'rejected'))
    await connection.close()
    assert.equal(peer.closeCalls, 1)
    assert.equal(connection.isReady, false)
    assert.equal(peer.stdout.listenerCount('data'), 0)
    assert.equal(peer.stdout.listenerCount('error'), 0)
    assert.equal(peer.stdin.listenerCount('error'), 0)
    assert.equal(peer.stderr.listenerCount('data'), 0)
  }
})

test('start, write, request and completion failures are bounded and clean up', async () => {
  const startupFailure = new RpcConnection(() => {
    throw new Error('factory failed')
  })
  await assert.rejects(startupFailure.start(), /factory failed/)
  const silent = new Peer()
  const timeout = new RpcConnection(() => silent, { startupTimeoutMs: 30 })
  await assert.rejects(timeout.start(), /startup timed out/)
  assert.equal(silent.closeCalls, 1)
  for (const mode of ['write', 'request', 'completion'] as const) {
    const { peer, connection } = await connected({
      requestTimeoutMs: 60,
      promptTimeoutMs: mode === 'completion' ? 60 : 0
    })
    if (mode === 'write') peer.failWrite = new Error('write failed')
    if (mode === 'completion')
      peer.onCommand = (command) => peer.respond(command, { agentInvoked: true })
    await assert.rejects(
      mode === 'completion' ? connection.prompt('hold') : connection.request({ type: 'get_state' }),
      /write failed|response timed out|completion timed out/
    )
    await connection.close()
    assert.equal(peer.closeCalls, 1)
    assert.equal(connection.isReady, false)
  }
})

test('malformed response ownership fails closed, but oversized local inputs leave no pending prompt', async () => {
  const { peer, connection } = await connected()
  await assert.rejects(connection.prompt('x'.repeat(1048576)), /frame limit/)
  peer.onCommand = (command) => peer.respond(command, { agentInvoked: false })
  assert.equal((await connection.prompt('/next')).agentInvoked, false)
  peer.onCommand = (command) =>
    peer.send({ type: 'response', id: command.id, command: 'other', success: true })
  await assert.rejects(connection.request({ type: 'get_state' }), /does not match/)
  await connection.close()
})

test('late output, exit and write callbacks from a retired generation cannot affect its replacement', async () => {
  const old = new Peer()
  const next = new Peer()
  let calls = 0
  const connection = new RpcConnection(() => (++calls === 1 ? old : next))
  const first = connection.start()
  old.send(ready)
  await first
  let finishOldWrite: ((error?: Error | null) => void) | undefined
  const oldWrite = old.stdin._write.bind(old.stdin)
  old.stdin._write = (data, encoding, callback) => {
    const command = JSON.parse(data.toString()) as Command
    if (command.type === 'get_state') {
      old.commands.push(command)
      finishOldWrite = callback
    } else oldWrite(data, encoding, callback)
  }
  const pending = connection.request({ type: 'get_state' })
  const rejected = assert.rejects(pending, /exited/)
  await until(() => old.commands.length === 2)
  old.ended.resolve({ code: 7, signal: null })
  await rejected
  const restarted = connection.start()
  next.send(ready)
  await restarted
  let events = 0
  connection.onEvent(() => events++)
  old.stdout.emit('data', bytes({ type: 'agent_end', messages: [] }))
  assert.ok(finishOldWrite)
  finishOldWrite(new Error('late write failure'))
  await turn()
  assert.equal(old.stdin.listenerCount('error'), 0)
  assert.equal(events, 0)
  assert.equal(connection.isReady, true)
  next.onCommand = (command) => next.respond(command, { value: 'new generation' })
  assert.deepEqual(await connection.request({ type: 'get_state' }), { value: 'new generation' })
  await connection.close()
  assert.equal(calls, 2)
})

test('closing a start waiting for old cleanup never invokes its cancelled factory', async () => {
  const old = new Peer()
  const cleanup = deferred<void>()
  old.closeGate = cleanup.promise
  let opens = 0
  const connection = new RpcConnection(
    () => {
      opens++
      return old
    },
    { closeTimeoutMs: 1000 }
  )
  const started = connection.start()
  old.send(ready)
  await started
  const closingOld = connection.close()
  const cancelledStart = connection.start()
  const rejected = assert.rejects(cancelledStart, /closed/)
  const closingNew = connection.close()
  cleanup.resolve()
  await Promise.all([closingOld, closingNew, rejected])
  await turn()
  assert.equal(opens, 1)
})

test('late startup results are reaped and stuck cleanup reports its bounded failure', async () => {
  const opening = deferred<RpcTransport>()
  const late = new Peer()
  const connection = new RpcConnection(() => opening.promise)
  const starting = connection.start()
  const rejected = assert.rejects(starting, /closed/)
  await turn()
  await connection.close()
  await rejected
  opening.resolve(late)
  await until(() => late.closeCalls === 1)
  const gate = deferred<void>()
  const { peer, connection: stuck } = await connected({ closeTimeoutMs: 30 })
  peer.closeGate = gate.promise
  await assert.rejects(stuck.close(), /cleanup timed out/)
  assert.equal(stuck.isReady, false)
  gate.resolve()
  await peer.closed
})

test('async and thenable observer failures remain isolated and synchronous invocation order is preserved', async () => {
  const { peer, connection } = await connected()
  const calls: string[] = []
  connection.onEvent(async () => {
    calls.push('async')
    await turn()
    throw new Error('async observer failed')
  })
  connection.onEvent(() => ({
    then: (_resolve: unknown, reject: (error: Error) => void) =>
      reject(new Error('thenable failed'))
  }))
  connection.onEvent(() => {
    calls.push('next')
  })
  connection.onDisconnect(async () => {
    await turn()
    throw new Error('async disconnect failed')
  })
  connection.onDisconnect(() => ({
    then: (_resolve: unknown, reject: (error: Error) => void) =>
      reject(new Error('disconnect thenable failed'))
  }))
  peer.send({ type: 'notice', message: 'event' })
  assert.deepEqual(calls, ['async', 'next'])
  await turn()
  await turn()
  peer.onCommand = (command) => peer.respond(command, { stillReady: true })
  assert.deepEqual(await connection.request({ type: 'get_state' }), { stillReady: true })
  await connection.close()
  await turn()
  await turn()
})

test('a past cleanup timeout cannot poison or bypass the current generation cleanup', async () => {
  const peers = [new Peer(), new Peer(), new Peer()]
  const firstGate = deferred<void>()
  peers[0].closeGate = firstGate.promise
  let opens = 0
  const connection = new RpcConnection(() => peers[opens++], { closeTimeoutMs: 50 })
  const first = connection.start()
  peers[0].send(ready)
  await first
  await assert.rejects(connection.close(), /cleanup timed out/)
  const second = connection.start()
  peers[1].send(ready)
  await second
  const secondGate = deferred<void>()
  peers[1].closeGate = secondGate.promise
  let closed = false
  const secondClosing = connection.close().then(() => {
    closed = true
  })
  const third = connection.start()
  peers[2].send(ready)
  await turn()
  await turn()
  assert.equal(opens, 2)
  assert.equal(closed, false)
  secondGate.resolve()
  await secondClosing
  await third
  assert.equal(opens, 3)
  assert.equal(connection.isReady, true)
  const thirdClose = peers[2].close.bind(peers[2])
  peers[2].close = async () => {
    await thirdClose()
    throw new Error('current cleanup failed')
  }
  await assert.rejects(connection.close(), /current cleanup failed/)
  firstGate.resolve()
  await peers[0].closed
})

test('an observer closing its generation prevents later observers receiving the same stale frame', async () => {
  const { peer, connection } = await connected()
  let closing: Promise<void> | undefined
  let stale = 0
  connection.onEvent(() => {
    closing = connection.close()
  })
  connection.onEvent(() => {
    stale++
  })
  peer.send({ type: 'notice', message: 'close during dispatch' })
  assert.ok(closing)
  await closing
  assert.equal(stale, 0)
})

test('prompt result validates declared metadata types while preserving unknown fields', async () => {
  for (const invalid of [
    { status: ['completed'] },
    { error: { message: 'bad', retryable: false, provider: {} } },
    { error: { message: 'bad', retryable: false, model: [] } },
    { error: { message: 'bad', retryable: false, httpStatus: '401' } },
    { error: { message: 'bad', retryable: false, httpStatus: 1.5 } }
  ]) {
    const { peer, connection } = await connected()
    peer.onCommand = (command) => {
      peer.respond(command, { agentInvoked: true })
      peer.send({ ...result(command.id, 'error'), ...invalid })
    }
    await assert.rejects(connection.prompt('invalid metadata'), /Invalid RPC prompt result/)
    await connection.close()
  }
  const { peer, connection } = await connected()
  let expected: RpcFrame | undefined
  peer.onCommand = (command) => {
    expected = {
      ...result(command.id, 'error'),
      futureFrame: { retained: true },
      error: {
        message: 'provider failed',
        retryable: false,
        provider: 'fixture',
        model: 'model',
        httpStatus: 401,
        futureField: 'kept'
      }
    }
    peer.respond(command)
    peer.send(expected)
  }
  assert.deepEqual(await connection.prompt('valid metadata'), expected)
  assert.equal(connection.isReady, true)
  await connection.close()
})
