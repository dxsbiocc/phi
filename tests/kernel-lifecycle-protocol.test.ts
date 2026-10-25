import assert from 'node:assert/strict'
import test from 'node:test'

import {
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
    const line = encodeFrame(frame)
    for (const listener of this.lineListeners) listener(line)
  }

  close(): void {
    for (const listener of this.closeListeners) listener()
  }
}

function makeCore(
  handlers: KernelMethodHandlers = {},
  options: {
    warnings?: string[]
    attached?: number[]
    detached?: number[]
    replayCapacity?: number
  } = {}
): KernelProtocolCore {
  return new KernelProtocolCore({
    kernelVersion: 'lifecycle-test-kernel',
    ompVersion: 'lifecycle-test-omp',
    kernelInstanceId: 'lifecycle-kernel-instance',
    handlers,
    replayCapacity: options.replayCapacity,
    disconnectPolicy: 'wait-for-reconnect',
    controllerLifecycle: {
      onControllerAttached(generation) {
        options.attached?.push(generation)
      },
      onControllerDetached(generation) {
        options.detached?.push(generation)
      }
    },
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
  options: { id?: string; takeover?: boolean; hostCapabilities?: string[] } = {}
): Promise<KernelResponseFrame> {
  return sendRequest(
    transport,
    request(options.id ?? 'hello', 'kernel.hello', 0, {
      protocol: PHI_KERNEL_PROTOCOL_VERSION,
      client: { name: 'lifecycle-test', version: '1.0.0' },
      ...(options.hostCapabilities ? { hostCapabilities: options.hostCapabilities } : {}),
      ...(options.takeover === undefined ? {} : { takeover: options.takeover })
    })
  )
}

function responseResult(response: KernelResponseFrame): JsonValue {
  assert.equal(response.ok, true)
  return response.result
}

function responseError(response: KernelResponseFrame): ProtocolError {
  assert.equal(response.ok, false)
  return response.error
}

function generationFrom(response: KernelResponseFrame): number {
  const result = responseResult(response)
  assert.equal(typeof result, 'object')
  assert.ok(result !== null && !Array.isArray(result))
  const generation = (result as Record<string, JsonValue>).controllerGeneration
  if (typeof generation !== 'number') assert.fail('hello response omitted controllerGeneration')
  return generation
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve
  })
  return { promise, resolve }
}

const planReviewParams = {
  runtimeSessionId: 'runtime-session-1',
  title: 'Review this plan',
  planContent: '# Plan',
  planFilePath: 'local://PLAN.md'
}

test('controller lifecycle observes negotiated attachment and transport detachment', async () => {
  const attached: number[] = []
  const detached: number[] = []
  const transport = new MemoryTransport()
  const core = makeCore({}, { attached, detached })
  core.attachTransport(transport, { trusted: true })

  assert.equal(generationFrom(await hello(transport)), 1)
  transport.close()
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.deepEqual(attached, [1])
  assert.deepEqual(detached, [1])
})

test('remote disconnect keeps a host request pending and re-sends its id after takeover', async () => {
  const first = new MemoryTransport()
  const second = new MemoryTransport()
  const core = makeCore()
  core.attachTransport(first, { trusted: true, connectionId: 'first-host' })
  await hello(first, { hostCapabilities: ['planReview.request'] })

  const resultPromise = core.requestHost('planReview.request', planReviewParams, {
    sessionId: 'session-1',
    runId: 'run-1'
  })
  const original = await waitFor(
    first,
    (frame) => frame.kind === 'host.request' && frame.capability === 'planReview.request'
  )
  assert.equal(original.kind, 'host.request')
  first.close()

  core.attachTransport(second, { trusted: true, connectionId: 'second-host' })
  await hello(second, { takeover: true, hostCapabilities: ['planReview.request'] })
  const resent = await waitFor(
    second,
    (frame) => frame.kind === 'host.request' && frame.capability === 'planReview.request'
  )
  assert.equal(resent.kind, 'host.request')
  assert.equal(resent.id, original.id)

  first.receive({
    kind: 'host.response',
    id: original.id,
    ok: true,
    result: { decision: 'cancel' }
  })
  second.receive({
    kind: 'host.response',
    id: resent.id,
    ok: true,
    result: { decision: 'approve' }
  })
  assert.deepEqual(await resultPromise, { decision: 'approve' })
})

test('a disconnected host request waits even when the old controller lacked its capability', async () => {
  const first = new MemoryTransport()
  const second = new MemoryTransport()
  const core = makeCore()
  core.attachTransport(first, { trusted: true, connectionId: 'old-capabilities' })
  await hello(first, { hostCapabilities: ['desktop.old'] })
  first.close()

  let settled = false
  const resultPromise = core
    .requestHost('settings.nextActionSuggestionsEnabled', {})
    .finally(() => {
      settled = true
    })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(settled, false)

  core.attachTransport(second, { trusted: true, connectionId: 'new-capabilities' })
  await hello(second, {
    takeover: true,
    hostCapabilities: ['settings.nextActionSuggestionsEnabled']
  })
  const requestFrame = await waitFor(
    second,
    (frame) =>
      frame.kind === 'host.request' && frame.capability === 'settings.nextActionSuggestionsEnabled'
  )
  assert.equal(requestFrame.kind, 'host.request')
  second.receive({ kind: 'host.response', id: requestFrame.id, ok: true, result: true })
  assert.equal(await resultPromise, true)
})

test('a queued disconnected host request fails only when reconnect omits its capability', async () => {
  const first = new MemoryTransport()
  const second = new MemoryTransport()
  const core = makeCore()
  core.attachTransport(first, { trusted: true, connectionId: 'queue-old' })
  await hello(first)
  first.close()

  const resultPromise = core.requestHost('settings.nextActionSuggestionsEnabled', {})
  const rejected = assert.rejects(resultPromise, (error: ProtocolError) => {
    assert.equal(error.code, 'CAPABILITY_UNAVAILABLE')
    return true
  })
  core.attachTransport(second, { trusted: true, connectionId: 'queue-new' })
  await hello(second, { takeover: true, hostCapabilities: ['desktop.other'] })
  await rejected
})

test('live takeover moves a pending host request and rejects the old controller reply', async () => {
  const first = new MemoryTransport()
  const second = new MemoryTransport()
  const warnings: string[] = []
  const core = makeCore({}, { warnings })
  core.attachTransport(first, { trusted: true, connectionId: 'live-old' })
  core.attachTransport(second, { trusted: true, connectionId: 'live-new' })
  await hello(first, { hostCapabilities: ['planReview.request'] })

  const resultPromise = core.requestHost('planReview.request', planReviewParams, {
    sessionId: 'session-live',
    runId: 'run-live'
  })
  const original = await waitFor(first, (frame) => frame.kind === 'host.request')
  assert.equal(original.kind, 'host.request')
  await hello(second, { takeover: true, hostCapabilities: ['planReview.request'] })
  const resent = await waitFor(second, (frame) => frame.kind === 'host.request')
  assert.equal(resent.kind, 'host.request')
  assert.equal(resent.id, original.id)

  first.receive({
    kind: 'host.response',
    id: original.id,
    ok: true,
    result: { decision: 'cancel' }
  })
  second.receive({
    kind: 'host.response',
    id: resent.id,
    ok: true,
    result: { decision: 'approve' }
  })
  assert.deepEqual(await resultPromise, { decision: 'approve' })
  assert.deepEqual(warnings, ['Ignored host response with an inactive id.'])
})

test('takeover buffers live events until replay is subscribed, then preserves event order', async () => {
  const first = new MemoryTransport()
  const second = new MemoryTransport()
  const core = makeCore({
    'events.subscribe': () => ({ subscribed: true, lastSeq: 0 })
  })
  core.attachTransport(first, { trusted: true, connectionId: 'event-old' })
  await hello(first)
  core.emitEvent('test.event', { value: 1 })
  first.close()

  core.attachTransport(second, { trusted: true, connectionId: 'event-new' })
  const generation = generationFrom(await hello(second, { takeover: true }))
  const afterHello = second.sent.length
  core.emitEvent('test.event', { value: 2 })
  const renegotiatedGeneration = generationFrom(await hello(second, { id: 'hello-again' }))
  core.emitEvent('test.event', { value: 3 })
  assert.deepEqual(
    second.sent
      .slice(afterHello)
      .map(decode)
      .filter((frame) => frame.kind === 'event'),
    []
  )
  assert.equal(renegotiatedGeneration, generation + 1)

  await sendRequest(
    second,
    request('event-replay', 'events.subscribe', renegotiatedGeneration, { afterSeq: 1 })
  )
  const replayed = second.sent
    .slice(afterHello)
    .map(decode)
    .filter((frame) => frame.kind === 'event')
  assert.deepEqual(
    replayed.map((event) => event.seq),
    [2, 3]
  )
  assert.deepEqual(
    replayed.map((event) => event.payload),
    [{ value: 2 }, { value: 3 }]
  )

  core.emitEvent('test.event', { value: 4 })
  const live = second.sent
    .map(decode)
    .filter(
      (frame): frame is Extract<ParsedFrame, { kind: 'event' }> =>
        frame.kind === 'event' && frame.seq === 4
    )
  assert.equal(live.length, 1)
  assert.deepEqual(live[0]?.payload, { value: 4 })
})

test('remote takeover re-announces a pending approval after replay', async () => {
  const decisions: JsonValue[] = []
  const first = new MemoryTransport()
  const second = new MemoryTransport()
  const core = makeCore({
    'approval.respond': (params) => {
      decisions.push(params)
      return { accepted: true }
    },
    'events.subscribe': () => ({ subscribed: true, lastSeq: 0 })
  })
  core.attachTransport(first, { trusted: true, connectionId: 'first-approval' })
  await hello(first)
  core.emitEvent(
    'approval.requested',
    {
      approvalId: 'approval-1',
      toolCallId: 'tool-1',
      toolName: 'write',
      input: { path: '/tmp/result.txt' }
    },
    { sessionId: 'session-1', runId: 'run-1' }
  )
  first.close()

  core.attachTransport(second, { trusted: true, connectionId: 'second-approval' })
  const generation = generationFrom(await hello(second, { takeover: true }))
  core.emitEvent(
    'approval.requested',
    {
      approvalId: 'approval-after-hello',
      toolCallId: 'tool-after-hello',
      toolName: 'read',
      input: {}
    },
    { sessionId: 'session-2', runId: 'run-2' }
  )
  const beforeSubscribe = second.sent.length
  await sendRequest(
    second,
    request('approval-replay', 'events.subscribe', generation, { afterSeq: 1 })
  )
  const announced = await waitFor(
    second,
    (frame) =>
      frame.kind === 'event' &&
      frame.type === 'approval.requested' &&
      (frame.payload as { approvalId?: string }).approvalId === 'approval-1',
    beforeSubscribe
  )
  assert.equal(announced.kind, 'event')
  assert.equal(announced.sessionId, 'session-1')
  assert.equal(announced.runId, 'run-1')
  const approvalEvents = second.sent.map(decode).filter((frame) => frame.kind === 'event')
  assert.deepEqual(
    [
      ...new Set(
        approvalEvents
          .filter(
            (frame) =>
              (frame.payload as { approvalId?: string }).approvalId === 'approval-after-hello'
          )
          .map((frame) => frame.seq)
      )
    ],
    [2]
  )
  assert.deepEqual(
    approvalEvents
      .filter((frame) => (frame.payload as { approvalId?: string }).approvalId === 'approval-1')
      .map((frame) => frame.seq),
    [3]
  )

  const response = await sendRequest(
    second,
    request('approve', 'approval.respond', generation, {
      approvalId: 'approval-1',
      decision: 'approved'
    })
  )
  assert.deepEqual(responseResult(response), { accepted: true })
  assert.deepEqual(decisions, [{ approvalId: 'approval-1', decision: 'approved' }])
})

test('replay gap enables live events and re-announces snapshotted approvals', async () => {
  const first = new MemoryTransport()
  const second = new MemoryTransport()
  const core = makeCore(
    {
      'events.subscribe': () => ({ subscribed: true, lastSeq: 0 }),
      'approval.respond': () => ({ accepted: true })
    },
    { replayCapacity: 2 }
  )
  core.attachTransport(first, { trusted: true, connectionId: 'gap-old' })
  await hello(first)
  core.emitEvent('test.event', { value: 1 })
  core.emitEvent('test.event', { value: 2 })
  core.emitEvent(
    'approval.requested',
    {
      approvalId: 'approval-gap',
      toolCallId: 'tool-gap',
      toolName: 'write',
      input: {}
    },
    { sessionId: 'session-gap', runId: 'run-gap' }
  )
  first.close()

  core.attachTransport(second, { trusted: true, connectionId: 'gap-new' })
  const generation = generationFrom(await hello(second, { takeover: true }))
  const afterHello = second.sent.length
  const gap = await sendRequest(
    second,
    request('gap-subscribe', 'events.subscribe', generation, { afterSeq: 0 })
  )
  assert.equal(responseError(gap).code, 'REPLAY_GAP')
  const approval = await waitFor(
    second,
    (frame) =>
      frame.kind === 'event' &&
      (frame.payload as { approvalId?: string }).approvalId === 'approval-gap',
    afterHello
  )
  assert.equal(approval.kind, 'event')
  const approvalResponse = await sendRequest(
    second,
    request('approve-after-gap', 'approval.respond', generation, {
      approvalId: 'approval-gap',
      decision: 'denied'
    })
  )
  assert.deepEqual(responseResult(approvalResponse), { accepted: true })

  core.emitEvent('test.live', { value: 4 })
  const live = await waitFor(
    second,
    (frame) => frame.kind === 'event' && frame.type === 'test.live'
  )
  assert.equal(live.kind, 'event')
  assert.deepEqual(live.payload, { value: 4 })
})

test('grace expiry denies approvals, aborts runs, and fails host requests', async () => {
  const completion = deferred<RunCompletionStatus>()
  const calls: Array<{ method: string; sessionId?: string; params: JsonValue }> = []
  const first = new MemoryTransport()
  const core = makeCore({
    'session.prompt': () => ({ runId: 'run-grace', completion: completion.promise }),
    'session.abort': (params, _context, frame) => {
      calls.push({ method: 'session.abort', sessionId: frame.sessionId, params })
      return { cancelled: true }
    },
    'approval.respond': (params) => {
      calls.push({ method: 'approval.respond', params })
      completion.resolve('failed')
      return { accepted: true }
    },
    'events.subscribe': () => ({ subscribed: true, lastSeq: 0 })
  })
  core.attachTransport(first, { trusted: true, connectionId: 'grace-client' })
  const generation = generationFrom(
    await hello(first, { hostCapabilities: ['planReview.request'] })
  )
  const accepted = await sendRequest(
    first,
    request(
      'prompt',
      'session.prompt',
      generation,
      { text: 'keep running' },
      {
        sessionId: 'session-grace'
      }
    )
  )
  assert.deepEqual(responseResult(accepted), { accepted: true, runId: 'run-grace' })
  core.emitEvent(
    'approval.requested',
    {
      approvalId: 'approval-grace',
      toolCallId: 'tool-grace',
      toolName: 'bash',
      input: { command: 'sleep 30' }
    },
    { sessionId: 'session-grace', runId: 'run-grace' }
  )
  first.close()

  const hostResult = core.requestHost('planReview.request', planReviewParams, {
    sessionId: 'session-grace',
    runId: 'run-grace'
  })
  const hostRejected = assert.rejects(hostResult, (error: ProtocolError) => {
    assert.equal(error.code, 'CANCELLED')
    return true
  })
  await core.expireDisconnectedState()
  await hostRejected
  assert.deepEqual(calls, [
    {
      method: 'approval.respond',
      params: {
        approvalId: 'approval-grace',
        decision: 'denied',
        reason: 'client did not return'
      }
    },
    { method: 'session.abort', sessionId: 'session-grace', params: {} }
  ])

  const reconnect = new MemoryTransport()
  core.attachTransport(reconnect, { trusted: true, connectionId: 'after-expiry' })
  const reconnectGeneration = generationFrom(await hello(reconnect, { takeover: true }))
  reconnect.sent.length = 0
  await sendRequest(
    reconnect,
    request('replay-after-expiry', 'events.subscribe', reconnectGeneration, { afterSeq: 0 })
  )
  const terminal = await waitFor(
    reconnect,
    (frame) => frame.kind === 'event' && frame.type === 'run.completed'
  )
  assert.equal(terminal.kind, 'event')
  assert.deepEqual(terminal.payload, { runId: 'run-grace', status: 'cancelled' })
  assert.equal(
    reconnect.sent
      .map(decode)
      .filter((frame) => frame.kind === 'event' && frame.type === 'run.completed').length,
    1
  )
})

test('a run that finishes during grace replays its completion after reconnect', async () => {
  const completion = deferred<RunCompletionStatus>()
  const first = new MemoryTransport()
  const core = makeCore({
    'session.prompt': () => ({ runId: 'run-finished-offline', completion: completion.promise }),
    'events.subscribe': () => ({ subscribed: true, lastSeq: 0 })
  })
  core.attachTransport(first, { trusted: true, connectionId: 'before-grace' })
  const generation = generationFrom(await hello(first))
  await sendRequest(
    first,
    request(
      'offline-prompt',
      'session.prompt',
      generation,
      { text: 'finish later' },
      {
        sessionId: 'session-offline'
      }
    )
  )
  core.emitEvent(
    'approval.requested',
    {
      approvalId: 'approval-cleared-by-run',
      toolCallId: 'tool-cleared-by-run',
      toolName: 'read',
      input: {}
    },
    { sessionId: 'session-offline', runId: 'run-finished-offline' }
  )
  first.close()
  completion.resolve('completed')
  await new Promise<void>((resolve) => setImmediate(resolve))

  const second = new MemoryTransport()
  core.attachTransport(second, { trusted: true, connectionId: 'after-grace' })
  const reconnectGeneration = generationFrom(await hello(second, { takeover: true }))
  second.sent.length = 0
  await sendRequest(
    second,
    request('offline-replay', 'events.subscribe', reconnectGeneration, { afterSeq: 0 })
  )
  const terminal = await waitFor(
    second,
    (frame) => frame.kind === 'event' && frame.type === 'run.completed'
  )
  assert.equal(terminal.kind, 'event')
  assert.deepEqual(terminal.payload, {
    runId: 'run-finished-offline',
    status: 'completed'
  })
  assert.equal(
    second.sent
      .map(decode)
      .filter((frame) => frame.kind === 'event' && frame.type === 'approval.requested').length,
    1
  )
})
