import assert from 'node:assert/strict'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { DecisionJobs } from '../src/main/agent/engine/decision-jobs'
import { createDecisionClient } from '../src/main/agent/engine/decision-client'
import { bindSessionDecisionEvaluator } from '../src/main/agent/engine/decision-evaluator'
import { buildDecisionTool } from '../src/main/agent/decisions/tool'
import {
  validateDecisionRequest,
  validateDecisionResult
} from '../src/main/agent/decisions/validation'
import type { DecisionRequest, DecisionResult } from '../src/shared/decisionTypes'
import type { OmpBridge } from '../src/main/agent/engine/omp-bridge'

const request: DecisionRequest = {
  purpose: 'evidence_review',
  context: 'Observed evidence.',
  question: 'Is the evidence sufficient?',
  options: [
    { id: 'enough', description: 'Sufficient evidence' },
    { id: 'missing', description: 'More evidence needed' }
  ]
}
const model = { providerId: 'test-provider', modelId: 'test-model' }
const answer: DecisionResult = {
  choice: 'enough',
  source: 'model',
  model,
  fallbackReason: 'not_configured'
}
const params = { agentDir: '/trusted/profile', sessionId: 'trusted-session', model, request }

test('decision boundary rejects oversized, ambiguous and authority-bearing input and output', () => {
  assert.deepEqual(validateDecisionRequest(request), request)
  for (const invalid of [
    { ...request, purpose: 'approve' },
    { ...request, sessionId: 'forged' },
    { ...request, context: 'x'.repeat(32769) },
    { ...request, question: 'x'.repeat(4097) },
    { ...request, context: '中'.repeat(32768) },
    { ...request, options: [request.options[0]] },
    {
      ...request,
      options: Array.from({ length: 13 }, (_, i) => ({ id: `a${i}`, description: 'a' }))
    },
    { ...request, options: [request.options[0], request.options[0]] },
    { ...request, options: [{ id: '__proto__', description: 'unsafe' }, request.options[1]] }
  ])
    assert.throws(() => validateDecisionRequest(invalid))
  for (const invalid of [
    { ...answer, choice: 'not-an-option' },
    { ...answer, confidence: 0.5 },
    { ...answer, source: 'native', confidence: NaN },
    { ...answer, fallbackReason: 'provider-secret' }
  ])
    assert.throws(() => validateDecisionResult(invalid, request))
  assert.deepEqual(validateDecisionResult({ ...answer, secret: 'discard' }, request), answer)
})

test('jobs cancel before dispatch and cancel one active provider without touching another', async () => {
  const jobs = new DecisionJobs(500)
  jobs.cancel('early')
  let called = false
  await assert.rejects(
    jobs.run('early', async () => {
      called = true
    }),
    /before dispatch/
  )
  assert.equal(called, false)
  let firstSignal: AbortSignal | undefined
  const first = jobs.run('first', (signal) => {
    firstSignal = signal
    return new Promise(() => {})
  })
  const failure = assert.rejects(first, /cancelled/)
  let finish!: () => void
  const second = jobs.run('second', async (signal) => {
    await new Promise<void>((resolve) => {
      finish = resolve
    })
    assert.equal(signal.aborted, false)
    return 'second-result'
  })
  jobs.cancel('first')
  assert.equal(firstSignal?.aborted, true)
  await failure
  finish()
  assert.equal(await second, 'second-result')
  jobs.close()
})

test('worker deadline aborts upstream and ignores late completion', async () => {
  const jobs = new DecisionJobs(15)
  let signal!: AbortSignal
  let finish!: (value: string) => void
  const operation = jobs.run('late', (received) => {
    signal = received
    return new Promise<string>((resolve) => {
      finish = resolve
    })
  })
  await assert.rejects(operation, /deadline/)
  assert.equal(signal.aborted, true)
  finish('late-output')
  assert.equal(await jobs.run('next', async () => 'ready'), 'ready')
})

test('jobs bound live work and cancellation history, and expire pre-dispatch cancellation', async () => {
  const jobs = new DecisionJobs(500)
  const pending = Array.from({ length: 64 }, (_, i) =>
    jobs.run(`job-${i}`, () => new Promise(() => {})).catch(() => undefined)
  )
  await assert.rejects(
    jobs.run('overflow', async () => 'bad'),
    /unavailable/
  )
  jobs.close()
  await Promise.all(pending)
  for (let i = 0; i <= 1024; i++) jobs.cancel(`cancel-${i}`)
  assert.equal(
    await jobs.run('cancel-0', async () => 'old tombstone evicted'),
    'old tombstone evicted'
  )
  await assert.rejects(
    jobs.run('cancel-1024', async () => 'bad'),
    /before dispatch/
  )
  const expiring = new DecisionJobs(10)
  expiring.cancel('expired')
  await delay(15)
  assert.equal(await expiring.run('expired', async () => 'ok'), 'ok')
  jobs.close()
})

function bridgeFixture(): {
  bridge: Pick<OmpBridge, 'request'>
  calls: Array<{ method: string; params: unknown }>
  finish(value: unknown): void
} {
  const calls: Array<{ method: string; params: unknown }> = []
  let finish: (value: unknown) => void = () => undefined
  return {
    calls,
    finish: (value) => finish(value),
    bridge: {
      request<T>(method: string, input?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
        calls.push({ method, params: input })
        if (method === 'decisions.cancel') return Promise.resolve(undefined as T)
        return new Promise<T>((resolve, reject) => {
          finish = (value) => resolve(value as T)
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true
          })
        })
      }
    }
  }
}

test('desktop client sends private cancellation on caller abort and deadline', async () => {
  for (const deadline of [false, true]) {
    const f = bridgeFixture()
    const caller = new AbortController()
    const operation = createDecisionClient(f.bridge, deadline ? 10 : 500).evaluate(
      params,
      caller.signal
    )
    const failure = assert.rejects(operation, deadline ? /deadline/ : /caller stop/)
    if (!deadline) caller.abort(new Error('caller stop'))
    await failure
    assert.deepEqual(
      f.calls.map((call) => call.method),
      ['decisions.evaluate', 'decisions.cancel']
    )
    const dispatched = f.calls[0].params as { jobId: string }
    assert.match(dispatched.jobId, /^[a-f0-9-]{36}$/)
    assert.deepEqual(f.calls[1].params, { jobId: dispatched.jobId })
    f.finish(answer)
  }
  const f = bridgeFixture()
  const caller = AbortSignal.abort(new Error('already cancelled'))
  await assert.rejects(createDecisionClient(f.bridge).evaluate(params, caller), /already cancelled/)
  assert.equal(f.calls.length, 0)
})

test('session evaluator snapshots the current trusted model for each invocation', async () => {
  const current = { provider: 'provider', id: 'first' }
  const seen: unknown[] = []
  const decide = bindSessionDecisionEvaluator({
    agentDir: params.agentDir,
    sessionId: params.sessionId,
    currentModel: () => current,
    evaluate: async (input) => {
      seen.push(input.model)
      return answer
    }
  })
  const first = decide(request)
  current.id = 'second'
  await first
  await decide(request)
  assert.deepEqual(seen, [
    { providerId: 'provider', modelId: 'first' },
    { providerId: 'provider', modelId: 'second' }
  ])
  const missing = bindSessionDecisionEvaluator({
    ...params,
    currentModel: () => undefined,
    evaluate: async () => answer
  })
  assert.throws(() => missing(request), /explicitly selected/)
})

test('generic decision tool publishes bounded advisory details through the normal tool result', async () => {
  const tool = buildDecisionTool(async () => answer)
  assert.equal(tool.approval, 'read')
  assert.equal(tool.site, 'host')
  assert.equal(tool.loadMode, 'essential')
  const result = await tool.execute('call', { ...request }, undefined, {
    cwd: '/project',
    recentUserImages: () => []
  })
  assert.deepEqual(result.details, answer)
  assert.equal(result.content[0].type, 'text')
  await assert.rejects(
    tool.execute('call', { ...request, model }, undefined, {
      cwd: '/project',
      recentUserImages: () => []
    }),
    /decision request/
  )
})
