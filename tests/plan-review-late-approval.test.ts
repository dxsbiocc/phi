import assert from 'node:assert/strict'
import test from 'node:test'

import {
  PHI_KERNEL_PROTOCOL_VERSION,
  encodeFrame,
  parseFrame,
  type HostRequestFrame,
  type JsonValue,
  type KernelRequestFrame,
  type KernelResponseFrame,
  type ParsedFrame,
  type ProtocolError
} from '../src/shared/kernel-protocol'
import {
  KernelProtocolCore,
  type FrameTransport,
  type KernelMethodHandlers
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

function makeCore(handlers: KernelMethodHandlers = {}): KernelProtocolCore {
  return new KernelProtocolCore({
    kernelVersion: 'plan-review-test-kernel',
    ompVersion: 'plan-review-test-omp',
    kernelInstanceId: 'plan-review-test-instance',
    handlers,
    log: {}
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
  predicate: (frame: ParsedFrame) => frame is T
): Promise<T> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const match = transport.sent.map(decode).find(predicate)
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = transport.sent
      .slice(after)
      .map(decode)
      .find(
        (candidate): candidate is KernelResponseFrame =>
          candidate.kind === 'response' && candidate.id === frame.id
      )
    if (response) return response
    await new Promise<void>((resolve) => setImmediate(resolve))
  }
  throw new Error('Timed out waiting for protocol response')
}

async function hello(
  transport: MemoryTransport,
  options: { hostCapabilities?: string[] } = {}
): Promise<number> {
  const response = await sendRequest(
    transport,
    request('hello', 'kernel.hello', 0, {
      protocol: PHI_KERNEL_PROTOCOL_VERSION,
      client: { name: 'plan-review-late-approval-test', version: '1.0.0' },
      ...(options.hostCapabilities ? { hostCapabilities: options.hostCapabilities } : {})
    })
  )
  assert.equal(response.ok, true)
  return (response.result as { controllerGeneration: number }).controllerGeneration
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

test('a pending review approval cannot be answered from another session', async () => {
  const decisions: JsonValue[] = []
  const core = makeCore({
    'approval.respond': (params) => {
      decisions.push(params as JsonValue)
      return { accepted: true }
    }
  })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  const generation = await hello(transport)
  core.emitEvent(
    'approval.requested',
    {
      approvalId: 'review-approval-1',
      toolCallId: 'plan-review-tool-1',
      toolName: 'write',
      input: { path: '/tmp/plan-output.txt' }
    },
    { sessionId: 'session-1', runId: 'run-1' }
  )

  const foreign = await sendRequest(
    transport,
    request(
      'foreign-answer',
      'approval.respond',
      generation,
      { approvalId: 'review-approval-1', decision: 'approved' },
      { sessionId: 'session-2' }
    )
  )
  assert.equal(responseError(foreign).code, 'INVALID_PARAMS')
  assert.deepEqual(decisions, [])

  const owner = await sendRequest(
    transport,
    request(
      'owner-answer',
      'approval.respond',
      generation,
      { approvalId: 'review-approval-1', decision: 'approved' },
      { sessionId: 'session-1' }
    )
  )
  assert.equal(owner.ok, true)
  assert.equal(decisions.length, 1)
})

test('a cancelled plan review ignores a late approval response', async () => {
  const core = makeCore({
    'session.abort': () => ({ cancelled: true })
  })
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  const generation = await hello(transport, { hostCapabilities: ['planReview.request'] })
  let planStarts = 0
  const review = core.requestHost('planReview.request', planReviewParams, {
    sessionId: 'session-1',
    runId: 'run-1'
  })
  void review.then(
    (result) => {
      if ((result as { decision?: string }).decision === 'approve') planStarts += 1
    },
    () => undefined
  )
  const outbound = await waitFor(
    transport,
    (frame): frame is HostRequestFrame =>
      frame.kind === 'host.request' && frame.capability === 'planReview.request'
  )

  const aborted = await sendRequest(
    transport,
    request('abort', 'session.abort', generation, {}, { sessionId: 'session-1', runId: 'run-1' })
  )
  assert.equal(aborted.ok, true)
  await rejectsWithCode(review, 'CANCELLED')

  transport.receive({
    kind: 'host.response',
    id: outbound.id,
    ok: true,
    result: { decision: 'approve' }
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(planStarts, 0)
})

test('a duplicate approval of one plan review starts the plan only once', async () => {
  const core = makeCore()
  const transport = new MemoryTransport()
  core.attachTransport(transport, { trusted: true })
  await hello(transport, { hostCapabilities: ['planReview.request'] })
  let planStarts = 0
  const review = core.requestHost('planReview.request', planReviewParams, {
    sessionId: 'session-1',
    runId: 'run-1'
  })
  void review.then((result) => {
    if ((result as { decision?: string }).decision === 'approve') planStarts += 1
  })
  const outbound = await waitFor(
    transport,
    (frame): frame is HostRequestFrame =>
      frame.kind === 'host.request' && frame.capability === 'planReview.request'
  )

  const approval = {
    kind: 'host.response' as const,
    id: outbound.id,
    ok: true as const,
    result: { decision: 'approve' }
  }
  transport.receive(approval)
  assert.deepEqual(await review, { decision: 'approve' })
  assert.equal(planStarts, 1)

  transport.receive(approval)
  await new Promise<void>((resolve) => setImmediate(resolve))
  assert.equal(planStarts, 1)
})
