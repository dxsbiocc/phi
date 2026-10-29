import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_FRAME_BYTES,
  PHI_KERNEL_PROTOCOL_VERSION,
  encodeFrame,
  parseFrame,
  type JsonValue,
  type KernelRequestFrame,
  type KernelResponseFrame,
  type ParsedFrame,
  type ProtocolError
} from '../src/shared/kernel-protocol'
import {
  KernelProtocolCore,
  type FrameTransport,
  type KernelMethodHandlers,
  type RunCompletionStatus
} from '../src/kernel/protocol'
import { normalizeHandlerError } from '../src/kernel/protocol/errors'

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

  receive(frame: ParsedFrame | string): void {
    const line = typeof frame === 'string' ? frame : encodeFrame(frame)
    for (const listener of this.lineListeners) listener(line)
  }

  close(): void {
    for (const listener of this.closeListeners) listener()
  }
}

test('protocol normalization only exposes the allowlisted broker disconnect reason', () => {
  assert.deepEqual(
    normalizeHandlerError({
      code: 'MODEL_UNAUTHENTICATED',
      message: 'internal message',
      detail: { reason: 'desktop_credential_broker_not_connected' }
    }),
    {
      code: 'MODEL_UNAUTHENTICATED',
      message: 'The desktop credential broker is not connected.',
      detail: { reason: 'desktop_credential_broker_not_connected' }
    }
  )
  assert.deepEqual(
    normalizeHandlerError({
      code: 'MODEL_UNAUTHENTICATED',
      message: 'internal message',
      detail: {
        reason: 'desktop_credential_broker_not_connected',
        unexpected: true
      }
    }),
    {
      code: 'MODEL_UNAUTHENTICATED',
      message: 'The requested model provider is not authenticated.',
      detail: {
        reason: 'desktop_credential_broker_not_connected',
        unexpected: true
      }
    }
  )
})

function makeCore(
  handlers: KernelMethodHandlers = {},
  options: { replayCapacity?: number; warnings?: string[] } = {}
): KernelProtocolCore {
  return new KernelProtocolCore({
    kernelVersion: '1.2.3-test',
    ompVersion: '18.10.3-test',
    kernelInstanceId: 'kernel-test-instance',
    handlers,
    replayCapacity: options.replayCapacity,
    log: {
      warn(message) {
        options.warnings?.push(message)
      }
    }
  })
}

function request(
  id: string,
  method: string,
  generation: number,
  params: JsonValue,
  correlation: Pick<KernelRequestFrame, 'sessionId' | 'runId'> = {}
): KernelRequestFrame {
  return { kind: 'request', id, method, generation, params, ...correlation }
}

function snapshotResult(sessionId: string): {
  sessionId: string
  messages: JsonValue[]
  cwd: string
} {
  return { sessionId, messages: [], cwd: '/tmp/phi-kernel-test' }
}

const createParams = {
  cwd: '/tmp/phi-kernel-test',
  model: { provider: 'phi-contract', id: 'contract-model' },
  sessionManager: { kind: 'memory' as const }
}

function decode(line: string): ParsedFrame {
  const parsed = parseFrame(line)
  if (!('kind' in parsed)) assert.fail(`expected frame, received ${parsed.code}`)
  return parsed
}

async function waitFor(
  transport: MemoryTransport,
  predicate: (frame: ParsedFrame) => boolean,
  after = 0
): Promise<ParsedFrame> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const match = transport.sent.slice(after).map(decode).find(predicate)
    if (match) return match
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for protocol frame')
}

async function sendRequest(
  transport: MemoryTransport,
  frame: KernelRequestFrame
): Promise<KernelResponseFrame> {
  const after = transport.sent.length
  transport.receive(frame)
  const response = await waitFor(
    transport,
    (candidate) => candidate.kind === 'response' && candidate.id === frame.id,
    after
  )
  assert.equal(response.kind, 'response')
  return response
}

async function hello(
  transport: MemoryTransport,
  options: {
    id?: string
    takeover?: boolean
    protocol?: { major: number; minor: number }
    hostCapabilities?: string[]
  } = {}
): Promise<KernelResponseFrame> {
  return sendRequest(
    transport,
    request(options.id ?? 'hello', 'kernel.hello', 0, {
      protocol: options.protocol ?? PHI_KERNEL_PROTOCOL_VERSION,
      client: { name: 'core-test', version: '1.0.0' },
      ...(options.hostCapabilities === undefined
        ? {}
        : { hostCapabilities: options.hostCapabilities }),
      ...(options.takeover === undefined ? {} : { takeover: options.takeover })
    })
  )
}

function responseError(response: KernelResponseFrame): ProtocolError {
  assert.equal(response.ok, false)
  return response.error
}

function responseResult(response: KernelResponseFrame): JsonValue {
  assert.equal(response.ok, true)
  return response.result
}

function generationFrom(response: KernelResponseFrame): number {
  const result = responseResult(response)
  assert.equal(typeof result, 'object')
  assert.ok(result !== null && !Array.isArray(result))
  const generation = (result as Record<string, JsonValue>).controllerGeneration
  if (typeof generation !== 'number') assert.fail('hello response omitted controllerGeneration')
  return generation
}

function deferred<T>(): {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

test('hello negotiates minor versions and rejects pre-negotiation or incompatible requests', async () => {
  const transport = new MemoryTransport()
  const core = makeCore({
    'session.snapshot': (_params, _context, frame) => snapshotResult(frame.sessionId ?? 'missing')
  })
  core.attachTransport(transport, { trusted: true, connectionId: 'first' })

  const beforeHello = await sendRequest(
    transport,
    request('before', 'session.snapshot', 0, {}, { sessionId: 'session-1' })
  )
  assert.equal(responseError(beforeHello).code, 'NOT_NEGOTIATED')

  const incompatible = await hello(transport, {
    id: 'bad-version',
    protocol: { major: 2, minor: 0 }
  })
  assert.equal(responseError(incompatible).code, 'VERSION_UNSUPPORTED')
  assert.deepEqual(responseError(incompatible).detail, {
    peer: { major: 2, minor: 0 },
    kernel: PHI_KERNEL_PROTOCOL_VERSION
  })

  const negotiated = await hello(transport, {
    id: 'compatible-version',
    protocol: { major: 1, minor: 9 }
  })
  assert.equal(negotiated.ok, true)
  assert.deepEqual((responseResult(negotiated) as { protocol: JsonValue }).protocol, {
    major: 1,
    minor: 1
  })
})

test('business handlers receive only the controller-negotiated host capabilities', async () => {
  const transport = new MemoryTransport()
  let observed: string[] = []
  const core = makeCore({
    'session.snapshot': (_params, context, frame) => {
      observed = [...(context.hostCapabilities ?? [])]
      return snapshotResult(frame.sessionId ?? 'missing')
    }
  })
  core.attachTransport(transport, { trusted: true, connectionId: 'desktop' })
  const negotiated = await hello(transport, { hostCapabilities: ['decisions.evaluate'] })
  const generation = generationFrom(negotiated)
  const response = await sendRequest(
    transport,
    request('snapshot-with-host', 'session.snapshot', generation, {}, { sessionId: 'session-1' })
  )
  assert.equal(response.ok, true)
  assert.deepEqual(observed, ['decisions.evaluate'])
})

test('takeover creates one controller generation and immediately stales the old controller', async () => {
  const calls: string[] = []
  let promptCalls = 0
  let abortCalls = 0
  const core = makeCore({
    'session.snapshot': (_params, context, frame) => {
      calls.push(`${context.connectionId}:${context.controllerGeneration}:${context.trusted}`)
      return snapshotResult(frame.sessionId ?? 'missing')
    },
    'approval.respond': () => ({ accepted: true }),
    'session.prompt': () => {
      promptCalls += 1
      return { runId: 'stale-run-must-not-start', completion: Promise.resolve('completed') }
    },
    'session.abort': () => {
      abortCalls += 1
      return { cancelled: true }
    }
  })
  const first = new MemoryTransport()
  const second = new MemoryTransport()
  const untrusted = new MemoryTransport()
  core.attachTransport(first, { trusted: true, connectionId: 'first' })
  core.attachTransport(second, { trusted: true, connectionId: 'second' })
  core.attachTransport(untrusted, { trusted: false, connectionId: 'network' })

  assert.equal(generationFrom(await hello(first)), 1)
  const refused = await hello(second, { id: 'refused' })
  assert.equal(responseError(refused).code, 'NOT_CONTROLLER')
  const untrustedTakeover = await hello(untrusted, { id: 'untrusted', takeover: true })
  assert.equal(responseError(untrustedTakeover).code, 'NOT_CONTROLLER')

  const takeover = await hello(second, { id: 'takeover', takeover: true })
  assert.equal(generationFrom(takeover), 2)

  const staleBusiness = await sendRequest(
    first,
    request('stale-snapshot', 'session.snapshot', 1, {}, { sessionId: 'session-1' })
  )
  assert.equal(responseError(staleBusiness).code, 'STALE_GENERATION')
  const staleApproval = await sendRequest(
    first,
    request('stale-approval', 'approval.respond', 1, {
      approvalId: 'approval-1',
      decision: 'approved'
    })
  )
  assert.equal(responseError(staleApproval).code, 'STALE_GENERATION')
  const stalePrompt = await sendRequest(
    first,
    request(
      'stale-prompt',
      'session.prompt',
      1,
      { text: 'must not run' },
      { sessionId: 'session-1' }
    )
  )
  assert.equal(responseError(stalePrompt).code, 'STALE_GENERATION')
  const staleAbort = await sendRequest(
    first,
    request('stale-abort', 'session.abort', 1, {}, { sessionId: 'session-1' })
  )
  assert.equal(responseError(staleAbort).code, 'STALE_GENERATION')
  assert.equal(promptCalls, 0)
  assert.equal(abortCalls, 0)

  const active = await sendRequest(
    second,
    request('active-snapshot', 'session.snapshot', 2, {}, { sessionId: 'session-1' })
  )
  assert.equal(active.ok, true)
  assert.deepEqual(calls, ['second:2:true'])
})

test('bad frames and duplicate ids are isolated while unknown replies are logged and ignored', async () => {
  const warnings: string[] = []
  const transport = new MemoryTransport()
  const core = makeCore(
    {
      'session.snapshot': (_params, _context, frame) => ({
        ...snapshotResult(frame.sessionId ?? 'missing')
      })
    },
    { warnings }
  )
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(await hello(transport))

  for (const invalid of [
    '{broken',
    JSON.stringify({ kind: 'mystery' }),
    JSON.stringify({
      ...request('extra-field', 'session.snapshot', generation, {}, { sessionId: 'session-1' }),
      role: 'admin'
    }),
    'x'.repeat(MAX_FRAME_BYTES + 1)
  ]) {
    const after = transport.sent.length
    transport.receive(invalid)
    const response = await waitFor(
      transport,
      (frame) => frame.kind === 'response' && frame.id === '__protocol__',
      after
    )
    assert.equal(response.kind, 'response')
    assert.equal(response.ok, false)
    assert.ok(['INVALID_FRAME', 'FRAME_TOO_LARGE'].includes(response.error.code))
  }

  const first = request('duplicate', 'session.snapshot', generation, {}, { sessionId: 'session-1' })
  assert.equal((await sendRequest(transport, first)).ok, true)
  const duplicate = await sendRequest(transport, first)
  assert.equal(responseError(duplicate).code, 'DUPLICATE_REQUEST')

  transport.receive({ kind: 'response', id: 'unknown-response', ok: true, result: null })
  transport.receive({ kind: 'host.response', id: 'unknown-host', ok: true, result: null })
  const usable = await sendRequest(
    transport,
    request('after-errors', 'session.snapshot', generation, {}, { sessionId: 'session-1' })
  )
  assert.equal(usable.ok, true)
  assert.deepEqual(warnings, [
    'Ignored response with an unknown id.',
    'Ignored host response with an inactive id.'
  ])
})

test('handler results must satisfy the strict method result DTO', async () => {
  const transport = new MemoryTransport()
  const core = makeCore({
    'session.snapshot': (_params, _context, frame) => ({
      ...snapshotResult(frame.sessionId ?? 'missing'),
      unexpected: true
    })
  })
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(await hello(transport))

  const response = await sendRequest(
    transport,
    request('invalid-result', 'session.snapshot', generation, {}, { sessionId: 'session-1' })
  )
  assert.equal(responseError(response).code, 'INTERNAL')
})

test('internal handler failures are logged with the error and invalid result paths', async () => {
  const transport = new MemoryTransport()
  const errors: Array<Readonly<Record<string, JsonValue>> | undefined> = []
  const core = new KernelProtocolCore({
    kernelVersion: '1.2.3-test',
    ompVersion: '18.10.3-test',
    handlers: {
      'session.snapshot': (_params, _context, frame) => ({
        ...snapshotResult(frame.sessionId ?? 'missing'),
        messages: [{ role: 'assistant', errorMessage: undefined }] as unknown as JsonValue[]
      })
    },
    log: { error: (_message, details) => errors.push(details) }
  })
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(await hello(transport))

  const response = await sendRequest(
    transport,
    request('undefined-field', 'session.snapshot', generation, {}, { sessionId: 'session-1' })
  )
  assert.equal(responseError(response).code, 'INTERNAL')
  assert.equal(responseError(response).message, 'Kernel method failed internally.')
  assert.equal(errors.length, 1)
  assert.equal(errors[0]?.method, 'session.snapshot')
  assert.match(String(errors[0]?.error), /invalid result at: messages\.0/)
})

test('a pending handler does not block later requests on the same connection', async () => {
  const createResult = deferred<JsonValue>()
  const transport = new MemoryTransport()
  const core = makeCore({
    'session.create': () => createResult.promise,
    'session.snapshot': (_params, _context, frame) => snapshotResult(frame.sessionId ?? 'missing')
  })
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(await hello(transport))

  transport.receive(request('slow-create', 'session.create', generation, createParams))
  transport.receive(
    request('fast-snapshot', 'session.snapshot', generation, {}, { sessionId: 'session-1' })
  )

  const snapshot = await waitFor(
    transport,
    (frame) => frame.kind === 'response' && frame.id === 'fast-snapshot'
  )
  assert.equal(snapshot.kind, 'response')
  assert.deepEqual(responseResult(snapshot), snapshotResult('session-1'))
  assert.equal(
    transport.sent
      .map(decode)
      .some((frame) => frame.kind === 'response' && frame.id === 'slow-create'),
    false
  )

  createResult.resolve({ sessionId: 'session-created' })
  const created = await waitFor(
    transport,
    (frame) => frame.kind === 'response' && frame.id === 'slow-create'
  )
  assert.equal(created.kind, 'response')
  assert.deepEqual(responseResult(created), { sessionId: 'session-created' })
})

test('a handler can await a host response delivered on the same connection', async () => {
  const transport = new MemoryTransport()
  const core: KernelProtocolCore = makeCore({
    'session.snapshot': async () => {
      const result = await core.requestHost('cursorBridge.ensure', {})
      assert.equal(typeof result, 'object')
      assert.ok(result !== null && !Array.isArray(result))
      return snapshotResult('session-from-host')
    }
  })
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(
    await hello(transport, { hostCapabilities: ['cursorBridge.ensure'] })
  )

  transport.receive(
    request('snapshot-via-host', 'session.snapshot', generation, {}, { sessionId: 'session-1' })
  )
  const hostRequest = await waitFor(
    transport,
    (frame) => frame.kind === 'host.request' && frame.capability === 'cursorBridge.ensure'
  )
  assert.equal(hostRequest.kind, 'host.request')
  transport.receive({
    kind: 'host.response',
    id: hostRequest.id,
    ok: true,
    result: { baseUrl: 'https://127.0.0.1.invalid/' }
  })

  const response = await waitFor(
    transport,
    (frame) => frame.kind === 'response' && frame.id === 'snapshot-via-host'
  )
  assert.equal(response.kind, 'response')
  assert.deepEqual(responseResult(response), snapshotResult('session-from-host'))
})

test('back-to-back hello and business frames observe the negotiated generation in order', async () => {
  const transport = new MemoryTransport()
  const core = makeCore({
    'session.snapshot': (_params, _context, frame) => snapshotResult(frame.sessionId ?? 'missing')
  })
  core.attachTransport(transport, { trusted: true })

  transport.receive(
    request('ordered-hello', 'kernel.hello', 0, {
      protocol: PHI_KERNEL_PROTOCOL_VERSION,
      client: { name: 'ordered-test', version: '1.0.0' }
    })
  )
  transport.receive(
    request('ordered-snapshot', 'session.snapshot', 1, {}, { sessionId: 'session-1' })
  )

  const greeting = await waitFor(
    transport,
    (frame) => frame.kind === 'response' && frame.id === 'ordered-hello'
  )
  const snapshot = await waitFor(
    transport,
    (frame) => frame.kind === 'response' && frame.id === 'ordered-snapshot'
  )
  assert.equal(greeting.kind, 'response')
  assert.equal(snapshot.kind, 'response')
  assert.equal(greeting.ok, true)
  assert.deepEqual(responseResult(snapshot), snapshotResult('session-1'))
})

test('event sequence and bounded replay are ordered without re-executing a handler', async () => {
  let subscribeHandlerCalls = 0
  const transport = new MemoryTransport()
  const core = makeCore(
    {
      'events.subscribe': () => {
        subscribeHandlerCalls += 1
        return { subscribed: true, lastSeq: -1 }
      }
    },
    { replayCapacity: 2 }
  )
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(await hello(transport))
  transport.sent.length = 0

  assert.equal(core.emitEvent('test.event', { index: 1 })?.seq, 1)
  assert.equal(core.emitEvent('test.event', { index: 2 })?.seq, 2)
  assert.equal(core.emitEvent('test.event', { index: 3 })?.seq, 3)
  transport.sent.length = 0

  const replayResponse = await sendRequest(
    transport,
    request('replay', 'events.subscribe', generation, { afterSeq: 1 })
  )
  assert.deepEqual(responseResult(replayResponse), { subscribed: true, lastSeq: 3 })
  await waitFor(transport, (frame) => frame.kind === 'event' && frame.seq === 3)
  const replayed = transport.sent.map(decode).filter((frame) => frame.kind === 'event')
  assert.deepEqual(
    replayed.map((event) => event.seq),
    [2, 3]
  )
  assert.equal(subscribeHandlerCalls, 0)

  const gap = await sendRequest(
    transport,
    request('gap', 'events.subscribe', generation, { afterSeq: 0 })
  )
  assert.equal(responseError(gap).code, 'REPLAY_GAP')
  assert.deepEqual(responseError(gap).detail, { oldestSeq: 2 })
})

test('session.prompt acceptance precedes one terminal event and preflights active-run duplicates', async () => {
  const completion = deferred<RunCompletionStatus>()
  let handlerCalls = 0
  const preflightKeys: Array<string | undefined> = []
  const transport = new MemoryTransport()
  const core = makeCore({
    promptConflict: (_sessionId, params) => {
      const clientRunKey = (params as { clientRunKey?: string }).clientRunKey
      preflightKeys.push(clientRunKey)
      return clientRunKey === 'client-run-1' ? { runId: 'run-1', status: 'running' } : undefined
    },
    'session.prompt': () => {
      handlerCalls += 1
      return { runId: 'run-1', completion: completion.promise }
    }
  })
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(await hello(transport))

  const accepted = await sendRequest(
    transport,
    request(
      'prompt-1',
      'session.prompt',
      generation,
      { text: 'hello', clientRunKey: 'client-run-1' },
      { sessionId: 'session-1' }
    )
  )
  assert.deepEqual(responseResult(accepted), { accepted: true, runId: 'run-1' })
  assert.equal(
    transport.sent
      .map(decode)
      .some((frame) => frame.kind === 'event' && frame.type === 'run.completed'),
    false
  )

  const duplicate = await sendRequest(
    transport,
    request(
      'prompt-duplicate',
      'session.prompt',
      generation,
      { text: 'again', clientRunKey: 'client-run-1' },
      { sessionId: 'session-1' }
    )
  )
  assert.equal(responseError(duplicate).code, 'DUPLICATE_REQUEST')
  assert.deepEqual(responseError(duplicate).detail, { runId: 'run-1', status: 'running' })

  const busy = await sendRequest(
    transport,
    request(
      'prompt-different',
      'session.prompt',
      generation,
      { text: 'different', clientRunKey: 'client-run-2' },
      { sessionId: 'session-1' }
    )
  )
  assert.equal(responseError(busy).code, 'SESSION_BUSY')

  const busyWithoutKey = await sendRequest(
    transport,
    request(
      'prompt-without-key',
      'session.prompt',
      generation,
      { text: 'without key' },
      { sessionId: 'session-1' }
    )
  )
  assert.equal(responseError(busyWithoutKey).code, 'SESSION_BUSY')
  assert.equal(handlerCalls, 1)
  assert.deepEqual(preflightKeys, ['client-run-1', 'client-run-2', undefined])

  completion.resolve('completed')
  const terminal = await waitFor(
    transport,
    (frame) => frame.kind === 'event' && frame.type === 'run.completed'
  )
  assert.equal(terminal.kind, 'event')
  assert.deepEqual(terminal.payload, { runId: 'run-1', status: 'completed' })
  assert.equal(terminal.sessionId, 'session-1')
  assert.equal(terminal.runId, 'run-1')

  const beforeDuplicate = transport.sent.length
  assert.equal(
    core.emitEvent(
      'run.completed',
      { runId: 'run-1', status: 'failed' },
      { sessionId: 'session-1', runId: 'run-1' }
    ),
    undefined
  )
  assert.equal(transport.sent.length, beforeDuplicate)
})

test('a run rejected before the agent loop reports a sanitized completion detail', async () => {
  const transport = new MemoryTransport()
  const core = makeCore({
    'session.prompt': () => ({
      runId: 'run-preloop-failure',
      completion: Promise.reject(new Error('Unable to initialize /private/secret/models.yml'))
    })
  })
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(await hello(transport))

  const accepted = await sendRequest(
    transport,
    request(
      'prompt-preloop-failure',
      'session.prompt',
      generation,
      { text: 'start' },
      { sessionId: 'session-preloop-failure' }
    )
  )
  assert.deepEqual(responseResult(accepted), {
    accepted: true,
    runId: 'run-preloop-failure'
  })
  const terminal = await waitFor(
    transport,
    (frame) => frame.kind === 'event' && frame.type === 'run.completed'
  )
  assert.equal(terminal.kind, 'event')
  assert.deepEqual(terminal.payload, {
    runId: 'run-preloop-failure',
    status: 'failed',
    detail: 'Unable to initialize <path>'
  })
})

test('terminal run deduplication stays bounded and retains recent run ids', () => {
  const warnings: string[] = []
  const core = makeCore({}, { replayCapacity: 2, warnings })

  assert.ok(core.emitEvent('run.completed', { runId: 'run-1', status: 'completed' }))
  assert.ok(core.emitEvent('run.completed', { runId: 'run-2', status: 'completed' }))
  assert.ok(core.emitEvent('run.completed', { runId: 'run-3', status: 'completed' }))

  const terminalRuns = (core as unknown as { terminalRuns: ReadonlySet<string> }).terminalRuns
  assert.equal(terminalRuns.size, 2)
  assert.deepEqual([...terminalRuns], ['run-2', 'run-3'])
  assert.equal(core.emitEvent('run.completed', { runId: 'run-3', status: 'failed' }), undefined)
  assert.deepEqual(warnings, ['Ignored duplicate terminal run event.'])
})

test('transport close only detaches the controller and never calls abort or close handlers', async () => {
  const calls = { detached: [] as number[], abort: 0, close: 0 }
  const transport = new MemoryTransport()
  const core = makeCore({
    'session.abort': () => {
      calls.abort += 1
      return { cancelled: true }
    },
    'session.close': () => {
      calls.close += 1
      return { closed: true }
    },
    onControllerDetached(generation) {
      calls.detached.push(generation)
    }
  })
  core.attachTransport(transport, { trusted: true })
  assert.equal(generationFrom(await hello(transport)), 1)

  transport.close()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(calls, { detached: [1], abort: 0, close: 0 })
})

test('missing kernel and host capabilities fail explicitly', async () => {
  const transport = new MemoryTransport()
  const core = makeCore()
  core.attachTransport(transport, { trusted: true })
  const greeting = await hello(transport)
  const result = responseResult(greeting)
  assert.equal(typeof result, 'object')
  assert.ok(result !== null && !Array.isArray(result))
  assert.deepEqual((result as Record<string, JsonValue>).capabilities, [])
  const generation = generationFrom(greeting)

  const unavailable = await sendRequest(
    transport,
    request('snapshot', 'session.snapshot', generation, {}, { sessionId: 'session-1' })
  )
  assert.equal(responseError(unavailable).code, 'CAPABILITY_UNAVAILABLE')
  const unknown = await sendRequest(transport, request('unknown', 'future.method', generation, {}))
  assert.equal(responseError(unknown).code, 'UNKNOWN_METHOD')

  await assert.rejects(core.requestHost('desktop.openPath', {}), (error: ProtocolError) => {
    assert.equal(error.code, 'INTERNAL')
    return true
  })
})

test('registered host requests correlate responses without trusting unknown response ids', async () => {
  const transport = new MemoryTransport()
  const core = makeCore()
  core.attachTransport(transport, { trusted: true })
  await hello(transport, { hostCapabilities: ['cursorBridge.ensure'] })

  const after = transport.sent.length
  const resultPromise = core.requestHost(
    'cursorBridge.ensure',
    {},
    { sessionId: 'session-1', runId: 'run-1', agentRunId: 'agent-run-1' }
  )
  const outbound = await waitFor(
    transport,
    (frame) => frame.kind === 'host.request' && frame.capability === 'cursorBridge.ensure',
    after
  )
  assert.equal(outbound.kind, 'host.request')
  assert.equal(outbound.sessionId, 'session-1')
  assert.equal(outbound.runId, 'run-1')
  assert.equal(outbound.agentRunId, 'agent-run-1')
  transport.receive({
    kind: 'host.response',
    id: outbound.id,
    ok: true,
    result: { baseUrl: 'https://127.0.0.1.invalid/' }
  })
  assert.deepEqual(await resultPromise, { baseUrl: 'https://127.0.0.1.invalid/' })
})

test('non-run-scoped host frames retain session and child identity without a run id', async () => {
  const transport = new MemoryTransport()
  const core = makeCore()
  core.attachTransport(transport, { trusted: true })
  await hello(transport, { hostCapabilities: ['wrapperJob.status'] })
  const pending = core.requestHost(
    'wrapperJob.status',
    { runId: 'wrapper-run-1' },
    { sessionId: 'session-1', agentRunId: 'child-1' }
  )
  const outbound = await waitFor(
    transport,
    (frame) => frame.kind === 'host.request' && frame.capability === 'wrapperJob.status'
  )
  assert.equal(outbound.kind, 'host.request')
  assert.equal(outbound.sessionId, 'session-1')
  assert.equal(outbound.runId, undefined)
  assert.equal(outbound.agentRunId, 'child-1')
  transport.receive({ kind: 'host.response', id: outbound.id, ok: true, result: null })
  assert.equal(await pending, null)
})

test('takeover invalidates pending host requests from the previous controller', async () => {
  const first = new MemoryTransport()
  const second = new MemoryTransport()
  const warnings: string[] = []
  const core = makeCore({}, { warnings })
  core.attachTransport(first, {
    trusted: true,
    connectionId: 'first-host'
  })
  core.attachTransport(second, { trusted: true, connectionId: 'second-host' })
  await hello(first, { hostCapabilities: ['cursorBridge.ensure'] })

  const resultPromise = core.requestHost('cursorBridge.ensure', {})
  const outbound = await waitFor(
    first,
    (frame) => frame.kind === 'host.request' && frame.capability === 'cursorBridge.ensure'
  )
  assert.equal(outbound.kind, 'host.request')
  const rejected = assert.rejects(resultPromise, (error: ProtocolError) => {
    assert.equal(error.code, 'STALE_GENERATION')
    return true
  })
  await hello(second, { takeover: true })
  await rejected
  await assert.rejects(core.requestHost('cursorBridge.ensure', {}), (error: ProtocolError) => {
    assert.equal(error.code, 'CAPABILITY_UNAVAILABLE')
    return true
  })
  first.receive({ kind: 'host.response', id: outbound.id, ok: true, result: true })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(warnings, ['Ignored host response with an inactive id.'])
})

test('same-connection re-negotiation invalidates pending host requests from its old generation', async () => {
  const transport = new MemoryTransport()
  const warnings: string[] = []
  const detached: number[] = []
  const core = makeCore(
    {
      onControllerDetached(generation) {
        detached.push(generation)
      }
    },
    { warnings }
  )
  core.attachTransport(transport, {
    trusted: true,
    connectionId: 'same-connection'
  })
  assert.equal(
    generationFrom(
      await hello(transport, {
        id: 'hello-1',
        hostCapabilities: ['cursorBridge.ensure']
      })
    ),
    1
  )

  const resultPromise = core.requestHost('cursorBridge.ensure', {})
  const outbound = await waitFor(
    transport,
    (frame) => frame.kind === 'host.request' && frame.capability === 'cursorBridge.ensure'
  )
  assert.equal(outbound.kind, 'host.request')

  const rejected = assert.rejects(resultPromise, (error: ProtocolError) => {
    assert.equal(error.code, 'STALE_GENERATION')
    return true
  })
  assert.equal(generationFrom(await hello(transport, { id: 'hello-2' })), 2)
  await rejected
  transport.receive({ kind: 'host.response', id: outbound.id, ok: true, result: true })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(detached, [1])
  assert.deepEqual(warnings, ['Ignored host response with an inactive id.'])
})

test('untrusted transports cannot supply host-internal model prompt fields or proxy routes', async () => {
  const transport = new MemoryTransport()
  let calls = 0
  const core = makeCore({
    'session.prompt': () => {
      calls += 1
      return { runId: 'run-internal', completion: Promise.resolve('completed') }
    },
    'modelAccess.configure': () => {
      calls += 1
      return { configured: true }
    }
  })
  core.attachTransport(transport, { trusted: false, connectionId: 'untrusted' })
  const greeting = await hello(transport)
  const generation = generationFrom(greeting)

  const prompt = await sendRequest(
    transport,
    request(
      'internal-prompt',
      'session.prompt',
      generation,
      { text: 'retry', modelSelection: 'automatic', synthetic: true, userInitiated: false },
      { sessionId: 'session-1' }
    )
  )
  assert.equal(prompt.ok, false)
  if (!prompt.ok) assert.equal(prompt.error.code, 'INVALID_PARAMS')

  const configured = await sendRequest(
    transport,
    request('configure-proxy', 'modelAccess.configure', generation, {
      endpoint: 'http://127.0.0.1:43123/v1/pi/stream',
      bearerToken: 'abcdefghijklmnopqrstuvwxyzABCDEFGH0123456789_-',
      models: [
        {
          provider: 'provider',
          id: 'model',
          name: 'Model',
          reasoning: false,
          input: ['text'],
          contextWindow: 32_000,
          maxTokens: 4_000
        }
      ]
    })
  )
  assert.equal(configured.ok, false)
  if (!configured.ok) assert.equal(configured.error.code, 'INVALID_PARAMS')
  assert.equal(calls, 0)
})

test('host progress is accepted only for a pending progressive request from the controller', async () => {
  const warnings: string[] = []
  const transport = new MemoryTransport()
  const core = makeCore({}, { warnings })
  core.attachTransport(transport, { trusted: true, connectionId: 'progress-controller' })
  const greeting = await hello(transport, {
    hostCapabilities: ['mcp.desktop.call', 'settings.nextActionSuggestionsEnabled']
  })
  const generation = generationFrom(greeting)
  const seen: JsonValue[] = []
  const call = core.requestHost(
    'mcp.desktop.call',
    {
      bindingId: 'binding-1',
      toolCallId: 'tool-call-1',
      name: 'mcp__fake__work',
      signature: 'a'.repeat(64),
      input: {}
    },
    { sessionId: 'session-1', runId: 'run-1' },
    (progress) => seen.push(progress)
  )
  const callFrame = await waitFor(
    transport,
    (frame) => frame.kind === 'host.request' && frame.capability === 'mcp.desktop.call'
  )
  assert.equal(callFrame.kind, 'host.request')
  transport.receive({ kind: 'host.progress', id: callFrame.id, progress: { content: [] } })
  transport.receive({ kind: 'host.progress', id: 'unknown-progress', progress: null })
  transport.receive({ kind: 'host.progress', id: 'unknown-progress', progress: null })
  transport.receive({
    kind: 'host.response',
    id: callFrame.id,
    ok: true,
    result: { content: [{ type: 'text', text: 'done' }] }
  })
  assert.deepEqual(await call, { content: [{ type: 'text', text: 'done' }] })
  assert.deepEqual(seen, [{ content: [] }])

  const ordinary = core.requestHost('settings.nextActionSuggestionsEnabled', {})
  const ordinaryFrame = await waitFor(
    transport,
    (frame) =>
      frame.kind === 'host.request' && frame.capability === 'settings.nextActionSuggestionsEnabled'
  )
  assert.equal(ordinaryFrame.kind, 'host.request')
  transport.receive({ kind: 'host.progress', id: ordinaryFrame.id, progress: true })
  transport.receive({ kind: 'host.progress', id: ordinaryFrame.id, progress: false })
  transport.receive({ kind: 'host.response', id: ordinaryFrame.id, ok: true, result: true })
  assert.equal(await ordinary, true)
  assert.equal(generation, 1)
  assert.deepEqual(warnings, ['Ignored host progress frame.', 'Ignored host progress frame.'])
})
