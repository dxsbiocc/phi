import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PHI_KERNEL_PROTOCOL_VERSION,
  encodeFrame,
  parseFrame,
  type JsonValue,
  type KernelRequestFrame,
  type KernelResponseFrame,
  type ParsedFrame
} from '../src/shared/kernel-protocol'
import {
  KernelProtocolCore,
  type FrameTransport,
  type RunCompletionStatus,
  type SessionPromptRun
} from '../src/kernel/protocol'

class MemoryTransport implements FrameTransport {
  readonly sent: string[] = []
  private readonly lineListeners = new Set<(line: string) => void>()
  private readonly closeListeners = new Set<() => void>()

  send(line: string): void {
    this.sent.push(line)
  }

  onLine(callback: (line: string) => void): void {
    this.lineListeners.add(callback)
  }

  onClose(callback: () => void): void {
    this.closeListeners.add(callback)
  }

  receive(frame: ParsedFrame): void {
    for (const listener of this.lineListeners) listener(encodeFrame(frame))
  }

  close(): void {
    for (const listener of this.closeListeners) listener()
  }
}

function request(
  id: string,
  method: string,
  generation: number,
  params: JsonValue,
  sessionId?: string
): KernelRequestFrame {
  return { kind: 'request', id, method, generation, params, ...(sessionId ? { sessionId } : {}) }
}

function decode(line: string): ParsedFrame {
  const parsed = parseFrame(line)
  if (!('kind' in parsed)) assert.fail(`expected frame, received ${parsed.code}`)
  return parsed
}

async function responseFor(
  transport: MemoryTransport,
  frame: KernelRequestFrame
): Promise<KernelResponseFrame> {
  const after = transport.sent.length
  transport.receive(frame)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const response = transport.sent
      .slice(after)
      .map(decode)
      .find((candidate) => candidate.kind === 'response' && candidate.id === frame.id)
    if (response) {
      assert.equal(response.kind, 'response')
      return response
    }
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error(`Timed out waiting for ${frame.id}`)
}

async function hello(transport: MemoryTransport, takeover = false): Promise<number> {
  const response = await responseFor(
    transport,
    request('hello', 'kernel.hello', 0, {
      protocol: PHI_KERNEL_PROTOCOL_VERSION,
      client: { name: 'prompt-race-test', version: '1.0.0' },
      ...(takeover ? { takeover: true } : {})
    })
  )
  assert.equal(response.ok, true)
  const result = response.result as Record<string, JsonValue>
  assert.equal(typeof result.controllerGeneration, 'number')
  return result.controllerGeneration as number
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

async function runLatePromptRace(lateAbort: 'success' | 'throw' | 'invalid'): Promise<{
  aborts: Array<{ sessionId?: string; runId?: string }>
  oldResponses: KernelResponseFrame[]
  terminal: ParsedFrame
}> {
  const prompt = deferred<SessionPromptRun>()
  const completion = deferred<RunCompletionStatus>()
  const aborts: Array<{ sessionId?: string; runId?: string }> = []
  const first = new MemoryTransport()
  const core = new KernelProtocolCore({
    kernelVersion: 'prompt-race-kernel',
    ompVersion: 'prompt-race-omp',
    kernelInstanceId: 'prompt-race-instance',
    disconnectPolicy: 'wait-for-reconnect',
    handlers: {
      'session.prompt': () => prompt.promise,
      'session.abort': (_params, _context, frame) => {
        aborts.push({ sessionId: frame.sessionId, runId: frame.runId })
        if (lateAbort === 'throw' && frame.runId) throw new Error('late abort failed')
        if (lateAbort === 'invalid' && frame.runId) return { cancelled: false }
        return { cancelled: true }
      },
      'events.subscribe': () => ({ subscribed: true, lastSeq: 0 })
    }
  })
  core.attachTransport(first, { trusted: true, connectionId: 'pending-prompt' })
  const generation = await hello(first)
  first.receive(request('slow-prompt', 'session.prompt', generation, { text: 'slow' }, 'session-1'))
  await new Promise<void>((resolve) => setImmediate(resolve))
  first.close()

  let expirySettled = false
  const expiry = core.expireDisconnectedState().finally(() => {
    expirySettled = true
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(aborts, [{ sessionId: 'session-1', runId: undefined }])
  assert.equal(expirySettled, false)
  prompt.resolve({ runId: 'run-late', completion: completion.promise })
  await expiry

  const second = new MemoryTransport()
  core.attachTransport(second, { trusted: true, connectionId: 'pending-replay' })
  const reconnectGeneration = await hello(second, true)
  await responseFor(
    second,
    request('replay', 'events.subscribe', reconnectGeneration, { afterSeq: 0 })
  )
  const terminal = second.sent
    .map(decode)
    .find((frame) => frame.kind === 'event' && frame.type === 'run.completed')
  assert.ok(terminal)
  return {
    aborts,
    oldResponses: first.sent
      .map(decode)
      .filter((frame): frame is KernelResponseFrame => frame.kind === 'response'),
    terminal
  }
}

test('grace expiry aborts pending prompt acceptance and cancels its late real run id', async () => {
  const result = await runLatePromptRace('success')
  assert.deepEqual(result.aborts, [
    { sessionId: 'session-1', runId: undefined },
    { sessionId: 'session-1', runId: 'run-late' }
  ])
  assert.equal(
    result.oldResponses.some((frame) => frame.id === 'slow-prompt'),
    false
  )
  assert.equal(result.terminal.kind, 'event')
  assert.deepEqual(result.terminal.payload, { runId: 'run-late', status: 'cancelled' })
})

test('a late run is unknown when grace expiry cannot prove its abort succeeded', async () => {
  const result = await runLatePromptRace('throw')
  assert.deepEqual(result.aborts, [
    { sessionId: 'session-1', runId: undefined },
    { sessionId: 'session-1', runId: 'run-late' }
  ])
  assert.equal(result.terminal.kind, 'event')
  assert.deepEqual(result.terminal.payload, { runId: 'run-late', status: 'unknown' })
})

test('an invalid late abort result records the real run as unknown', async () => {
  const result = await runLatePromptRace('invalid')
  assert.equal(result.terminal.kind, 'event')
  assert.deepEqual(result.terminal.payload, { runId: 'run-late', status: 'unknown' })
})

test('a real run id beginning with pending is never mistaken for prompt acceptance state', async () => {
  const completion = deferred<RunCompletionStatus>()
  const transport = new MemoryTransport()
  const core = new KernelProtocolCore({
    kernelVersion: 'prompt-prefix-kernel',
    ompVersion: 'prompt-prefix-omp',
    handlers: {
      'session.prompt': () => ({ runId: 'pending:real-run', completion: completion.promise })
    }
  })
  core.attachTransport(transport, { trusted: true })
  const generation = await hello(transport)
  const accepted = await responseFor(
    transport,
    request('prefixed-prompt', 'session.prompt', generation, { text: 'run' }, 'session-prefix')
  )
  assert.equal(accepted.ok, true)
  assert.deepEqual(accepted.result, { accepted: true, runId: 'pending:real-run' })

  completion.resolve('completed')
  await new Promise<void>((resolve) => setImmediate(resolve))
  const terminal = transport.sent
    .map(decode)
    .find((frame) => frame.kind === 'event' && frame.type === 'run.completed')
  assert.ok(terminal)
  assert.equal(terminal.kind, 'event')
  assert.deepEqual(terminal.payload, { runId: 'pending:real-run', status: 'completed' })
})
