import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PHI_KERNEL_PROTOCOL_VERSION,
  encodeFrame,
  parseFrame,
  type HostRequestFrame,
  type InteractionCancelledPayload,
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
  type KernelProtocolOptions,
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

type Diagnostic = {
  level: 'warn' | 'error'
  message: string
  details?: Readonly<Record<string, JsonValue>>
}

function makeCore(
  handlers: KernelMethodHandlers = {},
  options: {
    diagnostics?: Diagnostic[]
    disconnectPolicy?: KernelProtocolOptions['disconnectPolicy']
    hostRequestTimeoutMs?: number
  } = {}
): KernelProtocolCore {
  return new KernelProtocolCore({
    kernelVersion: 'interaction-test-kernel',
    ompVersion: 'interaction-test-omp',
    kernelInstanceId: 'interaction-test-instance',
    handlers,
    disconnectPolicy: options.disconnectPolicy,
    hostRequestTimeoutMs: options.hostRequestTimeoutMs,
    log: {
      warn(message, details) {
        options.diagnostics?.push({ level: 'warn', message, details })
      },
      error(message, details) {
        options.diagnostics?.push({ level: 'error', message, details })
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

async function waitFor<T extends ParsedFrame>(
  transport: MemoryTransport,
  predicate: (frame: ParsedFrame) => frame is T,
  after = 0
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const match = transport.sent.slice(after).map(decode).find(predicate)
    if (match) return match
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for protocol frame')
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (predicate()) return
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for interaction state')
}

async function sendRequest(
  transport: MemoryTransport,
  frame: KernelRequestFrame
): Promise<KernelResponseFrame> {
  const after = transport.sent.length
  transport.receive(frame)
  return waitFor(
    transport,
    (candidate): candidate is KernelResponseFrame =>
      candidate.kind === 'response' && candidate.id === frame.id,
    after
  )
}

async function hello(
  transport: MemoryTransport,
  options: { id?: string; takeover?: boolean; hostCapabilities?: string[] } = {}
): Promise<KernelResponseFrame> {
  return sendRequest(
    transport,
    request(options.id ?? 'hello', 'kernel.hello', 0, {
      protocol: PHI_KERNEL_PROTOCOL_VERSION,
      client: { name: 'interaction-core-test', version: '1.0.0' },
      ...(options.hostCapabilities ? { hostCapabilities: options.hostCapabilities } : {}),
      ...(options.takeover ? { takeover: true } : {})
    })
  )
}

function generationFrom(response: KernelResponseFrame): number {
  assert.equal(response.ok, true)
  const result = response.result as Record<string, JsonValue>
  assert.equal(typeof result.controllerGeneration, 'number')
  return result.controllerGeneration as number
}

function responseError(response: KernelResponseFrame): ProtocolError {
  assert.equal(response.ok, false)
  return response.error
}

async function rejectsWithCode(
  promise: Promise<unknown>,
  code: ProtocolError['code']
): Promise<void> {
  await assert.rejects(promise, (error: ProtocolError) => {
    assert.equal(error.code, code)
    return true
  })
}

const planReviewParams = {
  runtimeSessionId: 'runtime-session-1',
  title: 'Review this plan',
  planContent: '# Plan\n\n1. Verify the interaction.',
  planFilePath: 'local://PLAN.md'
}

type ApprovalDecision = {
  approvalId: string
  decision: 'approved' | 'denied'
  reason?: string
}

type BoundInteraction = {
  core: KernelProtocolCore
  transport: MemoryTransport
  generation: number
  decisions: ApprovalDecision[]
  hostRequest: HostRequestFrame
  hostResult: Promise<JsonValue>
}

async function createBoundInteraction(): Promise<BoundInteraction> {
  const decisions: ApprovalDecision[] = []
  const core = makeCore({
    'approval.respond': (params) => {
      decisions.push(params as ApprovalDecision)
      return { accepted: true }
    },
    'session.abort': () => ({ cancelled: true }),
    'session.close': () => ({ closed: true })
  })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true, connectionId: 'interaction-controller' })
  const generation = generationFrom(
    await hello(transport, { hostCapabilities: ['planReview.request'] })
  )
  core.emitEvent(
    'approval.requested',
    {
      approvalId: 'approval-1',
      toolCallId: 'tool-1',
      toolName: 'write',
      input: { path: '/tmp/interaction-result.txt' }
    },
    { sessionId: 'session-1', runId: 'run-1' }
  )
  const after = transport.sent.length
  const hostResult = core.requestHost('planReview.request', planReviewParams, {
    sessionId: 'session-1',
    runId: 'run-1'
  })
  const hostRequest = await waitFor(
    transport,
    (frame): frame is HostRequestFrame =>
      frame.kind === 'host.request' && frame.capability === 'planReview.request',
    after
  )
  return { core, transport, generation, decisions, hostRequest, hostResult }
}

function cancellationPayloads(transport: MemoryTransport): InteractionCancelledPayload[] {
  return transport.sent
    .map(decode)
    .flatMap((frame) =>
      frame.kind === 'event' && frame.type === 'interaction.cancelled'
        ? [frame.payload as InteractionCancelledPayload]
        : []
    )
}

async function assertBoundInteractionCancelled(
  interaction: BoundInteraction,
  reason: string
): Promise<void> {
  await rejectsWithCode(interaction.hostResult, 'CANCELLED')
  await waitUntil(() => interaction.decisions.length === 1)
  assert.deepEqual(interaction.decisions, [
    { approvalId: 'approval-1', decision: 'denied', reason }
  ])
  assert.deepEqual(
    cancellationPayloads(interaction.transport).sort((left, right) =>
      left.kind.localeCompare(right.kind)
    ),
    [
      {
        kind: 'approval',
        id: 'approval-1',
        sessionId: 'session-1',
        runId: 'run-1',
        reason
      },
      {
        kind: 'host',
        id: interaction.hostRequest.id,
        sessionId: 'session-1',
        runId: 'run-1',
        reason
      }
    ]
  )
}

test('an unknown registry capability rejects with INTERNAL and writes one diagnostic', async () => {
  const diagnostics: Diagnostic[] = []
  const core = makeCore({}, { diagnostics })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  await hello(transport)

  await rejectsWithCode(core.requestHost('future.unknown', {}), 'INTERNAL')

  assert.equal(diagnostics.length, 1)
  assert.match(diagnostics[0].message, /unknown host capability/i)
  assert.deepEqual(diagnostics[0].details, { capability: 'future.unknown' })
})

test('a registered but undeclared host capability rejects with CAPABILITY_UNAVAILABLE', async () => {
  const core = makeCore()
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  await hello(transport)

  await rejectsWithCode(
    core.requestHost('settings.nextActionSuggestionsEnabled', {}),
    'CAPABILITY_UNAVAILABLE'
  )
})

test('invalid host capability parameters reject with INVALID_PARAMS before sending', async () => {
  const core = makeCore()
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  await hello(transport, { hostCapabilities: ['settings.nextActionSuggestionsEnabled'] })
  const after = transport.sent.length

  await rejectsWithCode(
    core.requestHost('settings.nextActionSuggestionsEnabled', { unexpected: true }),
    'INVALID_PARAMS'
  )

  assert.equal(
    transport.sent
      .slice(after)
      .map(decode)
      .some((frame) => frame.kind === 'host.request'),
    false
  )
})

test('an invalid host result rejects with INVALID_PARAMS and diagnoses paths without values', async () => {
  const diagnostics: Diagnostic[] = []
  const core = makeCore({}, { diagnostics })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  await hello(transport, { hostCapabilities: ['settings.nextActionSuggestionsEnabled'] })
  const result = core.requestHost('settings.nextActionSuggestionsEnabled', {})
  const outbound = await waitFor(
    transport,
    (frame): frame is HostRequestFrame => frame.kind === 'host.request'
  )

  transport.receive({
    kind: 'host.response',
    id: outbound.id,
    ok: true,
    result: { enabled: 'secret-invalid-value' }
  })

  await rejectsWithCode(result, 'INVALID_PARAMS')
  assert.deepEqual(diagnostics, [
    {
      level: 'error',
      message: 'Host capability returned an invalid result.',
      details: {
        capability: 'settings.nextActionSuggestionsEnabled',
        paths: ['<root>']
      }
    }
  ])
  assert.doesNotMatch(JSON.stringify(diagnostics), /secret-invalid-value/)
})

test('environment binding allows create-time use and remains cancellable when run-bound', async () => {
  const core = makeCore()
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  await hello(transport, { hostCapabilities: ['environments.bindSession'] })
  const params = {
    runtimeSessionId: 'runtime-session-1',
    ref: 'phi:python@1',
    agent: 'Main',
    cwd: '/project'
  }

  const creating = core.requestHost('environments.bindSession', params, {
    sessionId: 'session-1'
  })
  const createRequest = await waitFor(
    transport,
    (frame): frame is HostRequestFrame => frame.kind === 'host.request'
  )
  transport.receive({
    kind: 'host.response',
    id: createRequest.id,
    ok: true,
    result: { ref: 'phi:python@1', envId: 'environment-1', variables: { PATH: '/env/bin' } }
  })
  assert.deepEqual(await creating, {
    ref: 'phi:python@1',
    envId: 'environment-1',
    variables: { PATH: '/env/bin' }
  })

  const running = core.requestHost('environments.bindSession', params, {
    sessionId: 'session-1',
    runId: 'run-1'
  })
  await waitFor(
    transport,
    (frame): frame is HostRequestFrame =>
      frame.kind === 'host.request' && frame.id !== createRequest.id
  )
  core.emitEvent(
    'run.completed',
    { runId: 'run-1', status: 'cancelled' },
    { sessionId: 'session-1', runId: 'run-1' }
  )
  await rejectsWithCode(running, 'CANCELLED')
})

test('a featured MCP API key resolves without entering replay events or diagnostics', async () => {
  const diagnostics: Diagnostic[] = []
  const core = makeCore(
    { 'events.subscribe': () => ({ subscribed: true, lastSeq: 0 }) },
    { diagnostics }
  )
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(
    await hello(transport, { hostCapabilities: ['mcp.featuredApiKey'] })
  )
  const result = core.requestHost('mcp.featuredApiKey', { id: 'featured-service' })
  const outbound = await waitFor(
    transport,
    (frame): frame is HostRequestFrame => frame.kind === 'host.request'
  )
  const secret = 'phi-secret-must-not-be-replayed'
  transport.receive({ kind: 'host.response', id: outbound.id, ok: true, result: secret })

  assert.equal(await result, secret)
  core.emitEvent('test.replay-marker', { safe: true })
  const beforeReplay = transport.sent.length
  const subscribed = await sendRequest(
    transport,
    request('replay-after-secret', 'events.subscribe', generation, { afterSeq: 0 })
  )

  assert.equal(subscribed.ok, true)
  assert.doesNotMatch(JSON.stringify(transport.sent.slice(beforeReplay)), new RegExp(secret))
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(secret))
})

test('model credential rows resolve without entering replay events or diagnostics', async () => {
  const diagnostics: Diagnostic[] = []
  const core = makeCore(
    { 'events.subscribe': () => ({ subscribed: true, lastSeq: 0 }) },
    { diagnostics }
  )
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(
    await hello(transport, { hostCapabilities: ['modelAccess.credentials'] })
  )
  const secret = 'fake-model-key-must-not-be-replayed'
  const result = core.requestHost('modelAccess.credentials', { provider: 'fixture' })
  const outbound = await waitFor(
    transport,
    (frame): frame is HostRequestFrame => frame.kind === 'host.request'
  )
  transport.receive({
    kind: 'host.response',
    id: outbound.id,
    ok: true,
    result: {
      credentials: [
        {
          id: 1,
          provider: 'fixture',
          credential: { type: 'api_key', key: secret },
          identityKey: null
        }
      ]
    }
  })

  assert.equal(
    ((await result) as { credentials: Array<{ credential: { key: string } }> }).credentials[0]
      ?.credential.key,
    secret
  )
  core.emitEvent('test.replay-marker', { safe: true })
  const beforeReplay = transport.sent.length
  await sendRequest(
    transport,
    request('replay-after-model-secret', 'events.subscribe', generation, { afterSeq: 0 })
  )
  assert.doesNotMatch(JSON.stringify(transport.sent.slice(beforeReplay)), new RegExp(secret))
  assert.doesNotMatch(JSON.stringify(diagnostics), new RegExp(secret))
})

test('a service host capability timeout rejects with CANCELLED', async () => {
  const core = makeCore({}, { hostRequestTimeoutMs: 10 })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  await hello(transport, { hostCapabilities: ['settings.nextActionSuggestionsEnabled'] })

  await rejectsWithCode(core.requestHost('settings.nextActionSuggestionsEnabled', {}), 'CANCELLED')
})

test('a user interaction has no service timeout while disconnected in grace', async () => {
  const core = makeCore({}, { disconnectPolicy: 'wait-for-reconnect', hostRequestTimeoutMs: 10 })
  const first = new MemoryTransport()
  core.attachTransport(first, { trusted: true, connectionId: 'before-grace' })
  await hello(first, { hostCapabilities: ['planReview.request'] })
  first.close()

  let settled = false
  const result = core
    .requestHost('planReview.request', planReviewParams, {
      sessionId: 'session-1',
      runId: 'run-1'
    })
    .finally(() => {
      settled = true
    })
  await new Promise<void>((resolve) => setTimeout(resolve, 25))
  assert.equal(settled, false)

  const second = new MemoryTransport()
  core.attachTransport(second, { trusted: true, connectionId: 'after-grace' })
  await hello(second, { takeover: true, hostCapabilities: ['planReview.request'] })
  const outbound = await waitFor(
    second,
    (frame): frame is HostRequestFrame => frame.kind === 'host.request'
  )
  second.receive({
    kind: 'host.response',
    id: outbound.id,
    ok: true,
    result: { decision: 'approve' }
  })
  assert.deepEqual(await result, { decision: 'approve' })
})

for (const status of [
  'completed',
  'failed',
  'cancelled',
  'unknown'
] satisfies RunCompletionStatus[]) {
  test(`a ${status} run cancels its pending approval and run-scoped host request`, async () => {
    const interaction = await createBoundInteraction()
    const rejected = assertBoundInteractionCancelled(interaction, 'run ended')

    interaction.core.emitEvent(
      'run.completed',
      { runId: 'run-1', status },
      { sessionId: 'session-1', runId: 'run-1' }
    )

    await rejected
  })
}

test('session.abort cancels the targeted run approval and run-scoped host request', async () => {
  const interaction = await createBoundInteraction()
  const rejected = assertBoundInteractionCancelled(interaction, 'run ended')

  const response = await sendRequest(
    interaction.transport,
    request(
      'abort',
      'session.abort',
      interaction.generation,
      {},
      {
        sessionId: 'session-1',
        runId: 'run-1'
      }
    )
  )

  assert.equal(response.ok, true)
  await rejected
})

test('session.close cancels every pending approval and run-scoped host request in the session', async () => {
  const interaction = await createBoundInteraction()
  const rejected = assertBoundInteractionCancelled(interaction, 'session closed')

  const response = await sendRequest(
    interaction.transport,
    request('close', 'session.close', interaction.generation, {}, { sessionId: 'session-1' })
  )

  assert.equal(response.ok, true)
  await rejected
})

test('cancelling one session plan review leaves the other session review answerable', async () => {
  const decisions: ApprovalDecision[] = []
  const core = makeCore({
    'approval.respond': (params) => {
      decisions.push(params as ApprovalDecision)
      return { accepted: true }
    }
  })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(
    await hello(transport, { hostCapabilities: ['planReview.request'] })
  )
  for (const index of [1, 2]) {
    core.emitEvent(
      'approval.requested',
      {
        approvalId: `approval-${index}`,
        toolCallId: `tool-${index}`,
        toolName: 'write',
        input: { path: `/tmp/plan-${index}.txt` }
      },
      { sessionId: `session-${index}`, runId: `run-${index}` }
    )
  }

  const firstResult = core.requestHost('planReview.request', planReviewParams, {
    sessionId: 'session-1',
    runId: 'run-1'
  })
  const firstRequest = await waitFor(
    transport,
    (frame): frame is HostRequestFrame => frame.kind === 'host.request'
  )
  const afterFirst = transport.sent.length
  const secondResult = core.requestHost(
    'planReview.request',
    { ...planReviewParams, runtimeSessionId: 'runtime-session-2' },
    { sessionId: 'session-2', runId: 'run-2' }
  )
  const secondRequest = await waitFor(
    transport,
    (frame): frame is HostRequestFrame => frame.kind === 'host.request',
    afterFirst
  )
  const firstRejected = rejectsWithCode(firstResult, 'CANCELLED')

  core.emitEvent(
    'run.completed',
    { runId: 'run-1', status: 'cancelled' },
    { sessionId: 'session-1', runId: 'run-1' }
  )
  await firstRejected
  await waitUntil(() => decisions.length === 1)

  const lateFirstApproval = await sendRequest(
    transport,
    request('late-first-review', 'approval.respond', generation, {
      approvalId: 'approval-1',
      decision: 'approved'
    })
  )
  assert.equal(responseError(lateFirstApproval).code, 'CANCELLED')
  transport.receive({
    kind: 'host.response',
    id: firstRequest.id,
    ok: true,
    result: { decision: 'approve' }
  })

  const beforeReplan = transport.sent.length
  const replanResult = core.requestHost(
    'planReview.request',
    {
      ...planReviewParams,
      runtimeSessionId: 'runtime-session-1',
      replanRequestId: firstRequest.id
    },
    { sessionId: 'session-1', runId: 'run-1-replan' }
  )
  const replanRequest = await waitFor(
    transport,
    (frame): frame is HostRequestFrame => frame.kind === 'host.request',
    beforeReplan
  )
  transport.receive({
    kind: 'host.response',
    id: replanRequest.id,
    ok: true,
    result: { decision: 'revise', note: 'Replanned independently.' }
  })
  assert.deepEqual(await replanResult, {
    decision: 'revise',
    note: 'Replanned independently.'
  })

  transport.receive({
    kind: 'host.response',
    id: secondRequest.id,
    ok: true,
    result: { decision: 'approve' }
  })
  assert.deepEqual(await secondResult, { decision: 'approve' })
  const secondApproval = await sendRequest(
    transport,
    request('answer-second-review', 'approval.respond', generation, {
      approvalId: 'approval-2',
      decision: 'approved'
    })
  )

  assert.equal(secondApproval.ok, true)
  assert.deepEqual(decisions, [
    { approvalId: 'approval-1', decision: 'denied', reason: 'run ended' },
    { approvalId: 'approval-2', decision: 'approved' }
  ])
  assert.notEqual(firstRequest.id, secondRequest.id)
  assert.deepEqual(
    cancellationPayloads(transport).map(({ kind, sessionId, runId }) => ({
      kind,
      sessionId,
      runId
    })),
    [
      { kind: 'host', sessionId: 'session-1', runId: 'run-1' },
      { kind: 'approval', sessionId: 'session-1', runId: 'run-1' }
    ]
  )
})

test('a late response to a cancelled approval rejects with CANCELLED', async () => {
  const interaction = await createBoundInteraction()
  const cancelled = assertBoundInteractionCancelled(interaction, 'run ended')
  interaction.core.emitEvent(
    'run.completed',
    { runId: 'run-1', status: 'cancelled' },
    { sessionId: 'session-1', runId: 'run-1' }
  )
  await cancelled

  const late = await sendRequest(
    interaction.transport,
    request('late-approval', 'approval.respond', interaction.generation, {
      approvalId: 'approval-1',
      decision: 'approved'
    })
  )

  assert.equal(responseError(late).code, 'CANCELLED')
  assert.equal(interaction.decisions.length, 1)
})

test('a duplicate approval response rejects with DUPLICATE_REQUEST and calls the worker once', async () => {
  const calls: JsonValue[] = []
  const core = makeCore({
    'approval.respond': (params) => {
      calls.push(params)
      return { accepted: true }
    }
  })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(await hello(transport))
  core.emitEvent(
    'approval.requested',
    { approvalId: 'approval-1', toolCallId: 'tool-1', toolName: 'write', input: {} },
    { sessionId: 'session-1', runId: 'run-1' }
  )

  const first = await sendRequest(
    transport,
    request('first-answer', 'approval.respond', generation, {
      approvalId: 'approval-1',
      decision: 'approved'
    })
  )
  const duplicate = await sendRequest(
    transport,
    request('duplicate-answer', 'approval.respond', generation, {
      approvalId: 'approval-1',
      decision: 'denied'
    })
  )

  assert.equal(first.ok, true)
  assert.equal(responseError(duplicate).code, 'DUPLICATE_REQUEST')
  assert.equal(calls.length, 1)
})

test('an unknown approval response rejects with INVALID_PARAMS without calling the worker', async () => {
  let calls = 0
  const core = makeCore({
    'approval.respond': () => {
      calls += 1
      return { accepted: true }
    }
  })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  const generation = generationFrom(await hello(transport))

  const response = await sendRequest(
    transport,
    request('unknown-answer', 'approval.respond', generation, {
      approvalId: 'approval-unknown',
      decision: 'approved'
    })
  )

  assert.equal(responseError(response).code, 'INVALID_PARAMS')
  assert.equal(calls, 0)
})

test('late responses to a cancelled host request have no effect and log once', async () => {
  const diagnostics: Diagnostic[] = []
  const core = makeCore({}, { diagnostics })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  await hello(transport, { hostCapabilities: ['planReview.request'] })
  const result = core.requestHost('planReview.request', planReviewParams, {
    sessionId: 'session-1',
    runId: 'run-1'
  })
  const outbound = await waitFor(
    transport,
    (frame): frame is HostRequestFrame => frame.kind === 'host.request'
  )
  const rejected = rejectsWithCode(result, 'CANCELLED')
  core.emitEvent(
    'run.completed',
    { runId: 'run-1', status: 'completed' },
    { sessionId: 'session-1', runId: 'run-1' }
  )
  await rejected

  transport.receive({
    kind: 'host.response',
    id: outbound.id,
    ok: true,
    result: { decision: 'approve' }
  })
  transport.receive({
    kind: 'host.response',
    id: outbound.id,
    ok: true,
    result: { decision: 'revise' }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(diagnostics, [
    {
      level: 'warn',
      message: 'Ignored host response with an inactive id.',
      details: { state: 'cancelled' }
    }
  ])
})

test('duplicate responses to an answered host request have no effect and log once', async () => {
  const diagnostics: Diagnostic[] = []
  const core = makeCore({}, { diagnostics, hostRequestTimeoutMs: 1_000 })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  await hello(transport, { hostCapabilities: ['settings.nextActionSuggestionsEnabled'] })
  const result = core.requestHost('settings.nextActionSuggestionsEnabled', {})
  const outbound = await waitFor(
    transport,
    (frame): frame is HostRequestFrame => frame.kind === 'host.request'
  )
  transport.receive({ kind: 'host.response', id: outbound.id, ok: true, result: true })
  assert.equal(await result, true)

  transport.receive({ kind: 'host.response', id: outbound.id, ok: true, result: false })
  transport.receive({ kind: 'host.response', id: outbound.id, ok: true, result: false })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(diagnostics, [
    {
      level: 'warn',
      message: 'Ignored host response with an inactive id.',
      details: { state: 'answered' }
    }
  ])
})

test('repeated responses with an unknown host id have no effect and log once', async () => {
  const diagnostics: Diagnostic[] = []
  const core = makeCore({}, { diagnostics })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  await hello(transport)

  transport.receive({ kind: 'host.response', id: 'host-unknown', ok: true, result: null })
  transport.receive({ kind: 'host.response', id: 'host-unknown', ok: true, result: null })
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(diagnostics, [
    {
      level: 'warn',
      message: 'Ignored host response with an inactive id.',
      details: { state: 'unknown' }
    }
  ])
})

test('an approval response from a stale generation is rejected before reaching the worker', async () => {
  let calls = 0
  const core = makeCore({
    'approval.respond': () => {
      calls += 1
      return { accepted: true }
    }
  })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true, connectionId: 'same-controller' })
  const oldGeneration = generationFrom(await hello(transport, { id: 'hello-1' }))
  core.emitEvent(
    'approval.requested',
    { approvalId: 'approval-1', toolCallId: 'tool-1', toolName: 'write', input: {} },
    { sessionId: 'session-1', runId: 'run-1' }
  )
  const newGeneration = generationFrom(await hello(transport, { id: 'hello-2' }))

  const stale = await sendRequest(
    transport,
    request('stale-answer', 'approval.respond', oldGeneration, {
      approvalId: 'approval-1',
      decision: 'approved'
    })
  )
  assert.equal(responseError(stale).code, 'STALE_GENERATION')
  assert.equal(calls, 0)

  const current = await sendRequest(
    transport,
    request('current-answer', 'approval.respond', newGeneration, {
      approvalId: 'approval-1',
      decision: 'approved'
    })
  )
  assert.equal(current.ok, true)
  assert.equal(calls, 1)
})

test('an approval response from a non-controller is rejected with NOT_CONTROLLER', async () => {
  let calls = 0
  const core = makeCore({
    'approval.respond': () => {
      calls += 1
      return { accepted: true }
    }
  })
  const controller = new MemoryTransport()
  const observer = new MemoryTransport()
  core.attachTransport(controller, { trusted: true, connectionId: 'controller' })
  core.attachTransport(observer, { trusted: true, connectionId: 'observer' })
  const generation = generationFrom(await hello(controller))
  core.emitEvent(
    'approval.requested',
    { approvalId: 'approval-1', toolCallId: 'tool-1', toolName: 'write', input: {} },
    { sessionId: 'session-1', runId: 'run-1' }
  )
  const refused = await hello(observer, { id: 'observer-hello' })
  assert.equal(responseError(refused).code, 'NOT_CONTROLLER')

  const response = await sendRequest(
    observer,
    request('observer-answer', 'approval.respond', generation, {
      approvalId: 'approval-1',
      decision: 'approved'
    })
  )

  assert.equal(responseError(response).code, 'NOT_CONTROLLER')
  assert.equal(calls, 0)
})
