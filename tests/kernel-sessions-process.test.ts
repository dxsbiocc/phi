import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'

import {
  KernelClientError,
  type KernelProtocolClient,
  type SpawnedKernelClient
} from '../src/main/agent/engine/kernel-client'
import type { JsonValue, KernelEventFrame } from '../src/shared/kernel-protocol'
import { createKernelFixture, type KernelEngineFixture } from './engine-contract/kernel-factory'

type A05PausePoint = 'a' | 'c' | 'd1' | 'd2'
type DurableReceipt = {
  runId: string
  clientRunKey?: string
  state: 'accepted' | 'terminal'
  status?: 'completed' | 'failed' | 'cancelled' | 'unknown'
}

function record(value: JsonValue): Record<string, JsonValue> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, JsonValue>
}

async function fixtureOrSkip(
  t: TestContext,
  testPause?: A05PausePoint
): Promise<KernelEngineFixture | undefined> {
  try {
    return await createKernelFixture(testPause ? { testPause } : {})
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM' || String(error).includes('EPERM')) {
      t.skip('sandbox forbids listening on 127.0.0.1')
      return undefined
    }
    throw error
  }
}

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${description}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

function sessionDirectory(fixture: KernelEngineFixture, sessionId: string): string {
  return join(fixture.agentDir, 'phi-kernel', 'sessions', sessionId)
}

function pauseMarker(fixture: KernelEngineFixture, point: A05PausePoint): string {
  return join(fixture.agentDir, 'phi-kernel', `test-pause-${point}.marker`)
}

function readReceipts(fixture: KernelEngineFixture, sessionId: string): DurableReceipt[] {
  return readFileSync(join(sessionDirectory(fixture, sessionId), 'runs.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as DurableReceipt)
}

function acceptedReceipt(
  fixture: KernelEngineFixture,
  sessionId: string,
  clientRunKey: string
): DurableReceipt {
  const receipt = readReceipts(fixture, sessionId).find(
    (candidate) => candidate.state === 'accepted' && candidate.clientRunKey === clientRunKey
  )
  assert.ok(receipt, `accepted receipt for ${clientRunKey} must be durable`)
  return receipt
}

async function assertRecoveredA05Run(options: {
  fixture: KernelEngineFixture
  sessionId: string
  clientRunKey: string
  runId: string
  point: A05PausePoint
  expectedStatus: 'completed' | 'unknown'
  committedEvidence?: string
}): Promise<SpawnedKernelClient> {
  const { fixture, sessionId, clientRunKey, runId, point, expectedStatus, committedEvidence } =
    options
  const peer = await fixture.spawnPeer()
  try {
    assert.deepEqual(await peer.client.request('session.open', { sessionId }), { sessionId })
    assert.deepEqual(await peer.client.request('session.open', { sessionId }), { sessionId })

    const snapshot = record(await peer.client.request('session.snapshot', {}, { sessionId }))
    assert.deepEqual(snapshot.lastRun, { runId, status: expectedStatus })

    const journal = readFileSync(
      join(sessionDirectory(fixture, sessionId), 'journal.jsonl'),
      'utf8'
    )
    assert.ok(journal.trim(), `A05(${point}) must retain committed journal history`)
    if (committedEvidence) {
      assert.ok(
        journal.includes(committedEvidence),
        `A05(${point}) journal must retain ${committedEvidence}`
      )
    }

    const receipts = readReceipts(fixture, sessionId)
    const terminals = receipts.filter(
      (receipt) => receipt.state === 'terminal' && receipt.runId === runId
    )
    assert.equal(
      terminals.length,
      1,
      `A05(${point}) must retain exactly one terminal receipt after repeated open`
    )
    assert.equal(terminals[0]?.status, expectedStatus)

    await assert.rejects(
      peer.client.request(
        'session.prompt',
        { text: 'must not replay', clientRunKey },
        { sessionId }
      ),
      (error: unknown) =>
        error instanceof KernelClientError &&
        error.code === 'DUPLICATE_REQUEST' &&
        record(error.detail ?? null).runId === runId &&
        record(error.detail ?? null).status === expectedStatus
    )

    fixture.provider.enqueue({ text: `recovered after ${point}` })
    const runs = trackCompletedRuns(peer.client)
    const next = record(
      await peer.client.request(
        'session.prompt',
        { text: 'continue safely', clientRunKey: `new-key-${point}` },
        { sessionId }
      )
    )
    assert.deepEqual(await runs.wait(String(next.runId)), {
      runId: next.runId,
      status: 'completed',
      model: { provider: 'phi-contract', id: 'contract-model' },
      resourceVersion: 'a'.repeat(64)
    })
    runs.close()
    return peer
  } catch (error) {
    await peer.close()
    throw error
  }
}

function trackCompletedRuns(client: KernelProtocolClient): {
  wait(runId: string): Promise<Record<string, JsonValue>>
  close(): void
} {
  const completed = new Map<string, Record<string, JsonValue>>()
  const waiters = new Map<string, (payload: Record<string, JsonValue>) => void>()
  const off = client.onEvent((event: KernelEventFrame) => {
    if (event.type !== 'run.completed') return
    const payload = record(event.payload)
    if (typeof payload.runId !== 'string') return
    completed.set(payload.runId, payload)
    waiters.get(payload.runId)?.(payload)
    waiters.delete(payload.runId)
  })
  return {
    wait(runId) {
      const existing = completed.get(runId)
      if (existing) return Promise.resolve(existing)
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          waiters.delete(runId)
          reject(new Error(`Timed out waiting for run ${runId}`))
        }, 10_000)
        waiters.set(runId, (payload) => {
          clearTimeout(timeout)
          resolve(payload)
        })
      })
    },
    close: off
  }
}

test(
  'A05(a) kill after accepted receipt but before prompt response recovers UNKNOWN once',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fixtureOrSkip(t, 'a')
    if (!fixture) return
    let peer: SpawnedKernelClient | undefined
    try {
      await fixture.createSession('a05-a', { persistent: true, noTools: 'all' })
      const sessionId = fixture.kernelSessionId('a05-a')
      assert.ok(sessionId)
      const clientRunKey = 'a05-a-key'
      const prompt = fixture.client.request(
        'session.prompt',
        { text: 'pause before the response', clientRunKey },
        { sessionId }
      )
      void prompt.catch(() => undefined)

      await waitFor(() => existsSync(pauseMarker(fixture, 'a')), 'A05(a) pause marker')
      const accepted = acceptedReceipt(fixture, sessionId, clientRunKey)
      await fixture.kill()
      await assert.rejects(prompt)

      peer = await assertRecoveredA05Run({
        fixture,
        sessionId,
        clientRunKey,
        runId: accepted.runId,
        point: 'a',
        expectedStatus: 'unknown'
      })
    } finally {
      await peer?.close()
      await fixture.close()
    }
  }
)

test(
  'A05(c) kill after a committed write result preserves one side effect and recovers UNKNOWN once',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fixtureOrSkip(t, 'c')
    if (!fixture) return
    let peer: SpawnedKernelClient | undefined
    try {
      await fixture.createSession('a05-c', { persistent: true })
      const sessionId = fixture.kernelSessionId('a05-c')
      assert.ok(sessionId)
      const clientRunKey = 'a05-c-key'
      const target = join(fixture.cwd, 'a05-c-side-effect.txt')
      const sideEffectMarker = 'A05-C-WRITE'
      const requestCount = fixture.provider.requests.length
      fixture.provider.enqueue(
        {
          tool: {
            name: 'write',
            id: 'a05-c-write-call',
            args: { path: target, content: `${sideEffectMarker}\n` }
          }
        },
        { text: 'held after the committed tool result', hold: true }
      )
      const accepted = record(
        await fixture.client.request(
          'session.prompt',
          { text: 'write exactly one marker', clientRunKey },
          { sessionId }
        )
      )
      assert.equal(typeof accepted.runId, 'string')

      // The pause suspends the kernel synchronously once the write result is in the journal;
      // it may come before the follow-up model request, which then never arrives.
      await waitFor(() => existsSync(pauseMarker(fixture, 'c')), 'A05(c) committed write marker')
      assert.equal(
        readFileSync(target, 'utf8').split(sideEffectMarker).length - 1,
        1,
        'the write tool side effect must happen at most once before recovery'
      )
      await fixture.kill()
      // An unconsumed held reply would stall the post-recovery prompt.
      if (fixture.provider.requests.length < requestCount + 2) fixture.provider.discardQueued?.()

      peer = await assertRecoveredA05Run({
        fixture,
        sessionId,
        clientRunKey,
        runId: String(accepted.runId),
        point: 'c',
        expectedStatus: 'unknown',
        committedEvidence: 'a05-c-write-call'
      })
      assert.equal(readFileSync(target, 'utf8'), `${sideEffectMarker}\n`)
    } finally {
      await peer?.close()
      await fixture.close()
    }
  }
)

for (const scenario of [
  { point: 'd1', expectedStatus: 'unknown' },
  { point: 'd2', expectedStatus: 'completed' }
] as const) {
  test(
    `A05(${scenario.point}) kill around terminal receipt recovers ${scenario.expectedStatus.toUpperCase()} once`,
    { timeout: 30_000 },
    async (t) => {
      const fixture = await fixtureOrSkip(t, scenario.point)
      if (!fixture) return
      let peer: SpawnedKernelClient | undefined
      try {
        await fixture.createSession(`a05-${scenario.point}`, {
          persistent: true,
          noTools: 'all'
        })
        const sessionId = fixture.kernelSessionId(`a05-${scenario.point}`)
        assert.ok(sessionId)
        const clientRunKey = `a05-${scenario.point}-key`
        const finalMessage = `A05 ${scenario.point} committed final message`
        const requestCount = fixture.provider.requests.length
        fixture.provider.enqueue({ text: finalMessage })
        const accepted = record(
          await fixture.client.request(
            'session.prompt',
            { text: 'finish at the deterministic boundary', clientRunKey },
            { sessionId }
          )
        )
        assert.equal(typeof accepted.runId, 'string')

        await waitFor(
          () =>
            existsSync(pauseMarker(fixture, scenario.point)) &&
            fixture.provider.requests.length >= requestCount + 1,
          `A05(${scenario.point}) pause marker after the final provider response`
        )
        await fixture.kill()

        peer = await assertRecoveredA05Run({
          fixture,
          sessionId,
          clientRunKey,
          runId: String(accepted.runId),
          point: scenario.point,
          expectedStatus: scenario.expectedStatus,
          committedEvidence: finalMessage
        })
      } finally {
        await peer?.close()
        await fixture.close()
      }
    }
  )
}

test(
  'SIGKILL after acceptance recovers UNKNOWN once, rejects replay, and accepts a new run',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fixtureOrSkip(t)
    if (!fixture) return
    let peer: SpawnedKernelClient | undefined
    try {
      await fixture.createSession('durable', { persistent: true, noTools: 'all' })
      const sessionId = fixture.kernelSessionId('durable')
      assert.ok(sessionId)
      assert.equal(
        JSON.parse(readFileSync(join(sessionDirectory(fixture, sessionId), 'writer.lock'), 'utf8'))
          .kernelInstanceId,
        fixture.kernelInstanceId,
        'stdio hello and writer lock must expose one kernel instance identity'
      )
      fixture.provider.enqueue({ hold: true })
      const accepted = record(
        await fixture.client.request(
          'session.prompt',
          { text: 'hold before any tool', clientRunKey: 'crash-key' },
          { sessionId }
        )
      )
      assert.equal(typeof accepted.runId, 'string')
      // Kill only once the held model request is in flight; otherwise the held
      // reply stays queued and would stall the post-recovery prompt instead.
      const deadline = Date.now() + 10_000
      while (fixture.provider.requests.length < 1) {
        if (Date.now() > deadline) throw new Error('The held model request never arrived')
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      await assert.rejects(
        fixture.client.request(
          'session.prompt',
          { text: 'same durable request', clientRunKey: 'crash-key' },
          { sessionId }
        ),
        (error: unknown) =>
          error instanceof KernelClientError &&
          error.code === 'DUPLICATE_REQUEST' &&
          record(error.detail ?? null).runId === accepted.runId &&
          record(error.detail ?? null).status === 'running'
      )
      await assert.rejects(
        fixture.client.request(
          'session.prompt',
          { text: 'different durable request', clientRunKey: 'other-live-key' },
          { sessionId }
        ),
        (error: unknown) => error instanceof KernelClientError && error.code === 'SESSION_BUSY'
      )
      await fixture.kill()

      peer = await fixture.spawnPeer()
      assert.deepEqual(await peer.client.request('session.open', { sessionId }), { sessionId })
      assert.deepEqual(await peer.client.request('session.open', { sessionId }), { sessionId })
      const snapshot = record(await peer.client.request('session.snapshot', {}, { sessionId }))
      assert.deepEqual(snapshot.lastRun, { runId: accepted.runId, status: 'unknown' })
      const receipts = readFileSync(
        join(fixture.agentDir, 'phi-kernel', 'sessions', sessionId, 'runs.jsonl'),
        'utf8'
      )
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>)
      assert.equal(receipts.filter((receipt) => receipt.status === 'unknown').length, 1)

      await assert.rejects(
        peer.client.request(
          'session.prompt',
          { text: 'must not replay', clientRunKey: 'crash-key' },
          { sessionId }
        ),
        (error: unknown) =>
          error instanceof KernelClientError &&
          error.code === 'DUPLICATE_REQUEST' &&
          record(error.detail ?? null).runId === accepted.runId &&
          record(error.detail ?? null).status === 'unknown'
      )

      fixture.provider.enqueue({ text: 'recovered' })
      const runs = trackCompletedRuns(peer.client)
      const next = record(
        await peer.client.request(
          'session.prompt',
          { text: 'continue safely', clientRunKey: 'new-key' },
          { sessionId }
        )
      )
      assert.deepEqual(await runs.wait(String(next.runId)), {
        runId: next.runId,
        status: 'completed',
        model: { provider: 'phi-contract', id: 'contract-model' },
        resourceVersion: 'a'.repeat(64)
      })
      runs.close()
    } finally {
      await peer?.close()
      await fixture.close()
    }
  }
)

test(
  'two kernel processes race one open and hand ownership to the loser after close',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fixtureOrSkip(t)
    if (!fixture) return
    const peers: SpawnedKernelClient[] = []
    try {
      await fixture.createSession('contended', { persistent: true, noTools: 'all' })
      const sessionId = fixture.kernelSessionId('contended')
      assert.ok(sessionId)
      await fixture.sessions.dispose({ sessionId: 'contended' })
      peers.push(await fixture.spawnPeer(), await fixture.spawnPeer())

      const results = await Promise.allSettled(
        peers.map((peer) => peer.client.request('session.open', { sessionId }))
      )
      const winnerIndex = results.findIndex((result) => result.status === 'fulfilled')
      const loserIndex = results.findIndex((result) => result.status === 'rejected')
      assert.notEqual(winnerIndex, -1)
      assert.notEqual(loserIndex, -1)
      const rejected = results[loserIndex]
      assert.equal(rejected.status, 'rejected')
      assert.ok(rejected.reason instanceof KernelClientError)
      assert.equal(rejected.reason.code, 'SESSION_BUSY')

      await peers[winnerIndex].client.request('session.close', {}, { sessionId })
      assert.deepEqual(await peers[loserIndex].client.request('session.open', { sessionId }), {
        sessionId
      })
    } finally {
      await Promise.allSettled(peers.map((peer) => peer.close()))
      await fixture.close()
    }
  }
)

test(
  'four persistent runs remain isolated and aborting one leaves the other three active',
  { timeout: 30_000 },
  async (t) => {
    const fixture = await fixtureOrSkip(t)
    if (!fixture) return
    try {
      for (let index = 0; index < 4; index += 1) {
        await fixture.createSession(`parallel-${index}`, {
          persistent: true,
          noTools: 'all'
        })
      }
      fixture.provider.enqueue({ hold: true }, { hold: true }, { hold: true }, { hold: true })
      const sessionIds = Array.from({ length: 4 }, (_, index) => {
        const sessionId = fixture.kernelSessionId(`parallel-${index}`)
        assert.ok(sessionId)
        return sessionId
      })
      const accepted = await Promise.all(
        sessionIds.map((sessionId, index) =>
          fixture.client.request(
            'session.prompt',
            { text: `hold ${index}`, clientRunKey: `parallel-key-${index}` },
            { sessionId }
          )
        )
      )
      assert.equal(accepted.length, 4)
      await assert.rejects(
        fixture.client.request(
          'session.prompt',
          { text: 'second prompt', clientRunKey: 'different-key' },
          { sessionId: sessionIds[0] }
        ),
        (error: unknown) => error instanceof KernelClientError && error.code === 'SESSION_BUSY'
      )

      await fixture.client.request('session.abort', {}, { sessionId: sessionIds[0] })
      for (const sessionId of sessionIds.slice(1)) {
        const snapshot = record(await fixture.client.request('session.snapshot', {}, { sessionId }))
        assert.equal(typeof snapshot.activeRunId, 'string')
      }
    } finally {
      await fixture.close()
    }
  }
)
